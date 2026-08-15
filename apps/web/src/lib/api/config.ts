/**
 * Where the API lives.
 *
 * `VITE_API_URL` is compiled into the bundle (§12.5), which is fine — it is
 * an origin, not a credential — but it means a missing value is baked in too.
 * The failure that produces is nasty: every request goes to the Vercel origin
 * instead of Railway, Vercel's SPA rewrite serves `index.html` for it, and
 * the client reports "the response was not what the API promised" for a
 * deployment problem. So a production build with no origin configured refuses
 * to construct a client at all, naming the variable.
 *
 * Development gets a default instead, because `pnpm dev` on a laptop with no
 * `.env` should still reach the API on its documented port rather than fail
 * at import time.
 */

/** Where `apps/api` listens locally — the `PORT` in `.env.example`. */
export const DEV_API_BASE_URL = 'http://localhost:8080'

/** Just the fields this module reads, so tests can pass a literal. */
export interface ApiEnvSource {
  readonly VITE_API_URL?: string | undefined
  readonly PROD?: boolean | undefined
}

/**
 * Trailing slashes are removed because every path in `@qsim/contract` begins
 * with one, and `https://api.example.com/` + `/api/v1/circuits` is a URL with
 * a double slash — which some proxies normalise, some 404, and none document.
 */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function resolveApiBaseUrl(env: ApiEnvSource = import.meta.env): string {
  const configured = env.VITE_API_URL?.trim() ?? ''
  if (configured !== '') return stripTrailingSlash(configured)

  if (env.PROD === true) {
    // The variable's *name*, never a value: this message reaches a console
    // and a Sentry event.
    throw new Error(
      'VITE_API_URL is not set. A production build needs the API origin; ' +
        'see .env.example and the Vercel project settings.'
    )
  }

  return DEV_API_BASE_URL
}
