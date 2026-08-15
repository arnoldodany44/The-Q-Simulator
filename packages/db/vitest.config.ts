import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Only this package's own sources. The generated client ships no tests,
    // and picking up `src/generated/**` would make the glob crawl a few
    // thousand files for nothing.
    include: ['src/*.test.ts'],
  },
})
