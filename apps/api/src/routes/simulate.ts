/**
 * Server-side simulation — §8's `/simulate`, and §4's argument for it existing.
 *
 * ── The endpoint has three successful answers ─────────────────────────────
 *
 *   201  a new run was created and finished inside the synchronous window.
 *   202  a new run was created and is still going. Poll `GET /simulate/:runId`.
 *   200  nothing was created: identical work was already in flight, and this
 *        is that run.
 *
 * All three carry the same envelope, which is also what the `GET` returns, so a
 * client writes one renderer and branches on `run.status` rather than on a
 * status code. The status code is still worth getting right: 201 and 200 differ
 * on whether a resource came into existence, and that is the one thing a
 * caller cannot infer from the body.
 *
 * ── Nothing here runs a simulation ────────────────────────────────────────
 *
 * The whole argument is in `plugins/queue.ts`. In short: a simulation runs in
 * exactly one place in this system, a killable child of `apps/worker` (§11),
 * and "synchronous if small" is a promise about the response rather than about
 * which process did the arithmetic.
 *
 * ── The order of operations, which is not arbitrary ───────────────────────
 *
 *   1. validate the circuit with `parseCircuit` — §11 says before the engine,
 *      and this is the earliest place that can happen;
 *   2. resolve `circuitId` through the ordinary readable-circuit filter, so a
 *      run cannot be attributed to something the caller may not see;
 *   3. apply §11's resource limits, *before* a row exists;
 *   4. create the row QUEUED;
 *   5. claim the deduplication key;
 *   6. enqueue.
 *
 * Steps 4 and 5 are the wrong way round for tidiness and the right way round
 * for correctness: the job payload names the row it writes into, so the row has
 * to exist before the job can. The cost is that the loser of a deduplication
 * race has a row to clean up, which `discardRun` does — scoped to its own id
 * and owner, and only while it is still QUEUED.
 *
 * Between 4 and 6 there is one window this route cannot close: a process that
 * dies exactly there leaves a QUEUED row that no job will ever pick up. It
 * reads back correctly (`GET` answers QUEUED), it is bounded by `createdAt`,
 * and closing it would need either a two-phase commit across Postgres and
 * Redis or a sweeper — neither of which is worth building for a window a
 * SIGKILL has to land inside. An enqueue that *fails* is handled properly: the
 * row is marked FAILED with `QUEUE_UNAVAILABLE` rather than left behind.
 */

import { createHash } from 'node:crypto'
import { SIMULATE_ROUTES } from '@qsim/contract'
import { randomSeed } from '@qsim/core'
import type { SimMode } from '@qsim/db'
import {
  MAX_QUEUE_DEPTH,
  canonicalWork,
  checkLimits,
  estimatedDurationMs,
  routeOf,
  shapeOf,
} from '@qsim/jobs'
import type { SimulationJobPayload } from '@qsim/jobs'
import { CircuitValidationError, safeParseCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
} from 'fastify'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { viewerIdOf } from '../plugins/auth.js'
import { QueueUnavailableError, workKey } from '../plugins/queue.js'
import type { SimulationQueue } from '../plugins/queue.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import {
  MAX_ERROR_DETAILS,
  withTruncationMarker,
} from '../plugins/validation.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  RunEnvelope,
  RunParams,
  SimulateBody,
  toRunResponse,
} from './simulate.schemas.js'

export interface SimulateRoutesOptions {
  readonly env: ApiEnv
}

/**
 * Shots for a mode that was not given any.
 *
 * A trajectories run with no shot count is not a run — the mode *is* the shot
 * loop (§5.3) — so it gets a default rather than a refusal. A thousand is where
 * the sampling error (1/(2√N) ≈ 1.6 %) is already below the size of the effects
 * §3.3 exists to show, and it is two orders below the ceiling, so the default
 * can never be the expensive choice.
 */
const DEFAULT_TRAJECTORY_SHOTS = 1_000

/**
 * Validates an incoming circuit with @qsim/schema and nothing else.
 *
 * The same function, for the same reason, as `acceptCircuit` in
 * `routes/circuits.ts`: the route schema gives a 400 a field path, and
 * `safeParseCircuit` is the whole contract — the shape plus the rules a shape
 * cannot express. §11 requires the second before the engine sees anything, and
 * the worker runs it *again* on the way out of the queue, because a job in
 * Redis is a job anything holding the connection string can add.
 */
function acceptCircuit(input: unknown): Circuit {
  const result = safeParseCircuit(input)
  if (result.ok) return result.circuit

  const details = result.issues.slice(0, MAX_ERROR_DETAILS).map((issue) => ({
    path:
      issue.operationId === undefined
        ? 'body.circuit'
        : `body.circuit.operations.${issue.operationId}`,
    code: issue.code,
  }))

  throw new ApiError('VALIDATION_FAILED', {
    details: withTruncationMarker(
      details,
      result.issues.length,
      'body.circuit'
    ),
    cause: new CircuitValidationError(result.issues),
  })
}

/** The queue, or the 503 that says server simulation is unavailable. */
function requireQueue(app: FastifyInstance): SimulationQueue {
  const queue = app.simulations
  if (queue === null) {
    throw new QueueUnavailableError('REDIS_URL is not configured')
  }
  return queue
}

/**
 * The shot count this mode will actually use, or a 400.
 *
 * `DENSITY_MATRIX` is refused rather than silently ignored. ρ is evolved
 * exactly and draws nothing (§5.4), so a shot count on it is a
 * misunderstanding — and a request whose field quietly did not happen is worse
 * than one that failed, because the caller goes on believing they asked for
 * something.
 */
function shotsFor(mode: SimMode, requested: number | undefined): number | null {
  if (mode === 'DENSITY_MATRIX') {
    if (requested === undefined) return null
    throw new ApiError('VALIDATION_FAILED', {
      details: [{ path: 'body.shots', code: 'unsupported_for_mode' }],
    })
  }
  if (mode === 'TRAJECTORIES') return requested ?? DEFAULT_TRAJECTORY_SHOTS
  return requested ?? null
}

/**
 * The stored circuit this run is about, resolved through the ordinary filter.
 *
 * Two things happen here and both matter. The handle becomes an id, so the row
 * points at something real; and the caller proves they may read it, so a run
 * cannot be attributed to a circuit they cannot see — which would make the run
 * a side channel onto it, since `simulationRunFilter` joins back through this
 * column when the run is read.
 */
async function resolveCircuitId(
  app: FastifyInstance,
  request: FastifyRequest,
  handle: string | undefined
): Promise<string | null> {
  if (handle === undefined) return null
  const circuit = await app.circuits.findReadable(handle, viewerIdOf(request))
  if (circuit === null) throw new ApiError('NOT_FOUND')
  return circuit.id
}

/** §11's resource limits, as a 413 that names what was refused. */
function assertWithinLimits(
  payload: Omit<SimulationJobPayload, 'runId'>,
  env: ApiEnv
): void {
  const refusal = checkLimits(shapeOf(payload), {
    maxQubits: env.queue.maxQubits,
    timeoutMs: env.queue.timeoutMs,
  })
  if (refusal === null) return
  throw new ApiError('SIMULATION_TOO_LARGE', {
    /*
     * The numbers travel as details rather than in a message, so the client can
     * say "24 qubits is the ceiling and you asked for 26" in three languages
     * from a code (D2). `value` and `limit` are numbers and are safe to echo:
     * they came from the request and from a constant.
     */
    details: [
      { path: 'body.circuit', code: refusal.code },
      { path: 'body.circuit', code: `value:${String(refusal.value)}` },
      { path: 'body.circuit', code: `limit:${String(refusal.limit)}` },
    ],
  })
}

/**
 * Refuses a submission when the queue is already deeper than it can drain.
 *
 * A 429 rather than a 503, and the distinction is what the caller should do
 * about it: the service is up, the work is real, and the answer is to come back
 * — which is what `RATE_LIMITED` means everywhere else in this API. A depth
 * that cannot be read is *not* a refusal: that is a Redis failure, and the
 * enqueue immediately after it will produce the 503 with the compensation the
 * route already has.
 */
async function assertQueueHasRoom(queue: SimulationQueue): Promise<void> {
  let waiting: number
  try {
    waiting = await queue.depth()
  } catch {
    return
  }
  if (waiting < MAX_QUEUE_DEPTH) return
  throw new ApiError('RATE_LIMITED', {
    details: [
      { path: 'queue', code: 'queue-depth-exceeded' },
      { path: 'queue', code: `value:${String(waiting)}` },
      { path: 'queue', code: `limit:${String(MAX_QUEUE_DEPTH)}` },
    ],
  })
}

/**
 * Claims the work, failing this caller's row if Redis cannot answer.
 *
 * The row is created before the claim (the job payload names the row it writes
 * into), so a Redis outage at this step used to leave it QUEUED for ever —
 * unreachable, because its id was never returned. One step later the same
 * outage is compensated properly; this is the same compensation at the step
 * before it.
 */
async function claimOrFail(
  app: FastifyInstance,
  queue: SimulationQueue,
  input: { key: string; runId: string; viewerId: string | null }
): Promise<string> {
  try {
    return await queue.claimWork({ key: input.key, runId: input.runId })
  } catch (error) {
    await app.runs.failRun({
      id: input.runId,
      code: 'QUEUE_UNAVAILABLE',
      durationMs: null,
    })
    throw error
  }
}

/** Waits for the completion signal, treating "could not watch" as "not yet". */
async function watchQuietly(
  app: FastifyInstance,
  queue: SimulationQueue,
  runId: string,
  windowMs: number
): Promise<boolean> {
  try {
    return await queue.awaitCompletion(runId, windowMs)
  } catch (error) {
    app.log.warn(
      { err: error, runId },
      'could not watch a run for the synchronous window; answering 202'
    )
    return false
  }
}

const plugin: FastifyPluginCallback<SimulateRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  app.post(
    SIMULATE_ROUTES.collection,
    {
      /*
       * Anonymous is allowed: §4 puts the editor in front of people who have
       * not signed in, and a run belongs to a user *or to nobody*. What bounds
       * the giveaway is the strict budget §11 singles this route out for — it
       * is the one endpoint where a single request can cost a minute of a
       * dedicated process.
       */
      config: { auth: 'optional', rateLimit: strictRateLimit(env) },
      schema: {
        body: SimulateBody,
        response: { 200: RunEnvelope, 201: RunEnvelope, 202: RunEnvelope },
      },
    },
    async (request, reply) => {
      const queue = requireQueue(app)
      const viewerId = viewerIdOf(request)
      const body = request.body

      const circuit = acceptCircuit(body.circuit)
      const circuitId = await resolveCircuitId(app, request, body.circuitId)

      const work = {
        circuit,
        mode: body.mode,
        shots: shotsFor(body.mode, body.shots),
        /*
         * Minted here when the caller did not supply one, and echoed in the
         * result. "Unseeded" has to mean "seeded with a number we can show
         * you": a run nobody can repeat is not an authoritative answer, which
         * is one of §4's three reasons for this endpoint to exist at all.
         */
        seed: body.seed ?? randomSeed(),
        noiseProfileId: body.noiseProfileId ?? null,
        readout: body.readout,
        submittedBy: viewerId,
        circuitId,
      } satisfies Omit<SimulationJobPayload, 'runId'>

      assertWithinLimits(work, env)

      /*
       * Computed here because here is the only place the circuit exists. It
       * travels on every answer this route gives — including the 200 for a
       * deduplicated submission, where the work is by definition identical, so
       * the estimate is too — and it is what lets a client waiting on a run id
       * say "about fifteen seconds" instead of showing a spinner with no end.
       *
       * Rounded to a whole millisecond because the wire schema is an integer,
       * and floored at 1: a model that answers "0 ms" for work that is plainly
       * happening reads as a pipeline that did not run, which is the same
       * complaint the panel's duration formatter already exists to answer.
       */
      const estimateMs = Math.max(
        1,
        Math.round(estimatedDurationMs(shapeOf(work)))
      )

      /*
       * Before the row, because a refusal must not leave one behind. The
       * instance is 256 MB with `noeviction` and every job carries a whole
       * circuit document, so a queue nobody bounds does not slow down — it
       * fills, and then every write in the system fails at once, including the
       * ones that would have reported the problem. See `MAX_QUEUE_DEPTH`.
       */
      await assertQueueHasRoom(queue)

      const run = await app.runs.createRun({
        userId: viewerId,
        circuitId,
        mode: work.mode,
        shots: work.shots,
        // The profile is stored as it was asked for, by id. §7 types the
        // column as Json because a future milestone stores a whole device.
        noiseProfile:
          work.noiseProfileId === null ? null : { id: work.noiseProfileId },
      })

      /*
       * SHA-256 and not a cheaper hash, because a collision here is not a wrong
       * number — it is the wrong *answer*, handed to the wrong person, over a
       * circuit that is not theirs. The key keeps 128 bits of the digest, which
       * is the same order as the entropy §11 sizes an unlisted circuit's whole
       * access control at — the *digest*, not the job id built from one, which
       * would leave 112 after the key's own truncation.
       */
      const digest = createHash('sha256')
        .update(canonicalWork(work))
        .digest('hex')
      const key = workKey(env, digest)
      const owner = await claimOrFail(app, queue, {
        key,
        runId: run.id,
        viewerId,
      })

      if (owner !== run.id) {
        const existing = await app.runs.findReadableRun(owner, viewerId)
        /*
         * A FAILED winner is not a winner. The key survives the failure and
         * carries no status, so a reader pressing "run on the server" again
         * after a failure — a byte-identical body, because the seed is the
         * panel's default — was handed the same failed run and nothing was
         * enqueued, for up to five minutes. That reads as an application that
         * has stopped responding to input. Releasing the key and re-claiming it
         * is what makes the retry a retry; if somebody else claims it in
         * between, this submission collapses onto *their* run, which is exactly
         * what deduplication is for.
         */
        const retry =
          existing !== null &&
          existing.status === 'FAILED' &&
          (await queue.releaseWork({ key, runId: owner })) &&
          (await claimOrFail(app, queue, {
            key,
            runId: run.id,
            viewerId,
          })) === run.id

        if (!retry) {
          await app.runs.discardRun({ id: run.id, userId: viewerId })
          /*
           * Unreachable through this route — the key was written by a
           * submission whose work digest includes this same viewer, so the run
           * is one this viewer may read. If it is ever null the key has
           * outlived its row, and the honest answer is that there is nothing to
           * point at.
           */
          if (existing === null) throw new ApiError('NOT_FOUND')
          reply.status(200)
          return {
            run: toRunResponse(existing, { estimatedDurationMs: estimateMs }),
          }
        }
      }

      try {
        await queue.enqueue({ runId: run.id, ...work })
      } catch (error) {
        /*
         * The row exists and nothing will ever pick it up, so it is failed here
         * rather than left QUEUED. A run that sits queued forever is worse than
         * one that failed: a client polls it, and nothing ever changes.
         */
        await app.runs.failRun({
          id: run.id,
          code: 'QUEUE_UNAVAILABLE',
          durationMs: null,
        })
        throw error
      }

      const immediate =
        routeOf(shapeOf(work), env.queue.syncWaitMs) === 'immediate'
      if (immediate) {
        /*
         * A failure to *observe* the completion is not the run's failure. The
         * job is enqueued and the row exists; answering 503 here would throw
         * away the one thing that makes the run collectable — its id — while
         * the worker went on spending a full job's CPU on it. The route already
         * treats "did not finish in the window" as an ordinary 202, and a
         * Redis that dropped mid-wait is the same outcome arrived at faster.
         */
        const observed = await watchQuietly(
          app,
          queue,
          run.id,
          env.queue.syncWaitMs
        )
        const finished = observed
          ? await app.runs.findReadableRun(run.id, viewerId)
          : null
        if (finished !== null && finished.status !== 'QUEUED') {
          /*
           * 201 even for a run that finished FAILED. The resource was created
           * and this is its final state; a failed simulation is not a failed
           * request, and answering 500 would put a user's bad circuit in this
           * service's error budget.
           */
          reply.status(finished.status === 'RUNNING' ? 202 : 201)
          return {
            run: toRunResponse(finished, {
              estimatedDurationMs: estimateMs,
            }),
          }
        }
      }

      reply.status(202)
      return { run: toRunResponse(run, { estimatedDurationMs: estimateMs }) }
    }
  )

  app.get(
    SIMULATE_ROUTES.run,
    {
      /*
       * Optional rather than required, because an anonymous submission has to
       * be able to collect its own answer. `simulationRunFilter` is what makes
       * that safe: for an anonymous run the id is the credential, and a run
       * with an owner is that owner's alone.
       *
       * The ordinary rate-limit budget rather than the strict one: this is the
       * route a client polls, and a poll that trips the same limit as a
       * submission would make the queued path unusable.
       */
      config: { auth: 'optional' },
      schema: { params: RunParams, response: { 200: RunEnvelope } },
    },
    async (request) => {
      const viewerId = viewerIdOf(request)
      const run = await app.runs.findReadableRun(request.params.runId, viewerId)
      // 404 and never 403, for the reason every read in this API does it: 403
      // would confirm that the run exists.
      if (run === null) throw new ApiError('NOT_FOUND')

      /*
       * Progress lives in Redis and is asked for only while there is something
       * to ask about. `progressOf` never throws — a queue outage degrades this
       * to a run without a progress field, which is what the contract's
       * nullable `progress` is for.
       */
      const queue = app.simulations
      const progress =
        queue !== null && run.status === 'RUNNING'
          ? await queue.progressOf(run.id)
          : null

      return { run: toRunResponse(run, { progress }) }
    }
  )

  done()
}

export const simulateRoutes = plugin
