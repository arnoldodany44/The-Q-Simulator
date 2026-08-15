/**
 * `prefers-reduced-motion`, as a value a component can branch on.
 *
 * The stylesheet already answers this query — `index.css` collapses every
 * transition and animation under it — and for most of the app that is the
 * whole of the accommodation. The histogram needs more than that, because
 * §10 asks for a *substitution* rather than a subtraction: the phasors stop
 * turning **and print their angle instead**. CSS can stop the motion; only
 * the component can put the number in its place.
 *
 * Same shape as `useCompactViewport`, and for the same reasons:
 * `useSyncExternalStore` so the first paint is already correct rather than
 * corrected by an effect one frame later, and a "no" when the query cannot
 * be evaluated at all (a bare test environment, a server render). Answering
 * "no" there is the safe default in the sense that matters: the arrows turn
 * for a reader who never asked them not to, and the numbers appear for
 * everyone who did.
 */

import { useCallback, useSyncExternalStore } from 'react'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function motionQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null
}

export function usePrefersReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = motionQuery()
    if (list === null) return () => undefined
    list.addEventListener('change', onChange)
    return () => {
      list.removeEventListener('change', onChange)
    }
  }, [])

  return useSyncExternalStore(
    subscribe,
    () => motionQuery()?.matches ?? false,
    () => false
  )
}
