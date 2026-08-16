/**
 * Where the circuit routes live — §8.
 *
 * The server registers a *template* (`/circuits/:id`) and the client builds a
 * concrete path (`/circuits/abc123`). Those are two spellings of one fact,
 * and a typo in either is a 404 that neither a type checker nor a unit test
 * on one side alone can see. So the template is declared once and the client
 * fills it: `apps/api` registers `CIRCUIT_ROUTES.item`, `apps/web` calls
 * `circuitPath.item(slug)`, and renaming a route touches one line.
 *
 * `encodeURIComponent` is applied per segment rather than to the whole path,
 * which is the only way that is correct: a slug is 21 characters from
 * nanoid's URL-safe alphabet today, but the same builders take a cuid `id`
 * and will one day take a username, and encoding the joined string would
 * escape the separators too.
 */

/** Every route of §8 lives under this prefix; `/health` deliberately does not. */
export const API_PREFIX = '/api/v1'

/**
 * Path templates, in Fastify's `:param` notation, relative to `API_PREFIX`.
 *
 * `:id` is one name for a circuit in every position, because §8 addresses the
 * same resource two ways — `/circuits/:slug` for the page, `/circuits/:id/
 * versions` for its history — and a route tree with two names in the same
 * slot is a trap for the next reader. The lookup accepts either; both columns
 * are unique.
 */
export const CIRCUIT_ROUTES = {
  collection: '/circuits',
  item: '/circuits/:id',
  fork: '/circuits/:id/fork',
  versions: '/circuits/:id/versions',
  version: '/circuits/:id/versions/:n',
  /** `POST` to star, `DELETE` to unstar. Both idempotent (§8). */
  star: '/circuits/:id/star',
} as const

export type CircuitRoute = (typeof CIRCUIT_ROUTES)[keyof typeof CIRCUIT_ROUTES]

/**
 * The two listings of §8 that are not scoped to the caller.
 *
 * `userCircuits` takes a username rather than a user id, which is what makes
 * it a shareable address — and `fillRoute` encodes the segment, so a handle
 * with a character the router would read as a separator cannot escape it.
 */
export const GALLERY_ROUTES = {
  gallery: '/gallery',
  userCircuits: '/users/:username/circuits',
} as const

export type GalleryRoute = (typeof GALLERY_ROUTES)[keyof typeof GALLERY_ROUTES]

/**
 * The account, and one person's public page — milestone M1.9.
 *
 * `/users/:username/circuits` stays in `GALLERY_ROUTES` beside `/gallery`
 * rather than moving here, because it is not really a route about a user: it
 * is the gallery query with one more `AND ownerId =` and it shares an
 * implementation with it. What lives here is what is about the *person*.
 */
export const USER_ROUTES = {
  /** The signed-in caller's own row: `GET` to read, `PATCH`, `DELETE`. */
  me: '/me',
  profile: '/users/:username',
  collections: '/users/:username/collections',
} as const

export type UserRoute = (typeof USER_ROUTES)[keyof typeof USER_ROUTES]

/**
 * Server-side simulation — §8, and §4's three reasons for it to exist.
 *
 * `run` takes a **run id** and not a circuit handle, and the distinction is
 * load-bearing: a run is not a property of a circuit. It may be over a circuit
 * that was never saved, several runs of one circuit differ only by seed and
 * shots, and a run belongs to whoever asked for it rather than to whoever owns
 * the document. Addressing it under `/circuits/:id/runs` would imply all three
 * of those are false.
 */
export const SIMULATE_ROUTES = {
  collection: '/simulate',
  run: '/simulate/:runId',
} as const

export type SimulateRoute =
  (typeof SIMULATE_ROUTES)[keyof typeof SIMULATE_ROUTES]

export const COLLECTION_ROUTES = {
  collection: '/collections',
  item: '/collections/:id',
  /** `POST` to add a circuit. */
  items: '/collections/:id/items',
  /** `DELETE` to remove one. */
  member: '/collections/:id/items/:circuitId',
  /** Which of the caller's own collections already hold a given circuit. */
  membership: '/circuits/:id/collections',
} as const

export type CollectionRoute =
  (typeof COLLECTION_ROUTES)[keyof typeof COLLECTION_ROUTES]

/**
 * Substitutes `:name` placeholders, encoding each value.
 *
 * Throws on a placeholder nobody supplied rather than leaving `:id` in the
 * path: a request to `/circuits/:id` is a 404 whose cause is three files
 * away, while a thrown error names the parameter.
 */
export function fillRoute(
  template: string,
  params: Readonly<Record<string, string | number>>
): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
    const key = String(name)
    const value = params[key]
    if (value === undefined) {
      throw new Error(`Route "${template}" has no value for ":${key}"`)
    }
    return encodeURIComponent(String(value))
  })
}

/** The concrete paths a client requests, relative to `API_PREFIX`. */
export const circuitPath = {
  collection: (): string => CIRCUIT_ROUTES.collection,
  item: (handle: string): string =>
    fillRoute(CIRCUIT_ROUTES.item, { id: handle }),
  fork: (handle: string): string =>
    fillRoute(CIRCUIT_ROUTES.fork, { id: handle }),
  versions: (handle: string): string =>
    fillRoute(CIRCUIT_ROUTES.versions, { id: handle }),
  version: (handle: string, versionNum: number): string =>
    fillRoute(CIRCUIT_ROUTES.version, { id: handle, n: versionNum }),
  star: (handle: string): string =>
    fillRoute(CIRCUIT_ROUTES.star, { id: handle }),
} as const

export const galleryPath = {
  gallery: (): string => GALLERY_ROUTES.gallery,
  userCircuits: (username: string): string =>
    fillRoute(GALLERY_ROUTES.userCircuits, { username }),
} as const

export const userPath = {
  me: (): string => USER_ROUTES.me,
  profile: (username: string): string =>
    fillRoute(USER_ROUTES.profile, { username }),
  collections: (username: string): string =>
    fillRoute(USER_ROUTES.collections, { username }),
} as const

export const simulatePath = {
  collection: (): string => SIMULATE_ROUTES.collection,
  run: (runId: string): string => fillRoute(SIMULATE_ROUTES.run, { runId }),
} as const

export const collectionPath = {
  collection: (): string => COLLECTION_ROUTES.collection,
  item: (id: string): string => fillRoute(COLLECTION_ROUTES.item, { id }),
  items: (id: string): string => fillRoute(COLLECTION_ROUTES.items, { id }),
  member: (id: string, circuitId: string): string =>
    fillRoute(COLLECTION_ROUTES.member, { id, circuitId }),
  membership: (handle: string): string =>
    fillRoute(COLLECTION_ROUTES.membership, { id: handle }),
} as const
