import { defineConfig } from 'vitest/config'

/**
 * The correctness suite. Runs everywhere, including on the many checkouts
 * with no Rust toolchain: the bridge is exercised against the linear-memory
 * stand-in in `src/testing/`, and the suites that need the real artifact skip
 * themselves when `pkg/` is empty rather than failing.
 *
 * `*.perf.test.ts` is excluded for the reason `@qsim/core` excludes it — a
 * wall-clock assertion running alongside four other workspaces measures the
 * scheduler.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.perf.test.ts'],
  },
})
