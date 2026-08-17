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
 * Lesson progress — §3.6, Phase 3.
 *
 * There is no `GET /lessons` and there must not be: a lesson is a file in
 * `apps/web`, so the list of them changes with a deploy of the client rather
 * than with one of the API. What the server owns is the bookmark, addressed by
 * the caller's token and the slug, which is why `item` is a `PUT` with no
 * companion `POST` — see `lessons.ts` for the whole argument.
 */
export const LESSON_ROUTES = {
  /** Every lesson this caller has a bookmark in. */
  progress: '/lessons/progress',
  /** `PUT` to record where they stopped in one lesson. */
  item: '/lessons/:slug/progress',
} as const

export type LessonRoute = (typeof LESSON_ROUTES)[keyof typeof LESSON_ROUTES]

/**
 * Challenges — §3.6, §8, Phase 3.
 *
 * The opposite arrangement to `LESSON_ROUTES` above, and deliberately so.
 * There *is* a `GET /challenges`, because a challenge is a database row: its
 * target, its gate budget and its fidelity threshold live on the server, which
 * is the whole of risk 5. A lesson has nothing to win and is a file in the
 * client; a challenge is judged, so the server owns it.
 *
 * `submit` is a `POST` and not a `PUT`, again unlike the lesson bookmark: every
 * attempt is its own resource, the leaderboard ranks attempts, and sending the
 * same circuit twice is genuinely two attempts rather than one write repeated.
 */
export const CHALLENGE_ROUTES = {
  collection: '/challenges',
  item: '/challenges/:slug',
  /** `POST` a circuit; the server simulates it and decides (§4, risk 5). */
  submit: '/challenges/:slug/submit',
  leaderboard: '/challenges/:slug/leaderboard',
} as const

export type ChallengeRoute =
  (typeof CHALLENGE_ROUTES)[keyof typeof CHALLENGE_ROUTES]

/**
 * The read behind an `<iframe>` — §3.4, §11.
 *
 * A separate route rather than a flag on `GET /circuits/:id`, and the
 * separation is the security rather than tidiness. `/circuits/:id` is
 * `auth: 'optional'`: it consults the `Authorization` header, and it is
 * supposed to — that is what lets an owner open their own PRIVATE circuit.
 * An embed must never be able to do that, because a page that renders a
 * private circuit whenever its author happens to be signed in would publish
 * that circuit to every reader of the blog post the moment the author
 * previewed it themselves.
 *
 * So the embed's read is `auth: 'public'` — the header is not consulted at
 * all — and the only way to guarantee that is for it to be a different route
 * with a different policy. A parameter on the existing one would have been a
 * conditional inside a handler, which is the shape of rule that gets forgotten.
 *
 * `:handle` rather than `:id`, unlike every other route here, because that is
 * what it means: only a *slug* reaches an UNLISTED circuit
 * (`slugAddressableCircuitFilter` in `@qsim/db`), so the embeddable set and
 * the set this parameter can name are the same set.
 */
export const EMBED_ROUTES = {
  item: '/embed/:handle',
} as const

export type EmbedRoute = (typeof EMBED_ROUTES)[keyof typeof EMBED_ROUTES]

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

export const lessonPath = {
  progress: (): string => LESSON_ROUTES.progress,
  item: (slug: string): string => fillRoute(LESSON_ROUTES.item, { slug }),
} as const

export const challengePath = {
  collection: (): string => CHALLENGE_ROUTES.collection,
  item: (slug: string): string => fillRoute(CHALLENGE_ROUTES.item, { slug }),
  submit: (slug: string): string =>
    fillRoute(CHALLENGE_ROUTES.submit, { slug }),
  leaderboard: (slug: string): string =>
    fillRoute(CHALLENGE_ROUTES.leaderboard, { slug }),
} as const

export const embedPath = {
  item: (handle: string): string => fillRoute(EMBED_ROUTES.item, { handle }),
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
