import { defineConfig } from 'vitest/config'

/**
 * The correctness suite. Deterministic, safe to run concurrently with every
 * other workspace, and expected to be green on every commit.
 *
 * `*.perf.test.ts` is excluded on purpose: those files assert wall-clock
 * budgets, and a timing assertion running alongside three other workspaces'
 * builds measures the scheduler rather than the engine. They run separately
 * via `pnpm test:perf` — see vitest.perf.config.ts.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.perf.test.ts'],
    /*
     * THE ONE THAT WAS ACTUALLY BREAKING CI, found on 2026-08-17.
     *
     * `trajectories-converge.test.ts` runs nine Monte Carlo cases at 120-200k
     * shots each and takes ~11 s for its 111 tests on an idle twelve-core
     * machine. GitHub's runners have two cores, so a single heavy case there
     * ran past vitest's 5 s default and the suite failed on every push to main
     * from e652ffe onwards -- four consecutive red runs, while `pnpm verify`
     * stayed green locally and nobody looked at the badge.
     *
     * The shot counts are load-bearing and are not the thing to cut: the
     * assertions compare observed counts against `shotTolerance(shots, p)`, so
     * fewer shots would mean a looser bound and a weaker test. What was wrong
     * was the deadline, not the work.
     *
     * This is the same failure that had been showing up locally as an
     * intermittent red under turbo -- heavy arithmetic plus a 5 s deadline
     * plus whatever else the machine was doing. Two earlier attempts blamed
     * apps/api and apps/worker and changed those instead; see the note in
     * apps/api/vitest.config.ts. CI is what made it deterministic enough to
     * read.
     *
     * 60 s, and it asserts nothing about speed -- the budgets that do live in
     * `*.perf.test.ts`, excluded above and run alone by `pnpm test:perf`. An
     * engine that genuinely hangs still fails here; a busy two-core runner no
     * longer decides.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
