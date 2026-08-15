/**
 * The route table (specification §9).
 *
 * React Router in declarative mode: the app is a single-page client with no
 * server rendering and no data loaders yet, so `BrowserRouter` plus a list
 * of routes is the whole of it. Loaders and the data router become worth
 * their weight in Phase 1, when circuits start coming from the API.
 *
 * `/new` is the editor over a blank document. `/c/:slug` — the same editor
 * over a saved one — arrives with persistence.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE EDITOR IS SPLIT OUT AND THE LANDING IS NOT (M0.9b).
 *
 * The landing page is the entry point and its job is to be understood inside a
 * minute (§2), so it is the one route that may not wait on a second round
 * trip: it stays in the entry chunk and paints as soon as the entry chunk
 * arrives. The editor is the opposite — it is reached by a deliberate click,
 * and it carries dnd-kit, the document store with its undo history, the
 * analysis panel, Zod and the URL codec — so it is imported lazily, and a
 * first-time reader who bounces off the landing never downloads any of it.
 *
 * That split only holds if nothing on the landing side reaches across it;
 * `routes/landing.tsx` lists the imports it is avoiding and why.
 *
 * The fallback is a translated line rather than `null`. A blank frame during
 * a chunk fetch on a slow connection is indistinguishable from a broken link,
 * and D2 does not stop at the strings inside a route.
 */

import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Route, Routes } from 'react-router'

import { EDITOR_NAMESPACES, loadNamespaces } from './i18n'
import { LandingRoute } from './routes/landing'

/**
 * Written as an async function rather than as `import(…).then(…)` because the
 * route is a *named* export: `lazy` requires a module whose `default` is the
 * component, and this is the shortest spelling that produces one without
 * adding a default export nothing else would use.
 *
 * The editor's catalogs travel with it, in the same wait. That is the other
 * half of the split: the bootstrap used to await all six namespaces before the
 * landing could paint, and `editor` alone was more than half of those bytes —
 * paid by every reader, for a route most of them never open. Fetched here they
 * are on the same round trip as the chunk that needs them, so the editor still
 * arrives fully translated and `Suspense` covers the wait it always covered.
 */
const EditorRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/editor'),
    loadNamespaces(EDITOR_NAMESPACES),
  ])
  return { default: module.EditorRoute }
})

/**
 * The table on its own, without a router around it, so a test can mount it
 * inside a `MemoryRouter` and assert what each path renders. `App` is then
 * the same table plus the history integration the browser needs.
 */
export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<LandingRoute />} />
        <Route path="/new" element={<EditorRoute />} />
      </Routes>
    </Suspense>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}

/** What is on screen while a route's chunk is on its way. */
function RouteFallback() {
  const { t } = useTranslation('common')
  return <p className="page page__loading">{t('loading')}</p>
}
