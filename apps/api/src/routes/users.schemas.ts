/**
 * The profile and account routes' schemas, as this process uses them — §8,
 * M1.9.
 *
 * Same division as `circuits.schemas.ts` and `gallery.schemas.ts`: the shapes
 * live in `@qsim/contract` because `apps/web` holds the other end of them, and
 * what stays here is the server-only part — a path parameter validated against
 * a pattern from `@qsim/db`, a package the browser may not import (§12.3).
 */

import { serverUserResponses } from '@qsim/contract'

export {
  DeleteAccountBody,
  PaginationQuery,
  UpdateProfileBody,
} from '@qsim/contract'

export { UsernameParams } from './gallery.schemas.js'

export const { AccountResponse, AccountDeletionResponse, ProfileResponse } =
  serverUserResponses
