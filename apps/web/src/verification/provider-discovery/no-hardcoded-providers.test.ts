// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { providerLabel } from '../../features/auth/providerLabels.js'

/**
 * The Monday invariant: enabling a provider is a dashboard switch, not a
 * deploy.
 *
 * `GET /auth/v1/settings` is read at runtime and every button comes from it,
 * so the sign-in screen is a reading of the project's configuration rather
 * than a claim about it. That property is worth a mechanical check because it
 * is so easy to lose by accident and so quiet when it goes: one
 * `if (provider === 'github')` — a feature flag, an icon lookup, an analytics
 * label — and the promise is gone. Nothing else in the toolchain notices.
 * TypeScript sees a string comparison, ESLint sees an expression, the tests
 * pass, and the screen keeps working right up until the day somebody enables a
 * provider and nothing appears.
 *
 * ── Why a source scan and not a behavioural test ──────────────────────────
 *
 * The behaviour is already covered twice over: `settings.test.ts` proves the
 * document is read in both directions, and `ProviderSignInButtons.test.tsx`
 * proves a `github: true` document renders a working button and a `false` one
 * renders none. What neither can see is a *second* code path that happens to
 * agree with them today — a provider named somewhere else in the app, gating
 * something else. That is a property of the source, so the source is what is
 * checked.
 *
 * `providerLabels.ts` is the one deliberate exception, and it is exempt
 * because it is presentation with a fallback: an unmapped provider still
 * renders, title-cased, so nothing there can stop a new provider from working.
 * The second test below is what keeps that exemption honest.
 */

const SOURCE_ROOT = join(import.meta.dirname, '..', '..')

/**
 * Providers Supabase currently offers, as they appear in `external`. Only the
 * list this test greps for — the app itself has no such list, which is the
 * whole point.
 */
const PROVIDER_NAMES = [
  'apple',
  'azure',
  'bitbucket',
  'discord',
  'facebook',
  'figma',
  'github',
  'gitlab',
  'google',
  'kakao',
  'keycloak',
  'linkedin',
  'notion',
  'slack',
  'spotify',
  'twitch',
  'twitter',
  'workos',
  'zoom',
]

/**
 * A provider name written as a string literal, which is the shape every way
 * of hardcoding one takes: a comparison, an array member, a map key, a class
 * name. Prose in a comment is not matched, and should not be — explaining
 * which providers exist is exactly what a comment is for.
 */
const HARDCODED = new RegExp(`['"\`](${PROVIDER_NAMES.join('|')})['"\`]`, 'i')

/** Files that ship. Tests may name a provider; that is their job. */
function shippedSources(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...shippedSources(path))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    // The fake auth port and the other test helpers are shipped-shaped but
    // never bundled.
    if (entry.name === 'testing.ts') continue
    found.push(path)
  }
  return found
}

/** The label table, exempt for the reason given in the header. */
const EXEMPT = join('features', 'auth', 'providerLabels.ts')

describe('no provider is named in code that ships', () => {
  it('finds no provider name outside the label table', () => {
    const offenders: string[] = []

    for (const path of shippedSources(SOURCE_ROOT)) {
      const shortPath = relative(SOURCE_ROOT, path)
      if (shortPath === EXEMPT) continue

      const source = readFileSync(path, 'utf8')
      for (const line of source.split('\n')) {
        // Comments explain; only code decides.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
        if (HARDCODED.test(code)) offenders.push(`${shortPath}: ${line.trim()}`)
      }
    }

    expect(
      offenders,
      'A provider named in shipped code is a provider that needs a deploy to ' +
        'turn on. The list belongs to GET /auth/v1/settings, read at runtime ' +
        'by lib/supabase/settings.ts — route the decision through there.'
    ).toEqual([])
  })

  it('renders a provider the label table has never heard of', () => {
    /*
     * The exemption above only holds while an unmapped provider still gets a
     * button. If this ever became a lookup that could return undefined, the
     * label table would quietly become a list of supported providers.
     */
    expect(providerLabel('some_new_idp')).toBe('Some New Idp')
    expect(providerLabel('x')).toBe('X')
    // And a mapped one keeps the brand's own spelling.
    expect(providerLabel('workos')).toBe('WorkOS')
  })
})
