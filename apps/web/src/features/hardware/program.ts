/**
 * The circuit somebody drew, beside the program the device ran.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A FOOTNOTE, IT IS THE EXPLANATION
 *
 * §3.7's third column shows a distribution that has moved, and the obvious
 * reading — "hardware is noisy" — is true and explains nothing. What explains
 * it is that a Heron processor has **no H and no CNOT**. Its gate set is
 * `{cz, id, rx, rz, rzz, sx, x}`, so the two gates of a Bell pair become
 * something like four `rz`, two `sx` and a `cz`: seven operations where the
 * reader drew two, each one an opportunity for the state to decay.
 *
 * A panel that showed the moved bars without showing that is a panel that
 * teaches "hardware is bad". A panel that shows both counts, and the gates each
 * side is made of, teaches where the error came from — which is the lesson
 * §3.7 calls the most valuable one in quantum computing today.
 *
 * ════════════════════════════════════════════════════════════════════════
 * BOTH SIDES ARE COUNTED THE SAME WAY, WHICH TAKES SAYING
 *
 * The drawn side is counted by `gateCount` over the **expanded** circuit, so a
 * subcircuit counts as its body rather than as one gate — otherwise packaging
 * two gates in a block would report "you drew 1, the device ran 7" and blame
 * the transpiler for the packaging. `@qsim/schema`'s own comment makes the same
 * argument about the leaderboard.
 *
 * The executed side is counted by `tallyQasm3` over the **stored** program,
 * which is the only honest source: the program that ran was placed against a
 * calibration that no longer exists, and re-transpiling now would produce a
 * different circuit from the one the samples came out of. That module's header
 * argues it, and `packages/transpile/src/tally.test.ts` is where the two
 * counting rules are made to agree against a real transpiler run.
 *
 * Both exclude measurement, reset and barrier, and both report them separately.
 * A difference that was partly an accounting change would be read as the
 * transpiler's doing, which is the one thing this figure must never invite.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY THE EXECUTED GATES ARE ALSO GROUPED BY WHAT THEY COST
 *
 * Because "eleven gates" is not eleven equal things. On this hardware:
 *
 *   `rz`            a **frame change**. The control electronics relabel the
 *                   rotating frame; no pulse is played, so it takes no time and
 *                   contributes no error. Half of a decomposed circuit is
 *                   usually these, and counting them as "gates the device ran"
 *                   without saying so overstates the damage.
 *   `sx`, `x`, `rx` **pulses**. Real microwave drive, real duration, real
 *                   error — a few parts in ten thousand each.
 *   `cz`, `rzz`     **entangling**. One to two orders of magnitude worse than a
 *                   pulse, and on almost every circuit this is where the
 *                   fidelity actually goes.
 *   `id`            a delay. It occupies time without doing anything, which is
 *                   error of the decoherence kind rather than of the gate kind,
 *                   so it is neither a pulse nor free.
 *
 * The names are IBM's basis set, measured from the account this milestone was
 * built against. A gate this list does not know is grouped as `other` rather
 * than guessed at: the panel prints the group beside the count, and a wrong
 * group would be a claim about a device's error budget that nothing supports.
 */

import { tallyQasm3, type QasmTally } from '@qsim/qasm'
import { gateCount, safeExpandCircuit, type Circuit } from '@qsim/schema'

/** One gate name and how often a side of the comparison contains it. */
export interface GateTally {
  readonly name: string
  readonly count: number
}

/** What a program costs, in the four groups the header argues for. */
export const GATE_COSTS = ['frame', 'pulse', 'entangling', 'other'] as const

export type GateCost = (typeof GATE_COSTS)[number]

/** IBM's Heron basis set, by what each member costs. See the header. */
const COST_OF: Readonly<Record<string, GateCost>> = {
  rz: 'frame',
  sx: 'pulse',
  x: 'pulse',
  rx: 'pulse',
  cz: 'entangling',
  rzz: 'entangling',
  id: 'other',
}

export function costOfGate(name: string): GateCost {
  return COST_OF[name] ?? 'other'
}

/** One side of the comparison — a drawn document or a submitted program. */
export interface ProgramSide {
  /** Wires it occupies: the document's register, or the physical qubits used. */
  readonly qubits: number
  /** Gates, on the shared accounting: no measurements, resets or barriers. */
  readonly gates: number
  readonly measurements: number
  /** Every gate name with its count, most frequent first, ties broken by name. */
  readonly tally: readonly GateTally[]
}

export interface ProgramComparison {
  readonly drawn: ProgramSide
  readonly executed: ProgramSide
  /** `executed.gates − drawn.gates`. The number the heading is about. */
  readonly extra: number
  /**
   * How many device gates one drawn gate became, or null when nothing was
   * drawn. Null rather than Infinity: a circuit of pure measurement has no
   * expansion factor, and printing one would be printing a division by zero.
   */
  readonly factor: number | null
  /** The executed gates grouped by what they cost. Sums to `executed.gates`. */
  readonly cost: Readonly<Record<GateCost, number>>
  /**
   * Whether the stored program turned out not to be flat.
   *
   * Always false for a program this system submitted — the transpiler expands
   * every custom gate before it decomposes anything — so a true here means the
   * stored program is not what this system thinks it is, and the tally is
   * counting calls to definitions rather than the gates behind them. Surfaced
   * rather than swallowed, because every number above would be understated.
   */
  readonly hasDefinitions: boolean
}

/**
 * Compare the document against the program.
 *
 * `layout` is logical → physical, stored beside the program, and its length is
 * how many device qubits the job occupied. Taken from the record rather than
 * counted out of the QASM: the program names its qubits as `$53`, and counting
 * distinct operands would answer "how many qubits appear in a statement",
 * which is a smaller number on any circuit with an idle wire.
 */
export function compareProgram(
  circuit: Circuit,
  qasm: string,
  layout: readonly number[]
): ProgramComparison {
  const tally = tallyQasm3(qasm)
  const drawn = drawnSide(circuit)
  const executed: ProgramSide = {
    qubits: layout.length,
    gates: tally.gateCalls,
    measurements: tally.measurements,
    tally: tally.gates.map((gate) => ({ name: gate.name, count: gate.count })),
  }

  return {
    drawn,
    executed,
    extra: executed.gates - drawn.gates,
    factor: drawn.gates === 0 ? null : executed.gates / drawn.gates,
    cost: costsOf(tally),
    hasDefinitions: tally.definitions > 0,
  }
}

/* ──────────────────────────────── internals ─────────────────────────── */

/**
 * The document's own side.
 *
 * Read from the expanded circuit — the same reading `gateCount` takes, and the
 * same fallback for one too large to expand, because a panel that cannot draw a
 * number must not be a crash.
 */
function drawnSide(circuit: Circuit): ProgramSide {
  const flat = safeExpandCircuit(circuit)?.circuit ?? circuit
  const counts = new Map<string, number>()
  let measurements = 0

  for (const operation of flat.operations) {
    if (operation.gate === 'measure') {
      measurements += 1
      continue
    }
    if (operation.gate === 'reset' || operation.gate === 'barrier') continue
    counts.set(operation.gate, (counts.get(operation.gate) ?? 0) + 1)
  }

  return {
    qubits: circuit.qubits,
    // `gateCount` rather than the sum of the tally, so the headline number is
    // the same function every other count in the product goes through.
    gates: gateCount(circuit),
    measurements,
    tally: [...counts]
      .map(([name, count]): GateTally => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  }
}

function costsOf(tally: QasmTally): Readonly<Record<GateCost, number>> {
  const cost: Record<GateCost, number> = {
    frame: 0,
    pulse: 0,
    entangling: 0,
    other: 0,
  }
  for (const gate of tally.gates) cost[costOfGate(gate.name)] += gate.count
  return cost
}
