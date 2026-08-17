-- Comments anchored to specific gates — §3.4, §14 (Fase 5, M5.4).
--
-- Three nullable columns, three indexes and two foreign keys on a table that
-- already exists and is empty. Nothing here drops, renames, rewrites or moves
-- a row: every column arrives nullable with no default, so an existing row
-- keeps every value it had and acquires nothing.
--
-- ── Why this migration is hand-written ────────────────────────────────────
--
-- The same reason every migration since M1.9 is: `prisma migrate dev
-- --create-only` replays the whole folder into a shadow database, and
-- `20260815181340_lock_public_schema_to_the_api` ends with
-- `ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY` — a table the
-- shadow database does not yet have when the replay reaches it (P3006/P3018,
-- 42P01). So the SQL below is written by hand in exactly the form Prisma
-- generates and applied with `prisma migrate deploy`, which uses no shadow
-- database.
--
-- ── Why "anchorOpId" is TEXT and carries no foreign key ───────────────────
--
-- It holds an `operations[].id` from §6, and those live inside the `jsonb`
-- document in `CircuitVersion.data`. There is nothing for a key to reference,
-- and nothing is wanted: whether the anchor still names an operation depends on
-- *which* document a reader is looking at — the head version, an older version,
-- the live CRDT session of M5.2, or an unsaved editor buffer — and those four
-- disagree. A constraint would have to pick one and would then refuse a comment
-- on the gate its author is looking at.
--
-- The consequence is that this column can name an operation that no longer
-- exists. That is the orphan case, it is deliberate, and it is *visible*: the
-- thread stays in the panel with a note saying its subject is gone. What the id
-- makes impossible is the other outcome — silently pointing at a different gate
-- — because the editor never reuses an operation id.
--
-- ── Why parentId gets a key now, and what it retires ──────────────────────
--
-- `Comment.parentId` is one of the four columns §7 left without a key, and
-- `accounts.ts` compensated with a breadth-first sweep that deleted replies by
-- hand before the `User` row went. Its own comment said the real fix belonged to
-- the milestone that added comment routes, which is this one. The key is added
-- with `ON DELETE CASCADE` and the sweep is deleted in the same commit.
--
-- The `Comment_parentId_idx` beside it is not cosmetic. Postgres does not
-- create an index for a referencing column, and without one every deletion of a
-- comment becomes a sequential scan of the table looking for children to
-- cascade to — a cost that is invisible until the table is large.
--
-- ── Why resolvedById is SET NULL and not CASCADE ──────────────────────────
--
-- A thread that was resolved must stay resolved after the person who resolved
-- it deletes their account: `ON DELETE CASCADE` here would delete the whole
-- conversation instead, which is the opposite of what resolving means. What is
-- lost is only the attribution, and the interface can say "resolved" without
-- saying by whom.
--
-- ── Why no ENABLE ROW LEVEL SECURITY line ─────────────────────────────────
--
-- `Comment` is one of the fifteen tables of §7 and was locked by
-- `20260815181340_lock_public_schema_to_the_api` when it closed the whole
-- schema. RLS is a property of a table, not of its columns, so adding three
-- cannot reopen it — and the tripwire in `migrations.test.ts` requires the
-- pairing only for a `CREATE TABLE`, which this migration deliberately does not
-- contain.

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "anchorOpId" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" UUID;

-- CreateIndex
-- The panel's own query: one circuit's threads, oldest first, because a
-- conversation reads in the order it happened.
CREATE INDEX "Comment_circuitId_createdAt_idx" ON "Comment"("circuitId", "createdAt");

-- CreateIndex
-- "Which threads are on this gate", which is what clicking a marker asks, and
-- the tally that draws every marker on the canvas from one response.
CREATE INDEX "Comment_circuitId_anchorOpId_idx" ON "Comment"("circuitId", "anchorOpId");

-- CreateIndex
-- Fetches a thread's replies, and keeps the cascade below off a sequential scan.
CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
