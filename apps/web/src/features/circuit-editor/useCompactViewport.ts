/**
 * The read-only breakpoint of specification §10 (risk 6): below 768px the
 * editor stops being editable and becomes something you scroll.
 *
 * It lives in its own module because two very different things need the same
 * answer — the canvas, to decide what to render, and the interaction model,
 * to decide what to refuse — and a second media query would eventually
 * disagree with the first at exactly 767px.
 *
 * `useSyncExternalStore` rather than an effect so the first paint is already
 * correct: a desktop-shaped frame flashing on a phone would render controls
 * that are about to vanish. When the query cannot be evaluated at all — a
 * server render, a bare test environment — the answer is "not compact",
 * because the full editor is the honest default when we cannot tell.
 */

import { useCallback, useSyncExternalStore } from 'react'

export const COMPACT_QUERY = '(max-width: 767px)'

function compactQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia(COMPACT_QUERY)
    : null
}

export function useCompactViewport(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = compactQuery()
    if (list === null) return () => undefined
    list.addEventListener('change', onChange)
    return () => {
      list.removeEventListener('change', onChange)
    }
  }, [])

  return useSyncExternalStore(
    subscribe,
    () => compactQuery()?.matches ?? false,
    () => false
  )
}
