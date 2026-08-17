/**
 * Profiles and the account itself — §3.4, §8, milestone M1.9.
 *
 * ── A profile is a listing, including the numbers on it ───────────────────
 *
 * `GET /users/:username` is anonymous by design: a profile is a page you send
 * somebody. What it contains is a name, a picture, and two counts — and the
 * counts are the interesting part, because a count is a listing. "How many
 * circuits has this person got" answered without the §11 filter is a report on
 * their private work in a single integer, which is small enough to look
 * harmless and is exactly as wrong as returning the rows.
 *
 * So neither number is computed here. `countPublished` runs the *same*
 * `galleryWhere` the listing runs, and `countCollections` runs the same
 * `listableCollectionFilter` the collection listing runs, both with the viewer
 * this process verified. The number a stranger sees is therefore the number of
 * cards they would get by paging to the end of `/users/:username/circuits`,
 * and the owner reading their own profile sees their own larger one.
 *
 * ── `GET /me` answers with the public shape, deliberately ─────────────────
 *
 * There is one user projection in this system — `publicUserSelect` — and it
 * has no `email`. Reading your own settings does not need one: the address is
 * a claim in the token you authenticated with, which `apps/web` already holds.
 * The value of having no second projection is that no future handler can pick
 * the wrong one.
 *
 * ── The avatar is chosen, never supplied ──────────────────────────────────
 *
 * `PATCH /me` takes `avatar: 'provider' | 'generated'` and no URL. A URL from
 * a request body would be rendered by every stranger who opens the profile,
 * which makes it a way to log who looked; the `provider` branch reads the
 * value off `request.auth` — the *verified* token — so the only string that
 * can reach the column is one the identity provider issued and `verify.ts`
 * already restricted to http and https.
 */

import { USER_ROUTES } from '@qsim/contract'
import type { AvatarSource } from '@qsim/contract'
import type { AccountUser } from '@qsim/db'
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
} from 'fastify'
import type { VerifiedIdentity } from '../auth/verify.js'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { requireViewerId, viewerIdOf } from '../plugins/auth.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import { toPage } from './circuits.schemas.js'
import { CollectionPageResponse } from './collections.schemas.js'
import {
  AccountDeletionResponse,
  AccountResponse,
  DeleteAccountBody,
  PaginationQuery,
  ProfileResponse,
  UpdateProfileBody,
  UsernameParams,
} from './users.schemas.js'

export interface UserRoutesOptions {
  readonly env: ApiEnv
}

/**
 * The caller's own `public.User` row, created on first use.
 *
 * Settings is very often the first authenticated request an account ever
 * makes — someone signs up and immediately goes to pick a name — so this is
 * one of the routes that has to be able to bring the row into existence
 * rather than 404 on it. See `users.ts` in @qsim/db for why the row is created
 * here and not by a trigger.
 */
async function ownRow(
  app: FastifyInstance,
  request: FastifyRequest
): Promise<AccountUser> {
  const identity = request.auth
  // Unreachable on a route declaring `auth: 'required'`; throwing rather than
  // asserting keeps a policy mistake a 401 instead of a 500.
  if (identity === null) throw new ApiError('AUTH_REQUIRED')
  if (identity.email === null) throw new ApiError('USER_EMAIL_REQUIRED')

  await app.circuits.ensureOwner({
    id: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
  })

  const user = await app.circuits.findUserById(identity.userId)
  // Only reachable if the row was deleted between the two statements — the
  // caller deleting their account from a second tab.
  if (user === null) throw new ApiError('NOT_FOUND')
  return user
}

/**
 * The account row split into the two halves the contract keeps apart: the
 * public face, and the settings only its owner reads.
 *
 * Written out rather than spread, like `toChallengeResponse` and for the same
 * reason: this is the one row in the API whose projection deliberately carries
 * more than the public shape, so which half each column lands in is a decision
 * one function makes rather than a property of what Prisma happened to select.
 * `leaderboardOptOut` on the `user` half would ride into every circuit byline.
 */
function toAccountResponse(row: AccountUser) {
  const { leaderboardOptOut, ...user } = row
  return { user, leaderboardOptOut }
}

/**
 * What `avatarUrl` becomes for a chosen source.
 *
 * `provider` is the *verified* token's claim and nothing else, which is the
 * whole point — see the header. `generated` is `null`, and null is what
 * `apps/web` draws an identicon for.
 */
function avatarFor(
  source: AvatarSource,
  identity: VerifiedIdentity | null
): string | null {
  return source === 'provider' ? (identity?.avatarUrl ?? null) : null
}

const plugin: FastifyPluginCallback<UserRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  /*
   * The stricter budget of §11 on the two routes that change or destroy an
   * account. A username is a public address other people link to, and a
   * deletion is the one irreversible request in the product; neither is
   * something a legitimate client does in a loop.
   */
  const accountLimit = strictRateLimit(env)

  app.get(
    USER_ROUTES.profile,
    {
      // Anonymous by design: a profile is a page you send somebody.
      config: { auth: 'optional', scope: 'read' },
      schema: {
        params: UsernameParams,
        response: { 200: ProfileResponse },
      },
    },
    async (request) => {
      /*
       * Resolved through `publicUserSelect`, which has no `email` and cannot
       * acquire one. That is the projection's job rather than this handler's,
       * which is why the lookup does not go through a bare `findUnique`.
       */
      const user = await app.circuits.findUserByUsername(
        request.params.username
      )
      if (user === null) throw new ApiError('NOT_FOUND')

      const viewerId = viewerIdOf(request)
      // Both counts through the very filters the two listings use. See the
      // header: an aggregate is a listing.
      const [circuitCount, collectionCount] = await Promise.all([
        app.circuits.countPublished({
          viewerId,
          ownerId: user.id,
          // Irrelevant to a count and required by the query shape; the
          // ordering only matters once there is a cursor to compare against.
          sort: 'recent',
        }),
        app.circuits.countCollections({ ownerId: user.id, viewerId }),
      ])

      return { user, circuitCount, collectionCount }
    }
  )

  app.get(
    USER_ROUTES.collections,
    {
      config: { auth: 'optional', scope: 'read' },
      schema: {
        params: UsernameParams,
        querystring: PaginationQuery,
        response: { 200: CollectionPageResponse },
      },
    },
    async (request) => {
      const user = await app.circuits.findUserByUsername(
        request.params.username
      )
      if (user === null) throw new ApiError('NOT_FOUND')

      const { page, perPage } = request.query
      const { items, total } = await app.circuits.listCollections({
        ownerId: user.id,
        /*
         * The viewer decides which of this author's collections appear, and
         * the two arguments are separate on purpose: passing the owner as the
         * viewer would make every profile page show every private collection
         * on it.
         */
        viewerId: viewerIdOf(request),
        skip: (page - 1) * perPage,
        take: perPage,
      })
      return toPage(items, total, page, perPage)
    }
  )

  app.get(
    USER_ROUTES.me,
    {
      config: { auth: 'required' },
      schema: { response: { 200: AccountResponse } },
    },
    async (request) => toAccountResponse(await ownRow(app, request))
  )

  app.patch(
    USER_ROUTES.me,
    {
      config: { auth: 'required', rateLimit: accountLimit },
      schema: {
        body: UpdateProfileBody,
        response: { 200: AccountResponse },
      },
    },
    async (request) => {
      const current = await ownRow(app, request)
      const { avatar, ...changes } = request.body

      /*
       * A `UsernameTakenError` from here travels untouched: the unique index
       * decided rather than a prior lookup, and `toApiError` turns its `code`
       * into `USERNAME_TAKEN`, which `apps/web` says in three languages (§11,
       * D2). Catching it to rephrase would be inventing a sentence the API is
       * not allowed to send.
       */
      const user = await app.circuits.updateProfile({
        userId: current.id,
        ...changes,
        // Absent leaves the column alone; a source resolves to a value that
        // came from the token, or to null. Never to anything in the body.
        ...(avatar === undefined
          ? {}
          : { avatarUrl: avatarFor(avatar, request.auth) }),
      })
      return toAccountResponse(user)
    }
  )

  app.delete(
    USER_ROUTES.me,
    {
      config: { auth: 'required', rateLimit: accountLimit },
      schema: {
        body: DeleteAccountBody,
        response: { 200: AccountDeletionResponse },
      },
    },
    async (request) => {
      const viewerId = requireViewerId(request)
      const user = await app.circuits.findUserById(viewerId)
      /*
       * No `ensureOwner` here. Creating a row in order to delete it is a write
       * nobody asked for, and an account with no row has nothing to destroy —
       * 404 is the truth and it is what the next request would say too.
       */
      if (user === null) throw new ApiError('NOT_FOUND')

      /*
       * The confirmation is compared here rather than trusted from the client,
       * so a client cannot decide what counts as confirming. It is the
       * caller's own username — this API has never seen a password (§11
       * delegates that to Supabase) and the one irreversible route in the
       * product should not be reachable by a single mistyped request.
       */
      if (request.body.confirm !== user.username) {
        throw new ApiError('VALIDATION_FAILED', {
          details: [{ path: 'body.confirm', code: 'confirmation_mismatch' }],
        })
      }

      const deleted = await app.circuits.deleteAccount(user.id)
      return { deleted }
    }
  )

  done()
}

export const userRoutes = plugin
