-- Custom gates, saved per user and publishable — §3.1, milestone M2.3.
--
-- One new table, two indexes, one unique index, two foreign keys. Nothing
-- here reads, writes, moves or drops an existing row, and no existing table is
-- altered.
--
-- ── Why this migration is hand-written ────────────────────────────────────
--
-- The same reason the M1.9 migration beside it is: `prisma migrate dev
-- --create-only` replays the whole folder into a shadow database, and
-- `20260815181340_lock_public_schema_to_the_api` ends with
-- `ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY` — a table the
-- shadow database does not yet have when the replay reaches it (P3006/P3018,
-- 42P01). So the SQL below is written by hand in exactly the form Prisma
-- generates and applied with `prisma migrate deploy`, which uses no shadow
-- database.
--
-- ── Why the last line is not optional ─────────────────────────────────────
--
-- The lockdown migration revoked the *default privileges* Supabase grants to
-- `anon` and `authenticated` on tables `postgres` creates in `public`, so this
-- table arrives without those grants. It does **not** arrive with row-level
-- security: `ALTER DEFAULT PRIVILEGES` has nothing to say about RLS, and a new
-- table is created with RLS disabled. Enabling it here is what keeps the
-- deny-by-default posture whole — this is the first table added since that
-- migration, and its note says in so many words that a table meant to be read
-- by a browser would have to say so on purpose. This one is not.
--
-- ── Why the library holds definitions and circuits hold copies ────────────
--
-- A saved circuit carries its own copy of every definition it uses, inside
-- `CircuitVersion.data.customGates`. Nothing in this table is ever referenced
-- by a stored circuit, which is what makes a published block safe to delete,
-- edit or unpublish: none of those can reach a circuit somebody else already
-- saved. `CircuitVersion` is immutable (§3.4), and a version whose meaning
-- depended on a row another account can edit would not be — and a circuit that
-- travels in a URL or an exported file has nothing to resolve a reference
-- against in any case.
--
-- What copying costs is attribution, and `forkedFromId` is where it is
-- recovered, exactly as `Circuit.forkedFromId` does it. `ON DELETE SET NULL`
-- rather than `CASCADE`: losing the credit must never take the copy with it.

-- CreateTable
CREATE TABLE "CustomGate" (
    "id" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "definition" JSONB NOT NULL,
    "qubitCount" INTEGER NOT NULL,
    "paramCount" INTEGER NOT NULL,
    "gateCount" INTEGER NOT NULL,
    "forkedFromId" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomGate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomGate_ownerId_name_key" ON "CustomGate"("ownerId", "name");

-- CreateIndex
CREATE INDEX "CustomGate_ownerId_updatedAt_idx" ON "CustomGate"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "CustomGate_visibility_updatedAt_id_idx" ON "CustomGate"("visibility", "updatedAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "CustomGate" ADD CONSTRAINT "CustomGate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomGate" ADD CONSTRAINT "CustomGate_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "CustomGate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deny-by-default, like every other table in this schema (§11).
ALTER TABLE "CustomGate" ENABLE ROW LEVEL SECURITY;
