-- Close the second door onto public.* — specification §11.
--
-- ── What was open ─────────────────────────────────────────────────────────
--
-- The init migration created fifteen tables in `public` with row-level
-- security disabled, and Supabase's default privileges grant `anon` and
-- `authenticated` DELETE, INSERT, SELECT, TRUNCATE and UPDATE on every table
-- created there by `postgres`. The Supabase Data API is enabled, so PostgREST
-- served all of it at /rest/v1 to whoever held the publishable key — a key
-- that ships to browsers by design and is readable in the deployed bundle.
--
-- Measured against this database before this migration: an anonymous caller
-- holding nothing but VITE_SUPABASE_PUBLISHABLE_KEY got 200 on
-- GET /rest/v1/User, /rest/v1/Circuit and /rest/v1/CircuitVersion, and 201 on
-- POST /rest/v1/Tag. The insert was real; the row was removed afterwards and
-- the table is back to zero.
--
-- The reasoning in schema.prisma and visibility.ts — "Prisma connects as
-- postgres and bypasses RLS, so the visibility filter lives in the query" —
-- is entirely correct about Prisma and says nothing about PostgREST, which is
-- a different client, on a different connection, as a different role, with no
-- filter at all. Application-level authorisation is the right design for the
-- API; it is not a design that can defend a door the API is not standing in.
--
-- ── What this does ────────────────────────────────────────────────────────
--
-- 1. Enables row-level security on every table, with no policies. RLS with no
--    policy denies everything, which is exactly the intent: nothing reaches
--    these rows except through apps/api.
--
--    Deliberately ENABLE and not FORCE. RLS is not applied to a table's owner
--    unless it is forced, and `postgres` owns these tables and also carries
--    rolbypassrls — so Prisma is unaffected twice over, while `anon` and
--    `authenticated`, which are neither, are denied.
--
-- 2. Revokes the grants as well. Belt and braces, and it changes what a
--    refused request looks like: "permission denied" rather than a silently
--    empty result, which is a far better thing to find in a log.
--
-- 3. Stops the grants coming back. The default privileges Supabase sets FOR
--    ROLE postgres IN SCHEMA public would re-grant anon and authenticated on
--    the next table Prisma creates, so a future migration would silently
--    reopen exactly this hole. NOTE FOR LATER: this makes `public` a schema
--    the Data API cannot serve from. If a table is ever meant to be read
--    directly by the browser, it needs its grants and its RLS policies
--    written out by hand, on purpose, in the migration that creates it.
--
-- `service_role` keeps its grants: reaching it requires SUPABASE_SECRET_KEY,
-- which is a server-side credential and never leaves a server.
--
-- Nothing here reads, writes, moves or drops a single row.

-- Row-level security, deny-by-default, on every table in the schema.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Circuit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CircuitVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SimulationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HardwareCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HardwareJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChallengeSubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Collection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Star" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CircuitTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;

-- Prisma's own bookkeeping table. It records what has been applied and when,
-- which is not a browser's business either.
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- The grants themselves, on everything that exists now.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "anon";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "authenticated";

-- And on everything `postgres` creates here in future, which is every table a
-- later Prisma migration will add.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
  REVOKE ALL ON TABLES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
  REVOKE ALL ON TABLES FROM "authenticated";
