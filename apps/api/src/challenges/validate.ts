/**
 * The authoritative validator — §4, §3.6, and risk 5.
 *
 * ════════════════════════════════════════════════════════════════════════
 * NOTHING THE CLIENT SAYS ABOUT ITS OWN SUBMISSION IS BELIEVED.
 *
 * §4 gives the server three reasons to exist and this is one of them:
 * "se necesita una simulación **autoritativa** (validar un reto, evitar
 * trampa)". Risk 5 is the same sentence from the other side. So a submission
 * arrives as a circuit and *only* as a circuit — the wire schema has one field
 * (`SubmitChallengeBody`) — and every figure that ends up in the row is
 * recomputed here:
 *
 *   the resulting state      by @qsim/core, in this process
 *   the fidelity             against the target this process read from Postgres
 *   the gate count           by @qsim/schema, over the EXPANDED circuit
 *   the depth                likewise
 *   the allowed-gate rule    over the expanded circuit, for the same reason
 *   the gate budget          from the recomputed count
 *   passed                   from all of the above
 *
 * A client that lies gains nothing, because there is nowhere for a claim to
 * enter. `routes/challenges.test.ts` submits a lie about every one of those
 * fields at once and asserts the stored row carries the truth.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SAME ENGINE, WHICH IS WHY THE MONOREPO IS ONE REPOSITORY (§12.1).
 *
 * The browser simulates for live feedback and the server simulates to judge. If
 * those were two implementations, a learner could see "solved" on their screen
 * and "failed" in the response, with nothing to debug. They are one package.
 *
 * ════════════════════════════════════════════════════════════════════════
 * A SUBMISSION IS UNTRUSTED CODE TO EXECUTE, AND IT RUNS IN THIS PROCESS.
 *
 * Not in the worker: a challenge circuit is bounded to the challenge's own
 * register — at most `MAX_CHALLENGE_QUBITS` wires, checked before anything is
 * allocated — and to `MAX_CHALLENGE_OPERATIONS` expanded operations, which
 * together cap the work at a few hundred thousand Float64 operations. That is
 * microseconds, and it is why this does not need the killable child §11 asks
 * for around a *general* server simulation. The order is the point:
 *
 *   1. `parseCircuit` (§11: validate before the engine sees anything);
 *   2. the register must be exactly this challenge's, which is what bounds 2ⁿ;
 *   3. the expanded operation count must be under the ceiling;
 *   4. only then does anything run.
 *
 * Step 2 does double duty — it is a rule of the puzzle *and* the resource
 * limit, and a submission that fails it is refused before a statevector exists.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE THREE COMPARISONS, AND THE TRAP IN EACH.
 *
 * **A state, up to global phase.** |ψ⟩ and e^{iφ}|ψ⟩ are the same physical
 * state — no measurement in any basis distinguishes them — so a validator that
 * failed them would be wrong about physics. `stateFidelity` is |⟨ψ|φ⟩|², which
 * squares the modulus and never sees the phase.
 *
 * **A unitary, up to global phase, and it is a different question from the
 * state.** Two circuits can agree on |0…0⟩ and disagree everywhere else — an
 * identity and a CNOT both leave |00⟩ alone — so a unitary target is compared
 * as a matrix: |Tr(A†B)|²/d², which is 1 exactly when the two differ by an
 * overall factor. See `@qsim/core/unitary.ts`.
 *
 * **A truth table, which CANNOT pin down an operation, and says so.** A table
 * fixes the image of each listed basis state and nothing else: it says nothing
 * about superposed inputs, because a per-column phase is invisible to it. `cz`
 * and the identity have the same truth table on two qubits — both leave every
 * basis state where it is — and they are entirely different operations, as the
 * state |++⟩ shows immediately. So a truth-table challenge is scored on the
 * listed basis inputs and on nothing else, and every verdict it produces
 * carries `basis-states-only` so the reader is told the scope rather than left
 * to assume it. A challenge that needs the phases needs a unitary target.
 *
 * The score for a table is the **worst** row, not the average. An average lets
 * three correct rows out of four carry a threshold of 0.7 while one input is
 * completely wrong, and "your circuit does the right thing three quarters of
 * the time" is not what a truth table asserts.
 *
 * ════════════════════════════════════════════════════════════════════════
 * A CIRCUIT THAT BREAKS THE GATE RULE IS NOT SCORED, AND THAT IS THE POINT.
 *
 * This module used to compute the fidelity for every submission and let
 * `allowedGates` decide only `passed`. The pedagogy was sound — "this is right
 * and it is too long" has to be sayable — but the side effect was not:
 * `allowedGates` then bounded the *answer* and never the *probe*, so a caller
 * could send any gate at all and read back a full-precision fidelity. That is
 * a state-tomography oracle. Eight basis probes and two interference probes
 * reconstruct a three-qubit target exactly, inside one minute's rate budget,
 * and the target is the one thing §3.6 and risk 5 say the server holds and the
 * client does not.
 *
 * So the two kinds of rule are separated:
 *
 *   - A **budget** violation (`gate-budget-exceeded`, `empty-circuit`) is
 *     still scored. The circuit is built out of the tools the puzzle handed
 *     out, so using them *is* the intended activity, and "correct and too
 *     long" survives intact.
 *   - A **gate** violation is refused before anything is simulated. The
 *     verdict carries `not-scored` and the gate to remove, the fidelity is 0
 *     because none was measured, and no diagnosis is computed — because every
 *     diagnosis is a comparison against the target, and a comparison is the
 *     thing being refused.
 *
 * What is left as a channel is the fidelity of a circuit written in the
 * challenge's own gate set, which is what §3.6 calls legitimate feedback, and
 * `routes/challenges.ts`'s strict rate limit is what bounds the loop over it.
 */

import {
  MidCircuitMeasurementError,
  alloc,
  allocUnitary,
  circuitUnitary,
  runFromState,
  stateFidelity,
  unitaryFidelity,
  type Statevector,
  type Unitary,
} from '@qsim/core'
import type { ChallengeFeedback } from '@qsim/contract'
import {
  MAX_EXPANDED_OPERATIONS,
  depth as circuitDepth,
  gateCount as circuitGateCount,
  gatesUsed,
  safeExpandCircuit,
  type Circuit,
} from '@qsim/schema'

import { diagnoseState, diagnoseUnitary, feedback } from './feedback.js'
import {
  ChallengeTargetError,
  type ChallengeTarget,
  type StateTarget,
  type TruthTableTarget,
  type UnitaryTarget,
} from './target.js'

/**
 * The most expanded operations a submission may carry.
 *
 * A challenge's gate budget is single digits; 256 is two orders above the
 * largest one seeded and is what bounds the work of a submission that has no
 * budget at all. It is far below `MAX_EXPANDED_OPERATIONS`, which bounds a
 * *document*, because this bound is about CPU in the request path rather than
 * about what a circuit may contain.
 */
export const MAX_CHALLENGE_OPERATIONS = 256

/** The rules of the challenge, as this module needs them. */
export interface ChallengeConstraints {
  readonly qubitCount: number
  readonly allowedGates: readonly string[]
  readonly maxGates: number | null
  readonly fidelityThreshold: number
}

/** What the server decided, and why. */
export interface ChallengeVerdict {
  readonly passed: boolean
  readonly fidelity: number
  readonly gateCount: number
  readonly depth: number
  readonly feedback: ChallengeFeedback[]
}

/** A submission past a resource bound. Answered as a 413, never simulated. */
export class SubmissionTooLargeError extends Error {
  readonly code: 'too-many-qubits' | 'too-many-operations'
  readonly value: number
  readonly limit: number

  constructor(
    code: 'too-many-qubits' | 'too-many-operations',
    value: number,
    limit: number
  ) {
    super(`Submission refused: ${code} (${value} against a limit of ${limit}).`)
    this.name = 'SubmissionTooLargeError'
    this.code = code
    this.value = value
    this.limit = limit
  }
}

/**
 * Judges one submission. Pure: takes a parsed circuit and a parsed target,
 * returns the verdict. No database, no request, no clock.
 */
export function judgeSubmission(input: {
  slug: string
  constraints: ChallengeConstraints
  target: ChallengeTarget
  circuit: Circuit
}): ChallengeVerdict {
  const { slug, constraints, target, circuit } = input

  /*
   * A threshold outside (0, 1] is a corrupted row rather than a lenient one.
   * Zero, or a negative, passes every submission including an empty circuit —
   * the same class of quiet wrongness `target.ts` refuses an un-normalised
   * state for, and the same answer: refuse the row rather than mark everybody
   * correct. Above 1 is refused too: nothing can reach it, so the challenge
   * would be unsolvable and would say only "not yet".
   */
  if (
    !Number.isFinite(constraints.fidelityThreshold) ||
    constraints.fidelityThreshold <= 0 ||
    constraints.fidelityThreshold > 1
  ) {
    throw new ChallengeTargetError(
      slug,
      `the row's fidelity threshold is ${String(constraints.fidelityThreshold)}` +
        ', which is not a fidelity'
    )
  }

  if (target.qubits !== constraints.qubitCount) {
    // A seeded row disagreeing with itself. Not the caller's problem, and not
    // something to paper over: comparing against a target of another width
    // would answer a fidelity that means nothing.
    throw new ChallengeTargetError(
      slug,
      `the row says ${constraints.qubitCount} qubits and the target has ` +
        `${target.qubits}`
    )
  }

  const gateCount = circuitGateCount(circuit)
  const depth = circuitDepth(circuit)

  /*
   * The register check is first because it is also the resource limit: 2ⁿ is
   * every allocation this module makes, and past this line n is the
   * challenge's own.
   */
  if (circuit.qubits !== constraints.qubitCount) {
    if (circuit.qubits > MAX_WRONG_REGISTER_QUBITS) {
      throw new SubmissionTooLargeError(
        'too-many-qubits',
        circuit.qubits,
        MAX_WRONG_REGISTER_QUBITS
      )
    }
    return {
      passed: false,
      fidelity: 0,
      gateCount,
      depth,
      feedback: [feedback('wrong-qubit-count', { value: circuit.qubits })],
    }
  }

  /*
   * Expanded once, here, and everything downstream runs the flat circuit. The
   * engine has no `myBlock` in its dispatch table — a custom gate is a document
   * feature, not an operation (§3.1, decision 2) — so a submission using one
   * would be a `CircuitRunError` rather than a verdict. It is also what the
   * operation budget has to count, since twenty definitions each using the
   * previous one twice are forty JSON operations and a million real ones.
   */
  const executable = expand(circuit)

  /*
   * A BUDGET violation does not stop the simulation, and that is deliberate. A
   * circuit that solves the puzzle in seven gates when the budget is five has
   * something to be told — "this is right and it is too long" is the lesson,
   * and reporting fidelity 0 for it would teach the opposite. Those violations
   * are collected, the physics is computed anyway, and `passed` requires both.
   */
  const violations = constraintViolations(circuit, constraints, gateCount)

  /*
   * A GATE violation does. See the header: scoring a circuit built from gates
   * the challenge forbids is what turns this route into a target-extraction
   * oracle, because it lets a caller choose the probe. Refused before the
   * engine is asked anything, so there is no fidelity to leak and no diagnosis
   * — every diagnosis is a comparison, and the comparison is what is refused.
   */
  const forbidden = violations.filter(
    (entry) => entry.code === 'gate-not-allowed'
  )
  if (forbidden.length > 0) {
    return {
      passed: false,
      // Not a reading. `not-scored` is what says so, and it comes first.
      fidelity: 0,
      gateCount,
      depth,
      feedback: trimVerdict([feedback('not-scored'), ...forbidden], []),
    }
  }

  const reading = compare(slug, constraints, target, executable)

  const passed =
    violations.length === 0 && reading.fidelity >= constraints.fidelityThreshold

  /*
   * The diagnosis is computed against the threshold as if the constraints held,
   * so a correct-but-too-long circuit is told it is correct. `passed` above is
   * the one that carries the constraints, and it is the one that is stored.
   */
  return {
    passed,
    fidelity: reading.fidelity,
    gateCount,
    depth,
    feedback: trimVerdict(violations, reading.feedback),
  }
}

/**
 * The verdict's codes, bounded, deduplicated, and never at the cost of the one
 * message the design says must always be present.
 *
 * Two properties this function exists for:
 *
 *   1. **`basis-states-only` survives the cut.** The header of this file
 *      argues that a truth table cannot pin down an operation and concludes
 *      that "every verdict it produces carries `basis-states-only` so the
 *      reader is told the scope rather than left to assume it". A plain
 *      `slice` queued it behind an unbounded list of refusals, so the one
 *      message that must always be there was the first to go.
 *   2. **Nothing is said twice.** Two paths can produce the same code for the
 *      same gate — the allowed-gate walk and the mid-circuit refusal both used
 *      to name `measure` — and a reader who sees one sentence printed twice
 *      reads it as two problems.
 */
function trimVerdict(
  violations: readonly ChallengeFeedback[],
  diagnosis: readonly ChallengeFeedback[]
): ChallengeFeedback[] {
  const seen = new Set<string>()
  const unique: ChallengeFeedback[] = []
  for (const entry of [...violations, ...diagnosis]) {
    const key = `${entry.code}|${String(entry.gate)}|${String(entry.value)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  if (unique.length <= MAX_VERDICT_CODES) return unique

  const kept = unique.slice(0, MAX_VERDICT_CODES)
  const scope = diagnosis.find((entry) => entry.code === 'basis-states-only')
  if (scope !== undefined && !kept.includes(scope)) {
    kept[MAX_VERDICT_CODES - 1] = scope
  }
  return kept
}

/**
 * Room for the constraint refusals *and* the diagnosis. `MAX_FEEDBACK` bounds
 * the second half on its own; this bounds the whole list, which can carry one
 * refusal per disallowed gate.
 */
const MAX_VERDICT_CODES = 6

/**
 * The ceiling on a *wrong* register, above which the submission is refused
 * rather than answered.
 *
 * A submission on the wrong number of wires is an ordinary failed attempt and
 * gets a verdict, which costs nothing: the register check happens before
 * anything is allocated, so a 28-qubit circuit sent at a 2-qubit challenge is
 * as cheap to reject as a 3-qubit one. Twelve exists so that the *answer* is a
 * 413 rather than a verdict once the register stops being plausibly a mistake
 * — a caller sending twenty wires at a two-wire puzzle is not misreading the
 * prompt, and the honest reply is that the request is out of bounds.
 */
const MAX_WRONG_REGISTER_QUBITS = 12

/**
 * The circuit the engine will actually run, with §11's resource limit applied
 * to it.
 *
 * `safeExpandCircuit` answers `null` for a document past the contract's own
 * ceilings rather than throwing, and that `null` is counted as over the limit:
 * a definition graph that blows up during expansion is exactly the case this
 * bound exists for (§3.1, decision 4), and it must be a 413 rather than a
 * container with no memory left.
 */
function expand(circuit: Circuit): Circuit {
  const expanded = safeExpandCircuit(circuit)
  const operations =
    expanded === null
      ? MAX_EXPANDED_OPERATIONS + 1
      : expanded.circuit.operations.length
  if (expanded === null || operations > MAX_CHALLENGE_OPERATIONS) {
    throw new SubmissionTooLargeError(
      'too-many-operations',
      operations,
      MAX_CHALLENGE_OPERATIONS
    )
  }
  return expanded.circuit
}

/**
 * The operation that left this circuit without a single final state, named as
 * the reader would find it on the canvas.
 *
 * The engine's `MidCircuitMeasurementError` carries its explanation in the
 * message and nothing a caller can branch on, so the cause is looked up here
 * against the same expanded document the engine ran. `gate` is left absent
 * when nothing matched, which is the honest answer rather than a guess: the
 * sentence still says what is wrong, it just has no gate to point at.
 */
function collapsingOperation(circuit: Circuit): { gate?: string } {
  for (const operation of circuit.operations) {
    if (operation.gate === 'measure' || operation.gate === 'reset') {
      return { gate: operation.gate }
    }
    // A gate that reads a classical bit is the third cause, and the operation
    // to remove is the gate carrying the condition rather than a measurement.
    if (operation.condition !== undefined) return { gate: operation.gate }
  }
  return {}
}

/**
 * The rules of the puzzle, checked against the expanded circuit.
 *
 * Expanded, because a custom gate is a container: a submission that hid a
 * forbidden `cx` inside a block would otherwise present one operation named
 * `myBlock` while the engine ran the very gate the challenge excluded.
 * `gatesUsed` does the expansion and argues the case.
 */
function constraintViolations(
  circuit: Circuit,
  constraints: ChallengeConstraints,
  gateCount: number
): ChallengeFeedback[] {
  const found: ChallengeFeedback[] = []

  if (gateCount === 0) found.push(feedback('empty-circuit'))

  if (constraints.allowedGates.length > 0) {
    const allowed = new Set(constraints.allowedGates)
    for (const gate of gatesUsed(circuit)) {
      if (!allowed.has(gate)) found.push(feedback('gate-not-allowed', { gate }))
    }
  }

  if (constraints.maxGates !== null && gateCount > constraints.maxGates) {
    found.push(feedback('gate-budget-exceeded', { value: gateCount }))
  }

  return found
}

interface Reading {
  readonly fidelity: number
  readonly feedback: ChallengeFeedback[]
}

function compare(
  slug: string,
  constraints: ChallengeConstraints,
  target: ChallengeTarget,
  circuit: Circuit
): Reading {
  try {
    switch (target.type) {
      case 'state':
        return compareState(constraints, target, circuit)
      case 'unitary':
        return compareUnitary(constraints, target, circuit)
      case 'truth_table':
        return compareTruthTable(constraints, target, circuit)
    }
  } catch (error) {
    /*
     * A circuit that measures, or that gates on a classical bit, has no single
     * final state and is not an operation (§5.3) — so there is nothing to
     * compare, and this is a failed attempt rather than a server error. Named
     * as the gate that caused it, because that is what the reader has to
     * remove.
     */
    if (error instanceof MidCircuitMeasurementError) {
      /*
       * The code is `no-final-state` rather than `gate-not-allowed`, and the
       * gate is found rather than assumed. @qsim/core raises this for three
       * different documents — a `measure`, a `reset` of a qubit that is not
       * already deterministic, and any operation carrying a classical
       * `condition` — and only the first of them is a `measure`. Naming all
       * three "measure" sent a reader whose circuit has no measurement
       * anywhere to hunt for one that is not there.
       */
      return {
        fidelity: 0,
        feedback: [feedback('no-final-state', collapsingOperation(circuit))],
      }
    }
    if (error instanceof RangeError) {
      // A width mismatch this function was supposed to have made impossible.
      throw new ChallengeTargetError(slug, error.message)
    }
    throw error
  }
}

function compareState(
  constraints: ChallengeConstraints,
  target: StateTarget,
  circuit: Circuit
): Reading {
  const actual = analyticState(circuit)
  const wanted = stateFrom(target)
  const fidelity = clampFidelity(stateFidelity(actual, wanted))
  return {
    fidelity,
    feedback: diagnoseState({
      actual,
      target: wanted,
      fidelity,
      threshold: constraints.fidelityThreshold,
    }),
  }
}

function compareUnitary(
  constraints: ChallengeConstraints,
  target: UnitaryTarget,
  circuit: Circuit
): Reading {
  const actual = circuitUnitary(circuit)
  const wanted = unitaryFrom(target)
  const fidelity = clampFidelity(unitaryFidelity(actual, wanted))
  return {
    fidelity,
    feedback: diagnoseUnitary({
      actual,
      target: wanted,
      fidelity,
      threshold: constraints.fidelityThreshold,
    }),
  }
}

/**
 * One run per listed input, and the score is the worst of them.
 *
 * The whole matrix is not built: a table names the columns it cares about, and
 * `runFromState` produces one column for the cost of one simulation. A
 * three-row table on six qubits is three runs rather than sixty-four.
 */
function compareTruthTable(
  constraints: ChallengeConstraints,
  target: TruthTableTarget,
  circuit: Circuit
): Reading {
  let worst = 1
  let wrongRows = 0
  let superposedRows = 0

  for (const row of target.rows) {
    const { state } = runFromState(
      circuit,
      basisState(target.qubits, row.input)
    )
    const re = state.re[row.output] as number
    const im = state.im[row.output] as number
    const landed = re * re + im * im
    worst = Math.min(worst, landed)
    if (landed < constraints.fidelityThreshold) {
      wrongRows++
      // A row that lands on no basis state at all is a different mistake from
      // a row that lands on the wrong one: the circuit put a superposition
      // where the table wanted a definite answer.
      if (largestOutcome(state) < constraints.fidelityThreshold) {
        superposedRows++
      }
    }
  }

  const fidelity = clampFidelity(worst)
  const found: ChallengeFeedback[] = [
    // ALWAYS, and on success too: the scope of the check is part of the
    // verdict. See the header.
    feedback('basis-states-only', { value: target.rows.length }),
  ]
  if (fidelity >= constraints.fidelityThreshold) {
    found.unshift(feedback('solved', { value: fidelity }))
  } else {
    found.push(feedback('rows-wrong', { value: wrongRows }))
    if (superposedRows > 0) {
      found.push(feedback('row-not-a-basis-state', { value: superposedRows }))
    }
  }
  return { fidelity, feedback: found }
}

/** The largest single-outcome probability in a state. */
function largestOutcome(state: Statevector): number {
  let largest = 0
  for (let i = 0; i < state.size; i++) {
    const re = state.re[i] as number
    const im = state.im[i] as number
    largest = Math.max(largest, re * re + im * im)
  }
  return largest
}

/** The final state of a circuit that must not measure. */
function analyticState(circuit: Circuit): Statevector {
  // `alloc` is |0…0⟩ already, and it is the engine's own allocator rather than
  // a second one here — so the register bounds are checked in one place.
  return runFromState(circuit, alloc(circuit.qubits)).state
}

function basisState(qubits: number, index: number): Statevector {
  const state = alloc(qubits)
  state.re[0] = 0
  state.re[index] = 1
  return state
}

function stateFrom(target: StateTarget): Statevector {
  const state = alloc(target.qubits)
  state.re[0] = 0
  for (let i = 0; i < target.amplitudes.length; i++) {
    const entry = target.amplitudes[i] as [number, number]
    state.re[i] = entry[0]
    state.im[i] = entry[1]
  }
  return state
}

function unitaryFrom(target: UnitaryTarget): Unitary {
  const matrix = allocUnitary(target.qubits)
  for (let i = 0; i < target.entries.length; i++) {
    const entry = target.entries[i] as [number, number]
    matrix.re[i] = entry[0]
    matrix.im[i] = entry[1]
  }
  return matrix
}

/**
 * A fidelity is a probability, and Float64 does not respect that: a sum of a
 * million terms lands a few ulps outside [0, 1]. Clamped rather than trusted,
 * because the number is stored, compared against a threshold and displayed.
 */
function clampFidelity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
