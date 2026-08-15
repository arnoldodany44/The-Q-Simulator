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
  },
})
