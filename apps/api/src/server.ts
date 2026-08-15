/**
 * The process. Railway runs `node dist/server.js` (§12.4).
 *
 * Everything interesting is in `app.ts`; this file owns the three things a
 * process owns and a Fastify instance does not: reading the environment,
 * binding the port, and dying well.
 *
 * ── Dying well ────────────────────────────────────────────────────────────
 *
 * On a redeploy the platform sends SIGTERM and then waits. What happens in
 * that window is the difference between a seamless deploy and a handful of
 * 502s:
 *
 *   - `app.close()` stops accepting connections, lets in-flight requests
 *     finish, and runs every `onClose` hook — which is where the Prisma pool
 *     is released. That release is not a nicety: `DATABASE_URL` carries
 *     `connection_limit=1`, so a process that exits still holding its
 *     connection makes the *next* instance's first requests queue behind a
 *     connection nobody is using.
 *   - A timer bounds the whole thing. A request stuck on a slow query would
 *     otherwise hold the shutdown open until the platform sends SIGKILL,
 *     which skips the hooks entirely and leaks exactly the connection the
 *     graceful path existed to release.
 *   - Nothing calls `process.exit(0)` on the happy path. Once the server is
 *     closed and the pool is released there is nothing left holding the event
 *     loop, so the process ends on its own — and the log output gets flushed,
 *     which an immediate exit can truncate.
 */

import process from 'node:process'
import { buildApp } from './app.js'
import { EnvValidationError, loadEnv } from './env.js'

const env = (() => {
  try {
    return loadEnv(process.env)
  } catch (error) {
    if (error instanceof EnvValidationError) {
      /*
       * Straight to stderr, before a logger exists. A structured JSON line
       * would be the wrong shape for the audience: whoever reads this is
       * looking at a crashed deploy's console, and they need to read it, not
       * parse it.
       */
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
})()

const app = await buildApp({ env })

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  // Platforms sometimes send SIGTERM twice, and an impatient operator sends
  // SIGINT during a slow one. A second signal must not start a second close.
  if (shuttingDown) return
  shuttingDown = true

  app.log.info({ signal }, 'shutting down')

  const forceExit = setTimeout(() => {
    app.log.error(
      { signal, timeoutMs: env.shutdownTimeoutMs },
      'graceful shutdown timed out; exiting'
    )
    process.exit(1)
  }, env.shutdownTimeoutMs)
  // Do not let the timer itself keep the process alive once close() is done.
  forceExit.unref()

  try {
    await app.close()
    clearTimeout(forceExit)
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    process.exit(1)
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal))
}

/*
 * A rejection nobody handled has left some state undefined by definition, so
 * the safe move is to stop taking traffic rather than to serve from it. The
 * log line comes first: without it the platform reports only a restart.
 */
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection')
  void shutdown('unhandledRejection')
})

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception')
  void shutdown('uncaughtException')
})

try {
  await app.listen({ port: env.port, host: env.host })
} catch (error) {
  app.log.fatal({ err: error }, 'failed to bind')
  process.exit(1)
}
