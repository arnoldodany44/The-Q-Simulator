/**
 * The end-to-end harness (§3/M0.5).
 *
 * Vitest already covers the editor unit by unit: the placement rules, the
 * store, the geometry, the canvas's accessible names. What no jsdom test can
 * cover is the join between them — a real `pointerdown` / `pointermove`
 * stream reaching dnd-kit's activation constraint, a real focus ring moving
 * through a roving tabindex, a real browser computing an accessible name
 * from the DOM we actually shipped. That join is what this suite exists for,
 * and it is why the assertions read the page rather than the store.
 *
 * ## The dev server is started here, not by whoever runs the suite
 *
 * `webServer` makes the suite self-contained: `pnpm test:e2e` on a cold
 * checkout starts Vite, waits for it, runs, and shuts it down. A suite that
 * silently depends on a server someone remembered to start is a suite that
 * fails in CI and nowhere else.
 *
 * `--strictPort` matters more than it looks. Vite is configured for 5173
 * (see `vite.config.ts`, where the COOP/COEP headers live) but will happily
 * fall forward to 5174 if the port is taken — and then Playwright waits two
 * minutes on a URL nothing is serving. Failing loudly on a busy port turns
 * that into an instant, readable error.
 *
 * ## Chromium only, deliberately
 *
 * The editor's browser-specific surface is dnd-kit's pointer handling and
 * the accessible name computation, and three engines would triple the
 * browser download in CI to re-prove the same DOM. Firefox and WebKit are
 * worth adding the day something here is actually engine-sensitive; adding
 * them now would only buy a slower gate.
 */

import { defineConfig, devices } from '@playwright/test'

const PORT = 5173
const BASE_URL = `http://localhost:${PORT}`

/** GitHub Actions and every other runner set this; local machines do not. */
const inCI = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e',
  // `support/` holds helpers, not specs, and must not be collected.
  testMatch: /.*\.spec\.ts$/,
  /*
   * `e2e/live/` is the two-browser acceptance suite for the shared session, and
   * it needs what this config deliberately does not start: the API, a database,
   * a Supabase project and two accounts it creates and deletes. It has a config
   * of its own (`playwright.live.config.ts`) and a script of its own
   * (`test:e2e:live`); ignoring it here is what keeps *this* suite runnable on a
   * checkout with no `.env`, which is why it can be the one that runs on `main`.
   */
  testIgnore: '**/live/**',

  fullyParallel: true,
  // A `.only` left in a spec silently shrinks the suite to one test, which is
  // exactly the kind of green nobody notices.
  forbidOnly: inCI,
  retries: inCI ? 2 : 0,
  workers: inCI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    /*
     * D2: with nothing in `localStorage`, i18next detects the language from
     * `navigator.language` — which on a developer's machine is whatever
     * their OS is set to. Pinning the browser locale keeps the default run
     * in English on every machine; the tests that care about a specific
     * language set it explicitly rather than inheriting it.
     */
    locale: 'en-US',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Locally the server is usually already up and reusing it saves the cold
    // start on every run; in CI reuse would mean silently testing whatever
    // stale process happened to survive from an earlier step.
    reuseExistingServer: !inCI,
    /*
     * Three minutes. A warm Vite is ready in under a second, but the first
     * start after an install has to pre-bundle the dependency graph, and on
     * Windows that walk is slow enough — Defender scans every file Vite
     * touches — that the 60s default fails on a cold checkout and nowhere
     * else.
     */
    timeout: 180_000,
  },
})
