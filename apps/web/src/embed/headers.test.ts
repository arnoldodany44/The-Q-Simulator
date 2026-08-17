// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  APP_HEADERS,
  EMBED_HEADERS,
  embedContentSecurityPolicy,
  headersFor,
  isEmbedPath,
} from './headers'

/**
 * The framing decision, asserted as a property rather than trusted to a
 * comment.
 *
 * Every assertion here is about an OPPOSITE: the app refuses to be framed and
 * the embed insists on it, the app is cross-origin isolated and the embed
 * deliberately is not. Those pairs are the kind of thing a later "let's
 * consolidate the header table" makes consistent — and consistent is exactly
 * wrong. So the tests say which way round each one goes and why.
 */

function valueOf(
  headers: readonly { key: string; value: string }[],
  key: string
): string | undefined {
  return headers.find((header) => header.key.toLowerCase() === key)?.value
}

describe('the ordinary app', () => {
  it('refuses to be framed, in both spellings', () => {
    // Two headers rather than one: browsers that honour `frame-ancestors`
    // ignore `X-Frame-Options` when both are present, so the legacy header
    // costs nothing and covers what is left.
    expect(valueOf(APP_HEADERS, 'x-frame-options')).toBe('DENY')
    expect(valueOf(APP_HEADERS, 'content-security-policy')).toContain(
      "frame-ancestors 'none'"
    )
  })

  it('stays cross-origin isolated, which is what buys SharedArrayBuffer', () => {
    expect(valueOf(APP_HEADERS, 'cross-origin-opener-policy')).toBe(
      'same-origin'
    )
    expect(valueOf(APP_HEADERS, 'cross-origin-embedder-policy')).toBe(
      'require-corp'
    )
  })
})

describe('the embed', () => {
  it('may be framed by anyone', () => {
    expect(valueOf(EMBED_HEADERS, 'content-security-policy')).toContain(
      'frame-ancestors *'
    )
  })

  it('sends no X-Frame-Options at all', () => {
    /*
     * THE ASSERTION MOST WORTH HAVING. `X-Frame-Options` has no "any origin"
     * value — `ALLOW-FROM` is dead in every current browser — so a
     * `SAMEORIGIN` left here by an over-broad rule would break every embed in
     * the world while looking like a tightening.
     */
    expect(valueOf(EMBED_HEADERS, 'x-frame-options')).toBeUndefined()
  })

  it('sends no COOP, so it runs the transfer path framed or not', () => {
    /*
     * A framed document is never cross-origin isolated — isolation is a
     * property of the whole frame tree and the top-level document belongs to
     * whoever framed us. Isolation needs COOP *and* COEP together, and only
     * for a top-level document, so leaving COOP out is what keeps an embed
     * opened directly behaving exactly like a framed one: `crossOriginIsolated`
     * is false either way and `useEmbedSimulation` always requests the
     * documented transfer path.
     */
    expect(valueOf(EMBED_HEADERS, 'cross-origin-opener-policy')).toBeUndefined()
  })

  it('says it is willing to be a resource AND a nested document', () => {
    /*
     * Both halves, because they answer different questions and the embed used
     * to answer only one.
     *
     * CORP is the permission for being loaded as a SUBRESOURCE. A nested
     * DOCUMENT loaded into a `COEP: require-corp` parent must additionally
     * carry its own `Cross-Origin-Embedder-Policy`, or the load is refused
     * with `net::ERR_BLOCKED_BY_RESPONSE` before a single script runs — so
     * with CORP alone the embed was blocked by exactly the technical sites
     * the header was added for, and blocked too early for any of the "never
     * show a blank frame" machinery to say so.
     */
    expect(valueOf(EMBED_HEADERS, 'cross-origin-resource-policy')).toBe(
      'cross-origin'
    )
    expect(valueOf(EMBED_HEADERS, 'cross-origin-embedder-policy')).toBe(
      'require-corp'
    )
  })

  it('never sends the address of an unlisted circuit as a referrer', () => {
    // Stricter than the app's `strict-origin-when-cross-origin`: the path of
    // an embed is the slug, and a slug is the credential §11 sized at 126
    // bits.
    expect(valueOf(EMBED_HEADERS, 'referrer-policy')).toBe('no-referrer')
  })
})

describe('the embed policy', () => {
  const policy = embedContentSecurityPolicy(false)

  it('refuses everything it does not name', () => {
    expect(policy).toContain("default-src 'none'")
  })

  it('allows no inline script and no eval', () => {
    // The one directive with no escape hatch. `style-src` has to carry
    // `'unsafe-inline'` because a bar's length is an inline style attribute
    // and a nonce cannot cover one; scripts have no such excuse.
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toContain('unsafe-eval')
  })

  it('lets the simulation worker start', () => {
    expect(policy).toContain("worker-src 'self' blob:")
  })

  it('forbids the two levers that turn an injected fragment into a request', () => {
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("base-uri 'none'")
  })

  it('adds exactly two relaxations in development, and no more', () => {
    /*
     * A dev policy that drifted from the deployed one would make the e2e
     * suite prove something about a page nobody visits. The two below are
     * forced: `@vitejs/plugin-react` injects an inline module preamble, and a
     * development machine's HMR socket and local API are on loopback ports
     * that `https:` does not cover.
     */
    const development = embedContentSecurityPolicy(true)
    expect(development).toContain("script-src 'self' 'unsafe-inline'")
    expect(development).toContain('ws://localhost:*')
    expect(development).toContain('http://localhost:*')
    // And neither reaches the deployed policy.
    expect(policy).not.toContain('localhost')

    const normalise = (value: string): string[] =>
      value
        .split('; ')
        .map((directive) => directive.split(' ')[0] ?? '')
        .sort()
    expect(normalise(development)).toEqual(normalise(policy))
  })
})

describe('which headers a path gets', () => {
  it('recognises the three spellings of the embed', () => {
    expect(isEmbedPath('/embed')).toBe(true)
    expect(isEmbedPath('/embed.html')).toBe(true)
    expect(isEmbedPath('/embed/c/abc')).toBe(true)
  })

  it('does not mistake a longer word for the embed', () => {
    // A prefix test against `/embed` alone would claim this one, and would
    // then serve a framable page at an address nobody meant to open up.
    expect(isEmbedPath('/embedding-guide')).toBe(false)
    expect(isEmbedPath('/')).toBe(false)
    expect(isEmbedPath('/c/abc')).toBe(false)
  })

  it('gives every other path the app table', () => {
    expect(headersFor('/c/abc')).toBe(APP_HEADERS)
    expect(valueOf(headersFor('/new'), 'x-frame-options')).toBe('DENY')
  })

  it('gives the embed the embed table, with only its policy relaxed in dev', () => {
    expect(headersFor('/embed/c/abc')).toEqual(EMBED_HEADERS)

    const development = headersFor('/embed/c/abc', true)
    expect(valueOf(development, 'x-frame-options')).toBeUndefined()
    expect(valueOf(development, 'content-security-policy')).toBe(
      embedContentSecurityPolicy(true)
    )
    expect(valueOf(development, 'referrer-policy')).toBe('no-referrer')
  })
})
