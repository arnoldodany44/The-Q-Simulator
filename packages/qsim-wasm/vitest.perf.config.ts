import { defineConfig } from 'vitest/config'

/**
 * The speedup measurement. Kept out of `pnpm test` because it asserts and
 * prints wall-clock numbers, which mean nothing when three other workspaces
 * are building on the same cores.
 *
 *   pnpm --filter @qsim/wasm test:perf
 *
 * With no `.wasm` artifact present it still runs, and reports the TypeScript
 * baseline alone — the numbers a future WASM build has to beat, measured on
 * the machine doing the asking rather than quoted from a README.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.perf.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
