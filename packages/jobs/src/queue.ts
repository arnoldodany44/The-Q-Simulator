/**
 * The names and the retry policy — the handful of constants that two separate
 * processes have to agree on exactly, or the producer writes into one key space
 * and the consumer blocks on another and neither reports anything wrong.
 *
 * ── Everything is namespaced, because the instance is shared ──────────────
 *
 * The Redis behind this is one small, metered instance that development,
 * production and every test share. BullMQ builds its keys as
 * `<prefix>:<queue>:<id>`, so a prefix is the only thing separating a
 * developer's queue from the live one, and a test that used the default would
 * be adding jobs to production. Hence `queuePrefix`, which takes the
 * environment's prefix and refuses an empty one rather than silently falling
 * back to BullMQ's `bull`.
 *
 * ── The retry policy is three policies, and they are not the same ─────────
 *
 * BullMQ distinguishes a job that *failed* from a job that *stalled*, and the
 * processor distinguishes a failure of the work from a failure of the storage.
 * The three are treated differently on purpose:
 *
 *   - A failure of the *work* is deterministic. A circuit that made the engine
 *     throw will make it throw again, from the same seed, in the same order —
 *     the whole point of §5's determinism. Retrying it spends a second minute
 *     of a killable child to reach the identical exception, so it is not
 *     retried at all: the processor writes a FAILED row and reports success,
 *     because writing that row *was* the job.
 *   - A failure of the *storage* is not. `DATABASE_URL` carries
 *     `connection_limit=1` through a transaction pooler, so a claim or a
 *     completion that cannot reach Postgres is the ordinary failure rather than
 *     the pathological one — and it leaves the row exactly as it was, which is
 *     non-terminal. That is the one case worth a retry, so the processor
 *     rethrows it and `JOB_ATTEMPTS` is greater than one, with a backoff long
 *     enough for a pooler to come back.
 *   - A stall is not about the job at all. It means the worker holding the
 *     lock stopped renewing it: killed mid-run by a redeploy, evicted, or
 *     starved. The work was never done, so it must be done — that is
 *     `MAX_STALLED_COUNT`, and it is what makes "a worker killed mid-job does
 *     not lose the job" true.
 *
 * That last sentence was, for a while, false in the one way that mattered. The
 * replacement could not *claim* the run, because the worker that died had
 * already moved it from QUEUED to RUNNING and the claim only accepted QUEUED —
 * so the job was re-delivered, refused itself, and was marked completed while
 * the row stayed RUNNING for ever. A recovery claim (`claimRun(id, { recovery
 * })`, passed only when the queue says this delivery is a re-execution) is what
 * closes it, and the reaper in `apps/worker` is what closes the residue: a row
 * nothing can move is failed rather than left describing work that stopped.
 *
 * The other half of that sentence — "and must not run twice with visible
 * effect" — is not enforced here and cannot be. A stalled job that was in fact
 * finished will be executed a second time, and the guard is the conditional
 * update in the run repository: the second completion writes onto a row that
 * is already terminal and matches zero rows. See `predecessorsOf` in `run.ts`.
 */

import { JOB_ID_DIGEST_CHARS } from './payload.js'

/** BullMQ's `prefix`. Every key this system creates starts here. */
export const DEFAULT_QUEUE_PREFIX = 'qsim'

/** The one queue this milestone defines. Hardware polling gets its own. */
export const SIMULATION_QUEUE = 'simulate'

/**
 * The job name inside that queue.
 *
 * BullMQ dispatches by queue and reports by name, so a second kind of work in
 * the same queue would be a name and not a second queue. There is only one
 * today; naming it explicitly is what makes adding the second a one-line change
 * rather than a migration.
 */
export const SIMULATION_JOB_NAME = 'simulate-circuit'

/** A prefix that cannot silently become BullMQ's default. */
export function queuePrefix(configured: string | undefined): string {
  const value = configured?.trim() ?? ''
  return value === '' ? DEFAULT_QUEUE_PREFIX : value
}

/**
 * How many times a job may be *executed* before BullMQ gives up on it.
 *
 * Three, and it is not a hedge against the engine. See the header: a
 * deterministic failure does not become truer on a retry, and the processor
 * does not throw for one — it writes a FAILED row and reports the job done. The
 * only thing that reaches BullMQ as a failure is a failure of the storage, and
 * that one is transient by nature: a pooler recycling its single connection, a
 * database restarting. One attempt meant such a job was filed as failed with
 * nobody listening and its row left QUEUED for ever.
 */
export const JOB_ATTEMPTS = 3

/**
 * How long to wait before re-executing a job whose storage failed, and by what
 * factor.
 *
 * Exponential from two seconds — 2 s, 4 s — so three attempts span about six
 * seconds. Long enough to outlast the reconnection of a transaction pooler,
 * short enough that a caller waiting on the synchronous window is not held past
 * it for a failure that is going to be permanent anyway.
 */
export const JOB_BACKOFF = { type: 'exponential', delay: 2_000 } as const

/**
 * How many times a job may be recovered from a worker that stopped renewing
 * its lock.
 *
 * One. A second recovery means two workers have now died on this job, which is
 * evidence about the job rather than about the workers — most likely a memory
 * profile the container cannot honour — and re-queueing it a third time would
 * turn one bad circuit into a loop that evicts every worker it touches.
 */
export const MAX_STALLED_COUNT = 1

/**
 * How long a job's lock survives without renewal.
 *
 * This is the number the child-process design in `apps/worker` exists to
 * protect. BullMQ renews the lock from the worker's *event loop*, so if the
 * simulation ran inline, a thirty-second synchronous kernel loop would block
 * every renewal, the lock would expire, the job would be declared stalled, and
 * a second worker would start running it — while the first was still running
 * it, and would go on to write its result. Two executions, both visible, from
 * nothing worse than a slow circuit.
 *
 * Thirty seconds is generous for a renewal that ought to happen every ten, and
 * generous on purpose: the failure it guards against is a scheduling hiccup on
 * a shared container, and the cost of being generous is that a genuinely dead
 * worker's job waits half a minute longer.
 */
export const LOCK_DURATION_MS = 30_000

/** How often the worker looks for jobs whose lock has expired. */
export const STALLED_CHECK_INTERVAL_MS = 15_000

/**
 * What is kept after a job finishes, and the ceiling on what is waiting.
 *
 * ── THE ARITHMETIC, WHICH IS THE WHOLE ARGUMENT ──────────────────────────
 *
 * Every job hash carries a whole circuit document. Measured on the live
 * instance, a job at the contract's column ceiling (4096 operations) stores
 * 290 KB; the API's body limit is 1 MiB, so a legal admitted job can be three
 * times that. The instance is 256 MB with `maxmemory-policy noeviction`, which
 * means exhaustion is not a slowdown — it is every write in the system
 * failing at once, including the API's deduplication SET (a 503 for everybody),
 * the worker's completion signal, and BullMQ's own Lua. Waiting-job keys have
 * no TTL, so it does not self-heal either.
 *
 * So the retained bytes are bounded deliberately: at most
 * `MAX_QUEUE_DEPTH + COMPLETED_RETENTION.count + FAILED_RETENTION.count`
 * payloads exist at any moment, which is about 54 MB at the body limit and a
 * few megabytes in practice. Drain rate is the other half of the sum: two
 * concurrent jobs of up to a minute each, against a strict rate limit of twenty
 * submissions a minute per caller, is a queue that fills far faster than it
 * empties — so a bound on *depth* is what keeps one caller from filling the
 * instance, and it is checked before `queue.add`.
 *
 * The completed-job retention used to be justified by deduplication. That was
 * simply wrong: deduplication is done by the separate `dedupe:` key with its
 * own TTL, and the job id is the run id, so nothing reads a completed job's
 * hash once the run is terminal. Five minutes and ten jobs is what an operator
 * looking at a dashboard needs and no more. Failures are kept longer and for a
 * real reason: they are the only record of *why* a run failed once its row has
 * been read, and nobody investigates within fifteen minutes.
 */
export const COMPLETED_RETENTION = { age: 300, count: 10 } as const
export const FAILED_RETENTION = { age: 3600, count: 20 } as const

/**
 * How many jobs may be waiting before a submission is refused.
 *
 * Twenty-four is twelve minutes of backlog at `WORKER_CONCURRENCY` 2 and the
 * full sixty-second bound — already far past what anybody waits for, and the
 * honest thing to do past it is to say so. A queue with no depth limit does not
 * degrade gracefully on a `noeviction` instance: it works perfectly until the
 * memory runs out, and then nothing works at all.
 */
export const MAX_QUEUE_DEPTH = 24

/* ────────────────── the two keys this system owns itself ────────────── */

/**
 * Where a submission records that it has claimed a piece of work.
 *
 * Deduplication is done with a plain `SET NX PX` rather than through BullMQ's
 * own facility, and the reason is ordering. The API has to create the
 * `SimulationRun` row before it enqueues — the job payload names the row it
 * writes into — so it needs to know *before* it commits to that row whether an
 * identical job already owns one. A key it sets itself answers that in one
 * command and hands back the winning run id; going through the queue would
 * mean adding the job first and asking afterwards, which is the wrong way
 * round and leaves a row behind either way.
 *
 * The value stored under this key is the winning run id, which is what makes
 * the loser's answer useful rather than merely a refusal.
 *
 * `digestHex` is the *digest*, not a job id built from one. Passing
 * `jobIdFrom(digest)` — which is `sim-` plus 32 hex characters — left 28 hex
 * characters after this slice, so the key carried 112 bits where `payload.ts`
 * argues at length for 128. A collision here does not produce a wrong number:
 * it hands the second submitter the first one's run, over a circuit that is not
 * theirs.
 */
export function deduplicationKey(prefix: string, digestHex: string): string {
  return `${prefix}:dedupe:${digestHex.slice(0, JOB_ID_DIGEST_CHARS)}`
}

/**
 * How long identical work collapses onto one run.
 *
 * Five minutes, bounded from both sides. It has to be at least as long as a job
 * can plausibly take — `DEFAULT_JOB_TIMEOUT_MS` is a minute, plus a queue wait
 * — or a resubmission while the first job is still running would start a
 * second identical one, which is the exact waste deduplication exists to
 * prevent. And it must not be much longer, because the key survives a
 * *failure* too: a run that failed is one a person will immediately try again,
 * and holding them to the failed run for an hour would be a worse bug than the
 * duplicate.
 */
export const DEDUPLICATION_TTL_MS = 5 * 60_000

/**
 * Where the worker says "this run has reached a terminal status".
 *
 * A one-byte key with a short expiry, and it carries no result: the answer
 * lives in Postgres, and a copy in Redis would be a second source of truth for
 * the one value in this system that must not have two. What this key buys is
 * the *synchronous* answer of §8 — the API can wait on it instead of polling
 * the database every fifty milliseconds through a pooler whose entire budget is
 * one connection.
 */
export function completionKey(prefix: string, runId: string): string {
  return `${prefix}:done:${runId}`
}

/**
 * How long a completion signal survives.
 *
 * Only ever read inside the synchronous window, so it needs to outlive that
 * and nothing more. A minute is generous by an order of magnitude and keeps the
 * key count on a 256 MB instance bounded by arrival rate rather than by
 * history.
 */
export const COMPLETION_TTL_MS = 60_000
