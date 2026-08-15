/**
 * The four circuits the landing page walks through, and the three numbers
 * read off each one — work plan M0.9, specification §2.
 *
 * §2 gives the landing page one job and makes it the acceptance criterion:
 * *someone who has never seen a quantum circuit understands, in under a
 * minute, what superposition is and what entanglement is.* Everything in this
 * file is chosen against that sentence and nothing else.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY FOUR STAGES, AND WHY THESE FOUR.
 *
 * Superposition needs two pictures: a certainty, and the same register after
 * one gate. Entanglement needs *three*, and this is the part most
 * introductions skip. Two entangled qubits produce two outcomes — but so does
 * a single qubit in superposition, so a reader shown only the Bell pair has no
 * way to see what is remarkable about it. What makes it remarkable is the
 * comparison with two qubits that are each in superposition and independent:
 *
 *   stage 3   H on both wires        four outcomes, a quarter each
 *   stage 4   H on one, then CNOT    two outcomes, a half each
 *
 * The marginals are identical across those two — each qubit still reads 1 half
 * the time — and the joint distribution is not. That difference *is*
 * entanglement, and it is visible as two bars disappearing rather than as an
 * equation. `presets.ts` makes the same argument for why the examples strip
 * ships `superposition` and `bell` next to each other; stages 3 and 4 are
 * those two circuits, and `stages.test.ts` asserts they have not drifted apart.
 *
 * Stage 1 is the baseline that makes stage 2 legible: without a picture of
 * "one outcome, with certainty" first, the two bars of a superposition are
 * just a chart.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS COMES FROM `@qsim/core`, ON THE MAIN THREAD, AND THAT IS
 * DELIBERATE.
 *
 * Everywhere else in the app a simulation crosses into a Web Worker, because
 * everywhere else it is driven by an editor whose register the reader controls
 * and whose cost is therefore unbounded (§5.6). Here it is not: these four
 * circuits are constants, two qubits wide and two columns long, and a run is
 * four amplitudes of arithmetic. Spawning a worker for that would buy nothing
 * and cost the one thing this page cannot spend — the first paint would show
 * an empty chart and fill it a round trip later, on the page whose entire
 * purpose is that a stranger understands something within a minute of arriving.
 *
 * What does *not* change is that the engine is the only thing computing
 * physics. Nothing here reimplements a gate: `run` evolves the state, and the
 * readings below are questions asked of the engine's own answers.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE SCHEMA VERSION IS A LOCAL CONSTANT.
 *
 * `CIRCUIT_SCHEMA_VERSION` lives in `@qsim/schema` beside the Zod schemas, and
 * importing a *value* from that package pulls Zod into whichever chunk did the
 * importing. The landing page is the one route that must stay small (M0.9b:
 * it may not carry the editor's bundle), and it needs no validation — these
 * circuits are compiled-in constants, not untrusted input. So the version is
 * written out here and `stages.test.ts` compares it against the real one,
 * which is the same trade `lib/circuit-url.ts` makes with `PACKED_CIRCUIT_KEYS`:
 * the coupling stays, and it fails in a test rather than in a bundle.
 */

import {
  bitOf,
  marginalProbability,
  probabilities,
  run,
  type Statevector,
} from '@qsim/core'
import type { Circuit } from '@qsim/schema'

import { occupiedStates } from '../analysis/histogram'

/** Mirrors `CIRCUIT_SCHEMA_VERSION`; pinned by `stages.test.ts`. See header. */
const SCHEMA_VERSION = 1

/** Every stage uses the same two wires, which is what makes them comparable. */
export const DEMO_QUBITS = 2

/**
 * Columns the diagram reserves. Two, because the longest stage is two columns
 * long and a diagram padded out to the editor's eight would be mostly empty
 * wire — on a page where the picture has to read at a glance.
 */
export const DEMO_COLUMNS = 2

/**
 * `q0`, `q1` — the names the demo's wires wear, in the diagram and in the
 * readings beside it.
 *
 * The same names `defaultQubitLabel` produces in the document store, written
 * out here because importing that module would pull Zustand, Zundo and the
 * whole undo history into the landing chunk (see the header rule this file
 * lives under). `DemoDiagram.test.tsx` pins the two against each other.
 */
export function wireLabel(qubit: number): string {
  return `q${String(qubit)}`
}

/** Stage keys. They name catalog entries, so they are stable. */
export const DEMO_STAGE_IDS = [
  'zero',
  'superposed',
  'independent',
  'entangled',
] as const

export type DemoStageId = (typeof DEMO_STAGE_IDS)[number]

export interface DemoStage {
  readonly id: DemoStageId
  readonly circuit: Circuit
}

/** Two wires, nothing done to them: |00⟩ with certainty. */
const zero: Circuit = {
  schemaVersion: SCHEMA_VERSION,
  qubits: DEMO_QUBITS,
  clbits: 0,
  operations: [],
}

/** One Hadamard on q0: |00⟩ and |01⟩, half each. */
const superposed: Circuit = {
  schemaVersion: SCHEMA_VERSION,
  qubits: DEMO_QUBITS,
  clbits: 0,
  operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
}

/** A Hadamard on each wire: four outcomes, a quarter each. Two coins. */
const independent: Circuit = {
  schemaVersion: SCHEMA_VERSION,
  qubits: DEMO_QUBITS,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'h', targets: [1], column: 0 },
  ],
}

/** The Bell pair: the same marginals as `independent`, half the outcomes. */
const entangled: Circuit = {
  schemaVersion: SCHEMA_VERSION,
  qubits: DEMO_QUBITS,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** In the order the demo walks them. See the header for why this order. */
export const DEMO_STAGES: readonly DemoStage[] = [
  { id: 'zero', circuit: zero },
  { id: 'superposed', circuit: superposed },
  { id: 'independent', circuit: independent },
  { id: 'entangled', circuit: entangled },
]

/**
 * The stage at `index`, clamped into the sequence.
 *
 * A function rather than an index expression at the call site because
 * `noUncheckedIndexedAccess` types every array read as possibly absent, and
 * the honest way to discharge that once is here — where the bound and the
 * array are both in view — instead of with a non-null assertion in a component.
 */
export function stageAt(index: number): DemoStage {
  const clamped = Math.min(DEMO_STAGES.length - 1, Math.max(0, index))
  const stage = DEMO_STAGES[clamped]
  if (stage === undefined) {
    throw new RangeError(`No demo stage at index ${String(index)}.`)
  }
  return stage
}

/**
 * What the reader is asked to compare between stages 3 and 4.
 *
 * Three numbers, and the pair of them that matters is `marginals` against
 * `agreement`: the first two are what each qubit does on its own, the third is
 * what the two do together. Entanglement is the case where the first two do
 * not move and the third does.
 */
export interface StageReading {
  /** P(qubit reads 1), one per wire, from the engine's `marginalProbability`. */
  readonly marginals: readonly number[]
  /** P(both wires read the same). ½ for two coins, 1 for a Bell pair. */
  readonly agreement: number
  /** Outcomes with any probability — the number of bars the chart draws. */
  readonly outcomes: number
}

/**
 * The final state of a stage.
 *
 * `run` defaults to analytic mode, and no stage measures, so the trajectories
 * branch cannot be reached. It is narrowed rather than asserted away so that a
 * stage which *did* measure would fail loudly here instead of quietly rendering
 * a chart of a state that does not exist (§5.3).
 */
export function stageState(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') {
    throw new Error('A demo stage may not measure: it has no final state.')
  }
  return result.state
}

/**
 * The three readings, all of them questions put to the engine's answers rather
 * than physics recomputed here.
 *
 * `agreement` is a sum over the engine's own probabilities, and it uses
 * `bitOf` rather than a local shift so that decision D1 — qubit 0 is the least
 * significant bit — is read from the one module that defines it. The bound is
 * the state's own size, so a wider stage would still be summed correctly.
 */
/** A stage's final state and the three numbers read off it. */
export interface StageAnalysis {
  readonly state: Statevector
  readonly reading: StageReading
}

/**
 * Everything a stage's panel needs, computed once per stage for the life of
 * the tab.
 *
 * A module-level cache rather than a `useMemo`, because these four circuits are
 * compile-time constants: the answer cannot change, and the reduced-motion
 * layout draws all four panels at once rather than one at a time, so a hook
 * keyed on the current stage would recompute three of them on every render.
 * Four two-qubit states is sixty-four bytes of amplitudes held for the session.
 */
const analyses = new Map<DemoStageId, StageAnalysis>()

export function stageAnalysis(stage: DemoStage): StageAnalysis {
  const cached = analyses.get(stage.id)
  if (cached !== undefined) return cached
  const state = stageState(stage.circuit)
  const analysis: StageAnalysis = { state, reading: readStage(state) }
  analyses.set(stage.id, analysis)
  return analysis
}

export function readStage(state: Statevector): StageReading {
  const distribution = probabilities(state)

  let agreement = 0
  for (let index = 0; index < distribution.length; index++) {
    if (bitOf(index, 0) === bitOf(index, 1)) {
      agreement += distribution[index] ?? 0
    }
  }

  const marginals: number[] = []
  for (let qubit = 0; qubit < DEMO_QUBITS; qubit++) {
    marginals.push(marginalProbability(state, qubit))
  }

  return {
    marginals,
    agreement,
    // The chart's own count, borrowed rather than recounted: the sentence
    // "four outcomes" sits beside a chart drawing them, and two independent
    // counts of one distribution are two things that can disagree.
    outcomes: occupiedStates(state),
  }
}
