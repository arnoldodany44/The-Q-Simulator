/**
 * `?example=<id>` — the landing page's route into the examples strip (M0.9b).
 *
 * The landing page ends on a Bell pair and then offers "start from an
 * example". That link has to arrive at the editor with the circuit already
 * loaded, or the reader lands on a blank canvas holding the idea they came
 * with and nothing to do with it.
 *
 * It is a *second* source for the opening document, and the precedence between
 * the two is the whole of the design:
 *
 *   `?c=`        a circuit somebody built and sent. It always wins.
 *   `?example=`  a name of one of the six shipped circuits. A starting point.
 *
 * An unknown name loads nothing rather than erroring: this parameter is a
 * convenience, and a stale link from an older build that named a preset which
 * no longer exists should open the editor, not a failure. A refused `?c=`
 * *does* report itself, because that one carries somebody's work.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PARAMETER REMOVES ITSELF.
 *
 * Once it has been read, `?example=` has done its job and is stripped from the
 * address bar — whether it named a preset, named nothing, or was outranked by a
 * `?c=`. All three are spent the moment they are read. `useCircuitUrl` then
 * does what it does for any other edit and writes the real `?c=` payload a
 * moment later, so the address the reader ends up holding is a complete,
 * shareable link to the circuit on screen rather than a name that only means
 * something to this build. Leaving it would also accumulate:
 * `?example=bell&c=…`, with two answers to one question in one URL.
 *
 * Mount it *after* `useCircuitUrl`. React runs layout effects in hook order,
 * and this one has to see the shared-circuit decision already made.
 */

import { useLayoutEffect, useRef, useState } from 'react'

import { readCircuitParam } from '../../lib/circuit-url'
import { findPreset, type Preset } from './presets'
import type { CircuitStore } from './useCircuitStore'

/** The query parameter naming a shipped example. */
export const EXAMPLE_URL_PARAM = 'example'

/** The `?example=` value of a query string, or null when there is none. */
export function readExampleParam(search: string): string | null {
  return new URLSearchParams(search).get(EXAMPLE_URL_PARAM)
}

export interface ExampleOptions {
  readonly store: CircuitStore
}

export function useExample({ store }: ExampleOptions): void {
  /*
   * Read once, in a state initialiser, for `useCircuitUrl`'s reason: what the
   * address bar said at mount is a fact about this visit, and from the first
   * edit onwards the URL is the editor's own output rather than an input.
   */
  const [preset] = useState<Preset | null>(() => {
    const search = window.location.search
    if (readCircuitParam(search) !== null) return null
    const id = readExampleParam(search)
    if (id === null) return null
    return findPreset(id) ?? null
  })

  /** Only ever `true` after the effect below has run — including in strict mode. */
  const loaded = useRef(false)

  useLayoutEffect(() => {
    if (loaded.current) return
    loaded.current = true

    /*
     * The parameter is spent whatever happened to it, and it is stripped in
     * all three cases rather than only in the one that loads something. An
     * unknown name is spent the moment it is ignored; a `?c=` that outranked
     * it has already answered the question. Leaving it behind produced exactly
     * the URL the header says this prevents — `?c=…&example=teleportation`,
     * two answers to one question — because `useCircuitUrl` writes its payload
     * beside whatever else is in the query.
     */
    if (preset !== null) {
      // Through `loadCircuit` like every other whole document: it validates,
      // drops the selection and clears the undo history, so nobody can undo
      // their way back to a blank canvas they never saw.
      store.getState().loadCircuit(preset.circuit)
    }
    stripExampleParam()
  }, [preset, store])
}

/**
 * Take `?example=` out of the address bar, keeping everything else.
 *
 * Silent about failure for the same reason `useCircuitUrl`'s writer is:
 * `replaceState` throws when a browser's rate limit is hit, and the only
 * consequence here is a spent parameter lingering in a URL that still opens
 * the right circuit.
 */
function stripExampleParam(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(EXAMPLE_URL_PARAM)) return
  url.searchParams.delete(EXAMPLE_URL_PARAM)
  try {
    window.history.replaceState(window.history.state, '', url.toString())
  } catch {
    // See above.
  }
}
