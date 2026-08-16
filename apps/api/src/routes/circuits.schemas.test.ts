/**
 * The seams between the three descriptions of one API.
 *
 * `@qsim/contract` declares the wire shapes, `@qsim/db` declares what
 * Postgres holds, and this app is the only workspace allowed to see both —
 * `apps/web` may not import `@qsim/db` (§12.3, rule 3). So the assertions
 * that the two agree can only live here, and if they do not live here they do
 * not exist anywhere: a browser holding a stale copy of an enum compiles
 * perfectly and fails at runtime, on a user's screen, as a visibility toggle
 * that silently does nothing.
 */

import {
  API_ERROR_CODES,
  API_PREFIX,
  CIRCUIT_ROUTES,
  COLLECTION_ROUTES,
  GALLERY_ROUTES,
  GALLERY_SORTS as CONTRACT_SORTS,
  MAX_COLLECTION_ITEMS as CONTRACT_MAX_COLLECTION_ITEMS,
  MAX_CURSOR_LENGTH as CONTRACT_MAX_CURSOR_LENGTH,
  MAX_TAGS,
  USERNAME_PATTERN as CONTRACT_USERNAME_PATTERN,
  USER_ROUTES,
  Visibility as ContractVisibility,
} from '@qsim/contract'
import {
  GALLERY_SORTS as DB_SORTS,
  MAX_COLLECTION_ITEMS as DB_MAX_COLLECTION_ITEMS,
  MAX_CURSOR_LENGTH as DB_MAX_CURSOR_LENGTH,
  MAX_TAGS_PER_CIRCUIT,
  USERNAME_PATTERN,
  Visibility as PrismaVisibility,
} from '@qsim/db'
import type { HTTPMethods } from 'fastify'
import { describe, expect, it } from 'vitest'
import { ERROR_DEFINITIONS } from '../errors.js'
import { createTestApp } from '../testing/app.js'
import { CircuitHandleParams, VersionParams } from './circuits.schemas.js'
import { UsernameParams } from './gallery.schemas.js'

describe('Visibility', () => {
  /*
   * The contract re-declares this enum because the browser cannot import
   * Prisma's. That re-declaration is safe exactly as long as this passes.
   */
  it('is spelled identically in the contract and in the database client', () => {
    expect(Object.entries(ContractVisibility).sort()).toEqual(
      Object.entries(PrismaVisibility).sort()
    )
  })

  it('is assignable in both directions at compile time', () => {
    // Not a runtime assertion — the value of these two lines is that they
    // stop compiling if either union gains or loses a member.
    const fromContract: PrismaVisibility = ContractVisibility.UNLISTED
    const fromPrisma: ContractVisibility = PrismaVisibility.UNLISTED

    expect(fromContract).toBe(fromPrisma)
  })
})

describe('the gallery vocabulary', () => {
  /*
   * Three constants that exist twice for the same reason `Visibility` does —
   * the browser may not import `@qsim/db` — and that therefore drift in
   * exactly the same silent way. A sort the client offers and the server has
   * never heard of is a 400 on a menu item; a tag cap the client enforces at
   * ten and the server at eight is a save that fails only for the users who
   * tag the most.
   */
  it('names the same orderings in the contract and in the database layer', () => {
    expect([...CONTRACT_SORTS].sort()).toEqual([...DB_SORTS].sort())
  })

  it('agrees on how many tags a circuit may carry', () => {
    expect(MAX_TAGS).toBe(MAX_TAGS_PER_CIRCUIT)
  })

  it('agrees on how many circuits a collection may hold', () => {
    // The contract refuses the request; the transaction refuses the insert. If
    // the contract's bound were the larger of the two, every over-full add
    // would reach the database to be told no there.
    expect(CONTRACT_MAX_COLLECTION_ITEMS).toBe(DB_MAX_COLLECTION_ITEMS)
  })

  it('agrees on what a username may look like', () => {
    /*
     * Three descriptions of one handle: what `ensureUser` can mint
     * (`@qsim/db`), what a settings form may submit (`@qsim/contract`), and
     * what the path parameter accepts. The middle one exists only because
     * `apps/web` may not import the first. A browser enforcing a wider
     * alphabet than the server is a form that offers to save a name the API
     * will refuse; a narrower one is a name somebody already holds and can no
     * longer type.
     */
    expect(CONTRACT_USERNAME_PATTERN.source).toBe(USERNAME_PATTERN.source)

    for (const handle of ['ada-7fk2', 'a_b', 'x'.repeat(32)]) {
      expect(CONTRACT_USERNAME_PATTERN.test(handle), handle).toBe(true)
      expect(UsernameParams.safeParse({ username: handle }).success).toBe(true)
    }
    for (const handle of ['Ada', 'a', 'x'.repeat(33), 'ada lovelace']) {
      expect(CONTRACT_USERNAME_PATTERN.test(handle), handle).toBe(false)
    }
  })

  it('agrees on the longest cursor it will decode', () => {
    // The contract rejects an over-long cursor before anything decodes it;
    // the decoder rejects it again. If the contract's bound were the larger
    // of the two, the second check would be the one doing the work and the
    // first would be decoration.
    expect(CONTRACT_MAX_CURSOR_LENGTH).toBe(DB_MAX_CURSOR_LENGTH)
  })
})

describe('error codes', () => {
  /*
   * `ERROR_DEFINITIONS` is declared `satisfies Record<ApiErrorCode, …>`, so
   * a missing or extra code is already a compile error. This asserts the same
   * thing at runtime, which is what a reader of a failing CI log can act on,
   * and it is the assertion that survives someone loosening the `satisfies`.
   */
  it('are exactly the codes the contract publishes', () => {
    expect(Object.keys(ERROR_DEFINITIONS).sort()).toEqual(
      [...API_ERROR_CODES].sort()
    )
  })
})

describe('route paths', () => {
  /*
   * The client builds its URLs from `CIRCUIT_ROUTES` and `API_PREFIX`. This
   * asserts the server actually listens on them — the direction a shared
   * constant cannot guarantee by itself, since a handler could always be
   * registered with a literal instead. The verbs are asserted alongside,
   * because §8 gives the same path different meanings per method.
   */
  const EXPECTED: readonly (readonly [HTTPMethods, string])[] = [
    ['GET', CIRCUIT_ROUTES.collection],
    ['POST', CIRCUIT_ROUTES.collection],
    ['GET', CIRCUIT_ROUTES.item],
    ['PATCH', CIRCUIT_ROUTES.item],
    ['DELETE', CIRCUIT_ROUTES.item],
    ['POST', CIRCUIT_ROUTES.fork],
    ['GET', CIRCUIT_ROUTES.versions],
    ['POST', CIRCUIT_ROUTES.versions],
    ['GET', CIRCUIT_ROUTES.version],
    ['POST', CIRCUIT_ROUTES.star],
    ['DELETE', CIRCUIT_ROUTES.star],
    ['GET', GALLERY_ROUTES.gallery],
    ['GET', GALLERY_ROUTES.userCircuits],
    ['GET', USER_ROUTES.me],
    ['PATCH', USER_ROUTES.me],
    ['DELETE', USER_ROUTES.me],
    ['GET', USER_ROUTES.profile],
    ['GET', USER_ROUTES.collections],
    ['GET', COLLECTION_ROUTES.collection],
    ['POST', COLLECTION_ROUTES.collection],
    ['GET', COLLECTION_ROUTES.item],
    ['PATCH', COLLECTION_ROUTES.item],
    ['DELETE', COLLECTION_ROUTES.item],
    ['POST', COLLECTION_ROUTES.items],
    ['DELETE', COLLECTION_ROUTES.member],
    ['GET', COLLECTION_ROUTES.membership],
  ]

  /*
   * The only test in this file that builds an app, and building one compiles
   * every route's Zod schemas. Vitest's five-second default is comfortable
   * alone and marginal when `turbo` is running four workspaces beside it, so
   * the budget is stated rather than left to decide the outcome by load.
   */
  it(
    'are registered where the contract says they are',
    { timeout: 20_000 },
    async () => {
      const app = await createTestApp()
      await app.ready()

      try {
        for (const [method, template] of EXPECTED) {
          const url = `${API_PREFIX}${template}`
          expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true)
        }
      } finally {
        await app.close()
      }
    }
  )
})

describe('path parameters', () => {
  /** Long enough for the handle pattern, which floors at eight characters. */
  const HANDLE = 'abc12345'

  it('rejects a handle that is not one', () => {
    expect(CircuitHandleParams.safeParse({ id: 'a b' }).success).toBe(false)
    expect(CircuitHandleParams.safeParse({ id: 'x'.repeat(500) }).success).toBe(
      false
    )
  })

  it('coerces a version number and bounds it', () => {
    expect(VersionParams.parse({ id: HANDLE, n: '4' }).n).toBe(4)
    expect(VersionParams.safeParse({ id: HANDLE, n: '1e308' }).success).toBe(
      false
    )
  })

  it('accepts the usernames ensureUser mints and refuses the rest', () => {
    // The suffixed form `baseUsernameFrom` + `withUsernameSuffix` produce.
    expect(UsernameParams.safeParse({ username: 'ada-7fk2' }).success).toBe(
      true
    )
    expect(USERNAME_PATTERN.test('ada-7fk2')).toBe(true)
    // Uppercase cannot be minted, and a case-insensitive lookup would turn a
    // unique index into a scan.
    expect(UsernameParams.safeParse({ username: 'Ada' }).success).toBe(false)
    expect(UsernameParams.safeParse({ username: 'a' }).success).toBe(false)
    expect(UsernameParams.safeParse({ username: 'x'.repeat(64) }).success).toBe(
      false
    )
    expect(UsernameParams.safeParse({ username: '../../etc' }).success).toBe(
      false
    )
  })
})
