/**
 * Where the account screens live in this app's address space — M1.9.
 *
 * This module imports nothing, because `App.tsx` reaches for the templates
 * here and lives in the entry chunk (M0.9b).
 *
 * ── Two addresses for one profile, deliberately ───────────────────────────
 *
 * `/u/:username` is what M1.5b shipped and what every card in the gallery
 * links to; `/users/:username` is the address §8 gives the API's own profile
 * route, and it is the one a person types or pastes from a copied API link.
 * Both render the same route rather than one redirecting to the other: a
 * redirect would make a shared link change shape in the address bar for no
 * reason the reader can see, and the shorter form stays canonical because it
 * is what fifty cards a page already point at.
 */

/** The signed-in caller's own settings. */
export const SETTINGS_PATH = '/settings'

/**
 * The long spelling of a profile, matching `USER_ROUTES.profile` in
 * `@qsim/contract`. The short one is `PROFILE_ROUTE_PATH` in
 * `features/gallery/paths`, which is what links are built from.
 */
export const PROFILE_ALIAS_ROUTE_PATH = '/users/:username'
