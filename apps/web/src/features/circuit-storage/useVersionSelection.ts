/**
 * The version selection, bound to the address bar — M1.4b.
 *
 * One hook, called once by the editor route, so that exactly one component
 * reads and writes these two parameters. `versionParams.ts` holds the rules
 * and has no React in it; this is the twenty lines that connect them to
 * React Router, and the reason they are separated is that the rules are worth
 * testing without a router and this is not.
 *
 * ── The read and the write come from different places ─────────────────────
 *
 * `useLocation().search` for the read, because a component has to re-render
 * when the selection changes and React Router's location is what re-renders it.
 *
 * `window.location.search` for the write, because React Router's copy is
 * *stale by design*: `useCircuitUrl` mirrors the open document into `?c=` with
 * `history.replaceState`, deliberately behind the router's back (its header
 * argues why at length). Building a navigation from the router's location
 * would therefore drop the `?c=` holding the reader's unsaved work — opening
 * the history would quietly empty the address bar. Reading the live query
 * string keeps every parameter this hook does not own.
 *
 * `replace: false`, so Back leaves the version you were looking at and returns
 * to the document. Looking at a past version is navigation, and the browser's
 * Back button is the control every reader already knows for undoing it.
 */

import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'

import {
  versionSearch,
  versionSelection,
  type VersionSelection,
} from './versionParams.js'

export interface VersionSelectionView {
  readonly selection: VersionSelection
  /** Put a selection in the address. `{version: null}` returns to the editor. */
  readonly select: (next: VersionSelection) => void
}

export function useVersionSelection(): VersionSelectionView {
  const location = useLocation()
  const navigate = useNavigate()

  const selection = useMemo(
    () => versionSelection(location.search),
    [location.search]
  )

  const select = useCallback(
    (next: VersionSelection) => {
      void navigate({ search: versionSearch(window.location.search, next) })
    },
    [navigate]
  )

  return { selection, select }
}
