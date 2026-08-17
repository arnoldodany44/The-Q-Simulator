import type { CircuitPreview } from '@qsim/schema'
import { parseStoredPreview } from './circuit-data.js'
import type { Prisma } from './generated/prisma/client.js'
import { MAX_TAGS_PER_CIRCUIT } from './tags.js'

/**
 * Column projections, paired with the type they produce.
 *
 * Each `select` object is a value the query passes to Prisma, and the type
 * beside it is derived from that same value with `CircuitGetPayload`. So the
 * type cannot describe a column the query does not fetch, and adding a column
 * to the projection widens the type in the same edit. That is the whole
 * point: the alternative is a hand-written interface that drifts from the
 * select it claims to describe, and drifts silently, because both sides
 * compile fine.
 */

/**
 * What a gallery card needs and nothing more. The `description` is absent on
 * purpose — it is `@db.Text` and a listing of fifty circuits does not need
 * fifty essays crossing the wire.
 *
 * Every counter here is denormalised on `Circuit` (§7), which is why sorting
 * the gallery by stars touches one table and no joins.
 */
export const circuitCardSelect = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  qubitCount: true,
  gateCount: true,
  depth: true,
  starCount: true,
  viewCount: true,
  /*
   * Fetched for the server's own use — attribution, and the fork graph a
   * later phase will render — and never serialised. It is a handle to a
   * different circuit with a different visibility, and the response schemas in
   * @qsim/contract deliberately do not mention it, so Fastify's serialiser
   * drops it. See the note on `CircuitCardResponse` for the hole that taught
   * us this.
   */
  forkedFromId: true,
  /*
   * The thumbnail (M1.5b). Selected here rather than joined from the head
   * version, which is the whole reason the column exists: a listing of fifty
   * circuits drawing fifty diagrams would otherwise read fifty documents of up
   * to 256 KiB each. See the note on `Circuit.preview` in schema.prisma.
   *
   * It carries no visibility question. Unlike `forkedFromId` it is not a
   * handle to another row — it is a lossy drawing of *this* circuit, derived
   * from the same document the rest of this projection describes.
   */
  preview: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, username: true, avatarUrl: true } },
  /*
   * The gallery filters by tag (§8), so a card that could not show its tags
   * would be a facet nobody can see they are inside. Unlike `forkedFromId` a
   * tag is a property of *this* circuit — it carries no handle to a row with a
   * different visibility, so there is nothing here to leak.
   *
   * `take` states the bound in the query rather than assuming it. It used to
   * say only that "the join is bounded by MAX_TAGS_PER_CIRCUIT", which was a
   * claim about a constant nothing enforced: concurrent replacements really
   * did leave 32 rows on one circuit, and every card in a fifty-row listing
   * would have read and serialised all of them. `setCircuitTags` now holds the
   * bound on the write side; this is what keeps a listing cheap even for a row
   * written before it did.
   */
  tags: {
    select: { tag: { select: { name: true } } },
    take: MAX_TAGS_PER_CIRCUIT,
  },
} satisfies Prisma.CircuitSelect

/** What the query returns, with the join table still visible in the shape. */
export type CircuitCardRow = Prisma.CircuitGetPayload<{
  select: typeof circuitCardSelect
}>

/**
 * A card as everything above the repository wants it: tags as plain names, and
 * the thumbnail already through its parser rather than as the `JsonValue`
 * Prisma has to call it.
 *
 * Both conversions happen here rather than in a route because both
 * implementations of the repository — Prisma and the in-memory one the API
 * tests drive — have to produce the same shape, and a mapping done twice is a
 * mapping that will one day differ.
 */
export interface CircuitCard extends Omit<CircuitCardRow, 'tags' | 'preview'> {
  readonly tags: string[]
  /** `null` for a row written before M1.5b, and for one that will not parse. */
  readonly preview: CircuitPreview | null
}

/**
 * One circuit on its own page: the card plus the two columns a listing has
 * no use for.
 *
 * `ownerId` is here and absent from the card on purpose. It is the input to
 * `canEditCircuit`, and every route that decides whether the caller may write
 * needs it — spelling it as `owner.id` would work too, but a nested read is
 * exactly the kind of thing a refactor drops, and dropping it turns an
 * authorisation check into `undefined === undefined`.
 */
export const circuitDetailSelect = {
  ...circuitCardSelect,
  ownerId: true,
  description: true,
} satisfies Prisma.CircuitSelect

export type CircuitDetailRow = Prisma.CircuitGetPayload<{
  select: typeof circuitDetailSelect
}>

export interface CircuitDetail extends Omit<
  CircuitDetailRow,
  'tags' | 'preview'
> {
  readonly tags: string[]
  readonly preview: CircuitPreview | null
}

/**
 * Sorted, so two requests for the same circuit never disagree about the order
 * of its tags — which would otherwise show up as a flickering card and as an
 * intermittent test.
 */
function tagNames(row: { tags: { tag: { name: string } }[] }): string[] {
  return row.tags.map((entry) => entry.tag.name).sort()
}

export function toCircuitCard(row: CircuitCardRow): CircuitCard {
  return {
    ...row,
    tags: tagNames(row),
    preview: parseStoredPreview(row.preview),
  }
}

export function toCircuitDetail(row: CircuitDetailRow): CircuitDetail {
  return {
    ...row,
    tags: tagNames(row),
    preview: parseStoredPreview(row.preview),
  }
}

/**
 * The public face of a user: what a profile page and a circuit byline show.
 * `email` is absent, and that is a rule rather than an oversight — it is the
 * one column on `User` that must never reach another user's browser.
 */
export const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  createdAt: true,
} satisfies Prisma.UserSelect

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect
}>

/**
 * The caller's own row: the public face plus the preferences only its owner
 * has any business reading.
 *
 * ── Why this is not a second projection in the sense §8 rules out ─────────
 *
 * `accounts.ts` argues that there is one user projection and that it has no
 * `email`, so that no future handler can pick the wrong one. This does not
 * reopen that: it is `publicUserSelect` *spread*, so it inherits every column
 * that one has and cannot acquire one it does not — in particular it cannot
 * grow an `email` without the shared constant growing one first.
 *
 * What it adds is a setting, and a setting is not a public fact about
 * somebody. `leaderboardOptOut` on the shared projection would ride along in
 * every circuit byline and every profile, publishing a preference that only
 * its owner and the leaderboard query have a use for. The three routes that
 * select through this — `GET`, `PATCH` and `DELETE /me` — are the three that
 * require a session and act on the caller's own row.
 */
export const accountSelect = {
  ...publicUserSelect,
  leaderboardOptOut: true,
} satisfies Prisma.UserSelect

export type AccountUser = Prisma.UserGetPayload<{
  select: typeof accountSelect
}>

/**
 * A collection as a listing shows it — M1.9.
 *
 * `ownerId` is present for the same reason it is on `circuitDetailSelect` and
 * absent from `circuitCardSelect`: it is the input to `canEditCollection`, and
 * every route that decides whether the caller may write needs it in hand.
 * Unlike a circuit card, a collection card is never long enough for that to
 * cost anything, and a listing that had to re-read the row to find out who
 * owns it would be a second query per card.
 *
 * `_count.items` is the *stored* number of items, which is not the number a
 * stranger will be shown: the items themselves go through
 * `listableCircuitFilter`, so the two differ exactly when a collection holds
 * something the viewer may not see. Both numbers are reported, and the
 * difference between them is the withheld count — see `collections.ts`.
 */
export const collectionCardSelect = {
  id: true,
  ownerId: true,
  title: true,
  description: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, username: true, avatarUrl: true } },
  _count: { select: { items: true } },
} satisfies Prisma.CollectionSelect

export type CollectionCardRow = Prisma.CollectionGetPayload<{
  select: typeof collectionCardSelect
}>

/** A card with the join-table shape flattened into one number. */
export interface CollectionCard extends Omit<CollectionCardRow, '_count'> {
  /**
   * How many items the collection holds, counted in the database and
   * therefore including the ones this viewer may not see. It is a count and
   * never a handle: it names no circuit, so it cannot be a way to reach one.
   */
  readonly itemCount: number
}

export function toCollectionCard(row: CollectionCardRow): CollectionCard {
  const { _count, ...rest } = row
  return { ...rest, itemCount: _count.items }
}

/**
 * A version as the history sidebar lists it: metadata only. `data` is the
 * whole circuit and is fetched one version at a time, when something is
 * actually going to render or run it.
 */
export const circuitVersionSummarySelect = {
  id: true,
  versionNum: true,
  message: true,
  createdAt: true,
} satisfies Prisma.CircuitVersionSelect

export type CircuitVersionSummary = Prisma.CircuitVersionGetPayload<{
  select: typeof circuitVersionSummarySelect
}>

/**
 * Hardware credential metadata. §11: the read endpoint returns provider,
 * label and date — never `encryptedToken`, never `iv`. Selecting through this
 * constant is how that stays true when someone adds a column later.
 */
export const hardwareCredentialMetaSelect = {
  id: true,
  provider: true,
  label: true,
  createdAt: true,
} satisfies Prisma.HardwareCredentialSelect

export type HardwareCredentialMeta = Prisma.HardwareCredentialGetPayload<{
  select: typeof hardwareCredentialMetaSelect
}>

/**
 * An API key's metadata — §3.5. The sibling of the constant above, and here
 * beside it for the same reason: it is a projection whose *whole job* is what
 * it cannot fetch.
 *
 * `keyHash` is not named, so the query that serves every listing and every
 * mutation response is incapable of loading it. That matters less than it does
 * next door — a SHA-256 of 256 random bits is not a credential and cannot be
 * turned back into one — and it is still the right shape, because "the read
 * endpoint cannot reach the secret material" is a property worth being able to
 * state about a credentials table without qualification.
 *
 * `keyPrefix` *is* named, and is the one deliberate exception: ten characters
 * of the key in the clear, which is what lets a person tell two rows apart
 * well enough to revoke the right one. The argument for why that is a
 * disclosure worth making — and why it is not the "last four" convention this
 * project refuses for hardware tokens — is in `@qsim/contract`'s `api-keys.ts`.
 */
export const apiKeyMetaSelect = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} satisfies Prisma.ApiKeySelect

export type ApiKeyMeta = Prisma.ApiKeyGetPayload<{
  select: typeof apiKeyMetaSelect
}>
