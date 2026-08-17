/**
 * The things that must never appear in a log line, and the three layers that
 * keep them out.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PACKAGE AND NOT A FILE IN `apps/api`
 *
 * It was a file in `apps/api`, and that was the defect. **Two** processes hold
 * `ENCRYPTION_KEY` and open a user's IBM credential — the API and the worker —
 * and only one of them serialised errors safely. The worker built a bare
 * `pino({ level, redact })`, so pino's default `err` serialiser applied:
 * `pino-std-serializers` folds the whole `cause` chain into `message` and
 * `stack` and then copies every own enumerable property of the error. The
 * worker wraps every repository call in `HardwareStorageError(operation,
 * { cause })` and logs exactly that on `worker.on('failed')`, so a Prisma
 * connection failure put "Can't reach database server at <pooler-host>" —
 * and, for a `pg`-shaped error, the datasource URL with its password — into the
 * log of the process that decrypts every user's provider key. The path-based
 * `redact` could not reach it, because the secret was inside a sentence and
 * because the serialiser had already dropped the `cause` key it named.
 *
 * §12.3 rule 4 is explicit about the remedy: logic shared by `api` and
 * `worker` moves down into a package. So the *rules* live here, once, and both
 * processes build their logger from them. A rule added for one process is now
 * a rule the other one has.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE THREAT IS NOT MALICE, IT IS CONVENIENCE
 *
 * A log line is written to help with a bug and then lives for months in an
 * aggregator that far more people can read than can read the database. The
 * three things that get in there by accident are always the same:
 *
 *   - the `Authorization` header, because request logging usually dumps
 *     headers wholesale;
 *   - a connection string, because Prisma and `pg` put the datasource URL into
 *     the text of connection errors, and error messages get logged;
 *   - a request body, because "log the payload when it fails" is the first
 *     thing anyone reaches for, and a body posted to an auth route is a
 *     credential.
 *
 * Three independent layers, each of which alone would be enough for the common
 * case:
 *
 *   1. **Serialisers that allow-list.** What is handed to pino is built field
 *      by field; headers and bodies are structurally absent rather than
 *      omitted by policy.
 *   2. **Redaction paths and `redactDeep`.** For anything logged by hand, at
 *      any depth.
 *   3. **`scrubSecrets`**, applied to free text — error messages and stacks —
 *      where no path-based rule can reach, because the secret is inside a
 *      sentence rather than in a field.
 */

export const CENSOR = '[REDACTED]'

/**
 * Patterns that match a secret wherever it appears in free text.
 *
 * The first is the important one and it is deliberately generic: *any* URI
 * carrying `user:password@` is redacted whole, so a Redis URL or a future
 * provider's URL is covered without anybody remembering to add it. The
 * PostgreSQL rule then catches a datasource URL even when it has no userinfo,
 * because the database name and host are not something to publish either.
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
   * above exists to hide walked straight into the log.
   */
  [/\b(database server at )\S+/gi, `$1${CENSOR}`],
  // A compact JWS: three base64url segments. Catches a bearer token pasted
  // into a message, and the token itself if a library ever quotes it. The IAM
  // token @qsim/ibm exchanges an API key for is one of these.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, CENSOR],
  // Supabase's own key format, in case one is ever passed around by hand.
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, CENSOR],
  /*
   * This product's own API keys (§3.5). The reason the format has a fixed,
   * distinctive prefix and a fixed length is precisely so that one rule can
   * find every one of them — and the first place worth spending that is here,
   * because a key arrives in an `Authorization` header on every request and a
   * log is where headers go to be read by more people than can read the
   * database.
   *
   * Spelled out rather than built from `API_KEY_PATTERN` in `@qsim/contract`:
   * that constant is anchored (`^…$`) because its job is to *validate one
   * string*, and this one has to match inside a sentence. Sharing the source
   * would mean stripping anchors at runtime, which is the kind of cleverness
   * that silently stops matching. The length is asserted against the contract
   * in `apps/api`'s `logging.test.ts` instead, which is where a drift would be
   * caught.
   */
  [/\bqsk_[A-Za-z0-9_-]{43}/g, CENSOR],
]

/**
 * Removes credentials from arbitrary text. Applied to every error message and
 * stack before it is logged.
 *
 * Not a security boundary on its own — a regular expression cannot know what a
 * secret is — but it is the only layer that can reach inside a sentence, and
 * the sentence is where connection strings actually leak.
 */
export function scrubSecrets(input: string): string {
  let output = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
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
 * Unlike a response, the log *does* keep the original message and stack — that
 * is the whole point of having one — but both go through `scrubSecrets` first,
 * because the message of a `pg` connection failure is the connection string.
 *
 * Four fields and no fifth. In particular **`cause` is not walked**, which is
 * the difference from pino's default: an error whose cause is a driver failure
 * would otherwise carry that driver's whole message and every own property it
 * hung on itself. The cause's *message* survives here only when the wrapper put
 * it there deliberately, and it is scrubbed on the way through like any other
 * text.
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
   * Not everything thrown is an `Error`. Prisma's driver adapter in particular
   * rejects with a plain object, and `String(value)` on one of those produces
   * `[object Object]` — a log line that says a failure happened and nothing
   * else, which was exactly what the first smoke test of `/health` against an
   * unreachable database produced.
   */
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const message =
      typeof record['message'] === 'string'
        ? record['message']
        : safeStringify(record)
    return {
      type: typeof record['name'] === 'string' ? record['name'] : 'NonError',
      message: scrubSecrets(message),
      ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
      ...(typeof record['stack'] === 'string'
        ? { stack: scrubSecrets(record['stack']) }
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
 * throw. Those are exactly the values the allow-list serialisers already
 * handle, so the walker leaves them alone and pino's serialisers get them
 * untouched.
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
 * pino's `redact` cannot deliver "at any depth". Every `'*.token'` path
 * matches a key named `token` at depth two and nowhere else — fast-redact's
 * wildcard is one level, not a descent. So a top-level `{ token }`, anything at
 * depth three, and anything inside an array went to the log in clear text.
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
 * Paths pino redacts before writing, shared by both processes.
 *
 * The serialisers already make most of these unreachable through the normal
 * paths, and `redactDeep` covers hand-written objects at any depth. These
 * remain as the third pass, on the literal paths that matter most, applied
 * after serialisation rather than before it.
 */
export const REDACT_PATHS: readonly string[] = [
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
  /*
   * A job payload carries a whole circuit and the id of whoever submitted it.
   * Neither belongs in an aggregator, and this is the path a careless `err`
   * serialisation would have carried them out through.
   */
  '*.circuit',
  '*.payload',
]
