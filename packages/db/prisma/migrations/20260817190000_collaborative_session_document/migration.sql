-- The live CRDT document of a collaborative session — §3.4, Fase 5 (M5.2).
--
-- One new table, one primary key, one foreign key. Nothing here reads, writes,
-- moves or drops an existing row, and no existing table is altered.
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
-- ── Why the circuit id is the primary key ─────────────────────────────────
--
-- A circuit has at most one live document. Two rows for one circuit would be two
-- groups of people editing the same thing and never seeing each other, which is
-- the exact failure real-time collaboration exists to remove — so the constraint
-- makes it unrepresentable rather than merely unlikely. It also makes the
-- relay's read a single primary-key lookup, which matters on a pooler whose
-- `connection_limit` is one.
--
-- No surrogate id and no `updatedAt` index: this table is only ever addressed by
-- the circuit it belongs to, and it is never listed, searched or ordered.
--
-- ── Why the state is BYTEA and not JSONB ──────────────────────────────────
--
-- It is a Yjs update: a binary encoding of CRDT operations against a state
-- vector, not a document with fields. Storing it as base64 inside JSON would add
-- a third of its size for no readability — nothing can usefully read it without
-- a Yjs decoder anyway — and would invite a future query to try to index into
-- it. `bytea` says what it is.
--
-- ── Why ON DELETE CASCADE ─────────────────────────────────────────────────
--
-- The document is scratch state belonging to a circuit; deleting the circuit
-- must take it, exactly as it takes the versions. There is nothing here worth
-- keeping past the row it describes, and an orphan would be an unreachable blob
-- with no owner to clean it up.
--
-- ── Why the last line is not optional ─────────────────────────────────────
--
-- `20260815181340_lock_public_schema_to_the_api` revoked the default privileges
-- Supabase grants `anon` and `authenticated` on tables `postgres` creates in
-- `public`, so this table arrives without those grants. It does **not** arrive
-- with row-level security: `ALTER DEFAULT PRIVILEGES` has nothing to say about
-- RLS, and a new table is created with it disabled. Enabling it here is what
-- keeps the deny-by-default posture whole, and it matters more for this table
-- than for most — it is the only place in the schema where unsaved work lives,
-- so a door onto it would publish exactly what nobody has chosen to publish.

-- CreateTable
CREATE TABLE "CircuitSession" (
    "circuitId" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitSession_pkey" PRIMARY KEY ("circuitId")
);

-- AddForeignKey
ALTER TABLE "CircuitSession" ADD CONSTRAINT "CircuitSession_circuitId_fkey" FOREIGN KEY ("circuitId") REFERENCES "Circuit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny-by-default, like every other table in this schema (§11).
ALTER TABLE "CircuitSession" ENABLE ROW LEVEL SECURITY;
