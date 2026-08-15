/**
 * The environment variables this bundle reads, declared so that
 * `import.meta.env.VITE_SUPABASE_URL` is a typed read rather than `any`.
 *
 * Vite's own `ImportMetaEnv` only knows `MODE`, `DEV`, `PROD`, `SSR` and
 * `BASE_URL`; everything project-specific has to be declared here or the
 * compiler cannot tell a real variable from a typo, which is the one mistake
 * with no runtime symptom until production — a misspelt name is `undefined`,
 * and `undefined` looks exactly like "not configured".
 *
 * Every name below is `VITE_`-prefixed and therefore compiled into the
 * JavaScript every visitor downloads (§12.5). That is fine for an origin and
 * for a publishable key, which identify rather than authorise. Nothing that
 * grants access may be added to this list: the API's secrets live in
 * `apps/api`'s environment, are read by a Node process, and never cross into
 * this file.
 *
 * They are all optional because a build can legitimately be made without
 * them: `lib/api/config.ts` falls back to a local origin in development, and
 * `lib/supabase/config.ts` treats a project that is entirely absent as a
 * deployment without accounts.
 */

interface ImportMetaEnv {
  /** Origin of `apps/api`. No path. */
  readonly VITE_API_URL?: string
  /** WebSocket origin for `/ws` (Phase 2). */
  readonly VITE_WS_URL?: string
  /** Supabase project origin. */
  readonly VITE_SUPABASE_URL?: string
  /** `sb_publishable_…`. Public by design; never the secret key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Sentry's public DSN (M1.8). */
  readonly VITE_SENTRY_DSN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
