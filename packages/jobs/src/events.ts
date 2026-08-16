/**
 * What the worker tells the API while a job is running — the other half of §8's
 * WebSocket, seen from the side that has no socket.
 *
 * ── The gap this crosses, and why it needed a decision ────────────────────
 *
 * `apps/worker` and `apps/api` are separate processes on separate containers.
 * The worker knows a run's progress; the socket that a browser is holding
 * belongs to the API. Nothing the worker can write reaches that socket
 * directly, so something in the middle has to carry it, and there were two
 * candidates already in the system.
 *
 * **BullMQ's own `QueueEvents` was rejected.** It is a permanently blocking
 * `XREAD` on a Redis *stream* that carries every event of every job — added,
 * active, progress, completed, failed — into every API replica, for as long as
 * the process lives, whether or not anybody is watching anything. On a shared,
 * metered, 256 MB instance that is a standing cost with no floor. It is the
 * same objection `plugins/queue.ts` already raised against using
 * `waitUntilFinished` for the synchronous window, and it is stronger here
 * because a stream is *retained*: the events accumulate as memory on the tier
 * until they are trimmed, so the price of nobody listening is paid twice.
 *
 * **Redis pub/sub was chosen.** It is fire-and-forget with no retention, one
 * channel per run so a replica receives only what one of its clients asked for,
 * and it costs exactly nothing when no socket is open — the API subscribes on
 * the first watcher and unsubscribes on the last. The worker already holds a
 * Redis connection, so publishing is one `PUBLISH` per event on a stream of
 * events that `shouldReport` has already throttled to about four a second.
 *
 * ── Pub/sub loses messages, and that is why this is a notification ────────
 *
 * At-most-once delivery is the price. A subscriber that is reconnecting, a
 * replica that was restarted, a network blip — any of them drops events on the
 * floor with no error anywhere. That would be unacceptable if these frames were
 * the *answer*; it is fine because they are not. The answer lives in Postgres
 * and is read with `GET /simulate/:runId`, exactly as it was before this file
 * existed. These events only say "there is something new to read", which is why
 * `run:complete` carries a status and not a result — the same reasoning that
 * keeps `completionKey` a single byte.
 *
 * A client that misses everything still finishes: it reconnects, re-subscribes
 * and reads the run. A client that misses nothing simply finds out sooner.
 *
 * ── Why the shapes are declared twice in this repository ──────────────────
 *
 * These are the *worker → API* payloads. The *API → browser* frames live in
 * `@qsim/contract`, because `apps/web` may not import this package, and this
 * package may not import that one (§12.3, and both directions are enforced in
 * `.dependency-cruiser.cjs`). The two are deliberately not the same type: the
 * API translates, adding nothing a browser has no business seeing and dropping
 * anything a client cannot act on. `apps/api` is the one workspace that holds
 * both, and it is where a test asserts they still agree — the same arrangement
 * as `RunStatus`, which is declared in Prisma, here, and in the contract.
 */

import { z } from 'zod'
import { JobProgressSchema } from './progress.js'
import { RUN_STATUSES } from './run.js'
import type { RunStatus } from './run.js'

/**
 * The three event names §8 lists for `/ws`.
 *
 * `job:status` is the queue's own lifecycle rather than the engine's: it fires
 * when a run leaves the queue and a worker claims it. That transition is
 * invisible in `run:progress` — a job can sit QUEUED for a minute behind other
 * work and report nothing, because there is nothing to report — and it is
 * precisely the moment a reader waiting on an estimate needs, since every
 * duration this system estimates is engine time and starts here.
 */
export const RUN_EVENT_TYPES = [
  'run:progress',
  'run:complete',
  'job:status',
] as const

export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

/**
 * A run id, bounded on the way *in*.
 *
 * A pub/sub payload is untrusted for the same reason a job payload is: anything
 * holding the connection string can publish one. The id is echoed into a socket
 * frame, so it is bounded and character-classed here rather than downstream —
 * the same gate `RunParams` puts in front of the HTTP route.
 */
const RunIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

/** Epoch milliseconds, stamped by the publisher. See `at` below. */
const InstantSchema = z.int().min(0)

const RunStatusSchema = z.enum(
  RUN_STATUSES as unknown as [RunStatus, ...RunStatus[]]
)

const TerminalStatusSchema = z.enum(['DONE', 'FAILED'])

/**
 * One event, as it travels through Redis.
 *
 * `at` is the publisher's clock and is carried for one purpose only: an event
 * that arrives after a later one — possible across a reconnect, since pub/sub
 * promises nothing about order between connections — can be recognised and
 * dropped rather than repainting a progress bar backwards. It is never
 * displayed, because it is a *different machine's* clock and a browser has no
 * way to know the skew.
 */
export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run:progress'),
    runId: RunIdSchema,
    at: InstantSchema,
    progress: JobProgressSchema,
  }),
  z.object({
    type: z.literal('job:status'),
    runId: RunIdSchema,
    at: InstantSchema,
    status: RunStatusSchema,
  }),
  z.object({
    type: z.literal('run:complete'),
    runId: RunIdSchema,
    at: InstantSchema,
    status: TerminalStatusSchema,
    /** Engine time, once known. Null for a run that failed before it started. */
    durationMs: z.int().min(0).nullable(),
    /**
     * The `SimulationFailureCode`, or null for a run that succeeded.
     *
     * A code and never prose, for the reason the whole system works that way
     * (D2): this reaches a trilingual client, which renders it from a catalog.
     */
    error: z.string().max(64).nullable(),
  }),
])

export type RunEvent = z.infer<typeof RunEventSchema>

/**
 * Where a run's events are published.
 *
 * One channel per run rather than one channel for the queue, and the reason is
 * bandwidth on a metered tier rather than tidiness. With a shared channel every
 * API replica receives every event of every run and discards almost all of
 * them; with a channel per run, Redis does the routing and a replica is billed
 * only for the runs its own clients are watching. The cost is one `SUBSCRIBE`
 * and one `UNSUBSCRIBE` per watched run, which is two commands for something
 * that then runs for seconds.
 *
 * Namespaced under the same prefix as every other key this system owns, for the
 * reason `queue.ts` gives: development, production and every test share one
 * instance, and the prefix is the only thing keeping them apart.
 */
export function runEventChannel(prefix: string, runId: string): string {
  return `${prefix}:events:${runId}`
}

/**
 * The largest event this system will publish or accept, in bytes.
 *
 * Every field above is bounded — a progress report is three small numbers, a
 * completion is a status and a 64-character code — so a legitimate event is a
 * couple of hundred bytes. This is the gate in front of `JSON.parse` on the
 * receiving side, and it is what stops a megabyte published by anything holding
 * the connection string from being parsed at all.
 */
export const MAX_RUN_EVENT_BYTES = 1024

export function encodeRunEvent(event: RunEvent): string {
  return JSON.stringify(event)
}

/**
 * An event off the wire, or `null`.
 *
 * Never throws, and that is the contract the subscriber depends on: this is
 * called from a Redis `message` listener, where a throw is an unhandled
 * rejection on an EventEmitter and takes the process down. A payload that does
 * not parse is a payload nobody can act on, so it is dropped and logged by the
 * caller — one malformed publish must not be able to sever a socket that is
 * otherwise delivering a run perfectly.
 */
export function parseRunEvent(raw: string): RunEvent | null {
  if (raw.length > MAX_RUN_EVENT_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = RunEventSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
