/**
 * Structured logging, and the things that must never appear in it.
 *
 * The threat is not malice, it is convenience. A log line is written to help
 * with a bug and then lives for months in a log aggregator that far more
 * people can read than can read the database. The three things that get in
 * there by accident are always the same:
 *
 *   - the `Authorization` header, because request logging usually dumps
 *     headers wholesale;
 *   - a connection string, because Prisma and `pg` put the datasource URL
 *     into the text of connection errors, and error messages get logged;
 *   - a request body, because "log the payload when it fails" is the first
 *     thing anyone reaches for, and a body posted to an auth route is a
 *     credential.
 *
 * So this module defends in three independent layers, and each one alone
 * would be enough for the common case:
 *
 *   1. **Serialisers that allow-list.** The `req` serialiser emits four
 *      fields. Headers and bodies are not omitted by policy, they are
 *      structurally absent from what is handed to pino.
 *   2. **Redaction paths.** For anything logged by hand, at any depth.
 *   3. **`scrubSecrets`**, applied to free text — error messages and stacks —
 *      where no path-based rule can reach, because the secret is inside a
 *      sentence rather than in a field.
 */

import type { LoggerOptions } from 'pino'
import type { ApiEnv } from './env.js'

/**
 * Query parameters whose *values* are credentials.
 *
 * Supabase returns tokens in the URL fragment, which a browser never sends,
 * so in practice these arrive from a hand-written client or a copy-pasted
 * link. That is exactly when they must not be logged.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'code',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'authorization',
])

const CENSOR = '[REDACTED]'

/**
 * Patterns that match a secret wherever it appears in free text.
 *
 * The first is the important one and it is deliberately generic: *any* URI
 * carrying `user:password@` is redacted whole, so a Redis URL or a future
 * provider's URL is covered without anybody remembering to add it. The
 * PostgreSQL rule then catches a datasource URL even when it has no
 * userinfo, because the database name and host are not something to publish
 * either.
 */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // scheme://user:pass@host/…  — credentials embedded in any URI.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]+:[^\s/@]*@\S*/gi, `$1://${CENSOR}`],
  // A datasource URL with no userinfo is still not for the log.
  [/\bpostgres(?:ql)?:\/\/\S*/gi, `postgresql://${CENSOR}`],
  /*
   * The same host, in prose. Prisma does not put the URL in a connection
   * failure, it puts the host in a sentence — "Can't reach database server at
   * <host>" — which neither rule above matches, so the one thing the rule
   * above exists to hide walked straight into the log. The comment on this
   * list already said the host is not something to publish; this is what
   * makes that true of the shape it actually arrives in.
   */
  [/\b(database server at )\S+/gi, `$1${CENSOR}`],
  // A compact JWS: three base64url segments. Catches a bearer token pasted
  // into a message, and the token itself if a library ever quotes it.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, CENSOR],
  // Supabase's own key format, in case one is ever passed around by hand.
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, CENSOR],
]

/**
 * Removes credentials from arbitrary text. Applied to every error message
 * and stack before it is logged.
 *
 * Not a security boundary on its own — a regular expression cannot know what
 * a secret is — but it is the only layer that can reach inside a sentence,
 * and the sentence is where connection strings actually leak.
 */
export function scrubSecrets(input: string): string {
  let output = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
}

/**
 * Rewrites a request target so the path stays readable and the credentials
 * do not survive.
 *
 * Keeps parameter *names* — knowing that `?access_token=` was present is
 * exactly the diagnostic that matters — and replaces only the values.
 */
export function sanitizeUrl(url: string): string {
  const separator = url.indexOf('?')
  if (separator === -1) return scrubSecrets(url)

  const path = url.slice(0, separator)
  const rawQuery = url.slice(separator + 1)

  const parts = rawQuery.split('&').map((pair) => {
    if (pair === '') return pair
    const equals = pair.indexOf('=')
    const name = equals === -1 ? pair : pair.slice(0, equals)
    const decodedName = safeDecode(name).toLowerCase()
    if (!SENSITIVE_QUERY_PARAMS.has(decodedName)) {
      return equals === -1
        ? pair
        : `${name}=${scrubSecrets(pair.slice(equals + 1))}`
    }
    return `${name}=${CENSOR}`
  })

  return `${scrubSecrets(path)}?${parts.join('&')}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A malformed percent escape is not a reason to fail a log line.
    return value
  }
}

/** The subset of a request that is safe to log, and all of it that is useful. */
interface LoggedRequest {
  readonly id: string
  readonly method: string
  readonly url: string
  readonly remoteAddress: string
}

interface RequestLike {
  id: string
  method: string
  url: string
  ip: string
}

interface ReplyLike {
  statusCode: number
}

export function serializeRequest(request: RequestLike): LoggedRequest {
  return {
    id: request.id,
    method: request.method,
    url: sanitizeUrl(request.url),
    // Kept because rate limiting and abuse reports are the reason this API
    // has logs at all. Nothing else about the client is recorded.
    remoteAddress: request.ip,
  }
}

export function serializeReply(reply: ReplyLike): { statusCode: number } {
  return { statusCode: reply.statusCode }
}

export interface LoggedError {
  readonly type: string
  readonly message: string
  readonly code?: string
  readonly stack?: string
}

/**
 * Serialises a thrown value for the log.
 *
 * Unlike the response, the log *does* keep the original message and stack —
 * that is the whole point of having one — but both go through
 * `scrubSecrets` first, because the message of a `pg` connection failure is
 * the connection string.
 */
export function serializeError(error: unknown): LoggedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      type: error.name,
      message: scrubSecrets(error.message),
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack === undefined
        ? {}
        : { stack: scrubSecrets(error.stack) }),
    }
  }

  /*
   * Not everything thrown is an `Error`. Prisma's driver adapter in
   * particular rejects with a plain object, and `String(value)` on one of
   * those produces `[object Object]` — a log line that says a failure
   * happened and nothing else, which was exactly what the first smoke test
   * of `/health` against an unreachable database produced.
   */
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const message =
      typeof record.message === 'string'
        ? record.message
        : safeStringify(record)
    return {
      type: typeof record.name === 'string' ? record.name : 'NonError',
      message: scrubSecrets(message),
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      ...(typeof record.stack === 'string'
        ? { stack: scrubSecrets(record.stack) }
        : {}),
    }
  }

  return { type: 'NonError', message: scrubSecrets(String(error)) }
}

function safeStringify(value: object): string {
  try {
    // Depth is not limited, but a log line is not a debugger; the scrubbing
    // above still applies to whatever comes out. `JSON.stringify` returns
    // `undefined` for a function or a symbol, hence the fallback.
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    // Circular, or a getter that throws.
    return Object.prototype.toString.call(value)
  }
}

/** Field names whose value is a credential wherever it appears. */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'password',
  'secret',
  'apikey',
  'api_key',
  'connectionstring',
  'database_url',
  'direct_url',
  'supabase_secret_key',
  'supabase_jwt_secret',
  'encryption_key',
  'body',
])

/** How deep the walker goes before it stops looking. */
const MAX_REDACT_DEPTH = 8
/** How many values it will visit in one log line before it stops looking. */
const MAX_REDACT_NODES = 2_000

/**
 * Whether this is a plain data object — one built by an object literal or by
 * `JSON.parse`, and not an instance of anything.
 *
 * The distinction is what makes the walk below safe to run on every log line.
 * A `FastifyRequest`, a `PrismaClient` or an `Error` has getters, cycles and a
 * few thousand reachable properties; walking one would be expensive and could
 * throw. Those are exactly the values the allow-list serialisers above
 * already handle, so the walker leaves them alone and pino's serialisers get
 * them untouched.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

/**
 * Replaces the value of any sensitive field, at any depth, in a hand-written
 * log object.
 *
 * ── Why `redact` alone was not enough ─────────────────────────────────────
 *
 * The docblock at the top of this module promises redaction "for anything
 * logged by hand, at any depth", and pino's `redact` cannot deliver that.
 * Every `'*.token'` path matches a key named `token` at depth two and nowhere
 * else — fast-redact's wildcard is one level, not a descent. So a top-level
 * `{ token }`, anything at depth three, and anything inside an array went to
 * the log in clear text. The two existing tests happened to pick the two
 * shapes that worked (`headers.authorization` is depth two; `body` is a
 * literal path), which is how a suite stays green while a stated guarantee is
 * absent.
 *
 * This is the layer that was claimed. `redact` stays as well: it runs on the
 * exact literal paths after serialisation, which is a different moment and
 * catches anything a serialiser reintroduces.
 *
 * Bounded twice — depth and node count — because a log line is written on the
 * error path, and the error path is not where an unbounded walk belongs.
 */
export function redactDeep(value: unknown): unknown {
  let budget = MAX_REDACT_NODES

  const walk = (input: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > MAX_REDACT_DEPTH) return input

    if (Array.isArray(input)) {
      budget -= 1
      return input.map((entry) => walk(entry, depth + 1))
    }
    if (!isPlainObject(input)) return input

    budget -= 1
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(input)) {
      output[key] = SENSITIVE_FIELD_NAMES.has(key.toLowerCase())
        ? CENSOR
        : walk(entry, depth + 1)
    }
    return output
  }

  return walk(value, 0)
}

/**
 * Paths pino redacts before writing.
 *
 * The serialisers above already make most of these unreachable through the
 * normal request/response path, and `redactDeep` covers hand-written objects
 * at any depth. These remain as the third pass, on the literal paths that
 * matter most, applied after serialisation rather than before it.
 */
const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.password',
  '*.secret',
  '*.connectionString',
  '*.DATABASE_URL',
  '*.DIRECT_URL',
  '*.SUPABASE_SECRET_KEY',
  '*.ENCRYPTION_KEY',
  /*
   * A request body is never logged, whatever it contains. `POST /auth/*` and
   * `POST /hardware/credentials` both carry secrets in the body (§11), and
   * "log the payload only when it fails" would log precisely those.
   */
  'body',
  'req.body',
  '*.body',
]

export function buildLoggerOptions(env: ApiEnv): LoggerOptions {
  return {
    level: env.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    formatters: {
      /*
       * Runs on the merged object of every log line, before the serialisers
       * below see their keys. `redactDeep` only descends into plain objects
       * and arrays, so `req`, `res` and `err` — class instances all — pass
       * through untouched and reach their serialisers as pino intends.
       */
      log: (object) => redactDeep(object) as Record<string, unknown>,
    },
    serializers: {
      req: serializeRequest as (value: unknown) => unknown,
      res: serializeReply as (value: unknown) => unknown,
      err: serializeError,
      error: serializeError,
    },
    /*
     * Deployment metadata, so a line from a stale instance is identifiable
     * during a rolling deploy. Never anything read from a credential.
     */
    base: { service: 'api', env: env.nodeEnv },
  }
}
