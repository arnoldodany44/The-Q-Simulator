import { randomInt } from 'node:crypto'
import type { User } from './generated/prisma/client.js'
import {
  isUniqueConstraintError,
  uniqueConstraintTargets,
} from './prisma-errors.js'

/**
 * Creating the `public.User` row for a Supabase identity.
 *
 * ── The decision ──────────────────────────────────────────────────────────
 *
 * There were two ways to make a row appear when someone first signs in: a
 * Postgres trigger on `auth.users`, or the backend upserting on the first
 * authenticated request. This package does the second, and the reason is not
 * ergonomics.
 *
 * A trigger has to live in, or reach into, the `auth` schema — the schema
 * Supabase owns and this project has ruled out of Prisma's reach entirely
 * (§7, §12.6). That has three consequences that compound:
 *
 *   1. It cannot be expressed in the Prisma datamodel, so it would need a
 *      hand-written SQL migration that Prisma neither generates nor verifies.
 *   2. Because Prisma cannot see it, it drifts silently. `migrate diff`
 *      compares datamodel to database and would report "no changes" whether
 *      the trigger is there, altered, or gone. The failure surfaces days
 *      later as a foreign-key violation on someone's first save.
 *   3. Supabase upgrades and restores replay their own `auth` schema. A
 *      trigger attached to their table is a hostage to their migrations.
 *
 * And the cost of the alternative is small and bounded: one primary-key
 * lookup on requests that were already going to hit the database, on a
 * connection that is already open. Only the very first request for a given
 * identity does a write.
 *
 * The trade the trigger would win is a user who signs up and never calls the
 * API: they get an `auth.users` row and no `public.User` row. That is fine —
 * a profile with no activity is not a state anything reads.
 *
 * ── The concurrency argument ──────────────────────────────────────────────
 *
 * Two requests can arrive from the same new identity at the same moment (a
 * page that fires two queries on mount is enough), and both will see no row.
 * Both then insert, and the primary key — which is Supabase's UUID, not a
 * value we generate — makes exactly one of them win. The loser is told
 * P2002, re-reads by id, and returns the winner's row. There is no window in
 * which two rows can exist, because the uniqueness is enforced by Postgres
 * rather than by our check.
 *
 * That is also why the P2002 handler re-reads *before* it inspects which
 * constraint fired: the id conflict is the case that matters and it must be
 * recognised even if the error's `meta.target` is missing or in a shape we
 * did not anticipate.
 */

/** The claims `ensureUser` needs, all of them from the verified JWT. */
export interface SupabaseIdentity {
  /** The `sub` claim: Supabase's UUID for this user. Becomes `User.id`. */
  id: string
  /** The `email` claim. */
  email: string
  displayName?: string | null
  avatarUrl?: string | null
}

/**
 * The slice of PrismaClient `ensureUser` touches. Narrow on purpose: it
 * documents that this function reads and inserts one table and does nothing
 * else, and it lets the retry logic be tested against a fake in-memory table
 * rather than against the project's only database.
 */
export interface UserStore {
  user: {
    findUnique(args: { where: { id: string } }): PromiseLike<User | null>
    create(args: { data: NewUserData }): PromiseLike<User>
  }
}

export interface NewUserData {
  id: string
  email: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

/**
 * Raised when a *different* Supabase identity already holds this email.
 * Supabase enforces one account per email, so in practice this means the
 * `public.User` row is stale — an account was deleted from `auth` and
 * recreated. Surfacing it as its own error keeps that case from being
 * papered over by returning somebody else's row, which would be an account
 * takeover.
 *
 * `code` is what the API sends to the client; §11 wants a machine-readable
 * token the web app translates, never an English sentence.
 */
export class UserIdentityConflictError extends Error {
  readonly code = 'USER_EMAIL_ALREADY_LINKED'

  constructor(readonly userId: string) {
    super(`Another user row already holds the email for identity ${userId}`)
    this.name = 'UserIdentityConflictError'
  }
}

/** Raised when several suffixed usernames in a row were all taken. */
export class UsernameUnavailableError extends Error {
  readonly code = 'USERNAME_UNAVAILABLE'

  constructor(readonly attempted: number) {
    super(`Could not find a free username after ${attempted} attempts`)
    this.name = 'UsernameUnavailableError'
  }
}

const MIN_USERNAME_LENGTH = 3
const MAX_USERNAME_LENGTH = 32
/** Leaves room for `-` plus `SUFFIX_LENGTH` characters inside the maximum. */
const MAX_BASE_USERNAME_LENGTH = MAX_USERNAME_LENGTH - 5
const SUFFIX_LENGTH = 4
const MAX_USERNAME_ATTEMPTS = 6

/**
 * Ambiguous glyphs are absent on purpose: a username is something people
 * read off someone else's screen and retype.
 */
const SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

/** The stem for an identity with nothing usable to build a handle from. */
const GENERIC_USERNAME_STEM = 'user'

/**
 * A first guess at a username, derived from the *display name*.
 *
 * ── Why not the email ─────────────────────────────────────────────────────
 *
 * It used to be the email's local part, and `ensureUser` used that base
 * unsuffixed on the first insert — so the first account with a given local
 * part got it verbatim. `username` is in `OwnerRef`, `OwnerRef` is in every
 * circuit card and detail response, and `GET /circuits/:id` is `auth:
 * 'optional'`. An anonymous reader of any PUBLIC circuit therefore learned
 * the owner's email local part, and with a guessed or known domain that is a
 * working address. It also became a permanent public URL
 * (`/users/:username/circuits`, §8) that the owner never chose.
 *
 * The specification asks for `username String @unique` and nothing more; it
 * does not ask for it to be a reversible function of the credential someone
 * signed up with. A display name is the opposite case: the user supplied it
 * *to be displayed*.
 *
 * An address that arrives as a display name — some providers fill `full_name`
 * with the email when the account has no name — is refused rather than
 * folded, because folding `@` into a hyphen would reintroduce exactly what
 * this function exists to avoid.
 *
 * Deliberately lossy otherwise: it lowercases, folds anything outside
 * `[a-z0-9_-]` into a hyphen, and collapses runs, because the result goes in
 * a URL and has to survive being typed by hand. Uniqueness is not this
 * function's job; the caller adds the suffix.
 */
export function baseUsernameFrom(displayName: string | null): string {
  if (displayName === null || displayName.includes('@')) {
    return GENERIC_USERNAME_STEM
  }

  const folded = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE_USERNAME_LENGTH)

  // A name that folds away to nothing, or to one or two characters, is not
  // worth showing. Both get the generic stem and take their identity from the
  // suffix.
  return folded.length >= MIN_USERNAME_LENGTH ? folded : GENERIC_USERNAME_STEM
}

/** `alice` → `alice-7fk2`. Pure; the randomness is the caller's. */
export function withUsernameSuffix(base: string, suffix: string): string {
  return `${base}-${suffix}`
}

function randomSuffix(): string {
  let out = ''
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    out += SUFFIX_ALPHABET.charAt(randomInt(SUFFIX_ALPHABET.length))
  }
  return out
}

/** The unique constraints on `User` that an insert can trip. */
export type UserUniqueField = 'id' | 'email' | 'username'

/**
 * The names a violated `User` constraint can arrive under: the column, or
 * the Postgres index identifier. Which one a given Prisma configuration
 * reports is not stable — see `prisma-errors.ts`, which reads all of them.
 */
const USER_UNIQUE_CONSTRAINTS: Record<UserUniqueField, readonly string[]> = {
  id: ['id', 'User_pkey'],
  email: ['email', 'User_email_key'],
  username: ['username', 'User_username_key'],
}

/**
 * Which unique constraint a P2002 refers to, or `null` when the error does
 * not say. `null` is a real answer and callers must handle it — see the
 * re-read in `ensureUser`.
 *
 * Matched exactly first. Only if that finds nothing is the loose pass tried,
 * and only against the index identifiers — a whole driver message contains
 * the word `id`, so matching the bare column name inside prose would answer
 * "the primary key" for every conflict there is.
 */
export function uniqueConflictField(error: unknown): UserUniqueField | null {
  const targets = uniqueConstraintTargets(error)
  if (targets.length === 0) return null

  for (const [field, names] of Object.entries(USER_UNIQUE_CONSTRAINTS)) {
    if (targets.some((target) => names.includes(target))) {
      return field as UserUniqueField
    }
  }
  for (const [field, names] of Object.entries(USER_UNIQUE_CONSTRAINTS)) {
    const identifiers = names.filter((name) => name.startsWith('User_'))
    if (
      targets.some((target) =>
        identifiers.some((identifier) => target.includes(identifier))
      )
    ) {
      return field as UserUniqueField
    }
  }
  return null
}

/**
 * Returns the `public.User` row for a verified identity, creating it on the
 * first authenticated request. Idempotent, and safe to call concurrently.
 *
 * @throws {UserIdentityConflictError} if another id already holds the email.
 * @throws {UsernameUnavailableError} if every suffixed candidate was taken.
 */
export async function ensureUser(
  store: UserStore,
  identity: SupabaseIdentity
): Promise<User> {
  // The fast path, and the one nearly every request takes: a single lookup
  // on the primary key.
  const existing = await store.user.findUnique({ where: { id: identity.id } })
  if (existing !== null) return existing

  /*
   * Suffixed from the first attempt, not only after a collision. Two reasons,
   * and the second is the one that matters: an unsuffixed base is a handle a
   * stranger can *predict* from a name they already know, and a name is not a
   * secret but "is Ada Lovelace on this site" should not be answerable by
   * typing a URL. The first reason is ordinary — with a display-name stem,
   * collisions are common rather than rare, and starting from the suffixed
   * form removes a guaranteed wasted insert for every second Ada.
   */
  const base = baseUsernameFrom(identity.displayName ?? null)
  let username = withUsernameSuffix(base, randomSuffix())

  for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt += 1) {
    try {
      return await store.user.create({
        data: {
          id: identity.id,
          email: identity.email,
          username,
          displayName: identity.displayName ?? null,
          avatarUrl: identity.avatarUrl ?? null,
        },
      })
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error

      // Ask the database before asking the error. If a row with our id now
      // exists, a concurrent first request created it and this is the loser
      // of that race — which is a success, not a failure, and is recognised
      // here without depending on how the error names its constraint.
      const winner = await store.user.findUnique({
        where: { id: identity.id },
      })
      if (winner !== null) return winner

      const field = uniqueConflictField(error)
      if (field === 'username') {
        username = withUsernameSuffix(base, randomSuffix())
        continue
      }
      if (field === 'email') throw new UserIdentityConflictError(identity.id)
      throw error
    }
  }

  throw new UsernameUnavailableError(MAX_USERNAME_ATTEMPTS)
}
