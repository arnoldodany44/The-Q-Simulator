import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
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
