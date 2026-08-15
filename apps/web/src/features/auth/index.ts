/**
 * The session layer (M1.3a) and the account screens' parts (M1.3b) — who is
 * signed in, what a route does about it, and what the forms are built from.
 *
 * The shape in one paragraph: `createAuthRuntime` builds the Supabase client
 * once and points the API transport at its access token; `SessionProvider`
 * turns that client's events into a three-state machine and throws away the
 * query cache when the user changes; `RequireSession` keeps a route from
 * rendering before that state is known; and `useAuthProviders` asks the
 * project which sign-in methods it actually offers rather than assuming.
 *
 * The screens themselves are routes (`routes/sign-in.tsx` and its three
 * siblings); what lives here is what more than one of them needs — the page
 * frame, the wired-up field, the two message shapes, the password rule read
 * off the project, and the account menu the shell renders.
 *
 * Nothing here decides what a user is allowed to do — §11 puts that on the
 * server, and this layer only spares the user a round trip that would end in
 * a 401 they cannot read.
 */

export {
  RedirectWhenSignedIn,
  RequireSession,
  SessionPending,
} from './RequireSession.js'
export { useIntendedPath } from './useIntendedPath.js'
export type {
  RedirectWhenSignedInProps,
  RequireSessionProps,
} from './RequireSession.js'

export {
  AuthRuntimeContext,
  SessionActionsContext,
  SessionStateContext,
  useAuthRuntime,
  useSession,
  useSessionActions,
} from './SessionContext.js'

export { SessionProvider } from './SessionProvider.js'
export type { SessionProviderProps } from './SessionProvider.js'

export { ProviderSignInButtons } from './ProviderSignInButtons.js'
export { providerLabel } from './providerLabels.js'
export type { ProviderSignInButtonsProps } from './ProviderSignInButtons.js'

export { AccountMenu } from './AccountMenu.js'

export { AuthField } from './AuthField.js'
export type { AuthFieldProps } from './AuthField.js'

export { AuthErrorAlert, AuthNotice } from './AuthMessage.js'
export type { AuthErrorAlertProps, AuthNoticeProps } from './AuthMessage.js'

export { AuthPage } from './AuthPage.js'
export type { AuthPageProps } from './AuthPage.js'

export {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  emailProblem,
  newPasswordProblem,
  passwordByteLength,
} from './passwordPolicy.js'
export type { PasswordProblem } from './passwordPolicy.js'

export {
  PROVIDER_RETURN_PARAMS,
  hrefWithoutProviderReturn,
  readProviderReturn,
} from './providerReturn.js'

export {
  CIRCUITS_PATH,
  DEFAULT_SIGNED_IN_PATH,
  INTENDED_PATH_STATE_KEY,
  PASSWORD_RESET_PATH,
  PASSWORD_UPDATE_PATH,
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  absoluteAppUrl,
  intendedPathFrom,
  isSafeRedirectPath,
  safeRedirectPath,
} from './paths.js'

export { createAuthRuntime } from './runtime.js'
export type { AuthRuntime } from './runtime.js'

export { createSessionActions } from './sessionActions.js'
export type {
  AuthOutcome,
  SessionActions,
  SignInWithProviderOptions,
  SignUpOutcome,
} from './sessionActions.js'

export {
  ANONYMOUS_SESSION,
  LOADING_SESSION,
  isUserChange,
  resolvedSessionState,
  toSessionUser,
} from './sessionState.js'
export type {
  SessionState,
  SessionStatus,
  SessionUser,
} from './sessionState.js'

export { authQueryKeys, useAuthProviders } from './useAuthProviders.js'
export type { AuthProvidersResult } from './useAuthProviders.js'
