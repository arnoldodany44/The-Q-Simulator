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
       * The same two headers must be configured on Vercel for production.
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
