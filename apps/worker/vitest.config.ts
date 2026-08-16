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
    env: liveQueue
      ? { NODE_ENV: 'test' }
      : { NODE_ENV: 'test', REDIS_URL: '', DATABASE_URL: '' },
  },
})
