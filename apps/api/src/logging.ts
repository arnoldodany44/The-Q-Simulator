/**
 * Structured logging for the API, and the things that must never appear in it.
 *
 * The *rules* — what a secret looks like in free text, how an error is
 * serialised, which field names are censored at any depth — live in
 * `@qsim/logging`, because `apps/worker` holds the same `ENCRYPTION_KEY` and
 * opens the same credentials and must scrub the same things (§12.3 rule 4).
 * They used to live here, and the consequence was exactly what a duplicated
 * safety rule always is: the worker did not have them. See that package's
 * header for the leak that moved them.
 *
 * What stays here is what is genuinely about *this* process: a request and a
 * reply are shapes the worker has no counterpart for, and the allow-list
 * serialisers below are the first of the three layers —
 *
 *   1. **Serialisers that allow-list.** The `req` serialiser emits four
 *      fields. Headers and bodies are not omitted by policy, they are
 *      structurally absent from what is handed to pino.
 *   2. **Redaction paths and `redactDeep`**, from the shared package, for
 *      anything logged by hand, at any depth.
 *   3. **`scrubSecrets`**, also shared, applied to free text — error messages
 *      and stacks — where no path-based rule can reach.
 */

import {
  CENSOR,
  REDACT_PATHS,
  redactDeep,
  scrubSecrets,
  serializeError,
} from '@qsim/logging'
import type { LoggerOptions } from 'pino'
import type { ApiEnv } from './env.js'

/*
 * Re-exported rather than imported directly by the tests and the routes that
 * use them. The leak tests in `logging.test.ts` and
 * `verification/credential-safety/` are written against "what this process
 * does", and pointing them at the package would let this file drift away from
 * the rules while its tests stayed green.
 */
export { scrubSecrets, serializeError }
export type { LoggedError } from '@qsim/logging'

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
