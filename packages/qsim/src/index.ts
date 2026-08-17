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
 *   - `eigen.ts`        Hermitian eigensolver — the spectrum entropy needs
 *   - `metrics.ts`      partial trace, Bloch, entropy, concurrence, fidelity
 *   - `density.ts`      ρ and ρ → UρU† for the noise mode (§5.4), 4ⁿ entries
 *   - `noise.ts`        Kraus channels, readout error and device profiles (§3.3)
 *   - `trajectories.ts` the same channels sampled on a statevector — 2ⁿ (§5.4)
 *   - `rng.ts`          the seeded generator every sampler takes
 *   - `runner.ts`       circuit JSON in, result out, with incremental caching
 *   - `unitary.ts`      a circuit as a matrix, compared up to global phase
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

/*
 * `kernel.ts` is the attachment point for the optional Rust/WASM core of
 * §5.6. Exported so `@qsim/wasm` can install one; adding no dependency and no
 * requirement, because with nothing installed the engine is exactly the
 * TypeScript it was. The `check*` guards `kernel.ts` shares with `apply.ts`
 * are deliberately not exported here — they are an internal contract between
 * those two files, not API.
 */
export {
  acceleratedApplyControlled,
  acceleratedApplyISwap,
  acceleratedApplySwap,
  activeStatevectorKernel,
  disableStatevectorKernel,
  installStatevectorKernel,
  kernelStatus,
  uninstallStatevectorKernel,
} from './kernel.js'
export type { KernelStatus, StatevectorKernel } from './kernel.js'

export {
  MidCircuitMeasurementError,
  analyticMode,
  assertMidCircuitAllowed,
  collapse,
  marginalProbability,
  measureQubit,
  orderedCounts,
  probabilities,
  sampleIndex,
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

/*
 * `eigen.ts` is the only dense linear algebra in the package. It exists
 * because an entropy is a function of a spectrum and a spectrum is not
 * something the index-pairing kernel can produce — see its header for why the
 * method is Jacobi and where `MAX_EIGEN_DIM` comes from.
 */
export {
  HERMITICITY_TOLERANCE,
  EigenTooLargeError,
  MAX_EIGEN_DIM,
  MAX_JACOBI_SWEEPS,
  NotHermitianError,
  eigenHermitian,
  eigenvaluesHermitian,
} from './eigen.js'
export type { EigenOptions, Eigensystem, HermitianMatrix } from './eigen.js'

/*
 * `metrics.ts` carries the §3.2 numbers: Bloch vectors, entropy, concurrence
 * and fidelity. Two of its exports name a density matrix in the operand
 * position — `densityFidelity`, `densityStateFidelity` — which reads with the
 * `density*` prefix rule below rather than against it: there the prefix says
 * "this is density.ts's version of a statevector operation", and here it says
 * "the argument is a ρ". Both readings land on the same import.
 */
export {
  MAX_SUBSYSTEM_QUBITS,
  PHYSICALITY_TOLERANCE,
  binaryEntropy,
  blochOf,
  blochVector,
  blochVectors,
  concurrence,
  concurrenceOf,
  densityFidelity,
  densityStateFidelity,
  distributionFidelity,
  partialTrace,
  partialTraceOfDensity,
  purity,
  qubitEntropy,
  reducedDensity,
  stateFidelity,
  subsystemEntropy,
  trace,
  vonNeumannEntropy,
} from './metrics.js'
export type { BlochVector, ReducedDensity } from './metrics.js'

/*
 * `density.ts` is the mixed-state mirror of `statevector.ts` + `apply.ts`, so
 * inside that module the functions carry the names their statevector twins
 * carry — `alloc`, `trace`, `purity`, `apply1q`. Here they would collide, and
 * the collisions matter: `trace` already means Tr of a one-qubit reduced ρ
 * (`metrics.ts`) and `purity` already means Tr(ρ²) of one. So every export
 * from that module is prefixed `density` at this boundary, without exception,
 * and the rule holds even where there is no collision to resolve —
 * `densityApplySwap` next to `applySwap` is what makes it impossible to import
 * the wrong one by autocomplete. A consumer that prefers the short names can
 * still write `import * as density from '@qsim/core/density'`-style access
 * inside this package; from outside, the prefix is the API.
 */
export {
  DENSITY_BUDGET_BYTES,
  DensityTooLargeError,
  MAX_DENSITY_QUBITS,
  alloc as densityAlloc,
  apply1q as densityApply1q,
  apply2q as densityApply2q,
  applyControlled as densityApplyControlled,
  applyISwap as densityApplyISwap,
  applySwap as densityApplySwap,
  assertDensityFits,
  clone as densityClone,
  densityBytes,
  entry as densityEntry,
  fromStatevector as densityFromStatevector,
  hermiticityDefect,
  isHermitian,
  isPositiveSemidefinite,
  probabilities as densityProbabilities,
  purity as densityPurity,
  renormalize as densityRenormalize,
  reset as densityReset,
  trace as densityTrace,
} from './density.js'
export type { DensityMatrix } from './density.js'

/*
 * `noise.ts` needs no prefix: a Kraus channel exists only for ρ, so there is no
 * statevector twin for `applyChannel` to be confused with. The one name that
 * comes close is `applyChannels` (plural), which is the same operation over a
 * list — deliberately one letter apart because they are deliberately
 * interchangeable at a call site with one channel in it.
 */
export {
  MAX_ONE_QUBIT_GATE_ERROR,
  MAX_TWO_QUBIT_GATE_ERROR,
  NOISE_CHANNEL_KINDS,
  NOISE_PROFILES,
  NOISE_PROFILE_IDS,
  NoiseProfileError,
  NotTracePreservingError,
  amplitudeDampingChannel,
  applyChannel,
  applyChannels,
  applyReadoutError,
  bitFlipChannel,
  channelFor,
  channelsForGate,
  channelsForIdle,
  customProfile,
  depolarizingChannel,
  depolarizingFromGateError,
  isTracePreserving,
  krausDefect,
  localDepolarizingFromPairError,
  phaseDampingChannel,
  phaseFlipChannel,
  readoutErrorsFor,
  relaxationFor,
  relaxationInfidelity,
  sampleReadout,
  validateProfile,
} from './noise.js'
export type {
  KrausChannel,
  NoiseChannelKind,
  NoiseProfile,
  NoiseProfileId,
  NoiseProfileValues,
  ReadoutError,
  RelaxationParameters,
} from './noise.js'

/*
 * `trajectories.ts` is the statevector half of the noise mode (§5.4): the same
 * channels `noise.ts` builds, sampled one operator at a time instead of summed
 * over. No prefix is needed and none would help — `applyTrajectoryChannels`
 * next to `applyChannels` names the difference that matters, which is not the
 * representation but whether the answer is drawn or evaluated.
 */
export {
  applyTrajectoryChannels,
  krausWeights,
  prepareChannel,
  prepareChannels,
  sampleKraus,
} from './trajectories.js'
export type { TrajectoryChannel } from './trajectories.js'

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
  runFromState,
  runNoisy,
  runNoisyDensity,
  runTrajectory,
  stateAfterColumn,
} from './runner.js'
export type {
  Checkpoint,
  CheckpointCache,
  CheckpointOptions,
  CircuitLike,
  ConditionLike,
  NoiseModel,
  NoisyDensityResult,
  NoisyOptions,
  NoisyResult,
  OperationLike,
  ParameterLike,
  TrajectoryRun,
} from './runner.js'

/*
 * `unitary.ts` is what a §3.6 challenge with a *unitary* target compares
 * against: the circuit as a matrix, and the fidelity that ignores an overall
 * phase — because two operations differing by one are the same operation, and
 * a validator that failed them would be wrong.
 */
export {
  MAX_UNITARY_QUBITS,
  UnitaryTooLargeError,
  allocUnitary,
  circuitUnitary,
  transitionProbability,
  unitaryFidelity,
} from './unitary.js'
export type { Unitary } from './unitary.js'
