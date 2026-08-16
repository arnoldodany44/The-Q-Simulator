/**
 * The environment, parsed once, at boot, or the process refuses to start.
 *
 * The failure this prevents is specific and expensive: a service that starts
 * happily and then fails on the *third* request — the first one that needed
 * the database — because `DATABASE_URL` was never set on the Railway
 * service. What the operator sees is an intermittent 500 with a stack trace
 * from inside Prisma, and the cause is three layers away from the symptom.
 * A process that exits immediately with `DATABASE_URL — missing` costs
 * thirty seconds instead.
 *
 * Two rules hold everywhere below:
 *
 *   - **No value is ever echoed.** Not in an error, not in a warning, not in
 *     a log line. Every message names the *variable*. `DATABASE_URL` is a
 *     credential and a validation error is the classic way one ends up in a
 *     crash report.
 *   - **Only the variables this service actually reads are declared.**
 *     `ENCRYPTION_KEY` is still absent, because nothing here uses it yet;
 *     requiring it would refuse to boot over something that cannot break.
 *     `REDIS_URL` arrived with the job queue and is declared **optional**,
 *     which is a deliberate exception argued at its schema entry below.
 *
 * This module and `server.ts` are the only two allowed to touch
 * `process.env` — enforced by a lint rule in `eslint.config.js`. Everything
 * else receives the `ApiEnv` object this file produces.
 */

import {
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_SERVER_QUBITS,
  DEFAULT_SYNC_WAIT_MS,
  queuePrefix,
} from '@qsim/jobs'
import { z } from 'zod'

export type NodeEnv = 'development' | 'test' | 'production'
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * Fastify's `trustProxy`: `false`, or the number of reverse-proxy hops to
 * trust, or an explicit list of proxy addresses.
 *
 * This is not a cosmetic setting. `request.ip` is the rate-limiting key for
 * anonymous callers, and it is read from `X-Forwarded-For` only when this is
 * on. Left off behind Railway's edge, every anonymous request shares one
 * proxy IP and the per-IP limit becomes a global limit. Turned on where
 * there is no proxy, any client can spoof the header and mint a fresh
 * identity per request, which removes the limit altogether. Neither default
 * is safe in both places, so it is configuration.
 */
export type TrustProxySetting = boolean | number | string[]

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

/**
 * Documented shape of every variable, keyed by name. The hint is what an
 * operator reads when the boot fails, so it says what the value is *for*,
 * not what type it is — the type is already in the Zod error.
 */
const HINTS: Record<string, string> = {
  NODE_ENV: 'one of development | test | production',
  PORT: 'TCP port to listen on; Railway injects this',
  HOST: 'bind address; 0.0.0.0 inside a container',
  LOG_LEVEL: `one of ${LOG_LEVELS.join(' | ')}`,
  WEB_URL:
    'origin allowed by CORS, e.g. https://the-q-simulator.vercel.app — ' +
    'comma-separated for several',
  DATABASE_URL:
    'Supabase TRANSACTION pooler, port 6543, with ' +
    '?pgbouncer=true&connection_limit=1',
  SUPABASE_URL:
    'https://<project-ref>.supabase.co — https, or http on loopback',
  SUPABASE_JWKS_URL:
    'public signing keys, normally <SUPABASE_URL>/auth/v1/.well-known/' +
    'jwks.json; must be https, or http on loopback — this is the trust anchor',
  SUPABASE_JWT_ISSUER:
    'expected iss claim; defaults to <SUPABASE_URL>/auth/v1; same scheme rule',
  SUPABASE_JWT_AUDIENCE: "expected aud claim; Supabase uses 'authenticated'",
  TRUST_PROXY:
    'false, a hop count like 1, or a comma-separated list of proxy IPs; ' +
    'controls whether X-Forwarded-For is believed',
  RATE_LIMIT_MAX: 'requests per window per caller',
  RATE_LIMIT_WINDOW_MS: 'length of the rate-limit window, in milliseconds',
  RATE_LIMIT_STRICT_MAX:
    'requests per window on the routes §11 singles out (auth, /simulate)',
  SHUTDOWN_TIMEOUT_MS:
    'how long a graceful shutdown may take before the process is killed',
  REDIS_URL:
    'redis:// or rediss:// for the simulation queue; without it /simulate ' +
    'answers 503 and every other route is unaffected',
  QUEUE_PREFIX:
    'namespace for every queue key; must differ between environments ' +
    'sharing one Redis instance',
  SIMULATION_MAX_QUBITS:
    'largest register a server run may use; must match the worker',
  SIMULATION_TIMEOUT_MS:
    'wall-clock bound on one run; must match the worker, and is what the ' +
    'admission work budget is derived from',
  SIMULATION_SYNC_WAIT_MS:
    'how long POST /simulate holds a request open for a small run before ' +
    'answering 202 with a run id instead',
}

const trustProxySchema = z.string().transform((raw, ctx): TrustProxySetting => {
  const value = raw.trim()
  if (value === 'false') return false
  if (value === 'true') {
    /*
     * `true` means "believe the whole X-Forwarded-For chain", which lets a
     * client prepend any address it likes and be rate-limited as somebody
     * else. A hop count is always what is meant, so refuse the ambiguous
     * spelling rather than silently accept the unsafe reading.
     */
    ctx.addIssue({
      code: 'custom',
      message:
        'use a hop count (1 behind a single proxy) rather than true, ' +
        'which trusts the entire X-Forwarded-For chain',
    })
    return false
  }
  if (/^\d+$/.test(value)) return Number(value)
  const addresses = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (addresses.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'expected false, a number, or addresses',
    })
    return false
  }
  return addresses
})

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),

  WEB_URL: z
    .string()
    .min(1)
    .refine(isOriginList, { message: 'entries must be absolute URLs' }),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine(isPostgresUrl, { message: 'expected a postgresql:// URL' }),

  /*
   * `z.url()` alone is not a check on any of these three. Zod's URL validator
   * accepts anything `new URL()` parses, which includes `http:`, `file:`,
   * `data:` and `javascript:` — and SUPABASE_JWKS_URL is the single most
   * security-critical value this service holds, because whatever that
   * document says is a signing key *becomes* a signing key. Left on plaintext
   * HTTP, an on-path attacker substitutes the key set and mints a token for
   * any user; pointed at a `data:` URL, the trust anchor is a literal in the
   * environment. Neither should be something the process starts with.
   *
   * The pattern already exists twice in this file — WEB_URL through
   * `isOriginList`, DATABASE_URL through `isPostgresUrl` — and this module's
   * whole purpose is refusing to start rather than failing later. Here
   * "later" means forged tokens.
   */
  SUPABASE_URL: z
    .url()
    .refine(isSecureHttpUrl, { message: 'expected an https:// URL' }),
  SUPABASE_JWKS_URL: z
    .url()
    .refine(isSecureHttpUrl, { message: 'expected an https:// URL' }),
  SUPABASE_JWT_ISSUER: z
    .url()
    .refine(isSecureHttpUrl, { message: 'expected an https:// URL' })
    .optional(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default('authenticated'),

  TRUST_PROXY: trustProxySchema.optional(),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_STRICT_MAX: z.coerce.number().int().min(1).default(20),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

  /*
   * OPTIONAL, AND THAT IS THE DESIGN.
   *
   * Every other dependency here is required because the service is useless
   * without it: no database, no circuits, no gallery, no anything. Redis is
   * not like that. It backs exactly one route — `POST /simulate` — and §4's
   * whole point is that most simulation happens in the browser and never
   * reaches this process at all. An API that refused to boot without Redis
   * would take the gallery, the editor's persistence and every sign-in down
   * with a queue outage, which is a much larger failure than the one it was
   * protecting against.
   *
   * So a missing URL is a boot *warning* and a 503 on one route
   * (`SIMULATION_UNAVAILABLE`), which is exactly what a Redis that is present
   * but unreachable produces — one behaviour for one situation, rather than
   * two.
   */
  REDIS_URL: z
    .string()
    .min(1)
    .refine(isRedisUrl, { message: 'expected a redis:// or rediss:// URL' })
    .optional(),

  /*
   * The namespace every queue key lives under. Not decorative: this project's
   * Redis is a single shared instance, so a developer running a worker locally
   * with the production prefix would be consuming production jobs — and would
   * be doing it silently and successfully. Defaulted in `@qsim/jobs` rather
   * than here so the worker and the API cannot default differently.
   */
  QUEUE_PREFIX: z.string().min(1).max(64).optional(),

  /*
   * The two ceilings the admission check applies. They must match the worker's
   * or the API will accept work the worker then refuses — which is not unsafe
   * (the worker checks again, and that is the check that matters) but is a
   * confusing 202 followed by a FAILED run instead of an immediate 413.
   */
  SIMULATION_MAX_QUBITS: z.coerce.number().int().min(1).max(28).optional(),
  SIMULATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).optional(),
  /*
   * Bounded above at thirty seconds because that is where platform gateways
   * start cutting idle requests, and a wait longer than the proxy's patience
   * is a failure the client cannot distinguish from a crash.
   */
  SIMULATION_SYNC_WAIT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional(),
})

/**
 * `https://…`, or `http://` on a loopback host and nowhere else.
 *
 * The exception is the local Supabase stack, which serves
 * `http://127.0.0.1:54321` and is the ordinary way to develop against this
 * project. Loopback traffic never crosses a network, so there is no on-path
 * attacker to defend against — the same reasoning browsers use to treat
 * `http://localhost` as a secure context. Every other host must be https.
 */
function isSecureHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  )
}

function isPostgresUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'postgres:' || protocol === 'postgresql:'
  } catch {
    return false
  }
}

/**
 * `redis:` or `rediss:`, and nothing else.
 *
 * The same reasoning as `isPostgresUrl`: a value that does not parse as the
 * protocol it is for produces a connection error three layers down, at the
 * first job rather than at boot. Both schemes are accepted because a managed
 * instance is TLS (`rediss:`) and a local one is not.
 */
function isRedisUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'redis:' || protocol === 'rediss:'
  } catch {
    return false
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * `URL.canParse` is not enough on its own: it accepts `localhost:5173`,
 * reading `localhost:` as the scheme and `5173` as the path. That produces
 * an "origin" of `null`, which would then be compared against every incoming
 * `Origin` header and match nothing — a CORS allow-list that silently allows
 * nobody. Requiring http/https rejects it at boot instead.
 */
function isOriginList(value: string): boolean {
  const entries = splitList(value)
  if (entries.length === 0) return false
  return entries.every((entry) => {
    try {
      const protocol = new URL(entry).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  })
}

/** The validated configuration every other module receives. */
export interface ApiEnv {
  readonly nodeEnv: NodeEnv
  readonly port: number
  readonly host: string
  readonly logLevel: LogLevel
  /**
   * Exact origins allowed by CORS — never a wildcard (§11). Normalised with
   * `new URL(...).origin`, because `https://example.com/` and
   * `https://example.com` are the same site but only the second one ever
   * appears in an `Origin` header, and the comparison is a string equality.
   */
  readonly webOrigins: readonly string[]
  readonly databaseUrl: string
  readonly supabaseUrl: string
  readonly jwksUrl: string
  readonly jwtIssuer: string
  readonly jwtAudience: string
  readonly trustProxy: TrustProxySetting
  readonly rateLimit: {
    readonly max: number
    readonly windowMs: number
    readonly strictMax: number
  }
  readonly shutdownTimeoutMs: number
  /**
   * The simulation queue, or `null` when no Redis was configured.
   *
   * `null` is a first-class state and not a missing value: `POST /simulate`
   * answers 503 and everything else works, which is the same behaviour as a
   * Redis that is configured and unreachable.
   */
  readonly queue: {
    readonly redisUrl: string | null
    readonly prefix: string
    readonly maxQubits: number
    readonly timeoutMs: number
    readonly syncWaitMs: number
  }
}

/** Thrown when the environment cannot produce a valid `ApiEnv`. */
export class EnvValidationError extends Error {
  constructor(
    override readonly message: string,
    readonly variables: readonly string[]
  ) {
    super(message)
    this.name = 'EnvValidationError'
  }
}

export type EnvSource = Record<string, string | undefined>

/**
 * An unset variable and one set to the empty string mean the same thing, and
 * the empty string is the common case: `.env.example` ships
 * `SUPABASE_JWT_SECRET=` deliberately blank, and a Railway variable cleared
 * through the dashboard becomes `''` rather than disappearing. Without this,
 * `z.string().min(1)` would report "too small" for something the operator
 * reasonably reads as "not set", and — worse — `z.coerce.number()` would
 * turn `PORT=` into `0` and bind to a random port.
 */
function withoutBlanks(source: EnvSource): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') result[key] = value
  }
  return result
}

function formatIssues(
  issues: readonly z.core.$ZodIssue[],
  present: Record<string, string>
): { message: string; variables: string[] } {
  const seen = new Set<string>()
  const lines: string[] = []

  for (const issue of issues) {
    const name = String(issue.path[0] ?? '(root)')
    if (seen.has(name)) continue
    seen.add(name)

    // Never `issue.message` alone for a missing variable: it reads "invalid
    // type: expected string, received undefined", which buries the one fact
    // that matters.
    const state = name in present ? issue.message : 'missing'
    const hint = HINTS[name]
    lines.push(`  ${name} — ${state}${hint === undefined ? '' : ` (${hint})`}`)
  }

  const message = [
    'Invalid environment for apps/api. The service will not start until ' +
      'these are fixed:',
    '',
    ...lines,
    '',
    'Values are never printed here. See .env.example for the shape and ' +
      'docs/especificacion.md §12.5 for where each one comes from.',
  ].join('\n')

  return { message, variables: [...seen] }
}

function toOrigins(webUrl: string): string[] {
  return splitList(webUrl).map((entry) => new URL(entry).origin)
}

/**
 * Parses and validates the environment.
 *
 * @throws {EnvValidationError} with a message that names every offending
 * variable at once. Reporting them one per restart is how a deploy takes
 * five rounds instead of one.
 */
export function loadEnv(source: EnvSource): ApiEnv {
  const present = withoutBlanks(source)
  const parsed = EnvSchema.safeParse(present)

  if (!parsed.success) {
    const { message, variables } = formatIssues(parsed.error.issues, present)
    throw new EnvValidationError(message, variables)
  }

  const env = parsed.data

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    // Production defaults to `info` because `debug` on a request-per-second
    // service is a bill, not a diagnostic.
    logLevel:
      env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    webOrigins: toOrigins(env.WEB_URL),
    databaseUrl: env.DATABASE_URL,
    supabaseUrl: env.SUPABASE_URL,
    jwksUrl: env.SUPABASE_JWKS_URL,
    /*
     * Supabase signs with `iss` = `<project>/auth/v1`. Deriving it rather
     * than requiring it is what makes "a token from another project" fail
     * closed: an operator who copies the JWKS URL from the wrong project
     * gets a mismatch, instead of a service that accepts both.
     */
    jwtIssuer:
      env.SUPABASE_JWT_ISSUER ?? `${trimSlash(env.SUPABASE_URL)}/auth/v1`,
    jwtAudience: env.SUPABASE_JWT_AUDIENCE,
    trustProxy: env.TRUST_PROXY ?? (env.NODE_ENV === 'production' ? 1 : false),
    rateLimit: {
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      strictMax: env.RATE_LIMIT_STRICT_MAX,
    },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    queue: {
      redisUrl: env.REDIS_URL ?? null,
      prefix: queuePrefix(env.QUEUE_PREFIX),
      maxQubits: env.SIMULATION_MAX_QUBITS ?? DEFAULT_SERVER_QUBITS,
      timeoutMs: env.SIMULATION_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS,
      syncWaitMs: env.SIMULATION_SYNC_WAIT_MS ?? DEFAULT_SYNC_WAIT_MS,
    },
  }
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * Configuration that is valid but probably wrong, reported as warnings at
 * boot rather than as a refusal to start.
 *
 * `connection_limit=1` and `pgbouncer=true` are not optional in practice
 * (§12.6): without the first, `pg` opens its own default of ten connections
 * against a pooler budget of one and requests hang waiting for a connection
 * that is not coming; without the second, Prisma uses prepared statements
 * that pgBouncer rejects in transaction mode, and the errors are
 * intermittent and awful to trace. But a developer pointed at a local
 * Postgres needs neither, so this is a warning and not a boot failure.
 *
 * Returns variable names and reasons — never any part of the URL.
 */
export function configurationWarnings(env: ApiEnv): string[] {
  const warnings: string[] = []

  if (env.queue.redisUrl === null) {
    warnings.push(
      'REDIS_URL is not set, so POST /simulate will answer 503 ' +
        'SIMULATION_UNAVAILABLE. Every other route is unaffected — see §4: ' +
        'most simulation happens in the browser and never reaches this ' +
        'process.'
    )
  }

  let url: URL
  try {
    url = new URL(env.databaseUrl)
  } catch {
    return warnings
  }

  const isSupabasePooler = url.hostname.includes('pooler.supabase.com')
  if (!isSupabasePooler) return warnings

  if (url.port === '5432') {
    warnings.push(
      'DATABASE_URL points at the session pooler (port 5432). That is ' +
        'DIRECT_URL, for migrations only; runtime queries belong on 6543.'
    )
  }
  if (url.searchParams.get('pgbouncer') !== 'true') {
    warnings.push(
      'DATABASE_URL is missing pgbouncer=true; Prisma will attempt prepared ' +
        'statements that the transaction pooler rejects intermittently.'
    )
  }
  if (url.searchParams.get('connection_limit') === null) {
    warnings.push(
      'DATABASE_URL is missing connection_limit; the pg driver will open its ' +
        'own default pool, which exceeds the shared pooler budget.'
    )
  }

  return warnings
}
