/**
 * The address bar as the document's storage — decision D4, work plan M0.9.
 *
 * Phase 0 has no backend, so the URL *is* the save file: the editor reads a
 * circuit out of `?c=` when the page opens and writes the circuit back as it
 * is edited. Copy the address, send it, and the person who opens it sees the
 * circuit you drew.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE BACK BUTTON HAS TO LEAVE THE PAGE.
 *
 * Every write is `history.replaceState`, never `pushState`. A `pushState` per
 * edit would turn the browser's history into a keystroke log: a reader who
 * pressed Back to return to the page they came from would instead walk
 * backwards through their own gates, one press at a time, with no indication
 * of how many presses are left. Replacing means the editor occupies exactly
 * one history entry however long it is edited, and Back does the one thing
 * every user expects it to.
 *
 * The writes are debounced on top of that, for two further reasons. Safari
 * throttles `replaceState` — roughly a hundred calls per thirty seconds, and
 * past that it throws — and a parameter slider emits a value per animation
 * frame, so an undebounced editor would hit that ceiling during a single
 * drag. And the URL is a destination rather than a live mirror: nobody reads
 * the address bar mid-gesture, and being correct a third of a second after
 * the last keystroke is indistinguishable from being correct always.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY `history` DIRECTLY AND NOT `useSearchParams`.
 *
 * React Router's setter would work, and it would re-render the whole route on
 * every write to change a string nothing renders from. It would also make
 * this hook — the only piece of the editor that talks to the browser's
 * history — untestable without a router around it. React Router computes its
 * location from `window.location` on demand, so a `replaceState` behind its
 * back is not a desynchronisation: the next navigation reads the live URL.
 * When Phase 1 introduces loaders and something actually renders from the
 * query, this is the single call site to revisit.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE DOCUMENT THE PAGE OPENED WITH IS NEVER WRITTEN BACK.
 *
 * `openedWith` holds the circuit that was on screen once the initial read
 * finished, and the writer skips while the circuit is still that one. It is
 * what keeps a *refused* payload in the address bar: a link this app could
 * not open stays visible so a reload retries the same thing and the reader can
 * see what they were sent, instead of the editor quietly erasing the evidence
 * and leaving them with an error about a URL that no longer says anything.
 * The first real edit takes ownership of the URL, and from then on it is the
 * document's.
 *
 * ────────────────────────────────────────────────────────────────────────
 * A PAYLOAD THIS TAB WROTE IS A SNAPSHOT, NOT A SOURCE.
 *
 * The debounce has a cost the design above did not account for. Leave the
 * editor inside those 400 ms — click the header link, open the listing — and
 * the history entry keeps the payload from *before* the last few edits. Press
 * Back and the route remounts, this hook reads that stale payload, and
 * `loadCircuit` replaces the newer document with the older one and clears the
 * undo history with it. Measured: leaving 47 ms after the last gate lost two
 * of four, and the toolbar then reported there was nothing left to undo. The
 * work was not recoverable by any means the interface offers, and
 * `useUnsavedWork.ts` deliberately arms no `beforeunload` for a carried
 * document precisely because "?c= is written as the circuit is edited".
 *
 * Flushing on unmount does not fix it: React Router pushes the new address
 * before the editor comes down, so by then `window.location` is the page being
 * navigated *to* and the entry being left is out of reach.
 *
 * What does fix it is noticing that the circuit store outlives the navigation.
 * Every payload this hook writes is recorded in `WRITTEN_PARAMS`, so on mount
 * it can tell "a snapshot this tab took a moment ago" from "a document
 * somebody sent me". Against the first, a non-empty store is the newer of the
 * two documents and wins — the address bar catches up on the next write.
 * Against the second — a fresh page load, a pasted link, an in-app link
 * carrying somebody else's circuit — the payload is the input it always was.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useStore } from 'zustand'

import {
  circuitUrl,
  decode,
  encode,
  exceedsUrlBudget,
  readCircuitParam,
  type CircuitUrlError,
} from '../../lib/circuit-url'
import type { CircuitStore } from './useCircuitStore'

/**
 * How long after the last edit the address bar catches up.
 *
 * Longer than the simulation's 150 ms on purpose: the histogram is watched
 * while you drag and the URL is not, so they are answering different
 * questions about how soon "soon" is. See the header for the Safari ceiling
 * this also stays under.
 */
export const CIRCUIT_URL_DEBOUNCE_MS = 400

/**
 * Every `?c=` payload this page session has written, so a remount can tell a
 * snapshot of its own from a document that came from outside. See the header.
 *
 * Module-scoped, because the thing it has to outlive is the component. Capped
 * because an afternoon of editing writes one entry per pause and none of them
 * is ever removed; past the cap the set is emptied, which costs nothing worse
 * than the behaviour this exists to improve on.
 */
const WRITTEN_PARAMS = new Set<string>()

const MAX_REMEMBERED_PARAMS = 256

/** Exported for the tests, which need a clean page session per case. */
export function forgetWrittenCircuitParams(): void {
  WRITTEN_PARAMS.clear()
}

function rememberWrittenParam(param: string | null): void {
  if (param === null) return
  if (WRITTEN_PARAMS.size >= MAX_REMEMBERED_PARAMS) WRITTEN_PARAMS.clear()
  WRITTEN_PARAMS.add(param)
}

export interface CircuitUrlOptions {
  readonly store: CircuitStore
  readonly debounceMs?: number
  /**
   * Stop carrying the document, because something else already does — M1.4a.
   *
   * The editor route sets this when the circuit on screen is byte-for-byte the
   * version stored under `/c/:slug`. Then `?c=` is not a draft, it is a second
   * copy of a document that has a home, and it makes a clean address unusable:
   * `/c/abc` is a link somebody can read and `/c/abc?c=eJyrVk…` is not, even
   * though the two open the same circuit.
   *
   * So the parameter is removed while the two agree and written again on the
   * first edit, which makes the address bar itself say whether there is
   * unsaved work — the visible half of the decision argued in
   * `features/circuit-storage/useUnsavedWork.ts`. Nothing is at risk when it
   * is removed: what it held is exactly what the server holds.
   *
   * Default `false`, which is Phase 0 and is what `/new` and every anonymous
   * visitor keep getting.
   */
  readonly suppressed?: boolean
}

export interface CircuitUrlView {
  /**
   * The shareable address of the circuit on screen: absolute, ready to paste.
   * `null` when there is nothing worth sharing — an empty document — or when
   * the circuit is past what a link may carry (`tooLarge`).
   */
  readonly link: string | null
  /**
   * True when the circuit no longer fits in a URL. The editor keeps working;
   * only sharing stops, and the control says so rather than handing out a
   * link that would be refused at the other end.
   */
  readonly tooLarge: boolean
  /**
   * Why the `?c=` payload this page was opened with was refused, or `null`.
   * A code, translated by the caller through the `editor` catalog (D2).
   */
  readonly rejected: CircuitUrlError | null
  /** Dismiss the refusal notice. */
  readonly dismiss: () => void
}

export function useCircuitUrl({
  store,
  debounceMs = CIRCUIT_URL_DEBOUNCE_MS,
  suppressed = false,
}: CircuitUrlOptions): CircuitUrlView {
  const circuit = useStore(store, (state) => state.circuit)

  /*
   * The payload the page was opened with, decoded once.
   *
   * In a `useState` initialiser rather than in an effect, and that is not a
   * shortcut: what the address bar said at mount is a fact about this visit,
   * fixed for as long as the page lives, and the moment the first edit lands
   * the URL becomes this hook's own output rather than an input. Reading it
   * here means the refusal is already known during the first render, so
   * nothing has to be moved into state by an effect and no cascading render
   * happens on the failure path.
   */
  const [incoming] = useState(() => {
    const param = readCircuitParam(window.location.search)
    return param === null ? null : decode(param)
  })
  /** Whether that payload is one this page session wrote. See the header. */
  const [incomingIsOurs] = useState(() => {
    const param = readCircuitParam(window.location.search)
    return param !== null && WRITTEN_PARAMS.has(param)
  })
  const [dismissed, setDismissed] = useState(false)
  const rejected =
    dismissed || incoming === null || incoming.ok ? null : incoming.code

  /**
   * The document the initial read left on screen — see the header. It doubles
   * as the "have I run yet" flag: it is only ever `undefined` before the
   * effect below has run once.
   */
  const openedWith = useRef<unknown>(undefined)

  /*
   * A layout effect, so the swap happens before the browser paints: with a
   * passive effect the editor would show one frame of the blank default
   * document before the shared circuit replaced it, which reads as the link
   * having failed.
   *
   * It runs once. Nothing here may re-read the URL after the user has started
   * editing, because by then the URL is this hook's own output — and React's
   * strict mode double-invokes effects, which the same guard covers.
   */
  useLayoutEffect(() => {
    if (openedWith.current !== undefined) return

    // Through `loadCircuit`, which is the store's one door for untrusted
    // documents: it validates again, resets the selection and clears the undo
    // history, so a reader cannot undo their way back to a blank canvas they
    // never saw. A refused payload loads nothing and leaves what is on screen
    // alone, and stays in the address bar with it.
    if (incoming !== null && incoming.ok) {
      /*
       * Unless this tab wrote that payload and is still holding a document.
       * Then the store is the newer of the two — see the header — and loading
       * the snapshot back over it is how edits made inside the debounce were
       * lost on a Back. `openedWith` is set to the *incoming* circuit rather
       * than to the store's, so the writer below sees a difference and brings
       * the address bar up to date rather than leaving it a snapshot behind.
       */
      const carried = store.getState().circuit
      if (incomingIsOurs && carried.operations.length > 0) {
        openedWith.current = incoming.circuit
        return
      }
      store.getState().loadCircuit(incoming.circuit)
    }
    openedWith.current = store.getState().circuit
  }, [incoming, incomingIsOurs, store])

  /**
   * The payload for the circuit on screen, or `null` for a document with
   * nothing in it. An empty circuit gets no `?c=` at all: `/new` is the
   * address of a blank editor, and encoding emptiness into the URL would make
   * a fresh page look like a shared one.
   */
  const param = useMemo(
    () => (circuit.operations.length === 0 ? null : encode(circuit)),
    [circuit]
  )
  const tooLarge = param !== null && exceedsUrlBudget(param)

  useEffect(() => {
    /*
     * Still showing exactly what the page opened with: the URL already says
     * this, correctly or otherwise, and it is not ours to rewrite yet.
     *
     * `suppressed` overrides that, and has to: a document that has just been
     * saved is byte-for-byte its stored version, and leaving the parameter
     * behind would keep a draft in the address bar for an edit that no longer
     * exists.
     */
    if (openedWith.current === circuit && !suppressed) return

    const timer = setTimeout(() => {
      // A circuit too large to share leaves *no* parameter rather than the
      // previous one: a stale payload in the address bar is a link that
      // silently promises a different circuit from the one on screen.
      writeParam(suppressed || tooLarge ? null : param)
    }, debounceMs)
    return () => {
      clearTimeout(timer)
    }
  }, [circuit, param, tooLarge, suppressed, debounceMs])

  const link = useMemo(() => {
    if (param === null || tooLarge) return null
    return circuitUrl(window.location.href, param)
  }, [param, tooLarge])

  const dismiss = useCallback(() => {
    setDismissed(true)
  }, [])

  return { link, tooLarge, rejected, dismiss }
}

/**
 * Put `param` in the address bar, replacing whatever is there.
 *
 * Silent about failure on purpose: `replaceState` throws when a browser's
 * rate limit is hit, and the only consequence is an address bar that is one
 * edit behind until the next write. Turning that into a visible error would
 * report a problem the reader cannot act on, about a feature that has not
 * actually stopped working — the circuit on screen is untouched and the copy
 * control builds its link from the circuit rather than from the URL.
 */
function writeParam(param: string | null): void {
  /*
   * Recorded even when the write below is a no-op or throws: what the set
   * answers is "did this tab produce that payload", and a payload this hook
   * decided on is one it produced whether or not the browser accepted the
   * `replaceState`.
   */
  rememberWrittenParam(param)
  const next = circuitUrl(window.location.href, param)
  if (next === window.location.href) return
  try {
    window.history.replaceState(window.history.state, '', next)
  } catch {
    // See above.
  }
}
