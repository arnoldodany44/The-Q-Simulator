/**
 * The embed's whole application: read the address, get one circuit, draw it.
 *
 * There is no router, no provider and no context. The three things the app's
 * `main.tsx` builds before it renders — a Supabase session, an API client with
 * a token provider, a React Query cache — are all absent here, and their
 * absence is the security property `fetchEmbed.ts` and `embed/headers.ts`
 * argue at length. What is left is a state machine with four states and no
 * transitions after the first.
 *
 * ── Every failure is a sentence, never a blank frame ─────────────────────
 *
 * An embed that renders nothing is indistinguishable, in the middle of a
 * lecture slide, from an embed that was never there. So each way this can fail
 * has a state and a translated line: the address is not an address, the
 * circuit is not embeddable (which is also what a PRIVATE one looks like, and
 * must be — §11), the link's payload will not decode, this deployment has no
 * API, or the request failed.
 *
 * ── The refusal deliberately says nothing ────────────────────────────────
 *
 * `unavailable` is one state for "there is no such circuit" and for "that
 * circuit is private", because the server answers both with the same 404 and
 * this client must not invent a distinction the response does not carry. The
 * sentence it renders is worded for a reader of a blog post rather than for
 * the author of the circuit, and it names neither possibility.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { decode } from '../lib/circuit-url'
import { EmbedView } from './EmbedView'
import { documentFromApi, documentFromLink } from './document'
import type { EmbedDocument } from './document'
import { fetchEmbed } from './fetchEmbed'
import type { EmbedFetchError } from './fetchEmbed'
import { readEmbedAddress } from './source'
import { useEmbedSimulation } from './useEmbedSimulation'

/** Everything that can be on screen instead of a circuit. */
export type EmbedFailure =
  /** The path is neither `/embed/c/:slug` nor `/embed?c=…`. */
  | 'no-address'
  /** A `?c=` payload the URL codec refused. */
  | 'bad-link'
  | EmbedFetchError

type Resolution =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly document: EmbedDocument }
  | { readonly status: 'failed'; readonly code: EmbedFailure }

export interface EmbedAppProps {
  /** `window.location`, injected so a test can hand it two strings. */
  readonly pathname: string
  readonly search: string
  readonly origin: string
}

export function EmbedApp({ pathname, search, origin }: EmbedAppProps) {
  const address = useMemo(
    () => readEmbedAddress(pathname, search),
    [pathname, search]
  )
  const resolution = useResolution(address.request)

  /*
   * The hook is called unconditionally with `null` until there is a document,
   * because a hook cannot be called conditionally — and passing `null` is
   * exactly what "there is nothing to simulate yet" means to it.
   */
  const circuit =
    resolution.status === 'ready' ? resolution.document.circuit : null
  const simulation = useEmbedSimulation(circuit)

  if (resolution.status === 'loading') return <EmbedPending />
  if (resolution.status === 'failed') {
    return <EmbedFailureNotice code={resolution.code} />
  }

  return (
    <EmbedView
      document={resolution.document}
      simulation={simulation}
      origin={origin}
    />
  )
}

/**
 * The one asynchronous step: turning an address into a document.
 *
 * ── HALF OF THIS IS DERIVED AND ONLY THE FETCH IS STATE ─────────────────
 *
 * A `?c=` payload needs no server — the circuit is in the link — so it is
 * computed during render and never stored. Only the slug case has anything to
 * remember, and what it remembers is stored *with the slug it answers*, so
 * "loading" is what comes out whenever those two disagree.
 *
 * The alternative, one `Resolution` in state reset from an effect, is what
 * this was first: it sets state synchronously inside an effect, which paints
 * one frame of the previous answer under the new address and makes the effect
 * able to cause the render that re-runs it. `useEmbedSimulation` documents the
 * same decision at more length, because there it cost an out-of-memory.
 */
function useResolution(
  request: ReturnType<typeof readEmbedAddress>['request']
): Resolution {
  /*
   * `decode` inflates and re-validates, so it is memoised on the payload
   * rather than run on every render. It never throws and never returns an
   * unvalidated circuit — it runs the payload through the same `parseCircuit`
   * the API would.
   */
  const local = useMemo(() => resolveLocally(request), [request])

  const [fetched, setFetched] = useState<{
    readonly slug: string
    readonly value: Resolution
  } | null>(null)

  const slug = request.kind === 'slug' ? request.slug : null

  useEffect(() => {
    if (slug === null) return

    /*
     * Aborted on unmount. An embed is mounted once and never unmounted in
     * production, but React 19's StrictMode runs effects twice in development
     * — and a fetch nobody cancels would set state after the first teardown,
     * which is the warning that trains people to ignore warnings.
     */
    const controller = new AbortController()

    void fetchEmbed(slug, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return
      setFetched({
        slug,
        value: result.ok
          ? { status: 'ready', document: documentFromApi(result.embed) }
          : { status: 'failed', code: result.code },
      })
    })

    return () => {
      controller.abort()
    }
  }, [slug])

  if (local !== null) return local
  return fetched !== null && fetched.slug === slug
    ? fetched.value
    : { status: 'loading' }
}

/**
 * Everything decidable without a server, or `null` when a request has to go
 * out.
 */
function resolveLocally(
  request: ReturnType<typeof readEmbedAddress>['request']
): Resolution | null {
  if (request.kind === 'invalid') {
    return { status: 'failed', code: 'no-address' }
  }
  if (request.kind === 'slug') return null

  /*
   * `decode`'s own error codes are developer-facing (`not-deflate`,
   * `not-a-circuit`), so they are collapsed to one sentence here: a reader of
   * somebody's blog post can do nothing with the difference, and the detail is
   * already in the console.
   */
  const decoded = decode(request.payload)
  if (!decoded.ok) {
    console.error('the embedded circuit could not be read', decoded.code)
    return { status: 'failed', code: 'bad-link' }
  }
  return { status: 'ready', document: documentFromLink(decoded.circuit) }
}

function EmbedPending() {
  const { t } = useTranslation('embed')
  return (
    <main className="embed embed--pending">
      <p className="embed__pending" role="status">
        {t('loading')}
      </p>
    </main>
  )
}

function EmbedFailureNotice({ code }: { code: EmbedFailure }) {
  const { t } = useTranslation('embed')
  return (
    <main className="embed embed--failed">
      <p className="embed__failure" role="status">
        {t(`failure.${code}`)}
      </p>
    </main>
  )
}
