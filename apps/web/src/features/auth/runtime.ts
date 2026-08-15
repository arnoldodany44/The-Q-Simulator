/**
 * Everything the session layer needs from the outside world, built once.
 *
 * `null` is a first-class answer here and not a failure: a deployment with no
 * Supabase project configured is Phase 0's deployment, and its landing page
 * and editor still work. The session then resolves to signed-out for good,
 * every guarded route redirects, and every action answers `AUTH_UNAVAILABLE`
 * — which the UI translates into a sentence rather than a blank page. See
 * `lib/supabase/config.ts` for why a *partial* configuration throws instead.
 *
 * The two fields travel together because they are always needed together and
 * one without the other is meaningless: the port is how the app signs a user
 * in, and the config is how it asks the project which methods are on offer.
 */

import {
  authPortOf,
  createBrowserSupabaseClient,
  installSupabaseAccessToken,
  resolveSupabaseConfig,
} from '../../lib/supabase/index.js'
import type {
  SupabaseAuthPort,
  SupabaseConfig,
  SupabaseEnvSource,
} from '../../lib/supabase/index.js'

export interface AuthRuntime {
  readonly auth: SupabaseAuthPort
  readonly config: SupabaseConfig
}

/**
 * Builds the runtime from the environment, or answers `null` when this
 * deployment has no auth.
 *
 * Installing the access-token provider is a side effect and it lives here on
 * purpose: this is the single construction site, so "the API client carries
 * the token" cannot be forgotten by a caller and cannot be done twice. Doing
 * it inside a React effect instead would leave every request made before the
 * first commit anonymous — including the ones a route fires on its first
 * paint.
 *
 * @throws if exactly one of the two Supabase variables is set.
 */
export function createAuthRuntime(env?: SupabaseEnvSource): AuthRuntime | null {
  const config = resolveSupabaseConfig(env)
  if (config === null) return null

  const auth = authPortOf(createBrowserSupabaseClient(config))
  installSupabaseAccessToken(auth)

  return { auth, config }
}
