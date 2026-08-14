import { defineConfig } from 'vitest/config'

/**
 * The performance budgets from the work plan (M0.2 and M0.4).
 *
 * Kept out of `pnpm test` because wall-clock assertions are only meaningful
 * when nothing else is competing for the CPU. Run this on its own:
 *
 *   pnpm --filter @qsim/core test:perf
 *
 * `fileParallelism: false` keeps the budget files from competing with each
 * other for the same reason they are kept out of the default suite.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.perf.test.ts'],
    fileParallelism: false,
  },
})
