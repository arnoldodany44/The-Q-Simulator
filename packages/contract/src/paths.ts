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
} as const

export type CircuitRoute = (typeof CIRCUIT_ROUTES)[keyof typeof CIRCUIT_ROUTES]

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
} as const
