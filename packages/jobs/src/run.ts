/**
 * What a server-side simulation *is*: its mode, its lifecycle, and the
 * vocabulary it fails in.
 *
 * Every value here has a twin somewhere it cannot import, and each twin is
 * asserted rather than assumed:
 *
 *   - `SIMULATION_MODES` mirrors the Postgres enum `SimMode` (§7). `@qsim/db`
 *     may not be imported here — this package is shared with `apps/api`, and
 *     `apps/worker`, and neither of them should learn what a mode is from the
 *     database. The two are asserted equal where both are in scope.
 *   - `RUN_STATUSES` mirrors `RunStatus`, for the same reason.
 *
 * ── The state machine is here because two processes drive it ──────────────
 *
 * `apps/api` creates a run QUEUED. `apps/worker` moves it to RUNNING and then
 * to DONE or FAILED. That is two processes writing one row, which is the
 * situation where an "obvious" transition table stops being obvious: a worker
 * that was killed after finishing the arithmetic but before the write will be
 * replaced, and the replacement will try to write DONE onto a row that may
 * already say DONE. So the table below is not decoration — `canTransition` is
 * what the repository's conditional update is built from, and it is what makes
 * "must not run twice with visible effect" a property of the data rather than
 * a hope about timing.
 *
 * The rule that matters: **a terminal status is final**. DONE and FAILED
 * accept nothing, including themselves. A second completion is therefore not
 * an error to report, it is a write that matches zero rows.
 */

/* ──────────────────────────────── modes ─────────────────────────────── */

/**
 * How the server evaluates a circuit. Mirrors `SimMode` in the Prisma schema.
 *
 * The three are genuinely different computations rather than three settings of
 * one (§5.3, §5.4):
 *
 *   `STATEVECTOR`     one run, one final |ψ⟩, exact. Refuses a circuit that
 *                     measures before it ends, because such a circuit has no
 *                     single final state.
 *   `TRAJECTORIES`    the whole circuit re-run once per shot, each with its
 *                     own collapses, tallied. The mode a measuring circuit
 *                     needs, and the mode a *noisy* large register needs.
 *   `DENSITY_MATRIX`  ρ evolved exactly through the Kraus channels. No shot
 *                     noise and 4ⁿ memory, which is why its ceiling is twelve
 *                     qubits and not twenty-something.
 */
export const SIMULATION_MODES = [
  'STATEVECTOR',
  'DENSITY_MATRIX',
  'TRAJECTORIES',
] as const

export type SimulationMode = (typeof SIMULATION_MODES)[number]

export function isSimulationMode(value: string): value is SimulationMode {
  return (SIMULATION_MODES as readonly string[]).includes(value)
}

/** Whether this mode's cost is driven by a shot count rather than by 2ⁿ alone. */
export function isSampledMode(mode: SimulationMode): boolean {
  return mode === 'TRAJECTORIES'
}

/* ─────────────────────────────── statuses ───────────────────────────── */

/** Mirrors `RunStatus` in the Prisma schema. */
export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

/** DONE and FAILED. Nothing leaves either, including a repeat of itself. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'DONE' || status === 'FAILED'
}

/**
 * Every legal move, as the set of statuses a run may be in *before* it.
 *
 * Written as "who may precede me" rather than "where may I go" because that is
 * the direction the writes are made in: the repository issues
 * `updateMany({ where: { id, status: { in: predecessorsOf(next) } } })`, and a
 * row that has moved on since the read matches nothing and is left alone.
 *
 * QUEUED has no predecessor: a run is *created* queued, in the same statement
 * that mints its id, and nothing may put it back.
 */
const PREDECESSORS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: [],
  RUNNING: ['QUEUED'],
  /*
   * RUNNING *and* QUEUED reach DONE and FAILED. The QUEUED → DONE edge is not
   * a shortcut for the impatient: it is the path a job takes when the worker
   * that claimed it died before its claim was written, was replaced, and the
   * replacement ran the work to completion against a row still reading QUEUED.
   * Refusing that edge would strand a perfectly good result.
   */
  DONE: ['QUEUED', 'RUNNING'],
  FAILED: ['QUEUED', 'RUNNING'],
}

/** The statuses a row may hold for a move to `next` to be legal. */
export function predecessorsOf(next: RunStatus): readonly RunStatus[] {
  return PREDECESSORS[next]
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return PREDECESSORS[to].includes(from)
}

/* ─────────────────────────── failure vocabulary ─────────────────────── */

/**
 * Why a run did not produce a result.
 *
 * A code and never a sentence, for the reason the whole API works that way
 * (§11, D2): `SimulationRun.errorMessage` is read back by `GET /simulate/:id`
 * and rendered by a trilingual client, so an English string written here would
 * be an English string on a French screen, living outside every catalog parity
 * test. The engine's own prose goes to the worker's log, where it belongs.
 *
 *   `INVALID_CIRCUIT`     the payload did not survive `parseCircuit`. Reachable
 *                         even though the API validates too — see
 *                         `apps/worker`'s processor for why the worker
 *                         validates again rather than trusting the producer.
 *   `LIMIT_EXCEEDED`      the work is past a ceiling the worker enforces:
 *                         qubits, operations, shots, or the work budget.
 *                         Decided *before* anything is allocated.
 *   `TIMED_OUT`           accepted, started, and still running when the
 *                         wall-clock bound expired. Distinct from
 *                         LIMIT_EXCEEDED because the estimate said yes and the
 *                         machine said no, which is a fact about the estimate.
 *   `RESULT_TOO_LARGE`    the answer will not fit in the row. See `result.ts`.
 *   `ENGINE_FAILED`       @qsim/core threw. A bug in this project.
 *   `WORKER_CRASHED`      the child process died without answering — OOM, a
 *                         segfault, a platform eviction. Distinct from
 *                         ENGINE_FAILED because there is no exception to read.
 *   `QUEUE_UNAVAILABLE`   never written by the worker. `apps/api` stamps it on
 *                         a run it created and then could not enqueue, so the
 *                         row does not sit QUEUED forever describing a job
 *                         that does not exist.
 */
export const SIMULATION_FAILURE_CODES = [
  'INVALID_CIRCUIT',
  'LIMIT_EXCEEDED',
  'TIMED_OUT',
  'RESULT_TOO_LARGE',
  'ENGINE_FAILED',
  'WORKER_CRASHED',
  'QUEUE_UNAVAILABLE',
] as const

export type SimulationFailureCode = (typeof SIMULATION_FAILURE_CODES)[number]

export function isSimulationFailureCode(
  value: string
): value is SimulationFailureCode {
  return (SIMULATION_FAILURE_CODES as readonly string[]).includes(value)
}

/**
 * A failure with its code attached, so the worker's `catch` can hand the
 * repository a code rather than a guess derived from a message.
 *
 * `detail` is the underlying English text and is deliberately not part of what
 * gets stored: it exists for the log line the worker writes next to the row.
 */
export class SimulationFailure extends Error {
  readonly code: SimulationFailureCode

  constructor(
    code: SimulationFailureCode,
    detail: string,
    options: { cause?: unknown } = {}
  ) {
    super(detail, options)
    this.name = 'SimulationFailure'
    this.code = code
  }
}

/**
 * The code for anything thrown, without ever reading a message.
 *
 * The same discipline as `toApiError` in `apps/api`: classification is by
 * shape, so no wording from a library can decide a stored value.
 */
export function failureCodeOf(error: unknown): SimulationFailureCode {
  if (error instanceof SimulationFailure) return error.code
  return 'ENGINE_FAILED'
}
