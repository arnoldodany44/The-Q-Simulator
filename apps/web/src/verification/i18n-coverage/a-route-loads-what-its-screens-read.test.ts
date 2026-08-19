// @vitest-environment node
/**
 * Every key a screen asks for is in a namespace its route actually loads.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS FOR
 *
 * §3.7's two screens were written against a `hardware` namespace that neither
 * `SETTINGS_NAMESPACES` nor `EDITOR_NAMESPACES` listed. Nothing threw: i18next
 * answers an unloaded key with the key itself, so the settings screen rendered
 * a form whose every label read `credentials.heading`, `credentials.apiKey`,
 * `credentials.save`. It shipped, and it was found by opening the page.
 *
 * Nothing could have caught it before this file:
 *
 *  - The compiler cannot. `t('credentials.apiKey')` is a string.
 *  - The unit suites cannot. Each component's own test builds an i18n instance
 *    and hands it exactly the namespaces that component wants, which is the one
 *    arrangement that can never disagree with itself.
 *  - `e2e/no-raw-keys.spec.ts` cannot, and this is the interesting one. It does
 *    sweep `/settings`, but it sweeps signed out, and `/settings` is behind
 *    `RequireSession` — so what it reads there is the guard's sign-in screen.
 *    That file's own header says as much. A sweep that cannot reach a screen
 *    cannot vouch for it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW IT CHECKS
 *
 * By reading the source, not by rendering. Rendering proves one branch of one
 * component under whatever fixtures the test happened to build; the question
 * here is about *every* key in the file against *the route's own declaration*,
 * and both of those are on disk.
 *
 * So: pull every `t('…')` literal out of a screen's source, resolve its
 * namespace — the explicit `ns:key` prefix, or the default the file passes to
 * `useTranslation` — and require that the route mounting it lists that
 * namespace and that the catalogue holds that key, in all three languages.
 *
 * The screens are named here rather than discovered, because "which route mounts
 * this component" is not something a regular expression can know. A new screen
 * has to be added to the table below, and a screen missing from it is the one
 * gap this file has by construction.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  EDITOR_NAMESPACES,
  SETTINGS_NAMESPACES,
  SHELL_NAMESPACES,
} from '../../i18n/index.js'

const LANGUAGES = ['en', 'es', 'fr'] as const

/** A screen, the route that mounts it, and what that route loads. */
const SCREENS = [
  {
    source: 'features/hardware/HardwareCredentialsSection.tsx',
    route: '/settings',
    loads: [...SETTINGS_NAMESPACES, ...SHELL_NAMESPACES],
  },
  {
    source: 'features/hardware/SubmitToHardwarePanel.tsx',
    route: '/new and /c/:slug',
    loads: [...EDITOR_NAMESPACES, ...SHELL_NAMESPACES],
  },
] as const

function read(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
}

function catalogue(language: string, namespace: string): unknown {
  return JSON.parse(
    read(`i18n/locales/${language}/${namespace}.json`)
  ) as unknown
}

/** `a.b.c` against a nested object, without assuming any depth. */
function lookup(root: unknown, dotted: string): unknown {
  let node: unknown = root
  for (const part of dotted.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/**
 * The default namespace the file passes to `useTranslation`.
 *
 * A single string is the default for every unprefixed key. An array's first
 * entry is i18next's default, which is a detail worth pinning: a file that reads
 * `useTranslation(['hardware', 'common'])` and then asks for a bare
 * `actions.close` is asking `hardware`, not `common`.
 */
function defaultNamespace(source: string): string | null {
  const single = /useTranslation\(\s*'([^']+)'\s*\)/.exec(source)
  if (single !== null) return single[1] ?? null
  const list = /useTranslation\(\s*\[\s*'([^']+)'/.exec(source)
  return list?.[1] ?? null
}

/** Every `t('…')` in the file, as `{namespace, key}`. */
function keysAskedFor(
  source: string,
  fallback: string | null
): readonly { namespace: string; key: string }[] {
  const found: { namespace: string; key: string }[] = []
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
    const raw = match[1]
    if (raw === undefined) continue
    const colon = raw.indexOf(':')
    if (colon >= 0) {
      found.push({
        namespace: raw.slice(0, colon),
        key: raw.slice(colon + 1),
      })
    } else if (fallback !== null) {
      found.push({ namespace: fallback, key: raw })
    }
  }
  return found
}

describe.each(SCREENS)('$source, mounted by $route', (screen) => {
  const source = read(screen.source)
  const fallback = defaultNamespace(source)
  const asked = keysAskedFor(source, fallback)

  it('asks for at least one key, or this file is checking nothing', () => {
    // A regular expression that silently matched nothing would make every
    // assertion below vacuously true, which is the failure mode of any test
    // that derives its own subject.
    expect(asked.length).toBeGreaterThan(0)
  })

  it('reads only namespaces the route loads', () => {
    const loaded = new Set<string>(screen.loads)
    const missing = [
      ...new Set(
        asked.map((entry) => entry.namespace).filter((ns) => !loaded.has(ns))
      ),
    ]
    expect(
      missing,
      `${screen.route} does not load these, so their keys render as text`
    ).toEqual([])
  })

  for (const language of LANGUAGES) {
    it(`finds every key in the ${language} catalogue`, () => {
      const absent = asked.filter((entry) => {
        // A namespace the route does not load is the other test's failure; here
        // it would only produce a confusing second one.
        if (!new Set<string>(screen.loads).has(entry.namespace)) return false
        const value = lookup(catalogue(language, entry.namespace), entry.key)
        return typeof value !== 'string'
      })
      expect(
        absent.map((entry) => `${entry.namespace}:${entry.key}`),
        `missing from ${language}`
      ).toEqual([])
    })
  }
})
