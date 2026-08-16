/**
 * The account and profile routes of §8, as functions — milestone M1.9.
 *
 * Same rules as `circuits.ts` and `gallery.ts` beside it: the path comes from
 * `@qsim/contract`'s builders, the response is parsed with its wire schemas,
 * and nothing is declared here.
 *
 * ── The avatar is a choice, not a URL ─────────────────────────────────────
 *
 * `updateProfile` cannot send an avatar URL because the contract has no field
 * for one. The server reads the picture off the *verified token* when the
 * caller picks `provider`, and stores nothing when they pick `generated`. A
 * URL accepted from a client would be rendered by every stranger who opens
 * that profile, which makes it a way to log who looked — see `users.ts` in
 * @qsim/contract for the whole argument.
 *
 * ── Why deletion carries a body ───────────────────────────────────────────
 *
 * `DELETE /me` sends `{ confirm: <username> }`, and the server compares it
 * against the row it is about to destroy. A client cannot decide what counts
 * as confirmation, and the one irreversible request in the product is not
 * reachable by a single mistyped call.
 */

import {
  DeleteAccountBody,
  UpdateProfileBody,
  userPath,
  wireUserResponses,
} from '@qsim/contract'
import type {
  Account,
  AccountDeletion,
  CollectionPage,
  PaginationParams,
  Profile,
  UpdateProfileRequest,
} from '@qsim/contract'
import { wireCollectionResponses } from '@qsim/contract'

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/** `GET /me` — the caller's own row. The same shape a stranger would see. */
export function getAccount(
  client: ApiClient,
  context: RequestContext = {}
): Promise<Account> {
  return client.request({
    method: 'GET',
    path: userPath.me(),
    schema: wireUserResponses.AccountResponse,
    ...context,
  })
}

/**
 * `PATCH /me` — display name, username, avatar source.
 *
 * The body goes through the contract schema before it is sent. That is not
 * belt-and-braces: it is what makes an impossible username a message beside
 * the field rather than a 400 the user has to interpret, and it is the same
 * schema the server validates with, so the two cannot disagree about what is
 * acceptable.
 */
export function updateProfile(
  client: ApiClient,
  changes: UpdateProfileRequest,
  context: RequestContext = {}
): Promise<Account> {
  return client.request({
    method: 'PATCH',
    path: userPath.me(),
    body: UpdateProfileBody.parse(changes),
    schema: wireUserResponses.AccountResponse,
    ...context,
  })
}

/** `DELETE /me` — irreversible, and confirmed with the caller's own handle. */
export function deleteAccount(
  client: ApiClient,
  confirm: string,
  context: RequestContext = {}
): Promise<AccountDeletion> {
  return client.request({
    method: 'DELETE',
    path: userPath.me(),
    body: DeleteAccountBody.parse({ confirm }),
    schema: wireUserResponses.AccountDeletionResponse,
    ...context,
  })
}

/**
 * `GET /users/:username` — a public profile.
 *
 * The counts in it are computed through the §11 filters on the server, so what
 * arrives here is already "what this viewer may see" and nothing has to be
 * subtracted or hidden on this side.
 */
export function getProfile(
  client: ApiClient,
  username: string,
  context: RequestContext = {}
): Promise<Profile> {
  return client.request({
    method: 'GET',
    path: userPath.profile(username),
    schema: wireUserResponses.ProfileResponse,
    ...context,
  })
}

/** `GET /users/:username/collections` — that author's, as this viewer sees. */
export function listUserCollections(
  client: ApiClient,
  username: string,
  params: PaginationParams = {},
  context: RequestContext = {}
): Promise<CollectionPage> {
  return client.request({
    method: 'GET',
    path: userPath.collections(username),
    query: { page: params.page, perPage: params.perPage },
    schema: wireCollectionResponses.CollectionPageResponse,
    ...context,
  })
}
