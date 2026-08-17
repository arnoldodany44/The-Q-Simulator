/**
 * The equivalence proof: WASM must agree with TypeScript, or WASM does not run.
 *
 * `packages/qsim/src/apply.ts` is the definition of what this engine computes.
 * It has an adversarial suite behind it, it runs everywhere, and it is what
 * the server validates challenge submissions with. The accelerator is an
 * optimisation of that definition and has no standing to differ from it — so
 * before a kernel is installed it is made to reproduce the reference, gate for
 * gate, over the whole catalogue, and if it cannot it is not installed.
 *
 * WHY THIS RUNS AT STARTUP AND NOT ONLY IN CI. The artifact is built on one
 * machine and executed on thousands, by engines that are not the one it was
 * tested on. A green CI run says the kernel is correct where it was compiled;
 * this says it is correct where it is about to be used, for about a
 * millisecond of eight-qubit arithmetic. Given the alternative is a silently
 * wrong amplitude on somebody's laptop, that is cheap.
 *
 * THE TOLERANCE IS 1e-12, BUT THE EXPECTED ANSWER IS ZERO. Both sides do the
 * same operations in the same association: the Rust in `kernel.rs` is a
 * transliteration of the TypeScript, Rust performs no floating-point
 * contraction or reassociation without being asked, and IEEE-754 `f64` is
 * `f64` on both sides. So the states should be **bit-identical**, and
 * `worstDeviation` should read exactly 0. The 1e-12 is the contract the work
 * plan states (two orders tighter than D6's 1e-10); a report that passes at
 * 1e-13 rather than at 0 means something reassociated, and that is worth
 * looking into even though it passed.
 *
 * WHAT IS COMPARED. Every path the runner can dispatch a unitary through:
 * the ten fixed one-qubit gates, the five parametrised ones, positive and
 * negative controls, two controls (`ccx`), SWAP, controlled SWAP and iSWAP.
 * Comparison is after *each* gate rather than at the end of a circuit, so a
 * defect is reported against the operation that caused it instead of against
 * the last one.
 */

import {
  GATE_MATRICES,
  alloc,
  applyControlled,
  applyISwap,
  applySwap,
  createRng,
  matrixFor,
  probabilities,
  reducedDensity,
  type ControlSpec,
  type FixedGateId,
  type Matrix2,
  type Rng,
  type Statevector,
  type StatevectorKernel,
} from '@qsim/core'

import { createExtras } from './kernel.js'
import type { KernelSession } from './session.js'

/**
 * The work plan's budget for two routes to the same state. Deliberately
 * tighter than D6's 1e-10 — see the header on why the honest expectation is
 * exact equality.
 */
export const EQUIVALENCE_TOLERANCE = 1e-12

const FIXED: readonly FixedGateId[] = [
  'i',
  'x',
  'y',
  'z',
  'h',
  's',
  'sdg',
  't',
  'tdg',
  'sx',
]

/** One gate, described well enough to reproduce a failure by hand. */
export interface EquivalenceCase {
  readonly index: number
  readonly description: string
  readonly deviation: number
}

export interface EquivalenceReport {
  readonly agreed: boolean
  /** Largest absolute difference over every real and imaginary part. */
  readonly worstDeviation: number
  /** How many gates were compared. */
  readonly gates: number
  readonly qubits: number
  readonly seed: number
  /** The first gate that exceeded the tolerance, if any. */
  readonly failure: EquivalenceCase | undefined
  /**
   * Gates the kernel declined. Not a failure — a kernel is entitled to
   * decline — but a report where *every* gate was declined proves nothing,
   * and `agreed` is false in that case for exactly that reason.
   */
  readonly declined: number
}

export interface EquivalenceOptions {
  /** Small on purpose: 8 qubits is 256 amplitudes and runs in about a ms. */
  readonly qubits?: number
  readonly gates?: number
  readonly seed?: number
  readonly tolerance?: number
}

/**
 * The distance between two doubles, for the purpose of deciding agreement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE NaN HOLE, WHICH WAS THE ONE FAILURE THIS GATE EXISTS TO CATCH
 *
 * `Math.abs(x - y)` is NaN when either side is, and **every comparison against
 * NaN is false** — so `deviation > worst` and `deviation > tolerance` were both
 * false and a candidate state full of NaN scored `worstDeviation: 0,
 * agreed: true`. `loadKernel` then installed it. Infinity was caught (Inf minus
 * a finite number is Inf); only NaN escaped, which is precisely the class
 * produced by a detached view, by uninitialised linear memory and by undefined
 * behaviour in a miscompiled artifact — the three failures `session.ts` and
 * `lib.rs` name as the ones they cannot tolerate.
 *
 * `Object.is` first, so two states that are bit-identical — including at a
 * position where the *reference itself* is NaN, which means the input was —
 * agree at zero. After that, a difference that is NaN means exactly one side is
 * NaN (or one side is `undefined`, which is what indexing a detached
 * `Float64Array` returns), and that is an infinite deviation rather than none.
 */
function difference(x: number, y: number): number {
  if (Object.is(x, y)) return 0
  const delta = Math.abs(x - y)
  return Number.isNaN(delta) ? Number.POSITIVE_INFINITY : delta
}

/** Largest difference between two states, over every component. */
export function maxDeviation(a: Statevector, b: Statevector): number {
  let worst = 0
  for (let i = 0; i < a.size; i++) {
    const dre = difference(a.re[i], b.re[i])
    const dim = difference(a.im[i], b.im[i])
    if (dre > worst) worst = dre
    if (dim > worst) worst = dim
  }
  return worst
}

/**
 * Fill two states with the same random, normalised amplitudes.
 *
 * A random start rather than |0…0⟩ because the ground state hides almost
 * everything: with one non-zero amplitude, a gate that reads the wrong
 * partner index still produces a plausible state, and a control mask with the
 * wrong endianness is satisfied by an all-zero index whatever it examines. A
 * dense state makes every index carry a distinguishable value.
 *
 * Both states receive the *identical* doubles, so any later difference is the
 * kernels' doing and not the generator's.
 */
function seedStates(a: Statevector, b: Statevector, rng: Rng): void {
  let sum = 0
  for (let i = 0; i < a.size; i++) {
    const re = rng.next() * 2 - 1
    const im = rng.next() * 2 - 1
    a.re[i] = re
    a.im[i] = im
    sum += re * re + im * im
  }
  const scale = 1 / Math.sqrt(sum)
  for (let i = 0; i < a.size; i++) {
    a.re[i] *= scale
    a.im[i] *= scale
    b.re[i] = a.re[i]
    b.im[i] = a.im[i]
  }
}

/**
 * `count` distinct qubits drawn without replacement.
 *
 * The caller must have checked that `count <= qubits`; drawing more than the
 * register holds would repeat one, and a repeated qubit is a shape the engine
 * rejects with a `RangeError` rather than a shape worth comparing.
 */
function distinct(rng: Rng, qubits: number, count: number): number[] {
  const pool: number[] = []
  for (let q = 0; q < qubits; q++) pool.push(q)
  const chosen: number[] = []
  for (let i = 0; i < count; i++) {
    chosen.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0])
  }
  return chosen
}

/**
 * One gate, in both dialects.
 *
 * The two are kept separate rather than fused into a single `run()` for a
 * reason that took a failing test to notice: when the kernel *declines*, the
 * reference has already advanced, and comparing the two states then reports a
 * disagreement that is nothing of the sort. A decline means "TypeScript does
 * this one" — so the candidate gets the reference applied to it as well, both
 * states stay in step, and the run carries on comparing the gates the kernel
 * did handle. Scoring a decline as a defect would have made every partial
 * kernel unshippable and, worse, made the failure look like bad arithmetic.
 */
interface Move {
  readonly description: string
  /** The `apply.ts` path. Applied to the reference always, and to the
   * candidate whenever the kernel declines. */
  readonly reference: (state: Statevector) => void
  /** The kernel path. Returns whether it handled the gate. */
  readonly accelerated: (state: Statevector) => boolean
}

/**
 * Draw one gate spanning the dispatch paths of the runner.
 *
 * The weights are not uniform over gate names, they are uniform over *code
 * paths*: the controlled walk, the uncontrolled walk, the two permutations
 * and the multi-control mask each get a share, because that is what can
 * differ between the two implementations. Which particular 2×2 is being
 * applied matters far less than whether its indices were paired correctly.
 */
function drawMove(rng: Rng, qubits: number, kernel: StatevectorKernel): Move {
  const angle = (): number => (rng.next() - 0.5) * 6

  const controlled = (
    matrix: Matrix2,
    label: string,
    controls: readonly ControlSpec[],
    target: number
  ): Move => ({
    description: `${label} target=${target} controls=${JSON.stringify(controls)}`,
    reference: (state) => applyControlled(state, matrix, target, controls),
    accelerated: (state) =>
      kernel.applyControlled(state, matrix, target, controls),
  })

  // A shape needing more qubits than the register has is not a hard case, it
  // is an invalid one — the engine rejects it with a RangeError. So the pool
  // of shapes is bounded by the register, and a 1-qubit run exercises the
  // one-qubit paths rather than throwing.
  const shapes = qubits >= 3 ? 8 : qubits === 2 ? 6 : 4
  const roll = Math.floor(rng.next() * shapes)

  switch (roll) {
    case 0:
    case 1: {
      // An uncontrolled one-qubit gate — the most common shape in any circuit.
      const [target] = distinct(rng, qubits, 1)
      const gate = FIXED[Math.floor(rng.next() * FIXED.length)]
      return controlled(GATE_MATRICES[gate], gate, [], target)
    }
    case 2: {
      // A parametrised gate: its matrix is built per call, so this also checks
      // that the staging buffer is rewritten and not read back stale.
      const [target] = distinct(rng, qubits, 1)
      const which = ['rx', 'ry', 'rz', 'p'] as const
      const gate = which[Math.floor(rng.next() * which.length)]
      return controlled(matrixFor(gate, [angle()]), gate, [], target)
    }
    case 3: {
      // `u` — three parameters and a fully complex matrix, so every one of the
      // eight staged doubles is non-zero and a mis-ordered stage shows up.
      const [target] = distinct(rng, qubits, 1)
      return controlled(
        matrixFor('u', [angle(), angle(), angle()]),
        'u',
        [],
        target
      )
    }
    case 4: {
      // One control, negative two times in five. A negative control is the
      // case where `mask` and `value` differ, which is where an endianness or
      // a fold mistake stops cancelling itself out.
      //
      // Half the time the 2×2 is COMPLEX, and that is not decoration. The
      // controlled walk and the uncontrolled walk are separate loops in
      // `kernel.rs` (and would be separately vectorised in the SIMD build), so
      // a matrix whose imaginary entries are non-zero has to go through both.
      // Only `x` and `z` were ever staged under a mask, which left `crz`, `cp`
      // and `cu` — shapes `apply.ts`'s COVERAGE table lists and the runner
      // dispatches — compared against nothing at all.
      const [target, control] = distinct(rng, qubits, 2)
      const controls: ControlSpec[] = [
        { qubit: control, state: rng.next() < 0.4 ? 0 : 1 },
      ]
      if (rng.next() < 0.5) {
        const which = ['rz', 'ry', 'p'] as const
        const gate = which[Math.floor(rng.next() * which.length)]
        return controlled(
          matrixFor(gate, [angle()]),
          `c${gate}`,
          controls,
          target
        )
      }
      return controlled(GATE_MATRICES.x, 'cx', controls, target)
    }
    case 5: {
      const [q0, q1] = distinct(rng, qubits, 2)
      return {
        description: `iswap ${q0}<->${q1}`,
        reference: (state) => applyISwap(state, q0, q1),
        accelerated: (state) => kernel.applyISwap(state, q0, q1),
      }
    }
    case 6: {
      // Two controls — `ccz`, or a fully complex `ccu`. A mask with two bits
      // set is the shape that a single-bit-shift mistake survives, and the `u`
      // variant is the one where all eight staged doubles are non-zero under a
      // multi-bit mask.
      const [target, c0, c1] = distinct(rng, qubits, 3)
      const controls: ControlSpec[] = [
        { qubit: c0, state: rng.next() < 0.3 ? 0 : 1 },
        { qubit: c1, state: rng.next() < 0.3 ? 0 : 1 },
      ]
      if (rng.next() < 0.5) {
        return controlled(
          matrixFor('u', [angle(), angle(), angle()]),
          'ccu',
          controls,
          target
        )
      }
      return controlled(GATE_MATRICES.z, 'ccz', controls, target)
    }
    default: {
      // SWAP, half the time controlled (`cswap`).
      const [q0, q1, control] = distinct(rng, qubits, 3)
      const controls: ControlSpec[] =
        rng.next() < 0.5 ? [{ qubit: control, state: 1 }] : []
      return {
        description: `swap ${q0}<->${q1} controls=${JSON.stringify(controls)}`,
        reference: (state) => applySwap(state, q0, q1, controls),
        accelerated: (state) => kernel.applySwap(state, q0, q1, controls),
      }
    }
  }
}

/**
 * Run the proof. The candidate state must be one the kernel owns, or every
 * gate is declined and the report says so rather than passing vacuously.
 *
 * Deterministic: the same `seed` replays the same gates in the same order, so
 * a failing report is a reproduction recipe and not a rumour.
 */
export function verifyEquivalence(
  session: KernelSession,
  kernel: StatevectorKernel,
  options: EquivalenceOptions = {}
): EquivalenceReport {
  const qubits = options.qubits ?? 8
  const gates = options.gates ?? 400
  const seed = options.seed ?? 0x5eed
  const tolerance = options.tolerance ?? EQUIVALENCE_TOLERANCE

  const handle = session.allocState(qubits)
  if (handle === undefined) {
    return {
      agreed: false,
      worstDeviation: Number.POSITIVE_INFINITY,
      gates: 0,
      qubits,
      seed,
      declined: 0,
      failure: {
        index: -1,
        description: 'the kernel could not allocate a statevector',
        deviation: Number.POSITIVE_INFINITY,
      },
    }
  }

  try {
    const rng = createRng(seed)
    const reference = alloc(qubits)
    seedStates(reference, handle.statevector, rng)

    let worstDeviation = 0
    let declined = 0
    let failure: EquivalenceCase | undefined

    for (let index = 0; index < gates; index++) {
      const move = drawMove(rng, qubits, kernel)
      move.reference(reference)

      // Re-read through the getter each time: an allocation elsewhere in the
      // process could have grown linear memory and detached the last views.
      const handled = move.accelerated(handle.statevector)
      if (!handled) {
        // Declining is legitimate, and it means TypeScript does this gate.
        // Applying the reference to the candidate is what "the engine falls
        // back" actually is — without it the two would drift apart for a
        // reason that has nothing to do with correctness.
        declined++
        move.reference(handle.statevector)
      }

      const deviation = maxDeviation(reference, handle.statevector)
      if (deviation > worstDeviation) worstDeviation = deviation
      if (deviation > tolerance && failure === undefined) {
        failure = { index, description: move.description, deviation }
        break
      }
    }

    /*
     * THE EXTRAS ARE PART OF THE PROOF, NOT A SEPARATE CONCERN.
     *
     * `loadKernel` hands `createExtras(session)` to the caller the moment this
     * report is accepted, and the report used to exercise only the three gate
     * entry points — so a crate whose `reduced_density` had one sign wrong
     * passed with `worstDeviation: 0` and then mirrored §5.5's Bloch y on every
     * entangled qubit. Anything the loader returns for a caller to compute with
     * belongs inside the thing that says the loader may return it.
     *
     * Run after the gate loop rather than before, so the state under test is a
     * dense evolved one rather than |0…0⟩ — the ground state hides a sign the
     * same way it hides a mis-paired index.
     */
    if (failure === undefined) {
      const extrasFailure = verifyExtras(
        session,
        reference,
        handle.statevector,
        gates,
        tolerance
      )
      if (extrasFailure !== undefined) {
        failure = extrasFailure
        if (extrasFailure.deviation > worstDeviation) {
          worstDeviation = extrasFailure.deviation
        }
      }
    }

    // A kernel that declined everything has demonstrated nothing. Reporting
    // that as agreement would install an untested accelerator, which is the
    // exact outcome this function exists to prevent.
    const proved = declined < gates
    return {
      agreed: failure === undefined && proved,
      worstDeviation,
      gates,
      qubits,
      seed,
      declined,
      failure:
        failure ??
        (proved
          ? undefined
          : {
              index: -1,
              description:
                'the kernel declined every gate, so nothing was compared',
              deviation: 0,
            }),
    }
  } finally {
    handle.release()
  }
}

/**
 * The four accelerated operations that are not gates, against their definitions
 * in `@qsim/core`.
 *
 * `normSquared` and `scale` against `metrics.ts`'s arithmetic, `probabilities`
 * against `measure.ts`'s and `reducedDensity` against `metrics.ts`'s — the same
 * functions the analysis panel calls, which is the whole point: a kernel that
 * disagrees with them draws a different Bloch sphere.
 *
 * A *declined* extra is not a failure, for the same reason a declined gate is
 * not: a kernel is entitled to say "not mine". What is a failure is answering,
 * and answering differently.
 */
function verifyExtras(
  session: KernelSession,
  reference: Statevector,
  candidate: Statevector,
  index: number,
  tolerance: number
): EquivalenceCase | undefined {
  const extras = createExtras(session)
  const fail = (description: string, deviation: number): EquivalenceCase => ({
    index,
    description,
    deviation,
  })

  const norm = extras.normSquared(candidate)
  if (norm !== undefined) {
    let expected = 0
    for (let i = 0; i < reference.size; i++) {
      const re = reference.re[i]
      const im = reference.im[i]
      expected += re * re + im * im
    }
    const deviation = difference(norm, expected)
    if (deviation > tolerance) {
      return fail(`extras.normSquared ${norm} against ${expected}`, deviation)
    }
  }

  /*
   * `probabilities` needs an output region inside linear memory. It has one:
   * `session.allocBuffer`. Until that existed the only way to call this was to
   * allocate a second whole statevector and borrow half of it, which is why
   * this check could not have been written before.
   */
  const out = session.allocBuffer(candidate.size)
  if (out !== undefined) {
    try {
      if (extras.probabilities(candidate, out.doubles)) {
        const expected = probabilities(reference)
        let worst = 0
        const got = out.doubles
        for (let i = 0; i < expected.length; i++) {
          const deviation = difference(got[i], expected[i])
          if (deviation > worst) worst = deviation
        }
        if (worst > tolerance) {
          return fail('extras.probabilities against measure.ts', worst)
        }
      }
    } finally {
      out.release()
    }
  }

  for (let qubit = 0; qubit < reference.qubits; qubit++) {
    const accelerated = extras.reducedDensity(candidate, qubit)
    if (accelerated === undefined) continue
    const expected = reducedDensity(reference, qubit)
    const entries: readonly [number, number, string][] = [
      [accelerated[0], expected.rho00, 'rho00'],
      [accelerated[1], expected.rho11, 'rho11'],
      [accelerated[2], expected.re01, 're01'],
      /*
       * The one §5.5 turns into y = -2·Im ρ₀₁. A single flipped sign here
       * mirrors every entangled qubit's sphere through the x–z plane, which is
       * a picture that looks entirely plausible.
       */
      [accelerated[3], expected.im01, 'im01'],
    ]
    for (const [got, want, name] of entries) {
      const deviation = difference(got, want)
      if (deviation > tolerance) {
        return fail(
          `extras.reducedDensity(${String(qubit)}).${name} ` +
            `${String(got)} against ${String(want)}`,
          deviation
        )
      }
    }
  }

  /*
   * `scale` last, because it is the only one that writes: everything above
   * reads the state the gate loop left, and this changes it. The candidate is
   * released by the caller immediately afterwards, so the mutation escapes
   * nowhere.
   */
  const factor = 0.5
  if (extras.scale(candidate, factor)) {
    let worst = 0
    for (let i = 0; i < reference.size; i++) {
      const dre = difference(candidate.re[i], reference.re[i] * factor)
      const dim = difference(candidate.im[i], reference.im[i] * factor)
      if (dre > worst) worst = dre
      if (dim > worst) worst = dim
    }
    if (worst > tolerance) {
      return fail(
        'extras.scale against the reference scaled in TypeScript',
        worst
      )
    }
  }

  return undefined
}

/** A one-line summary for a log or an error message. */
export function describeReport(report: EquivalenceReport): string {
  if (report.agreed) {
    return (
      `kernel agrees with the TypeScript reference over ${report.gates} ` +
      `gates on ${report.qubits} qubits (worst deviation ` +
      `${report.worstDeviation.toExponential(2)}, seed ${report.seed})`
    )
  }
  const failure = report.failure
  return (
    `kernel DISAGREES with the TypeScript reference: ` +
    `${failure?.description ?? 'unknown'} at gate ${failure?.index ?? -1} ` +
    `deviated by ${(failure?.deviation ?? 0).toExponential(2)} ` +
    `(seed ${report.seed}, replay with that seed to reproduce)`
  )
}
