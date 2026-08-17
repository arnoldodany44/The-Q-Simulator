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
     * WHAT THEY DID NOT DO IS FIX THE FLAKE. They were aimed at the wrong
     * package, and this comment previously asserted a cause that measurement
     * refuted. THE ACTUAL CULPRIT WAS packages/qsim: a 200k-shot Monte Carlo
     * case in `trajectories-converge.test.ts` running past vitest's 5 s default
     * whenever the machine was busy. It is fixed there, in that package's
     * vitest.config.ts, which carries the full account.
     *
     * Kept as a record of how it was chased, because the shape of the mistake
     * is worth more than the fix. The failure was described from the start as
     * "api and worker go red intermittently", and that description was never
     * verified — it came from noticing which suites were on screen, not from
     * reading which task turbo reported. Two rounds of changes were then made
     * to the two packages named in it. Three capture loops, seventeen cold
     * runs, and nothing caught. What finally identified it was CI: two cores
     * instead of twelve turned a ~6% local flake into a deterministic failure,
     * and the annotation named the file and the line.
     *
     * The lesson, since it cost four red runs on main that nobody looked at:
     * turbo writes each task's output to <package>/.turbo/turbo-<task>.log and
     * never caches a failing task, so a red run already holds the real failure
     * on disk. Read that before forming a theory about which suite it was.
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
