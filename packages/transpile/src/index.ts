/**
 * @qsim/transpile — the circuit somebody drew, made runnable on the machine
 * that exists.
 *
 * A Heron processor does not run the circuit anybody draws. It has no H and no
 * CNOT, and it couples 176 pairs of its 156 qubits — 1.46 % of the wiring a
 * drawn circuit assumes. Two things have to happen before a document becomes a
 * job, and only one of them is hard:
 *
 *   `euler.ts`, `decompose.ts`  DECOMPOSITION. Every gate in the catalog
 *      rewritten into `{rz, sx, x, id, cz}`. Known arithmetic, derived in the
 *      comments and multiplied out against `@qsim/core` in
 *      `verification/decomposition.test.ts` — exhaustively over the catalog,
 *      because a decomposition wrong by a phase produces a circuit that
 *      simulates plausibly and computes the wrong thing.
 *
 *   `device.ts`, `placement.ts`  PLACEMENT. Which physical qubits the logical
 *      ones become, chosen so that every interacting pair is genuinely wired
 *      together and, among those that are, so that the calibration prefers
 *      them. When no such choice exists the answer is a refusal naming what
 *      the circuit needs and what the device has — never a router quietly
 *      inserting SWAPs, which is the argument `refusal.ts` makes at length.
 *
 * And then two smaller pieces that are easy to get wrong:
 *
 *   `emit.ts`     the program, over physical qubits, in OpenQASM 3.
 *   `results.ts`  the way back. Samples come home as hexadecimal integers and
 *                 the layout does *not* appear in the conversion — see that
 *                 file's header for why, and why a Bell pair cannot tell you.
 *
 * Dependency rule (§12.3): this package may import `@qsim/schema`, `@qsim/core`
 * and `@qsim/qasm`. It touches no DOM, no Node API and no network — a device
 * is a value the caller fetched — so it runs in a browser worker, in the API
 * and in a worker alike.
 */

export {
  BASIS_GATE_IDS,
  HERON_NATIVE_GATES,
  PASSTHROUGH_GATE_IDS,
  isBasisGate,
  isPassthrough,
} from './basis.js'
export type { BasisGateId } from './basis.js'

export {
  identity2,
  matrixOf,
  multiply,
  scale,
  sqrtOf,
  unitarityDefect,
  zyzOf,
} from './complex2.js'
export type { EulerAngles, Matrix2 } from './complex2.js'

export {
  BASE_GATE_OF,
  eulerOf,
  isOneQubitCatalogId,
  oneQubitCatalogIds,
  pulseCost,
  zsxOf,
} from './euler.js'
export type { BasisRotation, OneQubitCatalogId } from './euler.js'

export { decomposableGateIds, decomposeCircuit } from './decompose.js'
export type { Decomposition, Interaction } from './decompose.js'

export { UNUSABLE_ERROR, deviceGraph, girthOf } from './device.js'
export type {
  CoupledPair,
  DeviceGraph,
  DeviceQubit,
  DeviceTarget,
} from './device.js'

export { deviceTargetFromIbm } from './ibm.js'
export type {
  IbmBackendStatus,
  IbmConfiguration,
  IbmProperties,
  IbmProperty,
} from './ibm.js'

export { DEFAULT_NODE_BUDGET, place } from './placement.js'
export type { Placement, PlacementOptions } from './placement.js'

export { emitPhysicalQasm } from './emit.js'
export type { EmitOptions, QasmStyle } from './emit.js'

export { TranspileRefusal } from './refusal.js'
export type { RefusalCode, TranspileOutcome } from './refusal.js'

export {
  bitsOfSample,
  countsFromSamples,
  invertLayout,
  logicalBitstring,
  sampleValue,
} from './results.js'
export type { ShotCounts } from './results.js'

export { safeTranspile, transpile } from './transpile.js'
export type {
  TranspileOptions,
  TranspileStats,
  TranspiledCircuit,
} from './transpile.js'
