/**
 * @qsim/jobs — the simulation queue contract (§4, §8, §11, §12.3).
 *
 * ── Why this is a package ─────────────────────────────────────────────────
 *
 * §12.3, rule 4: apps never import each other, and if `api` and `worker` share
 * logic that logic goes up into a package. They share a great deal here — one
 * enqueues what the other consumes — and every one of those agreements is a
 * place where two independently deployed processes can drift apart silently. A
 * queue is the worst possible place for that: the producer writes a payload the
 * consumer cannot parse, and nothing fails at build time, at deploy time, or in
 * any test either app runs alone. It fails at three in the morning as a job
 * that is picked up and immediately discarded.
 *
 * ── Why it holds no Redis, and no BullMQ ──────────────────────────────────
 *
 * Because the interesting half is pure, and the pure half is the half that can
 * be tested without a network. The job payload, the state machine, the progress
 * protocol, the cost model, the routing threshold and the result shape are all
 * arithmetic and data — so they are here, with unit tests that touch nothing —
 * and the connection, the blocking read and the Lua scripts stay in the two
 * apps, where a live instance is genuinely required and is used sparingly.
 *
 * That split is also what keeps this package honest about §12.3 rule 2: no Node
 * APIs, enforced by `"types": []` in the tsconfig, which is why the byte length
 * here is computed rather than taken from `Buffer`.
 *
 * ── Where things live ─────────────────────────────────────────────────────
 *
 *   - `run.ts`       what a run is: modes, statuses, the transition table two
 *                    processes drive, and the failure vocabulary
 *   - `limits.ts`    §11's resource limits, the cost model, and the §8
 *                    threshold — read the header there for where the number
 *                    comes from
 *   - `payload.ts`   what travels, and how two submissions of one job are
 *                    recognised as one
 *   - `progress.ts`  how a running job reports, and why it sometimes refuses to
 *                    guess a percentage
 *   - `result.ts`    the bounded reading a run stores, and the tripwire on it
 *   - `queue.ts`     the names, the prefix, and the two retry policies
 *   - `events.ts`    what the worker tells the API while a job runs, and why
 *                    it travels through pub/sub rather than through BullMQ's
 *                    own event stream
 */

export {
  RUN_STATUSES,
  SIMULATION_FAILURE_CODES,
  SIMULATION_MODES,
  SimulationFailure,
  canTransition,
  failureCodeOf,
  isSampledMode,
  isSimulationFailureCode,
  isSimulationMode,
  isTerminalStatus,
  predecessorsOf,
} from './run.js'
export type { RunStatus, SimulationFailureCode, SimulationMode } from './run.js'

export {
  CLIENT_DENSITY_QUBITS,
  CLIENT_STATEVECTOR_QUBITS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_SERVER_QUBITS,
  DEFAULT_SYNC_WAIT_MS,
  LIMIT_CODES,
  MAX_SERVER_OPERATIONS,
  MAX_SHOTS,
  MIN_SHOTS,
  UNIT_COST_MS,
  checkLimits,
  clampShots,
  clientCeilingFor,
  clientCeilingsAgree,
  estimatedDurationMs,
  routeOf,
  serverCeilingFor,
  simulationWork,
  workBudgetFor,
} from './limits.js'
export type {
  LimitCeilings,
  LimitCode,
  LimitRefusal,
  RouteInput,
  SimulationRoute,
} from './limits.js'

export {
  JOB_ID_DIGEST_CHARS,
  MAX_IDENTIFIER_LENGTH,
  MAX_SEED,
  NoiseProfileIdSchema,
  SimulationJobPayloadSchema,
  canonicalJson,
  canonicalWork,
  jobIdFrom,
  parseJobPayload,
  shapeOf,
  utf8ByteLength,
} from './payload.js'
export type { SimulationJobPayload } from './payload.js'

export {
  JobProgressSchema,
  PROGRESS_MIN_DELTA,
  PROGRESS_MIN_INTERVAL_MS,
  PROGRESS_PHASES,
  SHOT_CHUNK,
  initialProgress,
  parseProgress,
  progressFraction,
  shouldReport,
} from './progress.js'
export type { JobProgress, ProgressPhase } from './progress.js'

export {
  MAX_RESULT_JSON_BYTES,
  MAX_RESULT_OUTCOMES,
  RESULT_PROBABILITY_FLOOR,
  SimulationOutcomeSchema,
  SimulationRunResultSchema,
  assertResultFits,
  boundOutcomes,
  parseStoredResult,
  resultByteLength,
} from './result.js'
export type {
  BoundedOutcomes,
  OutcomeCandidate,
  SimulationOutcome,
  SimulationRunResult,
} from './result.js'

export {
  MAX_RUN_EVENT_BYTES,
  RUN_EVENT_TYPES,
  RunEventSchema,
  encodeRunEvent,
  hardwareEventChannel,
  parseRunEvent,
  runEventChannel,
} from './events.js'
export type { RunEvent, RunEventType } from './events.js'

export {
  DEFAULT_HARDWARE_SHOTS,
  HARDWARE_FAILURE_CODES,
  HARDWARE_JOB_NAME,
  HARDWARE_QUEUE,
  HARDWARE_STALE_AFTER_MS,
  HARDWARE_STATUSES,
  HardwareJobPayloadSchema,
  HardwareResultSchema,
  MAX_HARDWARE_SHOTS,
  MAX_POLL_ATTEMPTS,
  MAX_SUBMIT_ATTEMPTS,
  MIN_HARDWARE_SHOTS,
  POLL_TAIL_MS,
  RESUME_BATCH,
  RESUME_IDLE_MS,
  RESUME_INTERVAL_MS,
  SUBMIT_CLAIM_MS,
  hardwareTickId,
  isHardwareFailureCode,
  isHardwareStatus,
  isTerminalHardwareStatus,
  parseHardwarePayload,
  parseHardwareResult,
  pollDelayMs,
} from './hardware.js'
export type {
  HardwareFailureCode,
  HardwareJobPayload,
  HardwareResult,
  HardwareStatus,
} from './hardware.js'

export {
  COMPLETED_RETENTION,
  COMPLETION_TTL_MS,
  DEDUPLICATION_TTL_MS,
  DEFAULT_QUEUE_PREFIX,
  FAILED_RETENTION,
  JOB_ATTEMPTS,
  JOB_BACKOFF,
  LOCK_DURATION_MS,
  MAX_QUEUE_DEPTH,
  MAX_STALLED_COUNT,
  SIMULATION_JOB_NAME,
  SIMULATION_QUEUE,
  STALLED_CHECK_INTERVAL_MS,
  completionKey,
  deduplicationKey,
  queuePrefix,
} from './queue.js'
