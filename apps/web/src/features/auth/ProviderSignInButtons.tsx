/**
 * One button per provider the project actually has enabled.
 *
 * ── Why there is no GitHub button in this file ────────────────────────────
 *
 * Because there is no GitHub button anywhere. The list is whatever
 * `GET /auth/v1/settings` reports, so the day the owner enables GitHub in the
 * Supabase dashboard the button appears — with no edit here, no deploy, and
 * no possibility of the screen offering a provider that would answer the
 * click with an error page. Today the project reports every external provider
 * as false, so this component renders nothing at all, and that is the correct
 * rendering of the current configuration rather than a placeholder.
 *
 * ── Why the labels are not translated ─────────────────────────────────────
 *
 * `GitHub` and `Google` are proper nouns; D2 keeps those identical in all
 * three languages, exactly as it does for gate names. The sentence around
 * them is not — "Continue with %s" has a different word order in French — so
 * the brand name goes through interpolation into a translated frame, and the
 * frame lives in the catalog. A provider this bundle has never heard of gets
 * its Supabase key title-cased, which is a readable fallback and beats
 * rendering `linkedin_oidc` at somebody.
 *
 * ── The click asks again before it hands over the window ──────────────────
 *
 * `signInWithOAuth` navigates the top-level document, so anything the auth
 * server refuses is reported by replacing the app with a JSON error page —
 * `onFailure` below is unreachable for it. The settings document is cached for
 * the life of the tab, so a provider switched off after that cache was filled
 * is exactly the case that produces it. Re-reading first turns "the user is
 * stranded outside the app" into "the button says it is no longer available",
 * in the reader's own language. See `useAuthProviders.refresh`.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSessionActions } from './SessionContext.js'
import type { AuthFailureCode } from '../../lib/supabase/index.js'
import { providerLabel } from './providerLabels.js'
import { useAuthProviders } from './useAuthProviders.js'

export interface ProviderSignInButtonsProps {
  /** Where to return after the round trip. Defaults to the app root. */
  readonly redirectPath?: string
  /** Told when a provider refuses, so the screen can show one message. */
  readonly onFailure?: (code: AuthFailureCode) => void
}

export function ProviderSignInButtons({
  redirectPath,
  onFailure,
}: ProviderSignInButtonsProps) {
  const { t } = useTranslation('auth')
  const { settings, refresh } = useAuthProviders()
  const actions = useSessionActions()
  /*
   * Which provider is mid-redirect. A successful call navigates away, so this
   * normally never clears — its job is to stop a second click during the
   * moment before the browser leaves, which would start two OAuth flows and
   * invalidate the first one's PKCE verifier.
   */
  const [pending, setPending] = useState<string | null>(null)

  if (settings.providers.length === 0) return null

  const start = async (provider: string): Promise<void> => {
    setPending(provider)

    // What the project says right now, not what it said when this tab opened.
    const current = await refresh()
    if (!current.providers.includes(provider)) {
      setPending(null)
      onFailure?.('PROVIDER_DISABLED')
      return
    }

    const outcome = await actions.signInWithProvider(provider, { redirectPath })
    if (outcome.ok) return
    setPending(null)
    onFailure?.(outcome.code)
  }

  return (
    <ul className="provider-signin" aria-label={t('providers.groupLabel')}>
      {settings.providers.map((provider) => (
        <li key={provider}>
          {/*
           * `aria-disabled` rather than `disabled`, for the reason the account
           * screens give: a disabled button cannot hold focus, so a keyboard
           * user who pressed Enter here would lose the caret to the document
           * body during the redirect. The second flow it guards against is
           * refused by the handler instead.
           */}
          <button
            type="button"
            className="provider-signin__button"
            aria-disabled={pending !== null}
            onClick={() => {
              if (pending !== null) return
              void start(provider)
            }}
          >
            {t('providers.continueWith', { provider: providerLabel(provider) })}
          </button>
        </li>
      ))}
    </ul>
  )
}
