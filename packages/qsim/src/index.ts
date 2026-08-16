/**
 * @qsim/core — quantum circuit simulation engine.
 *
 * Constraints that define this package (specification §12.3):
 *   - zero runtime dependencies
 *   - no DOM, no React, no Node APIs
 *
 * It must produce byte-identical results in a browser Web Worker and in a
 * Node process, because the client simulates for live feedback while the
 * server simulates authoritatively to validate challenges. Any divergence
 * between the two would let a user see "solved" locally and "failed"
 * remotely, with almost nothing to debug.
 *
 * The "no Node APIs" half of that rule is enforced at the type level: this
 * package's tsconfig sets `"types": []`, so `process`, `Buffer` and friends
 * are not even in scope.
 *
 * Where things live:
 *   - `conventions.ts`  qubit ordering (D1). Read this one first.
 *   - `statevector.ts`  the state: two Float64Array, and its lifecycle
 *   - `gates.ts`        gate matrices and their flat layout
 *   - `apply.ts`        the kernel: in-place gate application by index pairing
 *   - `measure.ts`      Born rule, collapse, sampling, and the two run modes
 *   - `metrics.ts`      partial trace, Bloch vector, purity (§5.5)
 *   - `rng.ts`          the seeded generator every sampler takes
 *   - `runner.ts`       circuit JSON in, result out, with incremental caching
 *
 * A minimal Bell pair, end to end:
 *
 * ```ts
 * const state = alloc(2)
 * apply1q(state, GATE_MATRICES.h, 0)
 * applyControlled(state, GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }])
 * // amplitudes 0 and 3 are now 1/√2
 * ```
 */

export {
  bitOf,
  clearBit,
  flipBit,
  formatKet,
  setBit,
  stateSize,
} from './conventions.js'

export {
  MAX_QUBITS,
  RENORMALIZE_INTERVAL,
  alloc,
  amplitude,
  clone,
  norm,
  renormalize,
  reset,
} from './statevector.js'
export type { Complex, Statevector } from './statevector.js'

export {
  GATE_MATRICES,
  ISWAP_MATRIX,
  SWAP_MATRIX,
  dagger,
  isOneQubitGateId,
  matrixFor,
  pMatrix,
  rxMatrix,
  ryMatrix,
  rzMatrix,
  uMatrix,
} from './gates.js'
export type { FixedGateId, Matrix2, Matrix4, OneQubitGateId } from './gates.js'

export {
  apply1q,
  apply2q,
  applyControlled,
  applyISwap,
  applySwap,
} from './apply.js'
export type { ControlSpec } from './apply.js'

export {
  MidCircuitMeasurementError,
  analyticMode,
  assertMidCircuitAllowed,
  collapse,
  marginalProbability,
  measureQubit,
  orderedCounts,
  probabilities,
  sampleShots,
  trajectoriesMode,
} from './measure.js'
export type {
  AnalyticOptions,
  AnalyticResult,
  ExecutionMode,
  ExecutionOptions,
  RunResult,
  ShotCounts,
  TrajectoriesOptions,
  TrajectoriesResult,
} from './measure.js'

export {
  blochOf,
  blochVector,
  blochVectors,
  purity,
  reducedDensity,
  trace,
} from './metrics.js'
export type { BlochVector, ReducedDensity } from './metrics.js'

export { createRng, randomSeed } from './rng.js'
export type { Rng } from './rng.js'

export {
  CircuitRunError,
  DEFAULT_CHECKPOINT_INTERVAL,
  DEFAULT_CHECKPOINT_LIMIT,
  checkpointColumns,
  createCheckpoints,
  formatRegister,
  invalidateFrom,
  run,
  runFrom,
  runTrajectory,
  stateAfterColumn,
} from './runner.js'
export type {
  Checkpoint,
  CheckpointCache,
  CheckpointOptions,
  CircuitLike,
  ConditionLike,
  OperationLike,
  ParameterLike,
  TrajectoryRun,
} from './runner.js'
