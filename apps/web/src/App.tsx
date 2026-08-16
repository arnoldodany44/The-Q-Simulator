/**
 * The route table (specification §9).
 *
 * React Router in declarative mode: the app is a single-page client with no
 * server rendering and no data loaders yet, so `BrowserRouter` plus a list
 * of routes is the whole of it. Loaders and the data router become worth
 * their weight in Phase 1, when circuits start coming from the API.
 *
 * `/new` is the editor over a blank document; `/c/:slug` is the same editor
 * over a saved one (M1.4a). The second is deliberately **not** behind
 * `RequireSession`: `GET /circuits/:id` is `auth: 'optional'` in `apps/api`,
 * which is what makes a PUBLIC circuit readable by anyone and an UNLISTED link
 * work at all. A guard here would break every shared link in the name of a
 * check the server is already doing — and doing better, since it knows which
 * of the three visibilities the row actually has.
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

import { Suspense, lazy, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Route, Routes } from 'react-router'

import {
  CIRCUITS_PATH,
  PASSWORD_RESET_PATH,
  PASSWORD_UPDATE_PATH,
  RedirectWhenSignedIn,
  RequireSession,
  SIGN_IN_PATH,
  SIGN_UP_PATH,
} from './features/auth'
/*
 * From the leaf module, not the barrel, for the reason the import below gives:
 * this one runs on every load to decide whether a provider round trip failed,
 * so it has to be in the entry chunk — and it imports nothing but the failure
 * map.
 */
import {
  hrefWithoutProviderReturn,
  readProviderReturn,
} from './features/auth/providerReturn'
/*
 * The path template only, from a module that imports nothing. Reaching for the
 * feature's barrel would pull the save panel, the mutations and Zustand into
 * the entry chunk — undoing M0.9b's split for the sake of one string.
 */
import { CIRCUIT_ROUTE_PATH } from './features/circuit-storage/paths'
/*
 * Same reason as the line above: `features/gallery/paths` imports nothing, so
 * the entry chunk takes two path templates from it without acquiring React
 * Query, the thumbnail renderer and the star wiring (M0.9b).
 */
import { GALLERY_PATH, PROFILE_ROUTE_PATH } from './features/gallery/paths'
/*
 * Same reason again (M0.9b): both of these modules import nothing, so the
 * entry chunk takes four path templates without acquiring the collection
 * forms, the settings screen or the identicon.
 */
import {
  COLLECTIONS_PATH,
  COLLECTION_ROUTE_PATH,
} from './features/collections/paths'
import {
  PROFILE_ALIAS_ROUTE_PATH,
  SETTINGS_PATH,
} from './features/profile/paths'
import {
  AUTH_NAMESPACES,
  CIRCUITS_NAMESPACES,
  COLLECTIONS_NAMESPACES,
  EDITOR_NAMESPACES,
  GALLERY_NAMESPACES,
  SETTINGS_NAMESPACES,
  loadNamespaces,
} from './i18n'
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

/*
 * The four account screens (M1.3b), each with the `auth` catalog on the same
 * round trip as its own chunk — the same arrangement the editor gets, for the
 * same reason: most visits never open a sign-in form, and the catalog carries
 * a sentence per failure code. The one auth string rendered *outside* these
 * screens, the account menu in the header, comes from `common`, which the
 * shell already carries.
 */
const SignInRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/sign-in'),
    loadNamespaces(AUTH_NAMESPACES),
  ])
  return { default: module.SignInRoute }
})

const SignUpRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/sign-up'),
    loadNamespaces(AUTH_NAMESPACES),
  ])
  return { default: module.SignUpRoute }
})

const RequestPasswordResetRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/reset-password'),
    loadNamespaces(AUTH_NAMESPACES),
  ])
  return { default: module.RequestPasswordResetRoute }
})

const UpdatePasswordRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/update-password'),
    loadNamespaces(AUTH_NAMESPACES),
  ])
  return { default: module.UpdatePasswordRoute }
})

const CircuitsRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/circuits'),
    loadNamespaces(CIRCUITS_NAMESPACES),
  ])
  return { default: module.CircuitsRoute }
})

/*
 * The two public listings (M1.5b), lazy like every route but the landing.
 *
 * They are anonymous — `GET /gallery` is `auth: 'optional'` — so neither is
 * behind `RequireSession`, and that is the point rather than an omission: the
 * gallery is the front door, and §11 decides what a viewer may see inside the
 * query rather than at the door.
 */
const GalleryRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/gallery'),
    loadNamespaces(GALLERY_NAMESPACES),
  ])
  return { default: module.GalleryRoute }
})

const ProfileRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/profile'),
    // Both, because M1.9 put the author's public collections on this page and
    // the cards there speak the collections vocabulary.
    loadNamespaces([...GALLERY_NAMESPACES, ...COLLECTIONS_NAMESPACES]),
  ])
  return { default: module.ProfileRoute }
})

/*
 * The three screens M1.9 added, lazy like every route but the landing.
 *
 * `/collections/:id` is deliberately *not* behind `RequireSession`, for the
 * same reason the gallery is not: `GET /collections/:id` is `auth: 'optional'`,
 * which is what makes a public collection something you can send somebody and
 * an unlisted one a link that works. `/collections` is the caller's own and is
 * guarded — which spares an anonymous visitor a round trip ending in a 401
 * they cannot read, and decides nothing (§11).
 *
 * `/settings` is guarded too, and the guard is *inside* the route rather than
 * around it. Deleting an account is the one screen that stops needing a
 * session halfway through: the last thing it renders is the report of what was
 * destroyed, for somebody who by then has no account at all. With the guard
 * out here, signing out tore that report down and redirected to /sign-in — the
 * confirmation was on screen for about a tenth of a second, too short for a
 * live region to be announced. See `routes/settings.tsx`.
 */
const SettingsRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/settings'),
    loadNamespaces(SETTINGS_NAMESPACES),
  ])
  return { default: module.SettingsRoute }
})

const CollectionsRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/collections'),
    loadNamespaces(COLLECTIONS_NAMESPACES),
  ])
  return { default: module.CollectionsRoute }
})

const CollectionRoute = lazy(async () => {
  const [module] = await Promise.all([
    import('./routes/collection'),
    // The collection page draws gallery cards, so it needs their words too.
    loadNamespaces([...COLLECTIONS_NAMESPACES, ...GALLERY_NAMESPACES]),
  ])
  return { default: module.CollectionRoute }
})

/**
 * Only fetched when a provider actually sent the user back with a failure,
 * which for most sessions is never.
 */
const ProviderReturnAlert = lazy(async () => {
  const [module] = await Promise.all([
    import('./features/auth/ProviderReturnAlert'),
    loadNamespaces(AUTH_NAMESPACES),
  ])
  return { default: module.ProviderReturnAlert }
})

/**
 * The failure a third-party sign-in came back with, read once and then taken
 * out of the address.
 *
 * Read in a state initialiser for the reason `useCircuitUrl` gives about the
 * same question: what the address said when this page loaded is a fact about
 * this visit, and the effect below immediately makes it untrue.
 */
function useProviderReturn(): ReturnType<typeof readProviderReturn> {
  const [failure] = useState(() =>
    readProviderReturn(window.location.search, window.location.hash)
  )

  useEffect(() => {
    if (failure === null) return
    const next = hrefWithoutProviderReturn(window.location.href)
    if (next === window.location.href) return
    /*
     * `replaceState` rather than a router navigation, and behind its back for
     * the reason `useCircuitUrl` documents: React Router reads
     * `window.location` on demand, nothing renders from these parameters, and
     * a navigation would put a second entry in the history for a correction.
     */
    window.history.replaceState(window.history.state, '', next)
  }, [failure])

  return failure
}

/**
 * The table on its own, without a router around it, so a test can mount it
 * inside a `MemoryRouter` and assert what each path renders. `App` is then
 * the same table plus the history integration the browser needs.
 */
export function AppRoutes() {
  const providerFailure = useProviderReturn()

  return (
    <>
      {/*
       * Above the route, and outside the route table, because the address a
       * provider returns to is whatever `redirect_to` said — usually the app
       * root. Its own `Suspense` with a `null` fallback: the alert's chunk must
       * never hold up the page the user is standing on.
       */}
      {providerFailure === null ? null : (
        <Suspense fallback={null}>
          <ProviderReturnAlert code={providerFailure} />
        </Suspense>
      )}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route path="/new" element={<EditorRoute />} />
          <Route path={CIRCUIT_ROUTE_PATH} element={<EditorRoute />} />

          {/*
           * Deliberately not guarded. Both listings answer an anonymous
           * caller, which is what makes the gallery a way *in* to the product
           * rather than a page you have to have signed up to see.
           */}
          <Route path={GALLERY_PATH} element={<GalleryRoute />} />
          <Route path={PROFILE_ROUTE_PATH} element={<ProfileRoute />} />
          {/*
           * The long spelling §8 gives the API's own profile route, rendering
           * the same page rather than redirecting to the short one: a redirect
           * would make a pasted link change shape in the address bar for no
           * reason the reader can see. `/u/:username` stays canonical because
           * it is what fifty cards a page already point at.
           */}
          <Route path={PROFILE_ALIAS_ROUTE_PATH} element={<ProfileRoute />} />
          <Route path={COLLECTION_ROUTE_PATH} element={<CollectionRoute />} />

          {/*
           * Three of the four account screens are behind the mirror guard: a
           * user who is already signed in has no business being shown a login
           * form, and `RedirectWhenSignedIn` also takes them back to wherever
           * `RequireSession` was sending them.
           */}
          <Route
            path={SIGN_IN_PATH}
            element={
              <RedirectWhenSignedIn>
                <SignInRoute />
              </RedirectWhenSignedIn>
            }
          />
          <Route
            path={SIGN_UP_PATH}
            element={
              <RedirectWhenSignedIn>
                <SignUpRoute />
              </RedirectWhenSignedIn>
            }
          />
          <Route
            path={PASSWORD_RESET_PATH}
            element={
              <RedirectWhenSignedIn>
                <RequestPasswordResetRoute />
              </RedirectWhenSignedIn>
            }
          />
          {/*
           * The fourth is not, and deliberately. The recovery link establishes
           * a session before this page renders, so either guard would be wrong:
           * `RequireSession` would bounce the user whose link had expired to a
           * sign-in screen that explains nothing, and `RedirectWhenSignedIn`
           * would bounce every user whose link worked. The screen reads the
           * three session states itself.
           */}
          <Route
            path={PASSWORD_UPDATE_PATH}
            element={<UpdatePasswordRoute />}
          />

          <Route
            path={CIRCUITS_PATH}
            element={
              <RequireSession>
                <CircuitsRoute />
              </RequireSession>
            }
          />
          <Route
            path={COLLECTIONS_PATH}
            element={
              <RequireSession>
                <CollectionsRoute />
              </RequireSession>
            }
          />
          {/* Guarded inside the route, not here — see the note above. */}
          <Route path={SETTINGS_PATH} element={<SettingsRoute />} />
        </Routes>
      </Suspense>
    </>
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
