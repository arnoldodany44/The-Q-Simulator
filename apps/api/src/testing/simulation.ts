/**
 * In-memory stand-ins for the run table and the queue, so the whole
 * `/simulate` surface can be driven with neither Postgres nor Redis in reach.
 *
 * ── What is substituted, and what is deliberately not ─────────────────────
 *
 * Postgres and Redis, and nothing else. The Fastify instance, the hooks, the
 * token verifier, the Zod compilers, the §11 visibility decision and the error
 * handler in every test are the real ones. That matters most here, because the
 * things worth asserting about this route are exactly the things a mock is
 * tempted to skip: that a stranger cannot read somebody's run, that a
 * deduplicated submission answers with the *other* run rather than creating a
 * second, and that a queue that cannot be reached is a 503 rather than a 500.
 *
 * The one rule a double must never break is disagreeing with production about
 * the rule under test:
 *
 *   - The run store applies `simulationRunFilter` — the very `where` fragment
 *     the Prisma implementation passes to the database — through the same
 *     evaluator the circuit repository double uses. It is not a second
 *     implementation of the visibility rule.
 *   - Every status write is a compare-and-set against `predecessorsOf`, so a
 *     terminal row is as final here as it is in Postgres.
 *   - `claimWork` is a real `SET NX`: first caller wins, everyone else is told
 *     who did.
 */

import { simulationRunFilter } from '@qsim/db'
import type {
  CreateRunInput,
  SimulationRunRepository,
  StoredRun,
} from '@qsim/db'
import { predecessorsOf } from '@qsim/jobs'
import type {
  JobProgress,
  RunEvent,
  RunStatus,
  SimulationJobPayload,
} from '@qsim/jobs'
import type { RunEventBus, RunEventListener } from '../plugins/events.js'
import type { SimulationQueue } from '../plugins/queue.js'
import { QueueUnavailableError } from '../plugins/queue.js'

export interface MemoryRunStore extends SimulationRunRepository {
  readonly rows: Map<string, StoredRun>
  /** Every circuit id this store believes the viewer may read, by viewer. */
  readonly readableCircuits: Map<string, Set<string>>
  seed(
    run: Partial<StoredRun> & { id: string; userId?: string | null }
  ): StoredRun
  /** Drives a row to a terminal state the way the worker would. */
  finish(id: string, result: unknown, durationMs?: number): void
}

interface Row extends StoredRun {
  userId: string | null
}

/**
 * Evaluates the `where` fragment `simulationRunFilter` produces.
 *
 * Written against the fragment rather than against the rule, and it throws on a
 * shape it does not recognise instead of defaulting to "visible" — so a change
 * to the filter breaks this loudly rather than quietly widening what these
 * tests consider allowed. The circuit clause is answered from
 * `readableCircuits`, which the test populates: this double has no circuit
 * table, and pretending to evaluate a `Circuit` filter here would be inventing
 * the very rule under test.
 */
function matches(
  row: Row,
  filter: ReturnType<typeof simulationRunFilter>,
  viewerId: string | null,
  readable: Set<string>
): boolean {
  const clauses = filter.AND
  if (!Array.isArray(clauses) || clauses.length !== 3) {
    throw new Error(
      'simulationRunFilter changed shape; update this double rather than ' +
        'letting it guess'
    )
  }

  const [byId, ownership, circuitClause] = clauses as [
    { id?: string },
    { userId?: string | null; OR?: { userId: string | null }[] },
    { OR?: unknown[] },
  ]

  if (byId.id !== row.id) return false

  const owners =
    ownership.OR ?? ([{ userId: ownership.userId ?? null }] as const)
  if (!owners.some((entry) => entry.userId === row.userId)) return false

  if (!Array.isArray(circuitClause.OR)) {
    throw new Error('simulationRunFilter lost its circuit clause')
  }
  if (row.circuitId === null) return true
  // The viewer must be able to read the circuit the run names. `viewerId` is
  // unused beyond selecting the set, which the caller already did.
  void viewerId
  return readable.has(row.circuitId)
}

export function createMemoryRunStore(): MemoryRunStore {
  const rows = new Map<string, Row>()
  const readableCircuits = new Map<string, Set<string>>()
  let counter = 0

  function readableFor(viewerId: string | null): Set<string> {
    return readableCircuits.get(viewerId ?? '') ?? new Set<string>()
  }

  function move(id: string, to: RunStatus, changes: Partial<Row>): boolean {
    const row = rows.get(id)
    if (row === undefined) return false
    if (!predecessorsOf(to).includes(row.status)) return false
    rows.set(id, { ...row, ...changes, status: to })
    return true
  }

  const store: MemoryRunStore = {
    // `Row` is `StoredRun` plus `userId`, which the projection deliberately
    // omits: authorisation happens in the `where`, so no response needs it.
    // The test still has to be able to set it, hence the wider row here.
    rows,
    readableCircuits,

    seed(run) {
      const row: Row = {
        id: run.id,
        userId: run.userId ?? null,
        circuitId: run.circuitId ?? null,
        mode: run.mode ?? 'STATEVECTOR',
        shots: run.shots ?? null,
        status: run.status ?? 'QUEUED',
        result: run.result ?? null,
        errorMessage: run.errorMessage ?? null,
        durationMs: run.durationMs ?? null,
        createdAt: run.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
      }
      rows.set(row.id, row)
      return row
    },

    finish(id, result, durationMs = 3) {
      move(id, 'DONE', { result: result as Row['result'], durationMs })
    },

    createRun(input: CreateRunInput) {
      counter++
      return Promise.resolve(
        store.seed({
          id: `run_${String(counter).padStart(19, '0')}`,
          userId: input.userId,
          circuitId: input.circuitId,
          mode: input.mode,
          shots: input.shots,
        })
      )
    },

    findReadableRun(id, viewerId) {
      const row = rows.get(id)
      if (row === undefined) return Promise.resolve(null)
      const filter = simulationRunFilter(id, viewerId)
      const visible = matches(row, filter, viewerId, readableFor(viewerId))
      return Promise.resolve(visible ? row : null)
    },

    claimRun(id) {
      return Promise.resolve(move(id, 'RUNNING', {}))
    },

    completeRun({ id, result, durationMs }) {
      return Promise.resolve(
        move(id, 'DONE', {
          result: result as Row['result'],
          errorMessage: null,
          durationMs,
        })
      )
    },

    failRun({ id, code, durationMs }) {
      return Promise.resolve(
        move(id, 'FAILED', { errorMessage: code, result: null, durationMs })
      )
    },

    runStatus(id) {
      return Promise.resolve(rows.get(id)?.status ?? null)
    },

    failStaleRuns({ before, code, limit }) {
      let moved = 0
      for (const row of [...rows.values()]) {
        if (moved >= limit) break
        if (row.status === 'DONE' || row.status === 'FAILED') continue
        if (row.createdAt.getTime() >= before.getTime()) continue
        rows.set(row.id, {
          ...row,
          status: 'FAILED',
          errorMessage: code,
          result: null,
          durationMs: null,
        })
        moved += 1
      }
      return Promise.resolve(moved)
    },

    discardRun({ id, userId }) {
      const row = rows.get(id)
      if (row === undefined) return Promise.resolve(false)
      if (row.userId !== userId || row.status !== 'QUEUED') {
        return Promise.resolve(false)
      }
      rows.delete(id)
      return Promise.resolve(true)
    },
  }

  return store
}

export interface MemoryQueueOptions {
  /** Every call rejects, which is what an unreachable Redis looks like. */
  readonly unavailable?: boolean
  /** `enqueue` alone rejects — a queue that answers reads and not writes. */
  readonly enqueueFails?: boolean
  /**
   * Called after a job is enqueued, so a test can decide what "the worker" did
   * before the synchronous wait resolves.
   */
  readonly onEnqueue?: (payload: SimulationJobPayload) => void
  /** What `awaitCompletion` reports. Defaults to whatever `onEnqueue` signalled. */
  readonly completes?: boolean
  /** `awaitCompletion` alone rejects — a connection that dropped mid-wait. */
  readonly awaitFails?: boolean
  /** What `depth` reports, so the queue-depth ceiling can be exercised. */
  readonly depth?: number
  readonly progress?: JobProgress | null
}

export interface MemoryQueue extends SimulationQueue {
  readonly enqueued: SimulationJobPayload[]
  /** The deduplication keys held, and the run each is held by. */
  readonly claims: Map<string, string>
}

export function createMemoryQueue(
  options: MemoryQueueOptions = {}
): MemoryQueue {
  const enqueued: SimulationJobPayload[] = []
  const claims = new Map<string, string>()
  const completed = new Set<string>()

  function guard(): void {
    if (options.unavailable === true) {
      throw new QueueUnavailableError('the fake queue is unavailable')
    }
  }

  return {
    enqueued,
    claims,

    claimWork({ key, runId }) {
      guard()
      // A real `SET NX`: first caller wins, everyone else is told who did.
      const existing = claims.get(key)
      if (existing !== undefined) return Promise.resolve(existing)
      claims.set(key, runId)
      return Promise.resolve(runId)
    },

    releaseWork({ key, runId }) {
      guard()
      // Compare-and-delete, as the Lua does: a key claimed by somebody else in
      // the meantime is not this caller's to release.
      if (claims.get(key) !== runId) return Promise.resolve(false)
      claims.delete(key)
      return Promise.resolve(true)
    },

    depth() {
      guard()
      return Promise.resolve(options.depth ?? 0)
    },

    enqueue(payload) {
      guard()
      if (options.enqueueFails === true) {
        return Promise.reject(
          new QueueUnavailableError('the fake queue refused a job')
        )
      }
      enqueued.push(payload)
      options.onEnqueue?.(payload)
      if (options.completes !== false) completed.add(payload.runId)
      return Promise.resolve()
    },

    awaitCompletion(runId) {
      guard()
      if (options.awaitFails === true) {
        return Promise.reject(
          new QueueUnavailableError('the fake queue stopped answering')
        )
      }
      return Promise.resolve(completed.has(runId))
    },

    progressOf() {
      return Promise.resolve(options.progress ?? null)
    },

    close() {
      return Promise.resolve()
    },
  }
}

/* ─────────────────────── the worker's side of the socket ─────────────── */

export interface MemoryEventBus extends RunEventBus {
  /** Publishes as the worker would, to whoever is subscribed right now. */
  publish(event: RunEvent): void
  /** Run ids with at least one live subscription, for refcount assertions. */
  readonly watched: () => string[]
  /** Every subscription ever opened, so a leak is visible to a test. */
  readonly opened: string[]
  /** Set to make the next `subscribe` reject, as an unreachable Redis would. */
  unavailable: boolean
}

/**
 * Redis pub/sub, modelled in memory.
 *
 * Substituted for the same reason `createMemoryQueue` is, and with the same
 * rule: it must not disagree with production about anything under test. So it
 * reference-counts channels exactly as `redisRunEventBus` does — two sockets
 * watching one run, one of them releasing, and the other still receiving is a
 * property this double has to have or the tests prove nothing — and it delivers
 * synchronously, which is the ordering a single Redis connection gives.
 */
export function createMemoryEventBus(): MemoryEventBus {
  const channels = new Map<string, Set<RunEventListener>>()
  const opened: string[] = []

  const bus: MemoryEventBus = {
    opened,
    unavailable: false,

    watched: () => [...channels.keys()],

    subscribe(runId, listener) {
      if (bus.unavailable) {
        return Promise.reject(new Error('the fake event bus is unavailable'))
      }
      opened.push(runId)
      const listeners = channels.get(runId) ?? new Set<RunEventListener>()
      listeners.add(listener)
      channels.set(runId, listeners)
      return Promise.resolve(() => {
        listeners.delete(listener)
        if (listeners.size === 0) channels.delete(runId)
      })
    },

    publish(event) {
      const listeners = channels.get(event.runId)
      if (listeners === undefined) return
      for (const listener of [...listeners]) listener(event)
    },

    close() {
      channels.clear()
      return Promise.resolve()
    },
  }

  return bus
}
