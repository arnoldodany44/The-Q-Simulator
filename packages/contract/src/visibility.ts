/**
 * Circuit visibility, as the wire spells it — §11.
 *
 * ── Why this is declared here and not imported from @qsim/db ──────────────
 *
 * The authoritative definition of this enum is the Postgres type, and Prisma
 * generates a TypeScript mirror of it inside `@qsim/db`. The browser may not
 * import that package (§12.3, rule 3, enforced in CI): doing so would pull
 * the Prisma client into the bundle and imply that database credentials exist
 * client-side. So the browser needs *some* declaration of the three values,
 * and there are exactly two ways to get one — copy them into `apps/web`, or
 * declare them in a package both sides import.
 *
 * A copy in `apps/web` would be the third independent spelling of the same
 * enum, and the one nothing checks. This is the second, and it is checked:
 * `apps/api` imports both this module and Prisma's, and
 * `routes/circuits.schemas.test.ts` asserts the two agree — key for key,
 * value for value. `apps/api` is the only workspace that can make that
 * assertion, because it is the only one allowed to see both.
 *
 * The shape deliberately mirrors what `prisma generate` emits (a frozen
 * const object plus a union type of the same name) so that the two are
 * structurally interchangeable and a route can pass one where the other is
 * expected without a cast.
 */

import { z } from 'zod'

export const Visibility = {
  /** Only the owner. Verified in the query, never in the client (§11). */
  PRIVATE: 'PRIVATE',
  /**
   * Anyone holding the slug. Not discoverable: absent from every listing,
   * because the slug's 126 bits of entropy *are* the access control.
   */
  UNLISTED: 'UNLISTED',
  /** In the gallery, readable by anonymous callers. */
  PUBLIC: 'PUBLIC',
} as const

export type Visibility = (typeof Visibility)[keyof typeof Visibility]

export const VISIBILITY_VALUES = [
  Visibility.PRIVATE,
  Visibility.UNLISTED,
  Visibility.PUBLIC,
] as const

export const VisibilitySchema = z.enum(Visibility)
