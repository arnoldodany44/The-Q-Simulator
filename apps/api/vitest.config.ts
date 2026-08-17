import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /*
     * A TIMEOUT IS A SAFETY NET AGAINST A HANG, NOT A PERFORMANCE ASSERTION.
     *
     * At vitest's 5 s default this suite failed roughly one cold `pnpm verify`
     * in five, always passing in isolation and on the immediately following
     * run. The cause is oversubscription rather than anything here: turbo runs
     * up to ten packages at once, each vitest sizes its own worker pool to the
     * machine's cores, and 57 tasks over 12 cores means a test can be descheduled
     * for seconds. Under that, 5 s stops meaning "this hung" and starts meaning
     * "this box was busy" — and a suite that goes red at random is a suite
     * everyone learns to ignore, which is exactly the reasoning that moved the
     * engine's wall-clock budgets out of the default run
     * (packages/qsim/src/performance.perf.test.ts).
     *
     * 20 s, matching apps/worker. A genuine hang still fails; contention no
     * longer decides. This is NOT the thing that file argues against: there is
     * no assertion on elapsed time anywhere in this suite, and raising a
     * hang-detector's patience asserts nothing about speed.
     *
     * The pool is bounded for the other half of the same problem. Every test
     * here builds a Fastify instance and drives it with `inject()`, so the work
     * is CPU-bound and unbounded parallelism inside one package makes every
     * sibling package slower for no gain of its own.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 4,
    /*
     * Every test builds a Fastify instance and drives it with `inject()`, so
     * nothing binds a port and nothing reaches the network — but the test
     * process still inherits whatever is in the shell's environment. Clearing
     * these keeps a developer's real `.env` from leaking into a test: an
     * assertion that only passes because `WEB_URL` happened to be exported is
     * an assertion that fails in CI.
     */
    env: {
      NODE_ENV: 'test',
      WEB_URL: '',
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_JWKS_URL: '',
    },
  },
})
