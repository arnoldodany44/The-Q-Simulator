import type { PrismaClient } from './generated/prisma/client.js'
import { isUniqueConstraintError } from './prisma-errors.js'
import { accountSelect } from './projections.js'
import type { AccountUser } from './projections.js'
import { uniqueConflictField } from './users.js'

/**
 * The account itself — settings, and deleting it. Milestone M1.9.
 *
 * ── Why there is no second user projection ────────────────────────────────
 *
 * `GET /me` answers with `accountSelect`, which is `publicUserSelect` — the
 * same columns a stranger reading a profile gets, and in particular *without*
 * `email` — spread and widened by the settings that belong to the caller
 * alone. That `email` is absent looks like an oversight and it is the design:
 * the caller already knows their own address — it is a claim in the token they
 * authenticated with, and `apps/web` reads it off the Supabase session — so
 * returning it buys nothing and costs the one invariant this schema is easiest
 * to break by accident. Because the wider projection is written as a spread of
 * the narrower one, there is still exactly one place a user column is listed,
 * and no future edit can give either of them an address without giving it to
 * both at once.
 *
 * ── What a setting is doing on the account row ────────────────────────────
 *
 * `leaderboardOptOut` (Phase 3) is here rather than on `publicUserSelect`
 * because it is a preference and not a public fact: on the shared projection
 * it would ride along in every circuit byline and every profile page, telling
 * strangers something they have no use for. The three routes that read this
 * projection are the three that require a session and act on the caller's own
 * row.
 *
 * ── What a username change is ─────────────────────────────────────────────
 *
 * A username is a public address (`/users/:username`, §8) and it is unique.
 * Both facts are the whole of the problem:
 *
 *   - **Uniqueness without a race.** There is no check-then-write here.
 *     `updateProfile` writes and lets `User_username_key` decide, then
 *     translates the constraint violation into a refusal the client can act
 *     on. A "is this taken?" query followed by an update has a window two
 *     simultaneous requests fit inside, and the loser gets a 500 from a
 *     driver instead of an answer.
 *   - **Without leaking more than a profile already does.** There is
 *     deliberately no availability endpoint. `GET /users/:username` already
 *     tells anybody whether a handle belongs to somebody — that is what a
 *     public profile *is* — so the refusal below says exactly the same thing
 *     and no more: it is reachable only by a signed-in caller changing their
 *     own handle, it costs a write, it is rate-limited like every other write,
 *     and it says "taken" without saying by whom. A dedicated lookup would
 *     turn that into an unauthenticated, cheap, scriptable oracle over the
 *     whole table, which is a different thing wearing the same information.
 *
 * ── Deleting an account, and the four columns with no foreign key ─────────
 *
 * `ON DELETE CASCADE` from `User` removes circuits, versions, tags, stars,
 * comments, collections, collection items, hardware credentials, challenge
 * submissions and API keys. It does not remove everything, and the gaps are
 * not accidents — §7 leaves four columns pointing at rows with no foreign key
 * behind them, and each one is a row that would survive its subject:
 *
 *   1. `SimulationRun.userId`  — a run outlives the circuit it ran (SET NULL),
 *      and with no key on the user it would outlive the user too, leaving a
 *      record attributed to an id nobody can resolve.
 *   2. `HardwareJob.userId`    — the same, for a job submitted against
 *      somebody else's circuit. Jobs on the user's own circuits go by cascade
 *      from `Circuit`; these do not.
 *   3. `CollectionItem.circuitId` — in *anybody's* collection. Cascade removes
 *      the items of the deleted user's own collections; a row in a stranger's
 *      collection naming a circuit that has just ceased to exist is left
 *      pointing at nothing, and would be counted as "withheld" forever.
 *   4. `Comment.parentId`      — a reply by somebody else to a comment that
 *      cascade is about to remove.
 *
 * Plus one thing no foreign key was ever going to do: `Circuit.starCount` is
 * denormalised (§7), so cascading away a `Star` row leaves a count that is too
 * high on somebody else's circuit. `unstar` already documents that this was
 * coming.
 *
 * So the delete is a sequence, in a transaction, and the order matters: what
 * cascade is about to destroy has to be *read* before it is destroyed, because
 * afterwards there is nothing left to find the orphans by.
 *
 * ── What this deliberately does not do: the Supabase identity ─────────────
 *
 * The row in `auth.users` is not touched, and the account can therefore sign
 * in again — into a brand-new, empty account, since `ensureUser` will create a
 * fresh `public.User` row with a fresh username on the next request. Every
 * byte the user created is gone; the credential is not.
 *
 * That is a decision and not an omission. Removing an identity requires
 * Supabase's admin API and therefore the service-role key in this process —
 * a credential that can impersonate any user and read every table, and one
 * this service has so far never held: it verifies tokens against a *public*
 * JWKS (§11) and holds no Supabase secret at all. Acquiring it for one route
 * changes the blast radius of the entire API, and it brings an ordering
 * problem with no good answer at this size: delete the identity first and a
 * failure here leaves rows nobody can ever reach again, delete it second and a
 * failure there leaves a credential for an account with nothing in it. The
 * second is the recoverable one and it is what happens now, every time, by
 * construction.
 *
 * When the service does need that key for something else, this becomes a
 * second step after the transaction commits, and the failure mode is already
 * the benign one.
 */

/** Raised when the requested username belongs to somebody else. */
export class UsernameTakenError extends Error {
  readonly code = 'USERNAME_TAKEN'

  constructor(readonly username: string) {
    super(`Username ${username} is already taken`)
    this.name = 'UsernameTakenError'
  }
}

export interface UpdateProfileInput {
  readonly userId: string
  /** Absent leaves it alone; `null` clears it. Two different requests. */
  readonly displayName?: string | null
  readonly username?: string
  /**
   * Absent leaves it alone; `null` clears it, which is how a user asks for the
   * generated picture instead.
   *
   * A *string* here only ever comes from the verified token's own claim —
   * `apps/api` reads it off `request.auth`, never off the request body. An
   * arbitrary URL accepted from a caller would be rendered by every other
   * reader's browser, which makes it a way to log who looked at a profile, and
   * `verify.ts` already had to restrict the scheme of the claim for the same
   * family of reasons.
   */
  readonly avatarUrl?: string | null
  /**
   * "Do not print my name on a challenge leaderboard" (§3.6, Phase 3). Absent
   * leaves it alone, like every other field here.
   *
   * It withdraws the *row* from the listing and not the result from the
   * standings — see `challenges.ts`, which ranks first and filters afterwards
   * — so setting it cannot move anybody else up, and the person who set it can
   * still see where they stand.
   */
  readonly leaderboardOptOut?: boolean
}

/**
 * What a deletion actually removed. Counts only — the point of the report is
 * that the interface can tell the user what happened rather than saying
 * "done".
 */
export interface AccountDeletionReport {
  readonly circuits: number
  readonly collections: number
  readonly comments: number
  readonly stars: number
  readonly simulationRuns: number
  readonly hardwareJobs: number
  /**
   * Rows removed from *other people's* collections because they named a
   * circuit this account owned. Reported separately because it is the only
   * number here that describes a change to somebody else's data.
   */
  readonly orphanedCollectionItems: number
}

/**
 * How many rounds the reply sweep will walk before it stops.
 *
 * `Comment.parentId` has no foreign key, so removing a comment can orphan its
 * replies, and removing those can orphan theirs. The sweep is breadth-first
 * and terminates when a round finds nothing, which is the ordinary case; the
 * cap is what stops a pathological thread from holding open a transaction on
 * the only database connection this process has.
 *
 * Thirty-two is unreachable today for a plain reason: there is no comment
 * route in this API at all, so the table is empty. The real fix belongs to the
 * milestone that adds them — a foreign key `parentId → Comment.id` with
 * `ON DELETE CASCADE`, after which this sweep is dead code and should be
 * deleted rather than kept.
 */
const MAX_REPLY_SWEEP_ROUNDS = 32

/**
 * Transaction bounds, matching `circuits.ts`: the pooler budget is one
 * connection, so waiting is better than failing, and a transaction that
 * actually runs this long is holding up everything behind it.
 */
const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 20_000 } as const

export interface AccountRepository {
  /** The caller's own row, by id. `null` if `ensureUser` has never run. */
  findUserById(id: string): Promise<AccountUser | null>

  /**
   * @throws {UsernameTakenError} when the username belongs to another row.
   */
  updateProfile(input: UpdateProfileInput): Promise<AccountUser>

  /**
   * Destroys every row in `public` belonging to this user, including the ones
   * no foreign key would have reached. See the header for what survives and
   * why.
   */
  deleteAccount(userId: string): Promise<AccountDeletionReport>
}

export function prismaAccountRepository(
  prisma: PrismaClient
): AccountRepository {
  return {
    findUserById(id) {
      return prisma.user.findUnique({ where: { id }, select: accountSelect })
    },

    async updateProfile({ userId, ...changes }) {
      try {
        return await prisma.user.update({
          where: { id: userId },
          data: changes,
          select: accountSelect,
        })
      } catch (error) {
        /*
         * The write decided, not a prior read. `User_username_key` is what
         * makes two people unable to hold one handle, and translating its
         * violation here is what turns a race into an answer rather than into
         * a 500 from a driver.
         */
        if (
          isUniqueConstraintError(error) &&
          uniqueConflictField(error) === 'username' &&
          changes.username !== undefined
        ) {
          throw new UsernameTakenError(changes.username)
        }
        throw error
      }
    },

    deleteAccount(userId) {
      return prisma.$transaction(async (tx) => {
        /*
         * Step 1 — read what the cascades are about to make unfindable.
         *
         * Every orphan below is identified by an id that only exists while its
         * subject does, so all of this has to happen before the `User` row
         * goes. Doing it afterwards is the version of this function that
         * appears to work and quietly leaves rows behind.
         */
        const circuits = await tx.circuit.findMany({
          where: { ownerId: userId },
          select: { id: true },
        })
        const circuitIds = circuits.map((row) => row.id)

        const collections = await tx.collection.count({
          where: { ownerId: userId },
        })

        const starred = await tx.star.findMany({
          where: { userId },
          select: { circuitId: true },
        })

        const ownComments = await tx.comment.findMany({
          where: { userId },
          select: { id: true },
        })

        /*
         * Step 2 — the denormalised counter no key maintains.
         *
         * `Star` rows cascade away and nothing decrements `Circuit.starCount`,
         * so every circuit this user starred would keep a star that no longer
         * exists. One statement rather than one per row: the composite primary
         * key `(userId, circuitId)` means this user contributed at most one
         * star to each of these circuits, so a single decrement is exactly
         * right. `starCount > 0` is the floor `unstar` already relies on —
         * too high is cosmetic, negative is a number no interface can draw.
         */
        const starredIds = starred.map((row) => row.circuitId)
        if (starredIds.length > 0) {
          await tx.circuit.updateMany({
            where: { id: { in: starredIds }, starCount: { gt: 0 } },
            data: { starCount: { decrement: 1 } },
          })
        }

        /*
         * Step 3 — `CollectionItem.circuitId`, which has no foreign key.
         *
         * Scoped by circuit id and *not* by collection, because the rows that
         * matter are the ones in other people's collections: this user's own
         * collections cascade away whole. Without this, a stranger's
         * collection keeps a row naming a circuit that no longer exists, and
         * `readCollectionItems` counts it as withheld forever — a permanent
         * "there is something here you cannot see" about nothing.
         */
        const orphanedItems =
          circuitIds.length === 0
            ? { count: 0 }
            : await tx.collectionItem.deleteMany({
                where: { circuitId: { in: circuitIds } },
              })

        /*
         * Step 4 — replies to comments cascade is about to remove.
         *
         * `Comment.parentId` has no foreign key either, so a reply by somebody
         * else to one of this user's comments would be left pointing at
         * nothing. Breadth-first, because a reply can have replies.
         */
        let frontier = ownComments.map((row) => row.id)
        let replies = 0
        for (
          let round = 0;
          round < MAX_REPLY_SWEEP_ROUNDS && frontier.length > 0;
          round += 1
        ) {
          const children = await tx.comment.findMany({
            where: { parentId: { in: frontier } },
            select: { id: true },
          })
          const ids = children.map((row) => row.id)
          if (ids.length === 0) break
          const removed = await tx.comment.deleteMany({
            where: { id: { in: ids } },
          })
          replies += removed.count
          frontier = ids
        }

        /*
         * Step 5 — the two `userId` columns with no key behind them. A record
         * of something that happened survives its circuit by design (§7); it
         * must not survive the person it is attributed to.
         */
        const runs = await tx.simulationRun.deleteMany({ where: { userId } })
        const jobs = await tx.hardwareJob.deleteMany({ where: { userId } })

        // Step 6 — the row itself. Everything with a key on it goes here.
        await tx.user.delete({ where: { id: userId } })

        return {
          circuits: circuitIds.length,
          collections,
          // The user's own, which cascade removes, plus the replies swept
          // above — both are comments this deletion destroyed.
          comments: ownComments.length + replies,
          stars: starred.length,
          simulationRuns: runs.count,
          hardwareJobs: jobs.count,
          orphanedCollectionItems: orphanedItems.count,
        }
      }, TRANSACTION_OPTIONS)
    },
  }
}
