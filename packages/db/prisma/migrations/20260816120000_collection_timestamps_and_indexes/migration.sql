-- Collections become listable — milestone M1.9, specification §3.4.
--
-- Nothing here reads, writes, moves or drops a row. Two columns on a table
-- and two indexes.
--
-- ── Why this migration is hand-written ────────────────────────────────────
--
-- `prisma migrate dev --create-only` cannot run against this project. It
-- replays the whole migration folder into a shadow database, and
-- `20260815181340_lock_public_schema_to_the_api` ends with
-- `ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY` — a table the
-- shadow database does not have at the point the replay reaches it (P3018,
-- 42P01). The lockdown is not optional: Supabase serves `public` over
-- PostgREST and the migrations table is in `public` like everything else. So
-- the SQL below is written by hand, in exactly the form Prisma would have
-- generated, and applied with `prisma migrate deploy`, which uses no shadow
-- database.
--
-- ── Why Collection needs timestamps at all ───────────────────────────────
--
-- §7 gives Collection five columns and no dates, and a listing cannot page
-- through rows it cannot order. Without a sortable column, `ORDER BY` has
-- nothing to say: Postgres is free to return the rows in any order it likes,
-- and two requests for the same page of somebody's profile may disagree about
-- which collections are on it. `updatedAt` is also the only honest answer to
-- "what has this person been curating", which is what a profile page shows.
--
-- The `DEFAULT` on `updatedAt` is then dropped, and that is not fussiness:
-- Prisma's `@updatedAt` is maintained by the client rather than by the
-- database, so a column carrying a default would describe a datamodel this
-- schema does not declare, and every later `migrate diff` would report it as
-- drift. Adding it with a default and removing it afterwards is what makes
-- the statement safe for a table that already holds rows *and* leaves the
-- column exactly as the datamodel says.
--
-- ── Why CollectionItem is indexed by circuitId ───────────────────────────
--
-- `CollectionItem.circuitId` is one of the four columns §7 deliberately
-- leaves without a foreign key, so nothing in Postgres removes these rows
-- when the circuit they name is deleted. The application does it instead —
-- `remove` and `deleteAccount` in @qsim/db — and both are deletes *by
-- circuitId*. The primary key is `(collectionId, circuitId)` and a composite
-- key cannot be probed by its second column, so without this index every
-- circuit deletion is a sequential scan of the join table, and every orphan
-- sweep during an account deletion is one scan per circuit.

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Collection" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Collection" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Collection_ownerId_updatedAt_idx" ON "Collection"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "CollectionItem_circuitId_idx" ON "CollectionItem"("circuitId");
