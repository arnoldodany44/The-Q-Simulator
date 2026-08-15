import type { Prisma } from './generated/prisma/client.js'

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
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, username: true, avatarUrl: true } },
} satisfies Prisma.CircuitSelect

export type CircuitCard = Prisma.CircuitGetPayload<{
  select: typeof circuitCardSelect
}>

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

export type CircuitDetail = Prisma.CircuitGetPayload<{
  select: typeof circuitDetailSelect
}>

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
