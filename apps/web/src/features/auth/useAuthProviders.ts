/**
 * What the project offers, as server state — §9.
 *
 * The settings document comes from a server, so React Query owns it. That is
 * not bookkeeping: two components asking at once produce one request, the
 * answer survives a navigation between the sign-in and sign-up screens, and
 * the retry policy is stated rather than improvised.
 *
 * ── Why it never surfaces an error ────────────────────────────────────────
 *
 * `fetchAuthSettings` resolves to `EMAIL_ONLY_SETTINGS` instead of rejecting,
 * so this hook's `data` is always usable and `isError` is always false. The
 * reason is where it is consumed: a sign-in screen, by somebody trying to get
 * in. Whatever went wrong with a request for a *configuration* document, the
 * email and password form is very likely still going to work — so the screen
 * shows fewer options, not an error page. Rendering "something went wrong" in
 * front of a working login form would be the failure, not the report of one.
 *
 * ── Cached for the tab, not for thirty seconds ────────────────────────────
 *
 * `staleTime: Infinity`. Which providers a project has enabled changes when
 * somebody edits a dashboard, which is a deploy-scale event, not a
 * per-navigation one. Refetching it on the default 30-second staleness would
 * be a request per visit to the sign-in screen for an answer that is the same
 * every time. A reload picks up a change, and that is soon enough — including
 * for the case this milestone was written around: GitHub being switched on
 * next week must appear with no code change, and it will, on the next load.
 *
 * ── …except at the one moment being wrong is expensive ────────────────────
 *
 * `signInWithOAuth` is a top-level navigation. If the cached answer says a
 * provider is on and the project has since turned it off, the browser leaves
 * the app and lands on Supabase's raw JSON —
 *
 *     {"code":400,"error_code":"validation_failed",
 *      "msg":"Unsupported provider: provider is not enabled"}
 *
 * — with no alert, no form and no link back, because the promise that would
 * have reported it belongs to a page that no longer exists. `PROVIDER_DISABLED`
 * has a sentence in three catalogs that the browser flow could never show.
 *
 * `refresh()` is the cheap correction: one conditional read of a small static
 * document, taken *before* the redirect, so a provider that has been switched
 * off is caught while there is still a page to say so on. It is a deliberate
 * exception to the caching above rather than a retreat from it — the document
 * is still cached for every render, and only the click pays.
 */

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  EMAIL_ONLY_SETTINGS,
  fetchAuthSettings,
} from '../../lib/supabase/index.js'
import type { AuthSettings } from '../../lib/supabase/index.js'

import { useAuthRuntime } from './SessionContext.js'

/**
 * Keyed by project URL so that two projects — production and a preview
 * pointing at the dev project — can never serve each other's answer out of
 * one cache.
 */
export const authQueryKeys = {
  all: ['auth'] as const,
  settings: (projectUrl: string) =>
    [...authQueryKeys.all, 'settings', projectUrl] as const,
} as const

export interface AuthProvidersResult {
  /** Always usable: the real answer, or email-only. */
  readonly settings: AuthSettings
  /**
   * True only while the first request is in flight.
   *
   * No screen holds anything back on it, and that is deliberate: the hazard it
   * was meant to answer — a button appearing under a pointer aimed at
   * something else — is answered instead by where the list is rendered. The
   * account screens put `ProviderSignInButtons` *last*, below the links, so a
   * late arrival moves nothing that was already on screen. Waiting would have
   * cost every reader up to `SETTINGS_TIMEOUT_MS` of a blank sign-in form for
   * a document the form does not need, which is the trade `settings.ts`
   * refuses in its own header.
   *
   * It stays exported because a screen that renders providers somewhere with
   * content beneath them will need it.
   */
  readonly isLoading: boolean
  /**
   * Re-reads the document and answers with what the project says *now*.
   *
   * For the one caller that cannot afford a stale answer: the click that hands
   * the whole window to an OAuth endpoint. See the header.
   */
  readonly refresh: () => Promise<AuthSettings>
}

export function useAuthProviders(): AuthProvidersResult {
  const runtime = useAuthRuntime()
  const config = runtime?.config ?? null
  const queryClient = useQueryClient()

  const queryKey = authQueryKeys.settings(config?.url ?? '')

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAuthSettings(config!, { signal }),
    // No project configured means there is nothing to ask. The hook still
    // answers, with email-only, so no caller needs a null check.
    enabled: config !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    // The fetcher already absorbs every failure into a usable answer, so a
    // retry could only repeat work that cannot report having failed.
    retry: false,
  })

  const refresh = useCallback(async (): Promise<AuthSettings> => {
    if (config === null) return EMAIL_ONLY_SETTINGS
    /*
     * `fetchQuery` with `staleTime: 0` rather than `refetchQueries`, because
     * the caller needs the *answer* and not a notification. The result lands in
     * the same cache entry, so a provider that has gone away also disappears
     * from the buttons on the next render.
     */
    return queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => fetchAuthSettings(config, { signal }),
      staleTime: 0,
      retry: false,
    })
  }, [config, queryClient, queryKey])

  return {
    settings: query.data ?? EMAIL_ONLY_SETTINGS,
    isLoading: query.isLoading,
    refresh,
  }
}
