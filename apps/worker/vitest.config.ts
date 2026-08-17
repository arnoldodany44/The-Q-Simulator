import process from 'node:process'
import { defineConfig } from 'vitest/config'

/**
 * The integration suite is the one thing here that is *meant* to see a real
 * connection string, so the scrubbing below steps aside when it is asked for.
 *
 * Without this the two rules fight and the stricter one wins silently: the
 * unit suite must not inherit a developer's `.env` — an assertion that only
 * passes because `REDIS_URL` happened to be exported is an assertion that
 * fails in CI — while `QSIM_QUEUE_INTEGRATION=1` means "use the live instance
 * on purpose". Scrubbing unconditionally made the flag do nothing at all.
 */
const liveQueue = process.env.QSIM_QUEUE_INTEGRATION === '1'

export default defineConfig({
  test: {
    environment: 'node',
    /*
     * `*.perf.test.ts` is excluded from the default run, as everywhere else in
     * this repository: a wall-clock assertion belongs in a suite that is run
     * deliberately, not in the one that gates every commit.
     */
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.perf.test.ts', '**/node_modules/**'],
    /*
     * The pool forks real child processes and the queue tests reach for Redis
     * when it is enabled. Both need a hard ceiling: a test that hangs on a
     * blocking read against a metered instance would burn the tier overnight.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    /*
     * Bounded for the same reason apps/api's is, and with more force here: this
     * pool forks a real child process per job under test, so an unbounded pool
     * multiplies processes twice over. Turbo already runs up to ten packages at
     * once on 12 cores.
     *
     * That is the whole justification, and it is the only one available: this
     * suite was named as one of the two that went red intermittently under
     * turbo, but that was never verified and turned out to be wrong. The
     * failure was in packages/qsim — see the account in its vitest.config.ts,
     * and in apps/api's for how the wrong package came to be blamed twice.
     */
    maxWorkers: 3,
    env: liveQueue
      ? { NODE_ENV: 'test' }
      : { NODE_ENV: 'test', REDIS_URL: '', DATABASE_URL: '' },
  },
})
