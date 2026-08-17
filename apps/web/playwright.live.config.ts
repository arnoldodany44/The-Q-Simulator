/**
 * The live stack: two browsers, one relay, one database (Fase 5's acceptance).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SECOND CONFIG AND NOT THREE MORE PROJECTS IN THE FIRST
 *
 * `playwright.config.ts` starts Vite and nothing else. That is what makes the
 * existing suite runnable on a bare checkout with no `.env`, no Postgres and no
 * Supabase project, and it is why it can afford to be the gate that runs on
 * `main` (`.github/workflows/e2e.yml`) — fifteen specs against a static server.
 *
 * This suite cannot be that. It needs the API, which needs the database and the
 * auth project's JWKS, and it creates two real accounts. Folding it into the
 * same config would put those requirements on every run of the fast suite —
 * `webServer` is global, so the API would be started even for a spec that does
 * not want it — and a contributor with no `.env` would see fifteen green specs
 * become a boot failure. So: a config of its own, a script of its own
 * (`test:e2e:live`), and `testIgnore` in the fast config so neither collects the
 * other's specs.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS STARTED, AND THE ONE THING THAT DELIBERATELY IS NOT
 *
 * The API and Vite. Both are declared here so a run is self-contained, and both
 * reuse a server that is already listening, which is the common case on the
 * machine this was written on.
 *
 * **`apps/worker` is not started, and that is a decision rather than an
 * omission.** Nothing on the collaboration path enqueues a job: the relay lives
 * inside the API process (`plugins/collab.ts`), the editor simulates in a Web
 * Worker in the browser, and no scenario here calls `POST /simulate`. What a
 * BullMQ consumer *would* do is attach to the shared, metered Redis and take
 * whatever is on that queue — including a hardware submission somebody else
 * queued, which is IBM QPU seconds out of an account that has 598 of them left.
 * A consumer that can spend a quantum computer's time is not something to start
 * for fidelity's sake in a suite that has no work for it. If a scenario is ever
 * added that needs a server-side run, the worker belongs here with its own
 * readiness check — it has no HTTP port, so it cannot be a `webServer` entry as
 * it stands.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE THREE PROJECTS ARE A LIFECYCLE
 *
 *   accounts → live → cleanup
 *
 * `accounts` mints two Supabase users and signs two browsers in; `live` runs the
 * scenarios; `cleanup` deletes both accounts, which cascades every circuit,
 * version, session row and comment they own. `cleanup` is declared as `live`'s
 * `teardown`, so Playwright runs it after the scenarios *whether they passed or
 * not* — the database is the owner's only one, and a failing run is exactly when
 * rows get left behind.
 *
 * One worker, and not for speed: every scenario drives two or three browser
 * contexts against one API holding `connection_limit=1`, and the relay keeps a
 * document alive for minutes after its last peer leaves. Parallel workers would
 * be several tests' worth of peers contending for one connection.
 */

import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * The repository root, which is where the API's `--env-file` and Vite's
 * `envDir` both point.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/*
 * The one `.env`, loaded into this process so the setup project can reach
 * SUPABASE_SECRET_KEY. Absent is not fatal here: `liveEnv()` names the missing
 * variable when a test asks for it, which is a better error than a config that
 * refuses to load.
 */
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url))
} catch {
  // Reported by `liveEnv()`, where the reader is already looking at a failure.
}

const PORT = 5173
const BASE_URL = `http://localhost:${PORT}`
const API_URL = process.env.VITE_API_URL ?? 'http://localhost:8080'

const inCI = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e/live',
  testMatch: /.*\.(spec|setup|teardown)\.ts$/,

  /*
   * Serial, for the reason in the header. `forbidOnly` is on in CI for the same
   * reason the fast config has it: a stray `.only` shrinks the suite to one test
   * and nobody notices the green.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: inCI,
  /*
   * No retries. A CRDT convergence failure that a retry hides is the single most
   * expensive thing this suite could do: the whole reason it exists is that Fase
   * 5 looked finished twice. A flake here is information and must be read, not
   * re-rolled.
   */
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],

  /*
   * Ninety seconds a test. Each one opens two or three real sessions — a socket,
   * an ES256 verification, a database read for the authorisation, a document
   * built from the saved version — and then waits on presence, which is
   * throttled at 120 ms and heartbeats every ten seconds.
   */
  timeout: 90_000,
  expect: {
    /*
     * Fifteen seconds for one assertion, which is far above the propagation this
     * suite measures (a gate reaches the other browser in tens of milliseconds
     * plus the transport's 100 ms coalescing window) and below the ten-second
     * presence heartbeat that would mask a peer whose *first* announcement was
     * lost. A generous per-assertion timeout is what keeps a slow machine from
     * reading as a divergence; it does not make a real divergence pass, because
     * a document that never converges never converges.
     */
    timeout: 15_000,
  },

  use: {
    baseURL: BASE_URL,
    // D2: pinned so the assertions' English is not at the mercy of the machine's
    // locale. `pinLanguage` does the same for storage; both are needed.
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'accounts',
      testMatch: /accounts\.setup\.ts$/,
      teardown: 'cleanup',
    },
    {
      name: 'cleanup',
      testMatch: /accounts\.teardown\.ts$/,
    },
    {
      name: 'live',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['accounts'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      /*
       * Built and run rather than watched: `pnpm --filter api dev` is an esbuild
       * watcher that spawns the server as a grandchild, and a grandchild is
       * exactly the process a test runner's teardown fails to kill.
       */
      command:
        'pnpm --filter api build && node --env-file-if-exists=.env apps/api/dist/server.js',
      cwd: ROOT,
      // `/health` and not `/health/live`: this suite needs a database, and that
      // is the endpoint that answers whether there is one.
      url: `${API_URL}/health`,
      reuseExistingServer: !inCI,
      // A cold `pnpm build` of the API and its workspace dependencies on Windows,
      // with Defender reading every file esbuild touches.
      timeout: 240_000,
      /*
       * `stderr` only. The API logs a line per request through pino on stdout, so
       * piping it puts a hundred JSON lines between the reader and the assertion
       * that failed — while the two things worth seeing on a bad run, a Zod
       * environment error and a stack, are on stderr.
       */
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
