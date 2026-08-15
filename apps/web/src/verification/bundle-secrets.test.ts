// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Nothing that grants access may be compiled into the browser bundle — §11,
 * §12.5.
 *
 * ── Why this verifier exists now ──────────────────────────────────────────
 *
 * M1.3a pointed Vite's `envDir` at the repository root, because the monorepo
 * keeps one `.env` and the browser's two Supabase variables live in it. That
 * same file holds `SUPABASE_SECRET_KEY`, `DATABASE_URL` and `ENCRYPTION_KEY`.
 * Vite only exposes `VITE_`-prefixed variables to `import.meta.env`, so the
 * arrangement is safe — but it is safe because of a *prefix convention*, and
 * a convention with a five-character escape hatch is exactly the thing to
 * check mechanically.
 *
 * The failure this catches is not exotic. It is somebody who needs a value in
 * the frontend, adds `VITE_` to its name because that is what makes it
 * appear, and ships a service-role key to every visitor. It reviews as a
 * one-word change. Nothing else in the toolchain says a word about it:
 * TypeScript sees a string, ESLint sees a property read, the tests pass, and
 * the app works perfectly.
 *
 * ── Why the names and not the built output ────────────────────────────────
 *
 * Grepping `dist/` would be the direct test, and it would depend on a build
 * having happened — in an order `turbo` does not promise, against a `.env`
 * that CI does not have. This checks the two things that decide what the
 * bundle *can* contain: which variables carry the prefix, and whether the
 * prefix is still the whole gate. Same guarantee, one step earlier, in
 * milliseconds.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

/** The committed documentation, and the file actually loaded. */
const ENV_FILES = ['.env.example', '.env']

/**
 * Every `VITE_` variable this app is allowed to have.
 *
 * An allow-list rather than a deny-list, deliberately: a deny-list has to
 * anticipate the name of the next secret, and the next secret will be called
 * something nobody thought of. Adding a line here is the moment to ask
 * whether the value may be read by anyone who opens the network tab.
 */
const ALLOWED_PUBLIC_VARS: ReadonlySet<string> = new Set([
  // The API origin. An address, not a credential.
  'VITE_API_URL',
  // The WebSocket origin (Phase 2). Same.
  'VITE_WS_URL',
  // The Supabase project origin.
  'VITE_SUPABASE_URL',
  // `sb_publishable_…`. Identifies the project and authorises nothing on its
  // own; everything behind it is bound by row-level security server-side.
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  // Sentry's DSN is designed to be public — it is an ingest address.
  'VITE_SENTRY_DSN',
])

/** Substrings that mark a name as something which must stay server-side. */
const SECRET_MARKERS = [
  'SECRET',
  'PASSWORD',
  'PRIVATE',
  'TOKEN',
  'ENCRYPTION',
  'DATABASE_URL',
  'DIRECT_URL',
  'REDIS_URL',
]

/** The variable names declared in a dotenv-style file that exists. */
function publicVariablesIn(file: string): string[] {
  const path = join(REPO_ROOT, file)
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((name) => name.startsWith('VITE_'))
}

describe('the browser bundle carries no credentials', () => {
  it.each(ENV_FILES)('exposes only vetted variables from %s', (file) => {
    /*
     * Both files, because they drift: a variable gets added to `.env` during
     * an afternoon of debugging and never reaches the example. The example is
     * what review sees; `.env` is what Vite loads. A missing `.env` — CI —
     * simply contributes nothing.
     */
    for (const name of publicVariablesIn(file)) {
      expect(
        ALLOWED_PUBLIC_VARS.has(name),
        `${file} declares ${name}, which would be compiled into the browser ` +
          'bundle. If it is genuinely public, add it to ALLOWED_PUBLIC_VARS ' +
          'with a note saying why. If it is not, drop the VITE_ prefix and ' +
          'read it in apps/api instead.'
      ).toBe(true)
    }
  })

  it.each(ENV_FILES)('never prefixes a credential with VITE_ in %s', (file) => {
    // The other direction: not "is this name on the list" but "does this name
    // announce itself as a credential". The two catch different mistakes.
    for (const name of publicVariablesIn(file)) {
      for (const marker of SECRET_MARKERS) {
        expect(
          name.includes(marker),
          `${file} declares ${name}: a VITE_ variable whose name contains ` +
            `${marker} is almost certainly a credential being sent to every ` +
            'visitor.'
        ).toBe(false)
      }
    }
  })

  it('leaves envPrefix at its default, so VITE_ remains the whole gate', () => {
    /*
     * Setting it to the empty string exposes *every* variable in the file. It
     * is one line in a config nobody rereads, and it would publish the
     * database URL while every assertion above still passed — because they
     * are about names, and this changes the rule the names are read under.
     */
    const config = readFileSync(
      join(import.meta.dirname, '..', '..', 'vite.config.ts'),
      'utf8'
    )
    expect(config).not.toMatch(/^\s*envPrefix\s*:/m)
  })
})
