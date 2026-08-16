import { defineConfig } from 'vitest/config'

/**
 * The worker's wall-clock budget, kept out of `pnpm test` for the reason every
 * `*.perf.test.ts` in this repository is: a timing assertion is only meaningful
 * when nothing else is competing for the CPU, and this suite runs beside a
 * hundred other files and several forked child processes.
 *
 * What it defends is `UNIT_COST_MS` in `@qsim/jobs` — the constant the §11
 * admission check divides the wall-clock bound by. Run it on its own:
 *
 *   pnpm --filter worker test:perf
 *
 * `fileParallelism: false` for the same reason: a budget measured while a
 * sibling file is saturating the machine is a budget measuring the machine.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.perf.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
