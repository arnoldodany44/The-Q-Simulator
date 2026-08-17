-- Where a signed-in reader stopped in a guided lesson — §3.6, Phase 3.
--
-- One new table, one primary key, one foreign key. Nothing here reads, writes,
-- moves or drops an existing row, and no existing table is altered.
--
-- ── Why this migration is hand-written ────────────────────────────────────
--
-- The same reason the two before it are: `prisma migrate dev --create-only`
-- replays the whole folder into a shadow database, and
-- `20260815181340_lock_public_schema_to_the_api` ends with
-- `ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY` — a table the
-- shadow database does not yet have when the replay reaches it (P3006/P3018,
-- 42P01). The SQL below is what `prisma migrate diff --from-config-datasource
-- --to-schema` produced against the deployed database, with the last statement
-- added by hand, and it is applied with `prisma migrate deploy`, which uses no
-- shadow database.
--
-- ── Why the last line is not optional ─────────────────────────────────────
--
-- The lockdown migration revoked the *default privileges* Supabase grants to
-- `anon` and `authenticated` on tables `postgres` creates in `public`, so this
-- table arrives without those grants. It does **not** arrive with row-level
-- security: `ALTER DEFAULT PRIVILEGES` has nothing to say about RLS, and a new
-- table is created with it disabled. Enabling it here keeps the deny-by-default
-- posture whole, and `migrations.test.ts` fails the build for a `CREATE TABLE`
-- that is not paired with one.
--
-- It matters more here than for most tables: this one is keyed by user id and
-- holds nothing but a bookmark, which makes it look harmless enough to leave
-- open. It is not. `SELECT` on it over PostgREST would be a list of which
-- accounts are learning what, for anyone holding the publishable key that
-- ships in the browser bundle.
--
-- ── Why there is no Lesson table for this to point at ─────────────────────
--
-- A lesson is a file in `apps/web` — prose in the i18n catalogs, circuits and
-- objectives in TypeScript — so the set of lessons changes with a deploy of the
-- client. `slug` names one and carries no foreign key on purpose: the
-- alternative would make "add a lesson" mean "migrate the shared database", and
-- would put nine rows of English-only content in the one place D2 says content
-- must not live. A row naming a lesson that no longer exists is one unused row,
-- and the client lists its own catalog rather than this table.
--
-- ── Why this is not ChallengeSubmission ───────────────────────────────────
--
-- `ChallengeSubmission` exists on the server because risk 5 says a challenge is
-- validated there, with the same engine, so a user cannot mark their own
-- homework. This table is the opposite case written down: nothing here is
-- ranked, nothing is shown to another reader, and the client decides whether an
-- objective was met — because a lesson has nothing to win. The two tables look
-- similar and mean opposite things, which is exactly why the difference is
-- written here as well as in the model.

-- CreateTable
CREATE TABLE "LessonProgress" (
    "userId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonProgress_pkey" PRIMARY KEY ("userId","slug")
);

-- AddForeignKey
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deny by default, like every other table in this schema. See the note above.
ALTER TABLE "LessonProgress" ENABLE ROW LEVEL SECURITY;
