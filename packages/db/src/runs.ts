/**
 * Simulation-run persistence — §7's `SimulationRun`, §8's `/simulate`.
 *
 * ── One row, two processes ────────────────────────────────────────────────
 *
 * Every other repository in this package is written by one process. This one
 * is written by two: `apps/api` creates the row QUEUED and `apps/worker` moves
 * it to RUNNING and then to DONE or FAILED. That changes what a repository has
 * to be, because the interesting failures are no longer "the caller asked for
 * something silly" — they are "two workers believe they own this job".
 *
 * The whole defence is that **every status write is a compare-and-set**. The
 * methods below issue `updateMany` with the status in the `where`, taking the
 * legal predecessors from `@qsim/jobs`' transition table, and they return
 * whether a row actually moved. Nothing here reads-then-writes, because a read
 * followed by a write is a race with a wider window.
 *
 * That is what makes the milestone's hardest requirement true: a worker killed
 * mid-job has its job re-queued by BullMQ and executed a second time, and the
 * second execution's `complete()` finds a row that is already terminal, matches
 * zero rows, and changes nothing. The job ran twice; it had one visible effect.
 *
 * ── Why the result is `unknown` on the way in ─────────────────────────────
 *
 * `SimulationRun.result` is `Json?`, and this package may not import
 * `@qsim/jobs` (the boundary rule says db reaches for @qsim/schema and Prisma
 * and nothing else — and it exists precisely so that the persistence layer
 * cannot become a place where simulation logic lives). So the shape of a
 * result is owned by `@qsim/jobs`, validated there, and passed through here as
 * JSON. The reader is `parseStoredResult`, in the same package that defined it.
 */

import { Prisma } from './generated/prisma/client.js'
import type { PrismaClient } from './generated/prisma/client.js'
import { RunStatus } from './generated/prisma/enums.js'
import type { SimMode } from './generated/prisma/enums.js'
import { simulationRunFilter } from './visibility.js'
import type { ViewerId } from './visibility.js'

/**
 * A run as every read of it comes back.
 *
 * A `select` rather than the whole row, for the reason `circuitDetailSelect`
 * is: `userId` is fetched by nothing here because no response needs it —
 * authorisation happened in the `where`, and a field that never leaves the
 * query cannot leak out of a handler that forgot to omit it.
 */
export const simulationRunSelect = {
  id: true,
  circuitId: true,
  mode: true,
  shots: true,
  status: true,
  result: true,
  errorMessage: true,
  durationMs: true,
  createdAt: true,
} satisfies Prisma.SimulationRunSelect

export type StoredRun = Prisma.SimulationRunGetPayload<{
  select: typeof simulationRunSelect
}>

export interface CreateRunInput {
  /** The verified `sub`, or `null` for an anonymous run. Never a body field. */
  readonly userId: string | null
  /** The stored circuit this run is about, already checked as readable. */
  readonly circuitId: string | null
  readonly mode: SimMode
  readonly shots: number | null
  /** `{ id }` of a preset profile, or `null`. Owned by @qsim/jobs. */
  readonly noiseProfile: unknown
}

export interface CompleteRunInput {
  readonly id: string
  /** The bounded reading. Shape owned and validated by @qsim/jobs. */
  readonly result: unknown
  readonly durationMs: number
}

export interface FailRunInput {
  readonly id: string
  /**
   * A `SimulationFailureCode`, never a sentence.
   *
   * The column is named `errorMessage` by §7 and holds a code anyway, because
   * a trilingual client renders it (D2) and English prose here would be English
   * prose on a French screen, outside every catalog parity test. Renaming the
   * column would be a migration for a comment.
   */
  readonly code: string
  /** Engine time before it failed, when there was any. */
  readonly durationMs: number | null
}

export interface SimulationRunRepository {
  /** Creates the row QUEUED. The only way a run comes into existence. */
  createRun(input: CreateRunInput): Promise<StoredRun>

  /**
   * The run this id names, if this viewer may read it — §11 applied in the
   * query, as everywhere else in this package. `null` covers both "no such
   * run" and "not yours", which is what makes the route's 404 honest.
   */
  findReadableRun(id: string, viewerId: ViewerId): Promise<StoredRun | null>

  /**
   * Marks a run RUNNING. `false` means it was not claimable — another worker
   * holds it, or it was already finished — and the caller should stop.
   *
   * `recovery` widens the claim to a row that is *already* RUNNING, and it is
   * the whole of "a worker killed mid-job does not lose the job". BullMQ
   * re-delivers a job whose worker stopped renewing its lock, and the
   * replacement met a row the dead worker had already moved to RUNNING: the
   * claim matched zero rows, the job was reported as done, and the run stayed
   * RUNNING forever with a client polling it every five seconds. The caller
   * passes `recovery` only when the queue says this delivery is a re-execution
   * — the lock has expired by then, so the previous holder is not coming back —
   * and the guard that keeps a *finished* run safe is unchanged: a terminal row
   * is still refused, here and again at `completeRun`.
   */
  claimRun(id: string, options?: { recovery?: boolean }): Promise<boolean>

  /**
   * The status of a run, with no visibility filter. For the worker only.
   *
   * Every other read in this package is scoped to a viewer, because every other
   * read answers a request. This one answers "what happened to the job I am
   * holding", which is not a request and has no viewer: the worker is the
   * process that writes the row, not a reader of somebody's history.
   */
  runStatus(id: string): Promise<RunStatus | null>

  /**
   * Fails every run that has been non-terminal since before `before`.
   *
   * The last line of defence, and it exists because the two processes that
   * write these rows can both die between the write that creates one and the
   * write that finishes it: an API that is SIGKILLed between `createRun` and
   * `enqueue`, a worker whose database was unreachable for the whole of its
   * retry budget. Neither is recoverable by the mechanism that owns it, and the
   * result is a row nothing will ever move — which the client reads as a run
   * that is still going, forever.
   *
   * Answers how many rows moved. Scoped by age rather than by owner because a
   * stale run has no owner left to scope it to; `before` is chosen by the
   * caller to be far past any legitimate queue wait.
   */
  failStaleRuns(input: {
    before: Date
    code: string
    limit: number
  }): Promise<number>

  /** Compare-and-set to DONE. `false` if the run was already terminal. */
  completeRun(input: CompleteRunInput): Promise<boolean>

  /** Compare-and-set to FAILED. `false` if the run was already terminal. */
  failRun(input: FailRunInput): Promise<boolean>

  /**
   * Deletes a run this caller created and then decided not to keep.
   *
   * Exists for exactly one caller: `POST /simulate` creates the row before it
   * enqueues, and deduplication can only report that an identical job already
   * exists *after* the enqueue attempt. The losing row is a few milliseconds
   * old, has never been read, and is scoped to its own id and owner here so
   * that this can never become a way to delete somebody else's history.
   */
  discardRun(input: { id: string; userId: string | null }): Promise<boolean>
}

/**
 * The statuses a run may hold for a move to be legal.
 *
 * A restatement of `predecessorsOf` in `@qsim/jobs`, which this package may not
 * import. Both are small and both are tested; `apps/api` is where a test can
 * hold the two side by side, and it does.
 */
const NON_TERMINAL: readonly RunStatus[] = [RunStatus.QUEUED, RunStatus.RUNNING]

export function prismaSimulationRunRepository(
  prisma: PrismaClient
): SimulationRunRepository {
  return {
    createRun(input) {
      return prisma.simulationRun.create({
        data: {
          userId: input.userId,
          circuitId: input.circuitId,
          mode: input.mode,
          shots: input.shots,
          noiseProfile: toJson(input.noiseProfile),
          status: RunStatus.QUEUED,
        },
        select: simulationRunSelect,
      })
    },

    findReadableRun(id, viewerId) {
      return prisma.simulationRun.findFirst({
        where: simulationRunFilter(id, viewerId),
        select: simulationRunSelect,
      })
    },

    async claimRun(id, options = {}) {
      const claimable =
        options.recovery === true
          ? [RunStatus.QUEUED, RunStatus.RUNNING]
          : [RunStatus.QUEUED]
      const { count } = await prisma.simulationRun.updateMany({
        where: { id, status: { in: claimable } },
        data: { status: RunStatus.RUNNING },
      })
      return count === 1
    },

    async runStatus(id) {
      const row = await prisma.simulationRun.findUnique({
        where: { id },
        select: { status: true },
      })
      return row?.status ?? null
    },

    async failStaleRuns({ before, code, limit }) {
      /*
       * Two statements rather than one `updateMany` with a limit, because
       * Postgres has no LIMIT on UPDATE and Prisma has no `take` on
       * `updateMany`. The bound matters: this runs on a timer against a shared
       * database, and a sweep that touched ten thousand rows in one transaction
       * would hold locks on a pooler whose whole budget is one connection.
       */
      const stale = await prisma.simulationRun.findMany({
        where: {
          status: { in: [...NON_TERMINAL] },
          createdAt: { lt: before },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      })
      if (stale.length === 0) return 0
      const { count } = await prisma.simulationRun.updateMany({
        // The status predicate again, and not merely for tidiness: a worker may
        // have claimed one of these between the read and the write, and a sweep
        // that overwrote a run somebody is actively computing would be the very
        // bug it exists to prevent.
        where: {
          id: { in: stale.map((row) => row.id) },
          status: { in: [...NON_TERMINAL] },
        },
        data: {
          status: RunStatus.FAILED,
          errorMessage: code,
          result: Prisma.DbNull,
          durationMs: null,
        },
      })
      return count
    },

    async completeRun({ id, result, durationMs }) {
      const { count } = await prisma.simulationRun.updateMany({
        // The status predicate is the whole guard. Without it, a job that was
        // re-queued after its worker died would overwrite the answer the
        // replacement already stored — the same answer, but written twice, and
        // the second write would also resurrect a run somebody had failed.
        where: { id, status: { in: [...NON_TERMINAL] } },
        data: {
          status: RunStatus.DONE,
          result: toJson(result),
          errorMessage: null,
          durationMs,
        },
      })
      return count === 1
    },

    async failRun({ id, code, durationMs }) {
      const { count } = await prisma.simulationRun.updateMany({
        where: { id, status: { in: [...NON_TERMINAL] } },
        data: {
          status: RunStatus.FAILED,
          errorMessage: code,
          result: Prisma.DbNull,
          durationMs,
        },
      })
      return count === 1
    },

    async discardRun({ id, userId }) {
      const { count } = await prisma.simulationRun.deleteMany({
        // Scoped by owner *and* by status: a run that has started is a run
        // something is spending CPU on, and deleting its row would leave the
        // worker writing into nothing.
        where: { id, userId, status: RunStatus.QUEUED },
      })
      return count === 1
    },
  }
}

/**
 * `null` into the `jsonb` column, and not JSON `null`.
 *
 * Prisma distinguishes the two and the distinction is real: `Prisma.DbNull`
 * writes SQL NULL — "there is no result" — while `Prisma.JsonNull` writes the
 * JSON value `null`, which reads back as a result that happens to be null.
 * Every reader here treats a missing result as "not finished", so the wrong one
 * would make a failed run indistinguishable from one that succeeded at nothing.
 */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull
  return value
}
