/**
 * The runner for `src/verification/convergence-live/` — an independent
 * two-browser reading of §3.4's convergence claim.
 *
 * A config of its own rather than a project inside `playwright.live.config.ts`,
 * for the same reason that file is separate from `playwright.config.ts`: several
 * verifiers share this tree, and folding this lens into somebody else's config
 * would put its accounts, its artifact directory and its serial worker inside a
 * run that is not this one. The two suites can therefore run one after the other
 * without either teardown deleting the other's identities.
 *
 * Plain JavaScript on purpose. `apps/web/tsconfig.json` names the config files it
 * type-checks, and a `.ts` config that is not on that list is a file the type-aware
 * ESLint pass cannot resolve to a project — so it would fail `pnpm verify` for a
 * reason that has nothing to do with the tests. `*.config.js` is already ignored
 * by the lint config.
 *
 *   pnpm --filter web exec playwright test --config playwright.convergence.config.js
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
const inCI = Boolean(process.env.CI)

export default defineConfig({
  /*
   * Serial, and not for speed: every scenario drives two or three browser
   * contexts against one API holding `connection_limit=1`, and the relay keeps a
   * document alive for minutes after its last peer leaves.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: inCI,
  /*
   * No retries. A convergence failure that a retry hides is the most expensive
   * thing this suite could do — the whole reason it exists is that this feature
   * has looked finished twice.
   */
  retries: 0,
  reporter: [['list']],
  timeout: 150_000,
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
      testDir: './src/verification/convergence-live',
      testMatch: /accounts\.setup\.ts$/,
      teardown: 'cleanup',
    },
    {
      name: 'cleanup',
      testDir: './src/verification/convergence-live',
      testMatch: /accounts\.teardown\.ts$/,
    },
    {
      name: 'convergence',
      testDir: './src/verification/convergence-live',
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
      url: `${API_URL}/health`,
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
