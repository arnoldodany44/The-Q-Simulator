/**
 * The runner for `src/verification/presence-a11y/` — presence for somebody who
 * cannot see it.
 *
 * A config of its own rather than a project inside `playwright.live.config.ts`,
 * for the reason that file is separate from `playwright.config.ts`: several
 * verifiers share this tree, and folding this lens into somebody else's config
 * would put its accounts, its artifact directory and its serial worker inside a
 * run that is not this one. Each suite's teardown then deletes only its own
 * identities.
 *
 * Plain JavaScript on purpose. `apps/web/tsconfig.json` names the config files it
 * type-checks, and a `.ts` config that is not on that list cannot be resolved to
 * a project by the type-aware ESLint pass — so it would fail `pnpm verify` for a
 * reason that has nothing to do with the tests. `*.config.js` is already ignored
 * by the lint config.
 *
 *   pnpm --filter web exec playwright test --config playwright.presence-a11y.config.js
 */

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/** The repository root, where the one `.env` lives. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url))
} catch {
  // `liveEnv()` names the missing variable where the reader is already looking
  // at a failure.
}

const PORT = 5173
const BASE_URL = `http://localhost:${PORT}`
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:8080'
/*
 * The readiness probe, over IPv4 explicitly.
 *
 * Fastify binds `0.0.0.0`, which is IPv4 only, while `localhost` on Windows
 * resolves to `::1` first — and Playwright's readiness fetch does not fall back
 * the way Node's `fetch` does. So `reuseExistingServer` never saw the API that
 * was already listening, started a second one, and the run died on EADDRINUSE
 * instead of reusing. Only the probe is rewritten: the browser bundle is
 * compiled against `VITE_API_URL` and must keep the origin it was built with.
 */
const API_PROBE = API_URL.replace('//localhost', '//127.0.0.1')
const inCI = Boolean(process.env.CI)

export default defineConfig({
  /*
   * Serial. Every scenario opens two or three sessions against one API holding
   * `connection_limit=1`, and the relay keeps a document alive for minutes after
   * its last peer leaves.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: inCI,
  /*
   * No retries. A lost announcement that a retry hides is the most expensive
   * thing this suite could do: the transcript this lens measures is a race by
   * construction, and re-rolling a race is how a real defect becomes a flake.
   */
  retries: 0,
  reporter: [['list']],
  timeout: 180_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'accounts',
      testDir: './src/verification/presence-a11y',
      testMatch: /accounts\.setup\.ts$/,
      teardown: 'cleanup',
    },
    {
      name: 'cleanup',
      testDir: './src/verification/presence-a11y',
      testMatch: /accounts\.teardown\.ts$/,
    },
    {
      name: 'presence-a11y',
      testDir: './src/verification/presence-a11y',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['accounts'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command:
        'pnpm --filter api build && node --env-file-if-exists=.env apps/api/dist/server.js',
      cwd: ROOT,
      // `/health` and not `/health/live`: this suite needs a database, and that
      // is the endpoint that answers whether there is one.
      url: `${API_PROBE}/health`,
      reuseExistingServer: !inCI,
      timeout: 240_000,
      stderr: 'pipe',
    },
    {
      command: `pnpm exec vite --port ${PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: !inCI,
      timeout: 180_000,
    },
  ],
})
