// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APP_HEADERS,
  APP_HEADER_SOURCE,
  EMBED_HEADERS,
  isEmbedPath,
  type HttpHeader,
} from '../../embed/headers'

/**
 * The deployment sends what the dev server sends.
 *
 * `src/embed/headers.ts` is read by `vite.config.ts`, so `pnpm dev` and
 * `pnpm test:e2e` genuinely serve those values. Production is served by
 * Vercel from `vercel.json`, which cannot import anything and cannot even
 * carry a comment — its schema rejects unknown properties, so a `"//"` key
 * used as a note fails the deployment outright.
 *
 * That is a drift waiting to happen, and the drift is invisible: every test
 * in the project would stay green while the deployed site framed happily and
 * the embed refused to be framed. So this file reads the JSON and compares it,
 * value by value, against the module — which is the only way "the headers are
 * declared once" can be a fact rather than an intention.
 *
 * It also checks the shape of the *matching*, not only the values. The app's
 * rule is written as a negative lookahead rather than as a catch-all that the
 * embed's rule then overrides, because relying on which rule wins for a
 * duplicate key is relying on behaviour Vercel documents nowhere — and the
 * failure mode is `X-Frame-Options: DENY` surviving onto the embed, which
 * breaks every frame in the world silently.
 */

interface VercelHeaderRule {
  source: string
  headers: HttpHeader[]
}

interface VercelRewriteRule {
  source: string
  destination: string
}

interface VercelConfig {
  rewrites: VercelRewriteRule[]
  headers: VercelHeaderRule[]
}

const CONFIG_PATH = join(import.meta.dirname, '../../../vercel.json')

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as VercelConfig

function ruleFor(source: string): VercelHeaderRule {
  const rule = config.headers.find((entry) => entry.source === source)
  if (rule === undefined) {
    throw new Error(
      `vercel.json has no header rule for "${source}". The three embed ` +
        'spellings and the app rule all have to be there; see ' +
        'src/embed/headers.ts.'
    )
  }
  return rule
}

/** The three addresses that deliver `embed.html`, per `isEmbedPath`. */
const EMBED_SOURCES = ['/embed', '/embed.html', '/embed/(.*)']

describe('vercel.json and src/embed/headers.ts', () => {
  it('sends the app table on everything that is not the embed', () => {
    expect(ruleFor(APP_HEADER_SOURCE).headers).toEqual(APP_HEADERS)
  })

  it.each(EMBED_SOURCES)('sends the embed table on "%s"', (source) => {
    expect(ruleFor(source).headers).toEqual(EMBED_HEADERS)
  })

  it('excludes the embed from the app rule instead of overriding it', () => {
    /*
     * The lookahead is the whole safety of this arrangement. With a catch-all
     * `/(.*)` the app's `X-Frame-Options: DENY` would also match `/embed/…`,
     * and whether the embed's rule then removed it depends on merge semantics
     * this project does not control.
     */
    const app = config.headers.find((rule) =>
      rule.headers.some((header) => header.key === 'X-Frame-Options')
    )
    expect(app?.source).toBe(APP_HEADER_SOURCE)

    // And the pattern really does what it claims, checked as a regex rather
    // than as a shape somebody read.
    const matcher = new RegExp(`^${app?.source ?? ''}$`)
    expect(matcher.test('/')).toBe(true)
    expect(matcher.test('/c/abc')).toBe(true)
    expect(matcher.test('/embed')).toBe(false)
    expect(matcher.test('/embed.html')).toBe(false)
    expect(matcher.test('/embed/c/abc')).toBe(false)
  })

  /**
   * THE EXCLUSION MUST BE EXACTLY `isEmbedPath`, NOT A PREFIX OF IT.
   *
   * `/((?!embed).*)` excluded every path merely BEGINNING with "embed", and no
   * embed rule matched those, so the deployment answered `/embedded` and
   * `/embed-guide` with the whole application and not one header — no
   * `X-Frame-Options`, no `frame-ancestors`, no COOP, no COEP, no `nosniff`.
   * Framed from a foreign origin the app document loaded, where `/new` was
   * refused. The dev server, driven by the module, refused all of them
   * correctly; the disagreement was invisible because this file only ever
   * probed `/`, `/c/abc` and the three embed spellings.
   *
   * So the regex is now compared against `isEmbedPath` itself, over every path
   * shape that has ever been confusing, and the two must agree exactly.
   */
  it.each([
    '/',
    '/new',
    '/c/abc',
    '/challenges/bell-pair',
    '/lessons/superposition',
    '/embed',
    '/embed.html',
    '/embed/c/abc',
    '/embedded',
    '/embeds',
    '/embed-guide',
    '/embedX',
    '/embedding-guide',
    '/assets/embed-abc.js',
  ])(
    'the app rule matches "%s" exactly when the module says it is not an embed',
    (pathname) => {
      const matcher = new RegExp(`^${APP_HEADER_SOURCE}$`)
      expect(matcher.test(pathname)).toBe(!isEmbedPath(pathname))
    }
  )

  /**
   * The embed's answer to a `COEP: require-corp` parent is TWO headers.
   *
   * CORP governs subresources; a nested document loaded into a `require-corp`
   * parent must carry its own `Cross-Origin-Embedder-Policy` or the load is
   * refused before any script runs. The module used to send CORP alone and
   * claim the property, so the embed was blocked by exactly the technical
   * sites the header names — silently, with an empty frame and nothing to
   * diagnose from. Asserted here rather than only in the table comparison
   * because the two headers are one decision.
   */
  it('lets a cross-origin-isolated parent frame the embed', () => {
    const keys = EMBED_HEADERS.map((header) => header.key)
    expect(keys).toContain('Cross-Origin-Resource-Policy')
    expect(keys).toContain('Cross-Origin-Embedder-Policy')
    // And still no COOP, so nothing here is cross-origin isolated — framed or
    // opened directly, which is what keeps the transfer path the only path.
    expect(keys).not.toContain('Cross-Origin-Opener-Policy')
    expect(keys).not.toContain('X-Frame-Options')
  })

  it('routes every embed address to embed.html, before the SPA fallback', () => {
    /*
     * Order matters and is the reason this is asserted rather than assumed:
     * Vercel applies the first matching rewrite, so a catch-all placed above
     * these would answer `/embed/c/:slug` with `index.html` — the whole app,
     * session and all, at the one address that must not have one.
     */
    const embedRewrites = config.rewrites.filter(
      (rule) => rule.destination === '/embed.html'
    )
    expect(embedRewrites.map((rule) => rule.source)).toEqual([
      '/embed/:path*',
      '/embed',
    ])

    const fallback = config.rewrites.findIndex(
      (rule) => rule.destination === '/index.html'
    )
    expect(fallback).toBe(config.rewrites.length - 1)
  })
})
