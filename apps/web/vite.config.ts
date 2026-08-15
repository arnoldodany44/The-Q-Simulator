import react from '@vitejs/plugin-react'
// `vitest/config` rather than `vite` so the `test` key below is typed.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: {
      /*
       * Cross-origin isolation, required for SharedArrayBuffer. The
       * simulation worker (M0.6) shares the statevector with the main thread
       * through one, so the headers are set here from the start — discovering
       * they are missing after the worker is written costs an afternoon.
       * The same two headers are set for production in vercel.json, which
       * carries no explanation of its own: vercel.json is validated against a
       * strict schema that rejects unknown properties, so a `"//"` key used as
       * a comment fails the deployment outright — with an error that points at
       * the project-configuration docs rather than at the offending line.
       * Everything that file needs explaining is therefore explained here.
       *
       * `require-corp` is only safe because this app loads nothing
       * cross-origin. The three fonts are self-hosted precisely so that holds;
       * adding any external resource later means giving it CORP headers or
       * losing SharedArrayBuffer. The worker checks `crossOriginIsolated` and
       * falls back to copying transferable buffers rather than assuming, so
       * getting this wrong costs speed rather than correctness.
       *
       * vercel.json also rewrites everything to index.html, because `/new`
       * and the future `/c/:slug` are React Router paths rather than files.
       * Vercel checks the filesystem before applying rewrites, so real assets
       * still serve themselves.
       */
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
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
