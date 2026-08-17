/**
 * Log redaction and error serialisation, shared by `apps/api` and
 * `apps/worker`.
 *
 * Both processes hold `ENCRYPTION_KEY`, both open a user's provider credential,
 * and both write logs to the same aggregator — so both must scrub the same
 * things. See `redaction.ts` for the incident that made this a package rather
 * than a file in one of them.
 *
 * Deliberately free of `pino`: what lives here are pure functions over strings
 * and plain objects, so they are testable with nothing running and can be used
 * by any logger. Each app assembles its own `LoggerOptions` from them, because
 * the *serialisers* differ — the API has a request and a reply to describe and
 * the worker has neither.
 */

export {
  CENSOR,
  REDACT_PATHS,
  redactDeep,
  scrubSecrets,
  serializeError,
} from './redaction.js'
export type { LoggedError } from './redaction.js'
