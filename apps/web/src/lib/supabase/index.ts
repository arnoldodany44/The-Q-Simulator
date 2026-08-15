/**
 * Everything `apps/web` knows about Supabase Auth (§11).
 *
 * The boundary this directory draws is the same one `lib/api` draws around
 * the REST API: exactly one module constructs a client, exactly one reads the
 * access token, and no component imports `@supabase/supabase-js` directly. A
 * second `createClient` call somewhere else would be a second session store
 * with its own refresh timer, and the two would disagree about who is signed
 * in — silently, and only sometimes.
 *
 * What is deliberately absent: anything that touches the database. The
 * Supabase client also speaks PostgREST, storage and realtime, and §12.3 is
 * unambiguous that the frontend talks to `apps/api` and never to Postgres.
 * `authPort.ts` narrows the client to its auth surface before it leaves this
 * directory, so the rest of the app cannot reach the parts that would break
 * that rule.
 */

export { installSupabaseAccessToken } from './accessToken.js'

export {
  AUTH_FAILURE_CODES,
  authErrorMessageKey,
  authFailureCode,
} from './authErrors.js'
export type { AuthFailureCode } from './authErrors.js'

export { authPortOf } from './authPort.js'
export type {
  AuthChangeEvent,
  AuthError,
  AuthSubscription,
  EmailPasswordCredentials,
  Provider,
  Session,
  SupabaseAuthPort,
  User,
} from './authPort.js'

export { SESSION_STORAGE_KEY, createBrowserSupabaseClient } from './client.js'

export { resolveSupabaseConfig } from './config.js'
export type { SupabaseConfig, SupabaseEnvSource } from './config.js'

export {
  AUTH_SETTINGS_PATH,
  EMAIL_ONLY_SETTINGS,
  SETTINGS_TIMEOUT_MS,
  fetchAuthSettings,
  toAuthSettings,
} from './settings.js'
export type { AuthSettings, FetchAuthSettingsOptions } from './settings.js'
