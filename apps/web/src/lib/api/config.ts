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

/**
 * The `/ws` origin, derived from the API's rather than configured separately.
 *
 * Derived, and that is the point: a second variable is a second thing to get
 * wrong on a deploy, and the failure it produces is the worst kind — the REST
 * calls work, so the app looks fine, and only the progress feed is silently
 * pointed at the wrong host. The socket is served by the same Fastify process
 * on the same origin (§8 puts `/ws` beside `/health`), so there is exactly one
 * address here and one place it can be wrong.
 *
 * `http` becomes `ws` and `https` becomes `wss`, which is not cosmetic: a page
 * served over TLS may not open an insecure socket, and a browser refuses it
 * with a mixed-content error rather than a connection error — a message that
 * points at the wrong problem.
 */
export function resolveSocketUrl(baseUrl: string): string {
  const base = stripTrailingSlash(baseUrl)
  if (base.startsWith('https:')) return `wss:${base.slice('https:'.length)}/ws`
  if (base.startsWith('http:')) return `ws:${base.slice('http:'.length)}/ws`
  // Already a socket scheme, or something this function has no opinion about.
  return `${base}/ws`
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
