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
  Visibility as ContractVisibility,
} from '@qsim/contract'
import { Visibility as PrismaVisibility } from '@qsim/db'
import type { HTTPMethods } from 'fastify'
import { describe, expect, it } from 'vitest'
import { ERROR_DEFINITIONS } from '../errors.js'
import { createTestApp } from '../testing/app.js'
import { CircuitHandleParams, VersionParams } from './circuits.schemas.js'

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
})
