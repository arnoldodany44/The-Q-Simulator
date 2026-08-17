import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import type { Connect, PluginOption } from 'vite'
// `vitest/config` rather than `vite` so the `test` key below is typed. The two
// type imports above come from `vite` itself, which is where they are
// declared; `vitest/config` re-exports the runtime helpers only.
import { defineConfig } from 'vitest/config'

// With the extension: Vite's native config loader warns without one, and this
// file is loaded by Node rather than resolved through the bundler.
import { headersFor, isEmbedPath } from './src/embed/headers.js'

/**
 * Serves the two documents this app has, with the headers each one needs.
 *
 * ── Why the headers moved out of `server.headers` ────────────────────────
 *
 * That option sets one table for every response, and this app now needs two
 * that are deliberately opposite: the app refuses to be framed, the embed
 * insists on it (`src/embed/headers.ts` argues both). A single table could
 * only express one of them, and whichever it expressed would silently be
 * wrong for the other route.
 *
 * The values come from that module rather than being written here, and the
 * same module is what `verification/embed-isolation/` compares `vercel.json`
 * against. So there is one declaration, checked against the deployment and
 * enforced in development — which matters because the e2e suite runs against
 * *this* server, and a suite that asserts headers a deployment does not send
 * is a suite that proves nothing.
 *
 * ── Why the rewrite is here too ──────────────────────────────────────────
 *
 * `/embed/c/:slug` is an address, not a file. Vercel rewrites it to
 * `embed.html`; Vite's dev server has its own SPA fallback and would send
 * `index.html` — the whole app, session and all, at the address that must not
 * have one. Rewriting here makes `pnpm dev` and the deployment agree about
 * which of the two entry points answers.
 */
function embedRouting(): PluginOption {
  /**
   * @param dev Whether this server is the one that injects a React preamble
   *   and opens an HMR socket. It decides only the Content-Security-Policy's
   *   two relaxations (`src/embed/headers.ts`), and it is a *per-hook* flag
   *   rather than a per-config one: `vite preview` reports `command ===
   *   'serve'` like the dev server does, but serves the BUILT output, which
   *   has neither of those things. Deriving it from `command` therefore sent
   *   the relaxed policy from the one server that most resembles production —
   *   the exact place a policy mistake would hide.
   */
  const middleware = (dev: boolean): Connect.NextHandleFunction => {
    return (request, response, next) => {
      /*
       * The pathname alone. `/embed?c=…` is an embed and its query is not
       * part of the decision; `req.url` on a Node server is a path with a
       * query attached, never an absolute URL, so the base below is only
       * there to satisfy the parser.
       */
      const { pathname } = new URL(request.url ?? '/', 'http://localhost')

      for (const header of headersFor(pathname, dev)) {
        response.setHeader(header.key, header.value)
      }

      /*
       * `/embed.html` is already the file; everything else under `/embed` is
       * an address that has to be pointed at it. Done before Vite's own
       * `spa-fallback`, which is registered later in the stack and would
       * otherwise answer with `index.html`.
       */
      if (isEmbedPath(pathname) && pathname !== '/embed.html') {
        request.url = '/embed.html'
      }

      next()
    }
  }

  return {
    name: 'qsim-embed-routing',
    configureServer(server) {
      server.middlewares.use(middleware(true))
    },
    configurePreviewServer(server) {
      // The built output, so the deployed policy verbatim — which is what
      // makes `vite preview` a rehearsal rather than a different app.
      server.middlewares.use(middleware(false))
    },
  }
}

/**
 * `NODE_ENV` IN THE SHARED `.env` IS FOR `apps/api`, AND VITE MUST NOT ADOPT
 * IT.
 *
 * `envDir` below points at the repository root so there is one `.env` (the
 * argument is on the option itself). That file also carries
 * `NODE_ENV=development`, which is `apps/api`'s variable — every line in that
 * block is, and `.env.example` says so. Vite reads `NODE_ENV` out of an env
 * file regardless of `envPrefix`, promotes it to `VITE_USER_NODE_ENV`, and
 * then lets it override the mode: `pnpm build`, and therefore `pnpm verify`,
 * emitted React's DEVELOPMENT build. The `jsx-dev-runtime` chunk shipped, the
 * react-dom chunk was 353 kB instead of 179 kB, and the embed entry's import
 * closure was 634 kB — so every local and CI measurement of the embed's weight
 * and of its per-frame cost was made against the wrong artefact. Vercel was
 * unaffected only because `.env` is gitignored and nothing sets `NODE_ENV`
 * there, which makes this a defect that could only ever be seen by the people
 * checking for it.
 *
 * Assigning the empty string is the narrow fix: Vite fills
 * `VITE_USER_NODE_ENV` from the env file only when it is `undefined`, and
 * treats an empty value as "no opinion" — so the file is still read for every
 * `VITE_`-prefixed variable, and the mode goes back to being decided by the
 * command (`build` → production, `dev` → development). Setting it to
 * `'production'` instead would work and would print a warning on every build;
 * setting `process.env.NODE_ENV` here is too late, because Vite samples it
 * before it loads this file.
 */
process.env.VITE_USER_NODE_ENV = ''

export default defineConfig({
  plugins: [react(), embedRouting()],
  /*
   * The monorepo keeps ONE `.env`, at the repository root — that is where
   * `.env.example` documents it, where `.gitignore` excludes it, and where
   * `apps/api` reads it from. Vite looks in its own project root by default,
   * so without this it would read `apps/web/.env`, a file that does not exist
   * and must not be created: two env files is how the API and the browser end
   * up pointed at different Supabase projects, which fails as "the token is
   * invalid" rather than as anything that names the cause.
   *
   * Only `VITE_`-prefixed variables are exposed to the bundle (`envPrefix`
   * defaults to that), so widening where the file is *found* does not widen
   * what is *shipped*: `SUPABASE_SECRET_KEY` and `DATABASE_URL` sit in the
   * same file and stay server-side. `verification/bundle-secrets.test.ts`
   * checks that claim against the built output rather than trusting it.
   */
  envDir: '../..',
  build: {
    rollupOptions: {
      /*
       * TWO ENTRY POINTS, AND THAT IS THE WHOLE "IT MUST BE LIGHT" STORY.
       *
       * `embed.html` is not a route inside the app; it is a second document
       * with its own module graph. Nothing it imports can drag in the router,
       * the Supabase client, React Query, dnd-kit, Zustand or three.js,
       * because none of those is reachable from `src/embed/main.tsx` — and
       * `.dependency-cruiser.cjs` fails the build if one ever becomes so.
       *
       * A lazy route inside the existing entry would have looked equivalent
       * and would not have been: the entry chunk carries the session
       * provider and the API client (`src/main.tsx` builds both before it
       * renders anything), so every embed would ship the machinery for an
       * account it must never have. Six frames in a blog post would each
       * parse it.
       *
       * Vite keeps splitting shared modules out of both graphs, so React, the
       * histogram and `@qsim/schema` are downloaded once and served from
       * cache to all six frames.
       */
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        embed: fileURLToPath(new URL('embed.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    /*
     * COOP/COEP used to be declared here as `server.headers`. They now come
     * from `src/embed/headers.ts` through the plugin above, together with the
     * framing headers and the embed's Content-Security-Policy, because two
     * documents need two different tables. That module carries the reasoning
     * this file used to: why the app is cross-origin isolated, why the embed
     * deliberately is not, and why the transfer path in
     * `features/simulation/protocol.ts` is therefore what an embed runs.
     *
     * `vercel.json` still carries no explanation of its own: it is validated
     * against a strict schema that rejects unknown properties, so a `"//"`
     * key used as a comment fails the deployment outright. The verification
     * test that compares it against the module is what keeps the two honest.
     */
  },
  test: {
    environment: 'jsdom',
    /*
     * Vitest owns `src` and Playwright owns `e2e` — the two runners never
     * see each other's files. The pattern is what keeps them apart: an e2e
     * spec collected by Vitest would run `test()` from `@playwright/test`
     * inside jsdom, and the error that produces names neither runner.
     * The suffix differs too (`.test.ts` here, `.spec.ts` there), so the
     * separation survives either one of the rules being loosened.
     */
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
