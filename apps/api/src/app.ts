/**
 * The Fastify instance, assembled but not listening.
 *
 * Keeping construction separate from `listen()` is what makes the whole
 * service testable through `inject()`: every test in this package builds a
 * real app — real hooks, real plugins, real error handler — and drives it
 * without binding a port. There is no mock of the thing under test, which
 * matters most for authentication, where a mocked verifier is how an auth
 * bug survives a green suite.
 *
 * ── Registration order is behaviour, not taste ────────────────────────────
 *
 *   1. compilers      — must exist before any route is compiled
 *   2. error handling — so a plugin that fails at boot still answers in shape
 *   3. CORS           — before anything that can reject, or the browser sees
 *                       a CORS failure instead of the real status
 *   4. auth (resolve) — verifies, never rejects
 *   5. rate limit     — keyed on the identity from step 4
 *   6. auth (enforce) — rejects, but only after the request was counted
 *   7. database       — lazy; connects on first query, not at boot
 *   8. routes         — after every hook above, or they miss the ones added
 *                       later
 *
 * Steps 4-6 are argued in full in `plugins/auth.ts`. Step 3 is the one that
 * looks optional and is not: a 401 without `Access-Control-Allow-Origin` is
 * reported by the browser as a CORS error, and the developer then spends an
 * afternoon on the wrong problem.
 */

import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { API_PREFIX, MAX_SOCKET_FRAME_BYTES } from '@qsim/contract'
import Fastify from 'fastify'
import type { FastifyServerOptions } from 'fastify'
import type { ApiEnv } from './env.js'
import { configurationWarnings } from './env.js'
import { ApiError, toApiError } from './errors.js'
import { buildLoggerOptions } from './logging.js'
import apiKeysPlugin from './plugins/api-keys.js'
import type { ApiKeysPluginOptions } from './plugins/api-keys.js'
import authPlugin, { authEnforcement } from './plugins/auth.js'
import circuitsPlugin from './plugins/circuits.js'
import type { CircuitsPluginOptions } from './plugins/circuits.js'
import collabPlugin from './plugins/collab.js'
import type { CollabPluginOptions } from './plugins/collab.js'
import databasePlugin from './plugins/database.js'
import type { DatabasePluginOptions } from './plugins/database.js'
import eventsPlugin from './plugins/events.js'
import type { EventsPluginOptions } from './plugins/events.js'
import hardwarePlugin from './plugins/hardware.js'
import type { HardwarePluginOptions } from './plugins/hardware.js'
import hardwareQueuePlugin from './plugins/hardware-queue.js'
import type { HardwareQueuePluginOptions } from './plugins/hardware-queue.js'
import queuePlugin from './plugins/queue.js'
import type { QueuePluginOptions } from './plugins/queue.js'
import rateLimitPlugin from './plugins/rate-limit.js'
import runsPlugin from './plugins/runs.js'
import type { RunsPluginOptions } from './plugins/runs.js'
import {
  zodSerializerCompiler,
  zodValidatorCompiler,
} from './plugins/validation.js'
import type { ZodTypeProvider } from './plugins/validation.js'
import type { JwksCache } from './auth/jwks.js'
import { apiKeyRoutes } from './routes/api-keys.js'
import { challengeRoutes } from './routes/challenges.js'
import { circuitRoutes } from './routes/circuits.js'
import { collectionRoutes } from './routes/collections.js'
import { commentRoutes } from './routes/comments.js'
import { embedRoutes } from './routes/embed.js'
import { galleryRoutes } from './routes/gallery.js'
import { hardwareRoutes } from './routes/hardware.js'
import { healthRoutes } from './routes/health.js'
import { lessonRoutes } from './routes/lessons.js'
import { openApiRoutes } from './routes/openapi.js'
import { simulateRoutes } from './routes/simulate.js'
import { userRoutes } from './routes/users.js'
import { webSocketRoutes } from './routes/ws.js'

/*
 * `API_PREFIX` comes from `@qsim/contract` rather than being a literal here:
 * `apps/web` builds every request URL from the same constant, and a prefix
 * that only one side changes is a 404 with no error message anywhere.
 */

/**
 * A circuit is bounded by `@qsim/schema` — 28 qubits, 4096 columns — so a
 * legitimate body is kilobytes. One mebibyte leaves room for a large
 * annotated circuit and still refuses a payload whose only purpose is to
 * make the JSON parser work.
 */
const BODY_LIMIT_BYTES = 1024 * 1024

/** The three methods `frameworkErrors` needs off a reply. See the cast below. */
interface FrameworkErrorReply {
  status(code: number): FrameworkErrorReply
  header(name: string, value: string): FrameworkErrorReply
  send(payload: unknown): void
}

/** The router's own 4xx, when it suggested one. Never a 5xx: that is ours. */
function frameworkStatus(error: unknown): number | null {
  const status = (error as { statusCode?: unknown }).statusCode
  if (typeof status !== 'number') return null
  return status >= 400 && status < 500 ? status : null
}

export interface BuildAppOptions {
  readonly env: ApiEnv
  readonly database?: DatabasePluginOptions
  /** Tests inject an in-memory repository; production builds one on `app.db`. */
  readonly circuits?: CircuitsPluginOptions
  /**
   * The public API's credentials (§3.5). Tests inject an in-memory repository
   * and, where the clock matters, a verifier built over it.
   */
  readonly apiKeys?: ApiKeysPluginOptions
  /** Same arrangement for the run repository, which two processes write. */
  readonly runs?: RunsPluginOptions
  /**
   * Tests inject a queue that models Redis without one. Production builds a
   * BullMQ queue lazily, or leaves `app.simulations` null when REDIS_URL is
   * absent — see `plugins/queue.ts` for why that is a supported state.
   */
  readonly queue?: Omit<QueuePluginOptions, 'env'>
  /**
   * The worker→API event feed the socket delivers. Tests inject a bus they can
   * publish into; production builds a Redis subscriber on the first watcher,
   * or leaves `app.runEvents` null when REDIS_URL is absent.
   */
  readonly events?: Omit<EventsPluginOptions, 'env'>
  /**
   * Real hardware (§3.7). Tests inject a port backed by a recorded transport
   * and an in-memory repository; production builds one on the first hardware
   * request, or leaves `app.hardware` null when ENCRYPTION_KEY is absent.
   */
  readonly hardware?: Omit<HardwarePluginOptions, 'env'>
  /** The hardware poll queue, injected the same way. */
  readonly hardwareQueue?: Omit<HardwareQueuePluginOptions, 'env'>
  /**
   * The collaboration relay (§3.4, Fase 5). Tests inject a registry they can
   * drive, or a bus two registries share to model two replicas; production
   * builds one on the first `collab:join`.
   */
  readonly collab?: Omit<CollabPluginOptions, 'env'>
  /** Tests pass a cache backed by a locally generated key pair. */
  readonly jwks?: JwksCache
  /** `false` silences logging; tests use it to keep output readable. */
  readonly logger?: FastifyServerOptions['logger']
}

export async function buildApp(options: BuildAppOptions) {
  const { env } = options

  const app = Fastify({
    logger: options.logger ?? buildLoggerOptions(env),
    /*
     * `trustProxy` decides whether `X-Forwarded-For` is believed, and
     * `request.ip` is the rate-limit key for every anonymous caller. See the
     * argument on `TrustProxySetting` in env.ts — neither default is safe
     * everywhere, so it is configuration.
     */
    trustProxy: env.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    /*
     * The request id is generated here and never read from a header. A
     * client-supplied id would end up in every log line for the request,
     * which is an unauthenticated write into the log store.
     */
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    /*
     * The longest path parameter the router will accept. Every handle this
     * API takes is bounded far below this — `CIRCUIT_HANDLE_PATTERN` caps at
     * 64 — so the only thing a longer one can be is an attempt to make the
     * router work. Fastify's default is 100; this is explicit so that the
     * number is a decision rather than a default nobody read.
     */
    maxParamLength: 128,
    /*
     * Errors raised by the router itself, before a route or any hook exists:
     * a path parameter over the limit, a percent-escape the URL parser
     * cannot decode. Fastify answers these on its own and they escape
     * everything — `setErrorHandler`, the `onSend` hook, CORS — so they used
     * to leave in Fastify's own shape (`error` a string, not the object
     * clients parse), with the caller's URL reflected into the body and
     * without `x-request-id`, `nosniff` or `Access-Control-Allow-Origin`.
     *
     * `frameworkErrors` is the documented seam for exactly this. Routing them
     * through `toApiError` and `ApiError.toResponse` makes the envelope
     * genuinely universal, which is what every client-side parser assumes.
     */
    frameworkErrors: (error, request, reply) => {
      const apiError = toApiError(error)
      request.log.warn(
        { err: error, code: apiError.code },
        'request rejected by the router'
      )
      /*
       * Cast because Fastify types this reply against an unresolved schema
       * generic, so `status()` rejects a plain number here and nowhere else.
       * The runtime object is an ordinary FastifyReply.
       */
      const answer = reply as unknown as FrameworkErrorReply
      answer
        /*
         * The router's own status wins when it is a 4xx, because it is more
         * specific than the code's default: 414 for a path parameter over the
         * limit says what happened, where the 400 that `VALIDATION_FAILED`
         * carries only says the request was wrong. The body still speaks the
         * one vocabulary clients translate.
         */
        .status(frameworkStatus(error) ?? apiError.statusCode)
        .header('x-request-id', request.id)
        .header('x-content-type-options', 'nosniff')
        .send(apiError.toResponse(request.id))
    },
  }).withTypeProvider<ZodTypeProvider>()

  /*
   * Fastify ships a `text/plain` parser, which means a body sent with that
   * content type arrives as a string, fails the Zod body schema, and answers
   * 400 VALIDATION_FAILED — pointing the caller at their payload when the
   * problem is their header. Removing the parser puts `text/plain` where
   * `application/xml` and form encoding already are: 415, the code that says
   * what is actually wrong. This API accepts JSON and nothing else.
   */
  app.removeContentTypeParser('text/plain')

  app.setValidatorCompiler(zodValidatorCompiler)
  app.setSerializerCompiler(zodSerializerCompiler)

  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error)

    /*
     * The whole failure goes to the log — message, stack, cause — with
     * secrets scrubbed out of the text. The client gets a code and a request
     * id, and the request id is how the two are joined up. That split is the
     * point: everything needed to debug is recorded, and nothing derived
     * from the failure is transmitted.
     *
     * The raw error is handed to pino, not `serializeError(error)`. Pino's
     * `err` serialiser *is* `serializeError`, so pre-serialising ran it
     * twice: the second pass saw a plain object with `type` rather than
     * `name`, took the non-Error branch, and stamped `"type":"NonError"` on
     * every error line this service has ever written. Nothing leaked — the
     * message, code and stack all survived — but the one field a log
     * aggregator groups on was useless.
     */
    const logged = { err: error, code: apiError.code }
    if (apiError.statusCode >= 500) {
      request.log.error(logged, 'request failed')
    } else {
      request.log.warn(logged, 'request rejected')
    }

    /*
     * 401s advertise the scheme. Without it a browser client cannot tell a
     * missing token from a rejected one at the protocol level.
     */
    if (apiError.statusCode === 401) {
      reply.header('www-authenticate', 'Bearer')
    }

    reply.status(apiError.statusCode).send(apiError.toResponse(request.id))
  })

  app.addHook('onSend', async (request, reply) => {
    // Correlates a client-side report with a server log line without the
    // client having to parse an error body.
    reply.header('x-request-id', request.id)
    // The API answers JSON only; nosniff removes the whole class of bugs
    // where a browser decides a response is something else.
    reply.header('x-content-type-options', 'nosniff')
    /*
     * Nothing this service serves is a document, so nothing it serves has any
     * business inside a frame. This is the *ordinary* half of the framing
     * answer that `apps/web` splits in two (see `src/embed/headers.ts`): the
     * app and its API refuse to be framed, and exactly one route of the client
     * — the embed — opts back in. Setting it here rather than per route means
     * a route added later inherits the refusal instead of having to remember
     * it.
     *
     * It is cheap rather than decorative: `X-Frame-Options` is what stops a
     * JSON response being loaded into a frame and read through a rendering
     * side channel, and the error pages this handler emits are HTML-adjacent
     * enough that a browser will happily display one.
     */
    reply.header('x-frame-options', 'DENY')
  })

  await app.register(cors, {
    /*
     * An explicit allow-list, never `true` and never `*` (§11). The origins
     * are normalised in env.ts because this comparison is a string equality
     * and `https://example.com/` never appears in an `Origin` header.
     */
    origin: [...env.webOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
    exposedHeaders: [
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
    maxAge: 86_400,
  })

  await app.register(authPlugin, {
    env,
    ...(options.jwks === undefined ? {} : { jwks: options.jwks }),
  })
  await app.register(rateLimitPlugin, { env })

  /*
   * Registered here, after the limiter, because it needs `app.rateLimit`.
   *
   * `@fastify/rate-limit` installs no global hook — it appends to each
   * *matched* route's own `onRequest` array, as `plugins/auth.ts` documents at
   * length — so a request that matches no route was never counted at all.
   * That left an unauthenticated, unlimited surface: any unknown path, any
   * unsupported verb, ten thousand times a second, all answered 404 with the
   * budget untouched. Measured with RATE_LIMIT_MAX=3, ten consecutive
   * `GET /api/v1/does-not-exist` produced ten 404s and no 429.
   *
   * `app.rateLimit()` is the plugin's own hook, so unmatched requests are
   * counted against exactly the same key and window as matched ones.
   */
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    const notFound = new ApiError('NOT_FOUND')
    reply.status(notFound.statusCode).send(notFound.toResponse(request.id))
  })

  /*
   * The socket transport, registered before the routes that use it and after
   * the hooks that protect it. `@fastify/websocket` installs an `onRoute` hook
   * that upgrades any route declaring `websocket: true`, so the upgrade request
   * still runs the auth resolver, the limiter and the policy check above — the
   * whole reason `/ws` is a route rather than a server attached to `app.server`.
   */
  await app.register(websocket, {
    options: {
      /*
       * The protocol layer refuses an oversized frame and closes the
       * connection, so nothing is ever buffered while a decision is made. A
       * server that read first and judged afterwards would have a memory
       * ceiling any client could raise.
       */
      maxPayload: MAX_SOCKET_FRAME_BYTES,
    },
  })

  await app.register(authEnforcement)
  await app.register(databasePlugin, options.database ?? {})
  /*
   * The second credential (§3.5). After the database because verifying a key
   * is a query, and its own hook is global — so it still runs before the rate
   * limiter's route-level one, which is the ordering that matters. The whole
   * argument is at the top of `plugins/api-keys.ts`.
   */
  await app.register(apiKeysPlugin, options.apiKeys ?? {})
  await app.register(circuitsPlugin, options.circuits ?? {})
  await app.register(runsPlugin, options.runs ?? {})
  await app.register(queuePlugin, { ...(options.queue ?? {}), env })
  await app.register(eventsPlugin, { ...(options.events ?? {}), env })
  await app.register(hardwarePlugin, { ...(options.hardware ?? {}), env })
  await app.register(hardwareQueuePlugin, {
    ...(options.hardwareQueue ?? {}),
    env,
  })
  /*
   * After the circuit repository, which it reads a circuit's head version and
   * its live document through, and before the socket route that uses it.
   */
  await app.register(collabPlugin, { ...(options.collab ?? {}), env })

  /*
   * Health lives at the root, outside the versioned surface: a platform
   * probe is not part of the API contract and must not move when the version
   * does. Everything from §8 is versioned, so that a breaking change can ship
   * as `/api/v2` beside it rather than as a flag day.
   */
  await app.register(healthRoutes)
  /*
   * `/ws` sits beside `/health`, outside the versioned surface, because §8
   * writes it that way and because a socket is not a resource whose
   * representation can be versioned by path — its frames are versioned by the
   * union in `@qsim/contract`, and a client ignores a member it does not know.
   */
  await app.register(webSocketRoutes, { env })
  await app.register(circuitRoutes, { prefix: API_PREFIX, env })
  await app.register(galleryRoutes, { prefix: API_PREFIX })
  await app.register(collectionRoutes, { prefix: API_PREFIX, env })
  await app.register(commentRoutes, { prefix: API_PREFIX, env })
  await app.register(embedRoutes, { prefix: API_PREFIX })
  await app.register(lessonRoutes, { prefix: API_PREFIX })
  await app.register(challengeRoutes, { prefix: API_PREFIX, env })
  await app.register(simulateRoutes, { prefix: API_PREFIX, env })
  await app.register(hardwareRoutes, { prefix: API_PREFIX, env })
  await app.register(userRoutes, { prefix: API_PREFIX, env })
  await app.register(apiKeyRoutes, { prefix: API_PREFIX, env })
  /*
   * Last, and inside the versioned prefix rather than beside `/health`,
   * because the document describes `/api/v1` specifically — a `/api/v2` would
   * publish its own beside it rather than replacing this one.
   */
  await app.register(openApiRoutes, { prefix: API_PREFIX })

  for (const warning of configurationWarnings(env)) {
    app.log.warn({ configuration: true }, warning)
  }

  return app
}

/** The concrete instance type, including the Zod type provider. */
export type ApiInstance = Awaited<ReturnType<typeof buildApp>>
