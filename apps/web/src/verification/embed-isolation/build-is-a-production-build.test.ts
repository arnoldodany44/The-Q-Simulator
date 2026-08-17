// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveConfig } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `pnpm build` must emit a PRODUCTION bundle — and for a while it did not.
 *
 * `vite.config.ts` points `envDir` at the repository root so the monorepo
 * keeps one `.env`. That file is mostly `apps/api`'s, and one of its lines is
 * `NODE_ENV=development`. Vite reads `NODE_ENV` out of an env file whatever
 * `envPrefix` says, promotes it to `VITE_USER_NODE_ENV`, and lets it override
 * the mode — so `vite build` produced React's development build: a
 * `jsx-dev-runtime` chunk, a react-dom of 353 kB rather than 179 kB, and an
 * embed entry whose static import closure was 634 kB.
 *
 * That matters here rather than in a bundle-size ledger because the embed's
 * whole design argument is about weight and per-frame cost ("six frames in a
 * blog post would each parse it", `vite.config.ts`), and every local and CI
 * measurement of it was made against the wrong artefact. Vercel was fine —
 * `.env` is gitignored, so nothing sets `NODE_ENV` there — which is what made
 * this invisible: the defect existed only on the machines of the people
 * checking for it.
 *
 * ── Why the resolved config and not `dist/` ───────────────────────────────
 *
 * The same reasoning `bundle-secrets.test.ts` gives: grepping the built output
 * would depend on a build having happened, in an order `turbo` does not
 * promise. `isProduction` is the single value every one of those consequences
 * follows from — it is what selects the production JSX runtime and the
 * production react-dom — so resolving the real config with the real `.env` in
 * place asks the question one step earlier and in milliseconds.
 */

const WEB_DIR = join(import.meta.dirname, '..', '..', '..')
const REPO_ROOT = join(WEB_DIR, '..', '..')

/**
 * Vite samples `process.env.NODE_ENV` once, and if it is already set the env
 * file cannot override it. Vitest sets it to `test`, which would make this
 * assertion pass for a reason that has nothing to do with the defect — so the
 * variable is removed for the duration, exactly as a bare `vite build` finds
 * it.
 */
let savedNodeEnv: string | undefined
let savedUserNodeEnv: string | undefined

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV
  savedUserNodeEnv = process.env.VITE_USER_NODE_ENV
  delete process.env.NODE_ENV
  delete process.env.VITE_USER_NODE_ENV
})

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
  if (savedUserNodeEnv === undefined) delete process.env.VITE_USER_NODE_ENV
  else process.env.VITE_USER_NODE_ENV = savedUserNodeEnv
})

describe('the build this repository actually runs', () => {
  it('resolves as production, with the shared .env in place', async () => {
    const config = await resolveConfig(
      { root: WEB_DIR, configFile: join(WEB_DIR, 'vite.config.ts') },
      'build',
      'production',
      'production'
    )
    expect(config.isProduction).toBe(true)
    expect(config.mode).toBe('production')
  })

  it('still serves the dev server as development', async () => {
    // The other half: neutralising the env file's `NODE_ENV` must not have
    // turned `pnpm dev` into a production build, which would cost every React
    // warning the editor is developed against.
    const config = await resolveConfig(
      { root: WEB_DIR, configFile: join(WEB_DIR, 'vite.config.ts') },
      'serve',
      'development',
      'development'
    )
    expect(config.isProduction).toBe(false)
  })

  it('is still reading the shared .env for the browser variables', () => {
    /*
     * The fix must not have been "stop reading the file". `envDir` is the
     * reason there is one `.env` in this monorepo, and `bundle-secrets.test.ts`
     * is written against that arrangement. Asserted as the option rather than
     * as a loaded value, because a developer machine may legitimately have no
     * `.env` at all.
     */
    const source = readFileSync(join(WEB_DIR, 'vite.config.ts'), 'utf8')
    expect(source).toContain("envDir: '../..'")

    const envFile = join(REPO_ROOT, '.env')
    if (!existsSync(envFile)) return
    // And when the file IS there, it is the one carrying the line that used to
    // decide the build — so the assertions above were not vacuous.
    const env = readFileSync(envFile, 'utf8')
    expect(env).toMatch(/^NODE_ENV=/m)
  })
})
