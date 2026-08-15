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

export interface CircuitUrlOptions {
  readonly store: CircuitStore
  readonly debounceMs?: number
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
      store.getState().loadCircuit(incoming.circuit)
    }
    openedWith.current = store.getState().circuit
  }, [incoming, store])

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
    // Still showing exactly what the page opened with: the URL already says
    // this, correctly or otherwise, and it is not ours to rewrite yet.
    if (openedWith.current === circuit) return

    const timer = setTimeout(() => {
      // A circuit too large to share leaves *no* parameter rather than the
      // previous one: a stale payload in the address bar is a link that
      // silently promises a different circuit from the one on screen.
      writeParam(tooLarge ? null : param)
    }, debounceMs)
    return () => {
      clearTimeout(timer)
    }
  }, [circuit, param, tooLarge, debounceMs])

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
  const next = circuitUrl(window.location.href, param)
  if (next === window.location.href) return
  try {
    window.history.replaceState(window.history.state, '', next)
  } catch {
    // See above.
  }
}
