import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /*
     * A TIMEOUT IS A SAFETY NET AGAINST A HANG, NOT A PERFORMANCE ASSERTION.
     *
     * These two settings are defensible on their own terms, and that is the
     * only claim made for them. 20 s matches apps/worker; a genuine hang still
     * fails, and raising a hang-detector's patience asserts nothing about
     * speed, so this is not the thing that
     * packages/qsim/src/performance.perf.test.ts argues against — there is no
     * assertion on elapsed time anywhere in this suite. The pool is bounded
     * because every test here builds a Fastify instance and drives it with
     * `inject()`, so the work is CPU-bound and unbounded parallelism inside one
     * package makes every sibling package slower for no gain of its own.
     *
     * WHAT THEY DID NOT DO IS FIX THE FLAKE, and an earlier version of this
     * comment asserted a cause that measurement then refuted. For the record,
     * so nobody re-derives the dead end: `pnpm verify` fails intermittently
     * under turbo, always green in isolation and on the retry. Before these
     * settings the rate was roughly one cold run in five. After them: 1 failure
     * in 17 cold runs (~6%) across three measured batches. Lower, plausibly
     * because of these settings, but not zero — so "oversubscription plus an
     * impatient timeout" is at most part of it and is not established as the
     * cause. A second hypothesis, that the relay's fixed-window frame budgets
     * roll over mid-test, was also checked and refuted: the window is 10 s
     * (SOCKET_FRAME_WINDOW_MS) against a 60-frame ceiling, and the tests push
     * ~65 frames with a handful of event-loop yields, which cannot span it.
     *
     * The next occurrence is already instrumented and needs no capture loop:
     * turbo writes each task's output to <package>/.turbo/turbo-<task>.log and
     * a failing task is never cached, so after a red run that file holds the
     * real failure. Read it before running anything else, which overwrites it.
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
