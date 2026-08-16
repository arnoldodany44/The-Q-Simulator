/**
 * `/c/:slug` — a saved circuit, opened in the editor (M1.4a).
 *
 * This is the one place data crosses §9's line from React Query into Zustand,
 * and `lib/api/useCircuits.ts` says exactly what the crossing has to look
 * like: explicit, one direction, once. The rule it must not break is that a
 * *refetch* never writes into the store. A circuit that arrives again — after
 * a save invalidated its cache entry, after a reconnect — must leave the
 * document alone, because `loadCircuit` replaces what is on screen and clears
 * the undo history. Doing that to somebody mid-edit is indistinguishable from
 * losing their work.
 *
 * So the seeding effect is guarded by the binding rather than by the query:
 * it acts when the open document is not already bound to the circuit that
 * arrived, and does nothing otherwise. Refetches, remounts and the navigation
 * that follows the first save all land on "already bound" and skip.
 *
 * ── The draft in the address bar outranks the server ──────────────────────
 *
 * Phase 0's URL codec did not go away. `useCircuitUrl` still writes the
 * document into `?c=` as it is edited, on every route, so a page opened at
 * `/c/abc?c=…` is a saved circuit *plus* an unsaved edit of it — which is
 * exactly what a reload in the middle of editing produces.
 *
 * The edit wins. Seeding over it would throw away the newer of the two
 * documents to show the older, which is the one outcome nobody wants. The
 * server's version is still fetched and still becomes the base, so the editor
 * knows it is dirty, knows which version it descends from, and can detect a
 * stale save exactly as it would have.
 *
 * ── A change of user empties the workspace ────────────────────────────────
 *
 * `SessionProvider` throws away everything React Query is holding when the
 * signed-in user changes. That covers the server's half and none of this one:
 * the circuit store and the binding are module-scoped, they survive a sign-out
 * and the next sign-in, and without the release below the second person at a
 * shared machine finds the first person's PRIVATE circuit on the canvas — on a
 * page whose own notice says that circuit is not theirs to see, and with the
 * save panel inviting them to store it as their own.
 *
 * Only a *bound* document is discarded. A document with no binding never came
 * from the server: it is the anonymous draft in `?c=`, which is exactly what
 * somebody carries through the "sign in to save this" link, and throwing that
 * away would lose the work the sign-in was for.
 *
 * ── What the four states are for ──────────────────────────────────────────
 *
 * `loading` exists so the route can decline to paint a blank canvas that a
 * circuit is about to replace under the reader's eyes — the same frame
 * `useCircuitUrl` uses a layout effect to avoid. `unavailable` covers 404 and
 * 403 alike, which §11 makes indistinguishable on purpose: a PRIVATE circuit
 * belonging to somebody else answers "no such circuit", and the client must
 * not try to tell those apart.
 *
 * A live binding outranks a failed fetch, and the order matters. A save
 * succeeds, the invalidation that follows it fails — the connection dropped in
 * between — and the document is still open, still saved, still exactly what
 * the panel says it is. Reading the error first put a red "that circuit cannot
 * be opened, start a new one" alert above a working editor whose own status
 * line said "Saved as version 2", which is two contradictory claims on one
 * screen. `unavailable` is for a load that genuinely never produced a
 * document.
 *
 * `paused` is not a status but a flag beside `loading`, because React Query
 * distinguishes "no answer yet" from "not even asked": offline, `fetchStatus`
 * becomes `paused` while `status` stays `pending`, and a screen that reads
 * only the second shows a loading line for as long as the connection is down,
 * with nothing to say why and nothing to press.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { CircuitDetail } from '@qsim/contract'

import { readCircuitParam } from '../../lib/circuit-url'
import { useCircuit } from '../../lib/api'
import { useSession } from '../auth'
import {
  sameCircuit,
  useCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import {
  useDocumentBinding,
  type DocumentBase,
  type DocumentBindingStore,
} from './documentBinding.js'

export interface CircuitDocumentOptions {
  /** The `:slug` of the route, or `null` on `/new`. */
  readonly slug: string | null
  readonly store?: CircuitStore
  readonly binding?: DocumentBindingStore
}

export interface CircuitDocumentView {
  readonly slug: string | null
  /**
   * `blank` — an unsaved document; `loading` — a slug whose circuit has not
   * arrived; `open` — a saved circuit is bound; `unavailable` — the slug
   * named nothing this viewer may read.
   */
  readonly status: 'blank' | 'loading' | 'open' | 'unavailable'
  /**
   * The fetch is waiting for the network rather than for the server. Only ever
   * true alongside `loading`; the route says so instead of showing a loading
   * line that never resolves.
   */
  readonly paused: boolean
  /** The server's metadata: title, description, visibility, owner, counts. */
  readonly detail: CircuitDetail | null
  /** The version the editor descends from, or `null` for an unsaved document. */
  readonly base: DocumentBase | null
  /**
   * Whether this viewer has starred the open circuit (M1.5b).
   *
   * From the response envelope rather than from the circuit: it is a property
   * of the pair (circuit, viewer), which is why only `GET /circuits/:id`
   * answers it. `false` for an anonymous reader and for an unsaved document,
   * both of which have no star to have.
   */
  readonly starred: boolean
  /** The editor holds something other than `base.circuit`. */
  readonly dirty: boolean
  /** Whatever the fetch failed with, for `useApiErrorMessage`. */
  readonly error: unknown
  /** True when the page opened holding an unsaved edit in `?c=`. */
  readonly openedWithDraft: boolean
  /** Whether this viewer is the owner — a convenience, never a permission. */
  readonly ownedBy: (userId: string | null) => boolean
}

export function useCircuitDocument({
  slug,
  store = useCircuitStore,
  binding = useDocumentBinding,
}: CircuitDocumentOptions): CircuitDocumentView {
  const query = useCircuit(slug)
  const session = useSession()
  const base = useStore(binding, (state) => state.base)
  const circuit = useStore(store, (state) => state.circuit)

  /**
   * The signed-in user as of the last resolved session, or `undefined` before
   * there has been one. A ref rather than state: this is a comparison against
   * what was last *applied*, exactly as `SessionProvider` makes the same
   * decision, and a value captured by a render would compare against the wrong
   * thing on a change that arrived between renders.
   */
  const identity = useRef<string | null | undefined>(undefined)

  /*
   * Before the seeding effect below, and that order is load-bearing: within a
   * commit these run in hook order, so the previous identity's document is
   * gone before anything can be written over it.
   *
   * The query cache is already empty by now — `SessionProvider` resets it from
   * the same auth event — so there is nothing for the seed to put back until a
   * request answers under the new identity.
   */
  useLayoutEffect(() => {
    if (session.status === 'loading') return
    const current = session.user?.id ?? null
    const previous = identity.current
    identity.current = current
    // The first resolution of this page load is not a change of user.
    if (previous === undefined || previous === current) return
    // An unbound document is the reader's own draft, not the server's. See
    // the header on why that one survives.
    if (binding.getState().base === null) return
    binding.getState().release()
    store.getState().reset()
  }, [session, binding, store])

  /*
   * Read once, in a state initialiser, for the reason `useCircuitUrl` gives:
   * what the address bar said at mount is a fact about this visit, and from
   * the first edit onwards the URL is the editor's own output rather than an
   * input to it.
   */
  const [openedWithDraft] = useState(
    () => readCircuitParam(window.location.search) !== null
  )

  const data = query.data
  const arrived = data ?? null

  useLayoutEffect(() => {
    if (arrived === null) return
    // Already this document's base — a refetch, a remount, or the navigation
    // that follows the first save. Seeding again would clear the undo history
    // for no change at all.
    if (base?.circuitId === arrived.circuit.id) return

    if (!openedWithDraft) {
      // `loadCircuit` is the store's one door for a document from outside: it
      // re-validates, drops the selection and clears the history, so nobody
      // can undo their way back to a canvas they never saw.
      store.getState().loadCircuit(arrived.version.circuit)
    }

    binding.getState().bind({
      circuitId: arrived.circuit.id,
      slug: arrived.circuit.slug,
      versionNum: arrived.version.versionNum,
      circuit: arrived.version.circuit,
    })
  }, [arrived, base, openedWithDraft, store, binding])

  /*
   * `/new` means a new document, so a binding left over from the circuit the
   * user was editing a moment ago has to go — and the canvas with it.
   *
   * Without the release, "new circuit" from `/c/abc` would open a document
   * that still believed it was version 4 of `abc`, and the first save would
   * append it to somebody else's history. Without the reset, `/new` would show
   * the circuit the user had just left and offer to save it *again*, as a
   * second circuit — a duplicate nobody asked for.
   *
   * This runs before `useCircuitUrl` and `useExample` mount their own layout
   * effects (hook order, and `routes/editor.tsx` fixes that order), so
   * arriving at `/new?example=bell` still opens the example: the reset happens
   * first and the parameter is read after it.
   *
   * A *fresh load* of `/new` never reaches here — there is no binding yet — so
   * Phase 0's behaviour on that route is untouched, which is what an anonymous
   * visitor sees, always.
   */
  useLayoutEffect(() => {
    if (slug !== null || base === null) return
    binding.getState().release()
    store.getState().reset()
  }, [slug, base, binding, store])

  const detail = arrived?.circuit ?? null
  /*
   * Compared by id rather than by the address the route matched, because the
   * API accepts a slug *or* an id in the same position (`circuitPath.item`)
   * and a pasted id would otherwise never satisfy `base.slug === slug` — the
   * document would load and the page would say "loading" forever.
   */
  const bound = base !== null && base.circuitId === arrived?.circuit.id
  const boundBase = bound ? base : null

  /*
   * An unsaved document counts as dirty the moment it has anything in it: on
   * `/new` there is no version to be identical to, so "would be lost" and "has
   * content" are the same question.
   */
  const dirty = useMemo(() => {
    if (boundBase === null) return circuit.operations.length > 0
    return !sameCircuit(boundBase.circuit, circuit)
  }, [boundBase, circuit])

  /*
   * `bound` before `query.isError`: see the header. A document that is open
   * stays open when a background refetch fails, because it is still open.
   */
  const status: CircuitDocumentView['status'] =
    slug === null
      ? 'blank'
      : bound
        ? 'open'
        : query.isError
          ? 'unavailable'
          : 'loading'

  return {
    slug,
    status,
    paused: status === 'loading' && query.fetchStatus === 'paused',
    detail,
    base: boundBase,
    // Only while the arrived circuit is the one on screen: a star read from a
    // response for a *different* circuit would draw the wrong state on the
    // one the reader is looking at.
    starred: bound && (arrived?.starred ?? false),
    dirty,
    error: query.error,
    openedWithDraft,
    /*
     * §11 is unambiguous: authorisation is the server's. This exists so the
     * interface can decline to offer "save a new version" to somebody whose
     * save would be answered with 403 — a control that cannot work is worse
     * than no control — and for nothing else. The save path handles a 403 or
     * a 404 arriving anyway, because the answer can change between the paint
     * and the click.
     */
    ownedBy: (userId) => userId !== null && detail?.owner.id === userId,
  }
}
