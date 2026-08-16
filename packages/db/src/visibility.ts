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

/*
 * ── Collections (M1.9) ────────────────────────────────────────────────────
 *
 * The same three rules over a different table, written as their own fragments
 * rather than reused generically. A `where` fragment is typed against the
 * model it filters, and a shared helper that produced `{ visibility }` for
 * "whatever row this is" would be a helper that could be applied to the wrong
 * one and still compile.
 *
 * What a collection's visibility governs is the *collection*, never its
 * contents. A PUBLIC collection holding a PRIVATE circuit publishes the
 * collection and not the circuit: the items are read through
 * `listableCircuitFilter` like every other listing (see `collections.ts`), so
 * being inside a public group can never be a way to see something that would
 * otherwise be refused. That is the one rule this pair of models exists to get
 * right, and it is deliberately not expressible here — a filter over
 * `Collection` cannot say anything about a `Circuit`.
 */

/**
 * Collections that may appear in a listing — a profile page, the owner's own
 * index. PUBLIC for everyone, plus the viewer's own whatever their visibility.
 *
 * UNLISTED is absent for the same reason it is absent from
 * `listableCircuitFilter`: a listing is discovery, and unlisted means
 * reachable by whoever holds the link.
 */
export function listableCollectionFilter(
  viewerId: ViewerId
): Prisma.CollectionWhereInput {
  if (viewerId === null) return { visibility: Visibility.PUBLIC }
  return { OR: [{ visibility: Visibility.PUBLIC }, { ownerId: viewerId }] }
}

/**
 * The complete `where` for "the collection this id names, if this viewer may
 * open it".
 *
 * ── Why an id reaches an UNLISTED collection when it does not reach an
 * UNLISTED circuit ────────────────────────────────────────────────────────
 *
 * `idAddressableCircuitFilter` refuses UNLISTED, and the argument written
 * there is specific: the API *published* circuit ids to people who could not
 * read the circuit those ids named — `forkedFromId` rode out in every card —
 * so an id had escaped to callers who were never given one deliberately.
 *
 * Neither half of that applies to a collection. It has no slug, so its id is
 * the only handle it has and "reachable by whoever holds the link" would
 * otherwise mean nothing at all; and no response anywhere in this API carries
 * a collection id belonging to a collection the reader may not list — there is
 * no `forkedFromId` equivalent, and `CollectionItem` never travels as a
 * handle. The entropy is there for it: `@default(cuid(2))` is a hash of
 * randomness with no timestamp and no counter in it, in the same class as the
 * `nanoid` slug §11 sizes at 126 bits, and unlike the cuid v1 the id argument
 * was originally written about.
 *
 * If a collection id ever starts appearing in a response beside a row the
 * viewer cannot see, this decision has to be revisited — the same way the
 * circuit one was.
 */
export function collectionHandleFilter(
  id: string,
  viewerId: ViewerId
): Prisma.CollectionWhereInput {
  const shared: Prisma.CollectionWhereInput[] = [
    { visibility: Visibility.PUBLIC },
    { visibility: Visibility.UNLISTED },
  ]
  return {
    AND: [
      { id },
      viewerId === null
        ? { OR: shared }
        : { OR: [...shared, { ownerId: viewerId }] },
    ],
  }
}

/** Write access to a collection. Its visibility is irrelevant, as ever. */
export function canEditCollection(
  collection: { ownerId: string },
  viewerId: ViewerId
): boolean {
  return viewerId !== null && collection.ownerId === viewerId
}

/*
 * ── Simulation runs (§8's /simulate, §11) ─────────────────────────────────
 *
 * A run has no `visibility` column and should not have one: nobody publishes a
 * run. What it has instead are two facts that decide who may read it, and both
 * have to hold.
 */

/**
 * The complete `where` for "the run this id names, if this viewer may read it".
 *
 * ── Fact one: whose run it is ─────────────────────────────────────────────
 *
 * `SimulationRun.userId` is the verified `sub` of whoever submitted, or `null`
 * for an anonymous submission — and an anonymous run has to be readable by
 * *somebody*, or the anonymous caller could never collect the answer they were
 * handed a run id for. So for those the id is the credential, exactly as a
 * slug is the credential for an UNLISTED circuit: `@default(cuid(2))` is a
 * hash of randomness with no timestamp and no counter in it, the same class of
 * handle §11 sizes an unlisted circuit's whole access control at.
 *
 * A run that *does* belong to a user is that user's alone. There is no
 * "unlisted run" and no sharing: an anonymous caller holding a signed-in
 * user's run id gets nothing, because a run having an owner is itself the
 * statement that its id is not a credential.
 *
 * ── Fact two: the circuit it is about ─────────────────────────────────────
 *
 * A run's result is a function of a circuit, so it is readable only if that
 * circuit is. The filter is the *slug-addressable* one rather than the
 * listable one, and the difference is deliberate: submitting a run against an
 * UNLISTED circuit means the submitter held its handle, and holding the handle
 * is what UNLISTED means — refusing them their own run afterwards would be
 * stricter than the circuit is. A PRIVATE circuit belonging to somebody else
 * stays out of reach, which is the case this clause exists for.
 *
 * A run with no `circuitId` — the ordinary case for a document that was never
 * saved — passes this clause trivially. There is no circuit to be private.
 */
export function simulationRunFilter(
  runId: string,
  viewerId: ViewerId
): Prisma.SimulationRunWhereInput {
  const ownership: Prisma.SimulationRunWhereInput =
    viewerId === null
      ? { userId: null }
      : { OR: [{ userId: viewerId }, { userId: null }] }

  return {
    AND: [
      { id: runId },
      ownership,
      {
        OR: [
          { circuitId: null },
          { circuit: slugAddressableCircuitFilter(viewerId) },
        ],
      },
    ],
  }
}
