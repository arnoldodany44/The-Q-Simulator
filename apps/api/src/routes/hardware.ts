/**
 * Real hardware — §3.7, §8's `/hardware/*`, §11, risk 4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE CREDENTIAL IS THE USER'S, NOT THE PROJECT'S
 *
 * That sentence is §3.7 and risk 4, and it is the reason this router looks the
 * way it does. The Open Plan grants **ten minutes of QPU time per twenty-eight
 * days** and does not refill on request. If this service held one key, the
 * first person to submit a thousand-shot circuit would spend everybody's month.
 * So every route below names a credential explicitly, none of them falls back to
 * "the caller's only one", and there is no ambient key anywhere in this process.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE READ ENDPOINT RETURNS METADATA. THAT IS ENFORCED THREE TIMES.
 *
 * §11: «devuelve solo metadatos (proveedor, etiqueta, fecha), jamás el token.»
 *
 *   1. `hardwareCredentialMetaSelect` in `@qsim/db` **cannot fetch** the
 *      ciphertext — the constant does not name the column, so the query that
 *      serves this route is incapable of loading it.
 *   2. `HardwareCredentialResponse` in `@qsim/contract` has four fields and no
 *      fifth, and Fastify *serialises through it*, so anything extra a handler
 *      returned would be stripped before it reached a socket.
 *   3. The plaintext leaves `@qsim/db` through exactly one method,
 *      `openCredential`, which no route in this file calls. The only thing that
 *      opens a credential is `app.hardware.clientFor`, and what it hands back
 *      is a client — something that can *use* the key without exposing it.
 *
 * The test that matters is asserted from **the owner's own session**, because
 * "only the owner can read it" is the check people write instead of this one.
 * The owner may not read their own token either. There is nowhere to read it
 * from.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SUBMISSION IS SPLIT: THE API DECIDES, THE WORKER SPENDS
 *
 *   here          validate, resolve the circuit, fetch the device, transpile,
 *                 write the row SUBMITTED, schedule the first poll.
 *   apps/worker   send it to IBM, then poll until it finishes.
 *
 * The split is not tidiness. A `POST /jobs` at the provider can take seconds and
 * can fail in ways worth retrying, and a hardware job takes hours after that —
 * so the submission belongs in the process that already knows how to be
 * interrupted and resumed. Doing it here would mean the one irreversible,
 * allowance-spending call in this system happening on a request the client can
 * abandon halfway.
 *
 * What is *not* deferred is the transpilation, and that is deliberate the other
 * way: a circuit that cannot be placed on the device is a 422 the person sees
 * immediately, with the numbers that say why (`TranspileRefusal` carries "needs
 * 4 neighbours, the device has at most 3"). Deferring it would turn a
 * five-second refusal into a job that sits SUBMITTED and then fails.
 */

import { HARDWARE_ROUTES } from '@qsim/contract'
import type { HardwareProgram, StoredHardwareJob } from '@qsim/db'
import { parseStoredProgram } from '@qsim/db'
import { IBM_PROVIDER } from '@qsim/ibm'
import {
  DEFAULT_HARDWARE_SHOTS,
  parseHardwareResult,
  pollDelayMs,
} from '@qsim/jobs'
import { finalClassicalRegister } from '@qsim/qasm'
import { parseCircuit, safeExpandCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import {
  type TranspileRefusal,
  deviceGraph,
  safeTranspile,
} from '@qsim/transpile'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { requireViewerId } from '../plugins/auth.js'
import { CredentialNotFoundError } from '../plugins/hardware.js'
import type { HardwarePort } from '../plugins/hardware.js'
import type { HardwareQueue } from '../plugins/hardware-queue.js'
import { QueueUnavailableError } from '../plugins/queue.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  CreateHardwareCredentialBody,
  CreateHardwareJobBody,
  HardwareBackendListEnvelope,
  HardwareBackendsQuery,
  HardwareCredentialEnvelope,
  HardwareCredentialListEnvelope,
  HardwareIdParams,
  HardwareJobEnvelope,
  HardwareJobListEnvelope,
  HardwareJobsQuery,
  MAX_HARDWARE_JOB_PAGE,
} from './hardware.schemas.js'

export interface HardwareRoutesOptions {
  readonly env: ApiEnv
}

/**
 * The classical register the submitted program declares.
 *
 * Read out of the emitted OpenQASM rather than assumed, and that is the whole
 * point: the results document is keyed by register *name*, and picking the
 * wrong key produces a histogram of the wrong measurements that looks perfectly
 * plausible. Reading it from the text that was actually emitted means the two
 * cannot drift — a change to the emitter's register name is picked up here for
 * free, where a constant `'c'` would silently start reading nothing.
 */
function registerOf(qasm: string): { name: string; clbits: number } | null {
  const match = /^\s*bit\[(\d+)]\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/m.exec(qasm)
  if (match === null) return null
  const clbits = Number(match[1])
  const name = match[2]
  if (name === undefined || !Number.isInteger(clbits) || clbits < 1) return null
  return { name, clbits }
}

/** The hardware port, or the 503 that says hardware is unavailable. */
function requireHardware(app: FastifyInstance): HardwarePort {
  const hardware = app.hardware
  if (hardware === null) {
    /*
     * No master key, so no credential can be stored — and §11 has no weaker
     * mode. `SIMULATION_UNAVAILABLE` is reused rather than a fourth hardware
     * code because the fact is the same one every other "this dependency is
     * absent" answer states: the feature is off on this deployment and
     * everything else works.
     */
    throw new QueueUnavailableError('ENCRYPTION_KEY is not configured')
  }
  return hardware
}

/** The poll queue, or the same 503. */
function requireQueue(app: FastifyInstance): HardwareQueue {
  const queue = app.hardwareQueue
  if (queue === null) {
    throw new QueueUnavailableError('REDIS_URL is not configured')
  }
  return queue
}

/**
 * A `HardwareJob` row, as the wire carries it.
 *
 * Takes `StoredHardwareJob` — the repository's own projection — rather than a
 * structural shape, so that a column added to that projection is a compile
 * error here rather than a field that silently starts appearing in responses.
 * On a table that holds a pointer to somebody's credential, that is the
 * direction the type should push.
 */
function toJobResponse(row: StoredHardwareJob) {
  const program = parseStoredProgram(row.program)
  return {
    id: row.id,
    circuitId: row.circuitId,
    provider: row.provider,
    backend: row.backendName,
    providerJobId: row.providerJobId,
    shots: row.shots,
    status: row.status,
    queuePosition: row.queuePosition,
    program:
      program === null
        ? null
        : {
            qasm: program.qasm,
            layout: [...program.layout],
            register: program.register,
            clbits: program.clbits,
            /*
             * Forwarded only when the row has them. A response that turned an
             * absent field into `null` would let a client read "this job was
             * built from no version" where the truth is "this build did not
             * record one", and those two want different sentences on screen.
             */
            ...(program.versionId === undefined
              ? {}
              : { versionId: program.versionId }),
            ...(program.qubitOfClbit === undefined
              ? {}
              : { qubitOfClbit: [...program.qubitOfClbit] }),
            ...(program.calibratedAt === undefined
              ? {}
              : { calibratedAt: program.calibratedAt }),
          },
    /*
     * Parsed rather than passed through. A `Json` column is whatever was
     * written into it, including by an older build, and a response that
     * forwarded it unchecked would be this API's one place where an arbitrary
     * shape reaches a client. `parseHardwareResult` answers null for anything
     * it does not recognise, so a row written by a future version degrades to
     * "no result yet" on a page rather than to a 500 on a read.
     */
    result: parseHardwareResult(row.result),
    error: row.errorMessage,
    submittedAt: row.submittedAt,
    completedAt: row.completedAt,
  }
}

const plugin: FastifyPluginCallback<HardwareRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  /* ────────────────────────── credentials ─────────────────────────── */

  app.get(
    HARDWARE_ROUTES.credentials,
    {
      config: { auth: 'required' },
      schema: { response: { 200: HardwareCredentialListEnvelope } },
    },
    async (request) => {
      const hardware = requireHardware(app)
      const credentials = await hardware.repository.listCredentials(
        requireViewerId(request)
      )
      return { credentials }
    }
  )

  app.post(
    HARDWARE_ROUTES.credentials,
    {
      /*
       * The strict budget §11 singles out for authentication, and for the same
       * reason: this route performs an IAM token exchange per call, which is a
       * request to a third party that somebody else is being rate-limited by.
       * It is also the one route in this API where a body carries a secret, so
       * a caller trying many of them is a caller guessing.
       */
      config: { auth: 'required', rateLimit: strictRateLimit(env) },
      schema: {
        body: CreateHardwareCredentialBody,
        response: { 201: HardwareCredentialEnvelope },
      },
    },
    async (request, reply) => {
      const hardware = requireHardware(app)
      const userId = requireViewerId(request)
      const body = request.body

      /*
       * Proved before it is stored, and it costs no QPU time — an IAM exchange
       * spends nothing. The alternative is worse than it sounds: a mistyped key
       * is stored happily, and the person finds out an hour later when a
       * hardware job they were waiting on fails, having already chosen a
       * backend and a shot count. `IbmError` maps by shape, so a refused key is
       * "re-enter it" and an IAM that is merely down is "try again".
       */
      await hardware.verifyCredential({
        apiKey: body.apiKey,
        instance: body.instance,
      })

      /*
       * `hardware.store` and not `repository.createCredential`: the cipher
       * lives inside the port and there is no name bound to a
       * `CredentialCipher` anywhere in this file. Sealing is something the port
       * does, not something a route is handed the means to do.
       */
      const credential = await hardware.store({
        userId,
        provider: body.provider,
        label: body.label ?? null,
        document: { apiKey: body.apiKey, instance: body.instance },
      })

      reply.status(201)
      return { credential }
    }
  )

  app.get(
    HARDWARE_ROUTES.credential,
    {
      config: { auth: 'required' },
      schema: {
        params: HardwareIdParams,
        response: { 200: HardwareCredentialEnvelope },
      },
    },
    async (request) => {
      const hardware = requireHardware(app)
      const credential = await hardware.repository.findCredential(
        request.params.id,
        requireViewerId(request)
      )
      // 404 and never 403, for the reason every read in this API does it.
      if (credential === null) throw new ApiError('NOT_FOUND')
      return { credential }
    }
  )

  app.delete(
    HARDWARE_ROUTES.credential,
    {
      config: { auth: 'required' },
      schema: { params: HardwareIdParams },
    },
    async (request, reply) => {
      const hardware = requireHardware(app)
      const deleted = await hardware.repository.deleteCredential(
        request.params.id,
        requireViewerId(request)
      )
      if (!deleted) throw new ApiError('NOT_FOUND')
      /*
       * The bearer token derived from this credential is dropped from memory
       * immediately. Without it, a key somebody revoked because it leaked would
       * go on working from this process for up to an hour — which is exactly
       * the window a revocation exists to close.
       *
       * The jobs that named it keep their rows (`ON DELETE SET NULL`): a
       * person's record of what was run and what it cost is theirs, and a
       * credential deletion that erased it would be a delete they did not ask
       * for. Those jobs become unpollable, which the worker reports as
       * `CREDENTIAL_MISSING` rather than pretending.
       */
      hardware.forget(request.params.id)
      reply.status(204)
      return null
    }
  )

  /* ──────────────────────────── backends ──────────────────────────── */

  app.get(
    HARDWARE_ROUTES.backends,
    {
      config: { auth: 'required', rateLimit: strictRateLimit(env) },
      schema: {
        querystring: HardwareBackendsQuery,
        response: { 200: HardwareBackendListEnvelope },
      },
    },
    async (request) => {
      const hardware = requireHardware(app)
      const credentialId = request.query.credentialId
      const client = await clientOrNotFound(
        hardware,
        credentialId,
        requireViewerId(request)
      )
      /*
       * The queue length travels with every device, and it is the field this
       * route exists for. Measured on one morning: `ibm_fez` with 24 835 jobs
       * waiting and `ibm_marrakesh` with 15 — four orders of magnitude between
       * two devices that are otherwise indistinguishable on qubit count,
       * processor family and error rate. Choosing a backend is not a cosmetic
       * setting; it decides whether a result arrives today.
       */
      const backends = await client.backends()
      return { backends: [...backends], credentialId }
    }
  )

  /* ────────────────────────────── jobs ────────────────────────────── */

  app.get(
    HARDWARE_ROUTES.jobs,
    {
      config: { auth: 'required' },
      schema: {
        querystring: HardwareJobsQuery,
        response: { 200: HardwareJobListEnvelope },
      },
    },
    async (request) => {
      const hardware = requireHardware(app)
      const jobs = await hardware.repository.listJobs({
        userId: requireViewerId(request),
        ...(request.query.circuit === undefined
          ? {}
          : { circuitId: request.query.circuit }),
        limit: MAX_HARDWARE_JOB_PAGE,
      })
      return { jobs: jobs.map(toJobResponse) }
    }
  )

  app.post(
    HARDWARE_ROUTES.jobs,
    {
      /*
       * Strict, and this is the route the budget was invented for: one call
       * commits a slice of somebody's ten minutes per twenty-eight days to a
       * machine that will spend it whether or not the caller is still there.
       */
      config: { auth: 'required', rateLimit: strictRateLimit(env) },
      schema: {
        body: CreateHardwareJobBody,
        response: { 202: HardwareJobEnvelope },
      },
    },
    async (request, reply) => {
      const hardware = requireHardware(app)
      const queue = requireQueue(app)
      const userId = requireViewerId(request)
      const body = request.body
      const shots = body.shots ?? DEFAULT_HARDWARE_SHOTS

      /*
       * The circuit, through the ordinary readable filter. Two things happen
       * and both matter: the handle becomes an id, so the row points at
       * something real, and the caller proves they may read it — a hardware
       * job attributed to a circuit they cannot see would make the job a side
       * channel onto that circuit.
       */
      const stored = await app.circuits.findReadable(body.circuit, userId)
      if (stored === null) throw new ApiError('NOT_FOUND')
      const version = await app.circuits.latestVersion(stored.id)
      if (version === null) throw new ApiError('NOT_FOUND')
      // §11: validated before anything runs it, and this is the earliest point.
      const circuit: Circuit = parseCircuit(version.data)

      const client = await clientOrNotFound(hardware, body.credentialId, userId)

      /*
       * The device as it is *now*, calibration included. Not cached: a
       * calibration is re-measured several times a day and a stale one produces
       * a placement chosen from error rates that are no longer true — which is
       * a worse circuit, silently, with nothing anywhere saying so.
       */
      const target = await client.deviceTarget(body.backend)
      const graph = deviceGraph(target)

      const outcome = safeTranspile(circuit, graph, {
        title: stored.title,
      })
      if (!outcome.ok) {
        throw refusalToApiError(outcome.refusal)
      }
      const transpiled = outcome.value

      const register = registerOf(transpiled.qasm)
      if (register === null) {
        /*
         * Unreachable: `requireMeasurement` is on by default, so a program with
         * no classical register was already refused as `no-measurement`. If it
         * is ever reached, submitting would spend the allowance on a job whose
         * answer could not be read, which is the one outcome worth refusing
         * loudly.
         */
        throw new ApiError('HARDWARE_UNRUNNABLE', {
          details: [{ path: 'body.circuit', code: 'no-measurement' }],
        })
      }

      /*
       * THE ROW IS THE RECORD OF WHAT RAN, AND IT HAS TO BE COMPLETE HERE.
       *
       * Everything below is known at this instant and unknowable later. The
       * version, because a device queue is hours deep and the author will edit
       * the circuit while the job waits — without it, `/runs/:jobId` draws its
       * ideal column from a document the device never saw and prints the
       * difference as hardware error. The classical register map, because the
       * device answers with *its* register and turning a key into a basis state
       * needs the mapping the submitted document wrote (D1). The calibration
       * timestamp, because the placement was chosen from it and a device is
       * re-tuned about daily, so its age is what says how much to trust the
       * qubits — and it is in hand right now and gone the moment this handler
       * returns.
       */
      const flat = safeExpandCircuit(circuit)?.circuit ?? circuit
      const qubitOfClbit = finalClassicalRegister(
        flat.operations,
        register.clbits
      )

      const program: HardwareProgram = {
        qasm: transpiled.qasm,
        register: register.name,
        clbits: register.clbits,
        layout: transpiled.layout,
        versionId: version.id,
        /*
         * Only when the document's measurements make the device's register a
         * relabelling of the qubit register at all. A hole means some classical
         * bit is never written, which is a refusal on the reading side rather
         * than a mapping — storing a partial array would be storing a claim
         * that is not true.
         */
        ...(qubitOfClbit.every((qubit) => qubit !== undefined)
          ? { qubitOfClbit }
          : {}),
        calibratedAt: transpiled.calibratedAt,
      }

      const job = await hardware.repository.createJob({
        userId,
        circuitId: stored.id,
        credentialId: body.credentialId,
        provider: IBM_PROVIDER,
        backendName: body.backend,
        shots,
        program,
      })

      try {
        /*
         * Tick zero, with the schedule's own first delay rather than
         * immediately. Two seconds is not a throttle: it is what keeps the
         * *submission* — the irreversible, allowance-spending call — out of the
         * request that created the row, so a client that abandons the
         * connection has still committed exactly one job and the worker owns it
         * from here.
         */
        await queue.enqueueTick(
          { jobId: job.id, userId, tick: 0 },
          pollDelayMs(0)
        )
      } catch (error) {
        /*
         * The row exists and nothing will ever pick it up, so it is failed here
         * rather than left SUBMITTED. A job that sits submitted for ever is
         * worse than one that failed: a client polls it, and nothing changes.
         * Nothing was sent to the provider, so nothing was spent.
         */
        await hardware.repository.failJob({
          id: job.id,
          code: 'QUEUE_UNAVAILABLE',
          at: new Date(),
        })
        throw error
      }

      /*
       * 202 and never 201-with-a-result. There is no synchronous window here at
       * all, unlike `POST /simulate`: the fastest possible hardware job waits
       * behind whatever else is on the device, and the observed queue on one
       * morning was 24 835 jobs. Offering a wait would be offering a request
       * that holds a connection open for hours.
       */
      reply.status(202)
      return { job: toJobResponse(job) }
    }
  )

  app.get(
    HARDWARE_ROUTES.job,
    {
      config: { auth: 'required' },
      schema: {
        params: HardwareIdParams,
        response: { 200: HardwareJobEnvelope },
      },
    },
    async (request) => {
      const hardware = requireHardware(app)
      const job = await hardware.repository.findJob(
        request.params.id,
        requireViewerId(request)
      )
      if (job === null) throw new ApiError('NOT_FOUND')
      return { job: toJobResponse(job) }
    }
  )

  app.delete(
    HARDWARE_ROUTES.job,
    {
      config: { auth: 'required' },
      schema: {
        params: HardwareIdParams,
        response: { 200: HardwareJobEnvelope },
      },
    },
    async (request) => {
      const hardware = requireHardware(app)
      const userId = requireViewerId(request)
      const id = request.params.id

      const job = await hardware.repository.findJob(id, userId)
      if (job === null) throw new ApiError('NOT_FOUND')

      /*
       * THE ROW IS MOVED FIRST, AND THAT ORDER IS THE WHOLE DESIGN.
       *
       * The compare-and-set to CANCELLED is what makes "a job cancelled before
       * it was sent is never sent" true: the worker's submission is itself a
       * compare-and-set on SUBMITTED, so whichever of the two lands first, the
       * other matches zero rows. Telling the provider first and writing after
       * would leave a window where the row still says SUBMITTED and a tick
       * happily submits a job the person has already cancelled — spending
       * allowance on work nobody wants.
       */
      const cancelled = await hardware.repository.cancelJob({
        id,
        userId,
        at: new Date(),
      })
      if (!cancelled) {
        // Already terminal. Idempotent rather than an error: pressing cancel
        // twice, or cancelling a job that finished a second ago, is not a
        // mistake worth a 409.
        return { job: toJobResponse(job) }
      }

      if (job.providerJobId !== null) {
        /*
         * Best effort, and deliberately after the row. A cancellation the
         * provider refuses still leaves this system's row CANCELLED, which is
         * the honest state: this service will not collect the result and will
         * not poll again. The device may still run it — that is the provider's
         * business and their console shows it — and pretending otherwise by
         * failing the request would leave the person unable to cancel at all.
         *
         * The credential comes from the *poll* projection rather than from the
         * response one, because `credentialId` is deliberately absent from what
         * a client is shown: an identifier in a response is an identifier loose
         * in the world. Ownership was already decided by `findJob` above, so
         * this unscoped read is the same exception the worker's poll is.
         */
        try {
          const pollable = await hardware.repository.findPollable(id)
          const credentialId = pollable?.credentialId ?? null
          if (credentialId === null) {
            request.log.info(
              { jobId: id },
              'the job names no credential, so the provider cannot be told'
            )
          } else {
            const client = await hardware.clientFor(credentialId, userId)
            await client.cancelJob(job.providerJobId)
          }
        } catch (error) {
          request.log.warn(
            { err: error, jobId: id },
            'the provider did not accept a cancellation; the row is cancelled'
          )
        }
      }

      const updated = await hardware.repository.findJob(id, userId)
      return { job: toJobResponse(updated ?? job) }
    }
  )

  done()
}

/**
 * A client for a credential, or a 404.
 *
 * `CredentialNotFoundError` becomes NOT_FOUND rather than a 400 on the field:
 * naming a credential that is not yours must be indistinguishable from naming
 * one that does not exist, or the route is an oracle over other people's
 * credential ids.
 */
async function clientOrNotFound(
  hardware: HardwarePort,
  credentialId: string,
  userId: string
) {
  try {
    return await hardware.clientFor(credentialId, userId)
  } catch (error) {
    if (error instanceof CredentialNotFoundError)
      throw new ApiError('NOT_FOUND')
    throw error
  }
}

/**
 * A refusal from the transpiler, as a 422 that carries its numbers.
 *
 * The numbers are the point. `TranspileRefusal` says "needs 4 neighbours, the
 * device has at most 3", and that sentence teaches the reader the true thing
 * about a NISQ machine — that connectivity, not qubit count, is what bounds it.
 * They travel as `details` rather than in a message so the client can render
 * them in three languages from a code (D2); every value is a number or a short
 * identifier that came from the circuit or from the device.
 */
function refusalToApiError(refusal: TranspileRefusal): ApiError {
  const details = [
    { path: 'body.circuit', code: refusal.code },
    ...Object.entries(refusal.detail).map(([key, value]) => ({
      path: 'body.circuit',
      code: `${key}:${String(value)}`,
    })),
    ...refusal.operationIds.slice(0, 8).map((operationId) => ({
      path: `body.circuit.operations.${operationId}`,
      code: refusal.code,
    })),
  ]
  return new ApiError('HARDWARE_UNRUNNABLE', { details, cause: refusal })
}

export const hardwareRoutes = plugin
