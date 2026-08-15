/**
 * The six example circuits of M0.9 — Bell, GHZ, superposition, interference,
 * Deutsch–Jozsa, teleportation.
 *
 * A preset is the shortest path from "I opened this page" to "I have seen
 * entanglement", which is the job §2 gives the landing page. So the bar these
 * have to clear is not that they load: it is that each one really produces the
 * state its name claims. `presets.test.ts` runs every circuit here through
 * `@qsim/core` and asserts the physics — a preset called Bell that does not
 * produce a Bell pair teaches the wrong thing to exactly the reader who cannot
 * tell.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THESE SIX, IN THIS ORDER.
 *
 * They are a sequence, not a menu. Superposition and Bell share a register of
 * two wires on purpose: the first draws four bars, the second draws two, and
 * the difference between those two pictures *is* entanglement — no prose
 * required. GHZ then says the same thing survives a third qubit. Interference
 * introduces the phase as the thing that decides whether two paths add or
 * cancel, which is the one idea a probability histogram alone cannot show.
 * Deutsch–Jozsa is the first circuit that computes something, and
 * teleportation is the first that needs the classical register.
 *
 * ────────────────────────────────────────────────────────────────────────
 * NAMES, AND WHY ONLY HALF OF THEM ARE TRANSLATED (D2).
 *
 * "Bell", "GHZ" and "Deutsch–Jozsa" are proper nouns — people's names — and
 * D2 lists them among the things that stay identical in all three languages,
 * beside the gate symbols. They travel as `properName` and are rendered
 * through `Notation`, which also marks them `translate="no"` so Chrome's page
 * translator leaves them alone. "Superposition", "interference" and
 * "teleportation" are ordinary words that every language has its own form of
 * (_intrication_, _interférence_, _téléportation_), so those live in the
 * catalogs like any other string. The asymmetry in `editor.json` — three
 * entries with a `name`, six with a `summary` — is that rule, not an
 * oversight.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TELEPORTATION IS THE ODD ONE, AND IT IS SHIPPED WITH ITS LIMIT WRITTEN DOWN.
 *
 * It is the only preset that measures mid-circuit and conditions a gate on a
 * classical bit, so it is the only one that cannot run in analytic mode (§5.3)
 * — the analysis panel detects that from the document itself and runs it in
 * trajectories mode instead (`features/simulation/mode.ts`).
 *
 * The editor **can express it in the document and draw it**: `Operation` has
 * `condition`, the canvas already renders the classical wire, the write arrow
 * and the condition dot, and the store accepts the circuit through
 * `loadCircuit` like any other. What the editor cannot yet do is *build* one
 * from scratch: `GateDraft` in `placement.ts` has no `condition` field and the
 * palette offers no gesture that would set one, so a user can open this
 * preset, read it, run it and delete from it, but cannot add a second
 * conditioned gate. That gap is real and it is not this milestone's to close;
 * it is recorded here so nobody has to rediscover it by trying.
 */

import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'

/** Stable keys: they name catalog entries and will name analytics events. */
export const PRESET_IDS = [
  'superposition',
  'bell',
  'ghz',
  'interference',
  'deutschJozsa',
  'teleportation',
] as const

export type PresetId = (typeof PRESET_IDS)[number]

export interface Preset {
  readonly id: PresetId
  /**
   * A proper noun, rendered through `Notation` and never translated (D2), or
   * `null` when the name is an ordinary word the catalogs carry under
   * `editor:presets.<id>.name`.
   */
  readonly properName: string | null
  /** The document itself. Already contract-valid; the tests re-check it. */
  readonly circuit: Circuit
}

/**
 * The message qubit's angle in the teleportation preset.
 *
 * π/3 gives cos(π/6)|0⟩ + sin(π/6)|1⟩ — a 75/25 split. Deliberately lopsided:
 * a state that teleports to something asymmetric is a state you can *see*
 * arrive, whereas an even superposition would be indistinguishable from the
 * |+⟩ that half the circuit is made of anyway.
 */
const MESSAGE_ANGLE = Math.PI / 3

/**
 * Two wires, two Hadamards: every basis state at once, all four equally
 * likely. The register matches the Bell preset's on purpose — see the header.
 */
const superposition: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'h', targets: [1], column: 0 },
  ],
}

/** (|00⟩ + |11⟩)/√2 — the two-qubit entangled pair. */
const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/**
 * (|000⟩ + |111⟩)/√2. The CNOTs are chained q0→q1→q2 rather than fanned out
 * from q0, so each column adds exactly one wire to the correlation and the
 * timeline scrubber shows the entanglement growing one qubit at a time.
 */
const ghz: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'op_3', gate: 'cx', targets: [2], controls: [1], column: 2 },
  ],
}

/**
 * H · P(φ) · H on one qubit — the interferometer, and the smallest circuit in
 * which the phase is visibly the thing doing the work.
 *
 * At φ = π the two paths cancel on |0⟩ and add on |1⟩, so the state is exactly
 * |1⟩: a circuit made of nothing but superposition that nevertheless has a
 * certain answer. The parameter is a literal rather than a symbolic one so the
 * parameter editor's slider drives it directly — dragging φ from 0 to π and
 * watching one bar hand its probability to the other is the entire lesson, and
 * a symbolic parameter would put that behind a control this milestone does not
 * have.
 */
const interference: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 1,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'p', targets: [0], params: [Math.PI], column: 1 },
    { id: 'op_3', gate: 'h', targets: [0], column: 2 },
  ],
}

/**
 * Deutsch–Jozsa on two input qubits with a balanced oracle.
 *
 * q0 and q1 are the input register, q2 the ancilla held in |−⟩. The oracle is
 * f(x) = x₀ ⊕ x₁, built from two CNOTs into the ancilla, which is balanced —
 * so the input register reads |11⟩ with certainty after the closing
 * Hadamards. A constant f would leave it at |00⟩ with the same certainty, and
 * that is the point: one run of the circuit distinguishes the two, where a
 * classical procedure needs two evaluations of f.
 */
const deutschJozsa: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'x', targets: [2], column: 0 },
    { id: 'op_2', gate: 'h', targets: [0], column: 1 },
    { id: 'op_3', gate: 'h', targets: [1], column: 1 },
    { id: 'op_4', gate: 'h', targets: [2], column: 1 },
    { id: 'op_5', gate: 'cx', targets: [2], controls: [0], column: 2 },
    { id: 'op_6', gate: 'cx', targets: [2], controls: [1], column: 3 },
    { id: 'op_7', gate: 'h', targets: [0], column: 4 },
    { id: 'op_8', gate: 'h', targets: [1], column: 4 },
  ],
}

/**
 * Quantum teleportation: q0 carries the message, q1 and q2 are an entangled
 * pair, and the state of q0 ends up on q2.
 *
 * The columns are the protocol, in order:
 *   0  prepare the message on q0, and start the Bell pair with H on q1
 *   1  finish the Bell pair: CNOT q1 → q2
 *   2  Alice's CNOT q0 → q1
 *   3  Alice's H on q0
 *   4  measure q0 into c0 and q1 into c1 — the two classical bits she sends
 *   5  Bob's X, conditioned on c1
 *   6  Bob's Z, conditioned on c0
 *   7  read Bob's qubit into c2 — see below
 *
 * The corrections are in two columns rather than one because they act on the
 * same wire, and a column is one instant (§6). The order between them does not
 * matter physically; what does matter is that both come *after* column 4,
 * since a condition reads the register as it entered its column and would
 * otherwise read a bit that had not been written yet.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE THIRD CLASSICAL BIT IS PART OF THE EXAMPLE.
 *
 * A measuring circuit has no final state, so what this preset can put on
 * screen is a tally of the classical register and nothing else. With two bits
 * that tally is Alice's two measurement outcomes and *only* those: four
 * readings at a quarter each, indistinguishable from two independent coins.
 * Under the name "Teleportation" the reader was shown a flat four-way split
 * with nothing in it saying a state had moved — and the very asymmetry
 * `MESSAGE_ANGLE` exists to create was in the register of a qubit nobody read.
 *
 * Measuring q2 puts it there. Alice's two bits stay uniform, and the third
 * splits 75/25 exactly as the message does, so the eight readings fall into
 * two visibly unequal groups — the arriving state, in the one picture this
 * circuit is able to draw. It costs the reader nothing they had: reading Bob's
 * qubit is the last step of the protocol as anyone would perform it.
 */
const teleportation: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 3,
  operations: [
    {
      id: 'op_1',
      gate: 'ry',
      targets: [0],
      params: [MESSAGE_ANGLE],
      column: 0,
    },
    { id: 'op_2', gate: 'h', targets: [1], column: 0 },
    { id: 'op_3', gate: 'cx', targets: [2], controls: [1], column: 1 },
    { id: 'op_4', gate: 'cx', targets: [1], controls: [0], column: 2 },
    { id: 'op_5', gate: 'h', targets: [0], column: 3 },
    {
      id: 'op_6',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 4,
    },
    {
      id: 'op_7',
      gate: 'measure',
      targets: [1],
      clbitTargets: [1],
      column: 4,
    },
    {
      id: 'op_8',
      gate: 'x',
      targets: [2],
      column: 5,
      condition: { clbit: 1, equals: 1 },
    },
    {
      id: 'op_9',
      gate: 'z',
      targets: [2],
      column: 6,
      condition: { clbit: 0, equals: 1 },
    },
    {
      id: 'op_10',
      gate: 'measure',
      targets: [2],
      clbitTargets: [2],
      column: 7,
    },
  ],
}

/** The presets, in the teaching order argued in the header. */
export const PRESETS: readonly Preset[] = [
  { id: 'superposition', properName: null, circuit: superposition },
  { id: 'bell', properName: 'Bell', circuit: bell },
  { id: 'ghz', properName: 'GHZ', circuit: ghz },
  { id: 'interference', properName: null, circuit: interference },
  // The en dash is the typographic form the literature uses for a compound of
  // two authors' names, and it is part of the name rather than a hyphen.
  { id: 'deutschJozsa', properName: 'Deutsch–Jozsa', circuit: deutschJozsa },
  { id: 'teleportation', properName: null, circuit: teleportation },
]

/** The angle the teleportation preset prepares, for the test that checks it. */
export const TELEPORTATION_MESSAGE_ANGLE = MESSAGE_ANGLE

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id)
}
