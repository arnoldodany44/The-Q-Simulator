/**
 * The sentence a failed third-party sign-in comes back to.
 *
 * Deliberately outside the route table: `redirect_to` defaults to the app root
 * and can be any path the guard recorded, so the failure has to be sayable on
 * whichever screen the provider returned the user to — including the landing
 * page, which has no account machinery of its own.
 *
 * It is loaded as its own chunk with the `auth` catalog, the same arrangement
 * the four account screens get, so a visit that never comes back from a
 * provider never downloads either. `providerReturn.ts` does the noticing and
 * lives in the entry chunk, because something has to be there to decide
 * whether this is worth fetching at all.
 */

import { useEffect, useRef } from 'react'

import { AuthErrorAlert } from './AuthMessage.js'
import type { AuthFailureCode } from '../../lib/supabase/index.js'

export interface ProviderReturnAlertProps {
  readonly code: AuthFailureCode
}

export function ProviderReturnAlert({ code }: ProviderReturnAlertProps) {
  const region = useRef<HTMLDivElement>(null)

  /*
   * The user is on a page they did not ask for, having pressed a button that
   * appeared to do nothing, so the answer is where the caret belongs — and on
   * the landing page the alert is above a wall of marketing copy a keyboard
   * user would otherwise have to tab through to find it.
   */
  useEffect(() => {
    region.current?.focus()
  }, [])

  return (
    <div className="provider-return" ref={region} tabIndex={-1}>
      <AuthErrorAlert code={code} />
    </div>
  )
}
