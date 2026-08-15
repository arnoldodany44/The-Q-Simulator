import { Visibility } from './generated/prisma/client.js'
import type { Prisma } from './generated/prisma/client.js'

/**
 * The §11 visibility rules, as `where` fragments.
 *
 * Postgres row-level security does nothing for this project: Prisma connects
 * as the `postgres` role, which bypasses RLS. So "PRIVATE is verified on the
 * server" means the filter is in the query — and a route that forgets it does
 * not fail a test, it leaks. These helpers exist so a route composes a filter
 * instead of writing one, and so the rule itself can be asserted without a
 * database.
 *
 * The viewer is `null` for an anonymous caller, and otherwise the `sub` claim
 * of a *verified* token. Never pass an id that came from a request body or a
 * query parameter.
 */

/** `null` for an anonymous caller; otherwise the verified `sub` claim. */
export type ViewerId = string | null

/**
 * Circuits that may appear in a listing — the gallery, a profile page, a
 * search. PUBLIC for everyone, plus the viewer's own circuits whatever their
 * visibility, because their own private work is theirs to see.
 *
 * UNLISTED is deliberately absent: unlisted means reachable by whoever holds
 * the slug, not discoverable, and a listing is discovery.
 */
export function listableCircuitFilter(
  viewerId: ViewerId
): Prisma.CircuitWhereInput {
  if (viewerId === null) return { visibility: Visibility.PUBLIC }
  return { OR: [{ visibility: Visibility.PUBLIC }, { ownerId: viewerId }] }
}

/**
 * Circuits reachable when the caller already presented the exact slug, which
 * is what makes UNLISTED useful — a link you can send someone. The slug is a
 * `nanoid` with enough entropy that holding one is itself the credential
 * (§11), so this must be combined with a slug equality, never used alone.
 *
 * `circuitHandleFilter` is the only sanctioned way to do that combining.
 */
export function slugAddressableCircuitFilter(
  viewerId: ViewerId
): Prisma.CircuitWhereInput {
  const shared: Prisma.CircuitWhereInput[] = [
    { visibility: Visibility.PUBLIC },
    { visibility: Visibility.UNLISTED },
  ]
  if (viewerId === null) return { OR: shared }
  return { OR: [...shared, { ownerId: viewerId }] }
}

/**
 * Circuits reachable by their primary key, which is a narrower set than the
 * ones reachable by slug — the same set a listing may show.
 *
 * ── Why the id is not slug-equivalent ─────────────────────────────────────
 *
 * §8 addresses a circuit both ways, so both used to go through
 * `slugAddressableCircuitFilter` on the reasoning that "you cannot present
 * either handle without already holding one". That reasoning was wrong for
 * one specific reason: the API published ids. `Circuit.forkedFromId` rode out
 * in every card, so making a fork PUBLIC handed every anonymous reader a
 * working handle to the UNLISTED circuit it was forked from — readable
 * title, description, full version history and payload, with no way for the
 * owner to notice or revoke it, and un-publishing the source did not close it.
 *
 * The response no longer carries `forkedFromId`, and this is the other half:
 * even if an id escapes again — through a log, a POST response the caller
 * kept, a future field — it opens nothing that was not already public. The
 * slug remains the credential for UNLISTED, which is what its 126 bits were
 * sized for and what the id's ~41 bits of cuid randomness were not.
 */
export function idAddressableCircuitFilter(
  viewerId: ViewerId
): Prisma.CircuitWhereInput {
  return listableCircuitFilter(viewerId)
}

/**
 * The complete `where` for "the circuit this handle names, if this viewer may
 * see it" — slug or id, with the right rule applied to each.
 *
 * Built here rather than in the repository so that the Prisma implementation
 * and the in-memory one used by the API's route tests are deciding with the
 * same fragment rather than with two descriptions of it.
 */
export function circuitHandleFilter(
  handle: string,
  viewerId: ViewerId
): Prisma.CircuitWhereInput {
  return {
    OR: [
      { AND: [{ slug: handle }, slugAddressableCircuitFilter(viewerId)] },
      { AND: [{ id: handle }, idAddressableCircuitFilter(viewerId)] },
    ],
  }
}

/**
 * Write access, which visibility has nothing to do with: a PUBLIC circuit is
 * readable by everyone and editable by its owner alone. Forking is how
 * somebody else builds on it.
 */
export function canEditCircuit(
  circuit: { ownerId: string },
  viewerId: ViewerId
): boolean {
  return viewerId !== null && circuit.ownerId === viewerId
}
