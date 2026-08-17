/**
 * The worker's logger options — the same discipline as the API's, from the
 * same rules.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * It did not, and that was a leak. This process builds a `pino` with a
 * `redact` list and nothing else, which left pino's *default* `err` serialiser
 * in place — and `pino-std-serializers` folds the entire `cause` chain into
 * `message` and `stack` and then copies every own enumerable property of the
 * thrown error. `hardware.ts` wraps every repository call in
 * `HardwareStorageError(operation, { cause })` and `hardware-queue.ts` logs
 * exactly that on `worker.on('failed')`, so a Prisma P1001 arrived in the log
 * as "the hardware repository failed during findPollable: Can't reach database
 * server at <pooler-host>" — the host the API censors by name — and a `pg`
 * error carrying the datasource URL arrived with its password intact.
 *
 * This is the process that holds `ENCRYPTION_KEY` and decrypts every user's
 * IBM credential. It is the last place in the system where the error path
 * should be the unguarded one.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS DIFFERENT FROM THE API'S, AND WHY THAT IS ALL
 *
 * The API serialises a request and a reply; this process has neither, because
 * it listens on nothing (`worker-is-a-consumer-not-a-server`). Everything else
 * — the error serialiser, the redaction paths, the deep walk over hand-written
 * objects, the free-text scrubbing — is `@qsim/logging`, shared verbatim, so a
 * rule added for one process is a rule the other one has.
 */

import { CENSOR, REDACT_PATHS, redactDeep, serializeError } from '@qsim/logging'
import type { LoggerOptions } from 'pino'

export interface WorkerLogEnv {
  readonly logLevel: string
  readonly nodeEnv: string
}

export function buildWorkerLoggerOptions(env: WorkerLogEnv): LoggerOptions {
  return {
    level: env.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    formatters: {
      /*
       * Runs on the merged object of every log line, before the serialisers
       * see their keys. `redactDeep` descends only into plain objects and
       * arrays, so an `Error` passes through untouched and reaches
       * `serializeError` as pino intends.
       */
      log: (object) => redactDeep(object) as Record<string, unknown>,
    },
    serializers: {
      /*
       * BOTH SPELLINGS. Every call site in this process writes `{ err }`, but
       * `error` is one slip away and pino applies serialisers by key name —
       * so a line written as `{ error }` would take the default path, which is
       * the path this file exists to close.
       */
      err: serializeError,
      error: serializeError,
    },
    /*
     * Deployment metadata, so a line from a stale instance is identifiable
     * during a rolling deploy. Never anything read from a credential.
     */
    base: { service: 'worker', env: env.nodeEnv },
  }
}
