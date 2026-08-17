-- What a job that takes hours needs, which a job that takes seconds did not —
-- §3.7, Phase 4.
--
-- Four nullable-or-defaulted columns, three indexes and one foreign key. No
-- table is created, no column is dropped or retyped, no row is read, moved,
-- rewritten or deleted, and no existing constraint is changed. That matters
-- here because this project has one Postgres and development and production
-- are the same rows.
--
-- ── Why this migration is hand-written ────────────────────────────────────
--
-- The same reason every migration since the second is: `prisma migrate dev
-- --create-only` replays the whole folder into a shadow database, and
-- `20260815181340_lock_public_schema_to_the_api` ends with
-- `ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY` — a table the
-- shadow database does not yet have when the replay reaches it (P3006/P3018,
-- 42P01). The SQL below is verbatim what `prisma migrate diff
-- --from-config-datasource --to-schema` emits for the schema change, and it is
-- applied with `prisma migrate deploy`, which uses no shadow database.
--
-- ── Why RLS is not enabled here ───────────────────────────────────────────
--
-- `migrations.test.ts` requires every `CREATE TABLE` to be paired with an
-- `ENABLE ROW LEVEL SECURITY` in the same migration. This one creates no
-- table: `HardwareJob` and `HardwareCredential` were created by the initial
-- migration and locked down by `20260815181340_lock_public_schema_to_the_api`
-- along with the other thirteen. A column inherits its table's posture, an
-- index has none of its own, and a foreign key is a constraint rather than a
-- surface.
--
-- ══════════════════════════════════════════════════════════════════════════
-- THE ONE FACT ALL OF THIS FOLLOWS FROM: A HARDWARE JOB OUTLIVES ITS PROCESS
--
-- A `SimulationRun` is written by a worker that is holding it: it starts,
-- takes at most a minute, and finishes inside one BullMQ lock. A `HardwareJob`
-- does not. It is handed to somebody else's machine and may sit in a queue of
-- twenty-four thousand for hours, across every redeploy this service performs
-- in the meantime. So every fact a *later, different* process needs in order
-- to pick the job back up has to be in the row, because the queue payload that
-- carried it the first time is long gone.
--
-- ── 1. `credentialId` ─────────────────────────────────────────────────────
--
-- Whose allowance this job is spending, and therefore which key a resuming
-- worker must poll with. "The user's credential for this provider" is not an
-- answer: §3.7 has each person bring their own token precisely so the cost
-- lands on the right allowance, and a person may hold a personal key and an
-- employer's.
--
-- `ON DELETE SET NULL` and not `CASCADE`. Deleting a credential must not
-- delete the record of what was run with it — that record is the user's own
-- history and, on a metered plan, their evidence of what was spent. A job whose
-- credential is gone becomes unpollable, which is a *state* the poll reports
-- rather than a row that should vanish.
--
-- ── 2. `program` ──────────────────────────────────────────────────────────
--
-- The transpiled OpenQASM 3, the physical qubits it was placed on, and the
-- classical register it measures into.
--
-- Stored rather than re-derived, and this is the column that keeps the results
-- honest. Re-transpiling at result time would place the circuit against
-- *today's* calibration, while the samples coming back were measured on the
-- qubits chosen when the job was submitted — possibly days earlier, against
-- error rates that have since been re-measured twice. A layout that disagrees
-- with the job that ran is not an error anybody would notice: it is a
-- plausible-looking histogram of the wrong qubits.
--
-- ── 3. `pollCount` ────────────────────────────────────────────────────────
--
-- How many times this job has been asked about. Two jobs at once: it bounds a
-- poll loop that would otherwise run for ever against a device that never
-- answers, and it makes each tick's queue job id deterministic and unique, so
-- two workers cannot schedule the same poll twice.
--
-- `NOT NULL DEFAULT 0` is what makes the write cheap: since Postgres 11 a
-- column added with a non-volatile default is a catalog change and does not
-- rewrite the table.
--
-- ── 4. `lastPolledAt` ─────────────────────────────────────────────────────
--
-- What the resume sweep orders by. NULL means "never polled", and NULLs sort
-- first under the default ordering — which is the ordering that is wanted: a
-- job that was submitted and then lost is more urgent than one that is merely
-- slow.
--
-- ── The three indexes ─────────────────────────────────────────────────────
--
-- `HardwareJob_status_lastPolledAt_idx` is the sweep's. It runs on a timer and
-- reads "non-terminal, least recently polled first"; without it that is a
-- sequential scan of every hardware job this system has ever run, on a pooler
-- whose whole budget is one connection.
--
-- `HardwareJob_providerJobId_idx` is how a poll finds the row from the
-- provider's own id — the only identifier an operator, or a future webhook, has
-- in hand.
--
-- `HardwareCredential_userId_provider_idx` serves the credential list, which is
-- read on every hardware page and by every job submission. There is deliberately
-- no UNIQUE on that pair: two keys for one provider is a supported and useful
-- state, not a mistake to be prevented.

-- AlterTable
ALTER TABLE "HardwareJob" ADD COLUMN     "credentialId" TEXT,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "pollCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "program" JSONB;

-- CreateIndex
CREATE INDEX "HardwareCredential_userId_provider_idx" ON "HardwareCredential"("userId", "provider");

-- CreateIndex
CREATE INDEX "HardwareJob_status_lastPolledAt_idx" ON "HardwareJob"("status", "lastPolledAt");

-- CreateIndex
CREATE INDEX "HardwareJob_providerJobId_idx" ON "HardwareJob"("providerJobId");

-- AddForeignKey
ALTER TABLE "HardwareJob" ADD CONSTRAINT "HardwareJob_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "HardwareCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
