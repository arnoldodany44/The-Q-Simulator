import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { disconnectPrismaClient, getPrismaClient } from './client.js'

/**
 * Asks the database what it actually contains, rather than asking Prisma
 * what it believes it wrote.
 *
 * Opt-in, and off by default. Not because it is dangerous — every statement
 * below reads `information_schema` or `pg_catalog`, writes nothing, and
 * creates nothing — but because this project has one database and `pnpm
 * verify` runs constantly. A gate that reaches the network on every run
 * turns a broken wifi connection into a failing test suite, and turns the
 * pooler's single connection into something the test suite competes for.
 *
 * Run it deliberately, after a migration:
 *
 *   QSIM_DB_INTROSPECTION=1 pnpm --filter @qsim/db test
 */
const enabled = process.env.QSIM_DB_INTROSPECTION === '1'

/*
 * Vitest inherits the ambient environment and does not read `.env` — Vite
 * only surfaces `VITE_`-prefixed values, and only to the client bundle. So
 * load the repo-root file the same way `prisma.config.ts` does, and only
 * when this suite is actually going to run.
 */
if (enabled && process.env.DATABASE_URL === undefined) {
  const repoRootEnv = path.resolve(import.meta.dirname, '../../../.env')
  if (existsSync(repoRootEnv)) process.loadEnvFile(repoRootEnv)
}

interface NameRow {
  name: string
}

describe.skipIf(!enabled)('the deployed schema', () => {
  const prisma = enabled ? getPrismaClient() : null

  afterAll(async () => {
    if (enabled) await disconnectPrismaClient()
  })

  async function names(sql: string): Promise<string[]> {
    const rows = await prisma!.$queryRawUnsafe<NameRow[]>(sql)
    return rows.map((row) => row.name).sort()
  }

  it('holds the fifteen tables of §7', async () => {
    const tables = await names(
      `select table_name as name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
         and table_name <> '_prisma_migrations'`
    )
    expect(tables).toEqual([
      'ApiKey',
      'Challenge',
      'ChallengeSubmission',
      'Circuit',
      'CircuitTag',
      'CircuitVersion',
      'Collection',
      'CollectionItem',
      'Comment',
      'HardwareCredential',
      'HardwareJob',
      'SimulationRun',
      'Star',
      'Tag',
      'User',
    ])
  })

  it('holds the four enum types', async () => {
    const types = await names(
      `select t.typname as name from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typtype = 'e'`
    )
    expect(types).toEqual(['JobStatus', 'RunStatus', 'SimMode', 'Visibility'])
  })

  it('types User.id as uuid', async () => {
    const rows = await prisma!.$queryRawUnsafe<{ name: string }[]>(
      `select data_type as name from information_schema.columns
       where table_schema = 'public' and table_name = 'User'
         and column_name = 'id'`
    )
    expect(rows[0]?.name).toBe('uuid')
  })

  it('has no password hash and no Account table', async () => {
    const columns = await names(
      `select column_name as name from information_schema.columns
       where table_schema = 'public' and column_name = 'passwordHash'`
    )
    expect(columns).toEqual([])

    const account = await names(
      `select table_name as name from information_schema.tables
       where table_schema = 'public' and table_name = 'Account'`
    )
    expect(account).toEqual([])
  })

  it('carries the indexes the gallery and leaderboard sort on', async () => {
    const indexes = await names(
      `select indexname as name from pg_indexes
       where schemaname = 'public' and indexname like '%_idx'`
    )
    expect(indexes).toEqual([
      'ChallengeSubmission_challengeId_passed_gateCount_idx',
      'Circuit_ownerId_updatedAt_idx',
      'Circuit_visibility_starCount_idx',
      'HardwareJob_userId_status_idx',
      'SimulationRun_userId_createdAt_idx',
    ])
  })

  it('carries the unique constraints ensureUser depends on', async () => {
    const unique = await names(
      `select indexname as name from pg_indexes
       where schemaname = 'public' and tablename = 'User'`
    )
    expect(unique).toEqual(['User_email_key', 'User_pkey', 'User_username_key'])
  })

  it('leaves no table in public reachable by the Data API', async () => {
    /*
     * The second door, and it was wide open. Supabase serves `public` over
     * PostgREST to anyone holding the publishable key — a key that ships to
     * browsers by design — and its default privileges grant `anon` and
     * `authenticated` full DML on every table `postgres` creates there.
     * Measured before the lockdown migration: an anonymous caller got 200 on
     * GET /rest/v1/Circuit and 201 on POST /rest/v1/Tag.
     *
     * Row-level security with no policy denies everything, and `postgres`
     * both owns these tables and carries rolbypassrls, so Prisma is
     * unaffected twice over. This is the assertion that catches a future
     * `CREATE TABLE` arriving without its `ENABLE ROW LEVEL SECURITY` — the
     * static half lives in `migrations.test.ts`, and this is what confirms
     * the deployed database agrees.
     */
    const unprotected = await names(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not c.relrowsecurity`
    )
    expect(unprotected).toEqual([])

    const policies = await names(
      `select policyname as name from pg_policies where schemaname = 'public'`
    )
    // Deny-by-default is the whole design: a policy here would be a door.
    expect(policies).toEqual([])

    const granted = await names(
      `select distinct grantee as name
       from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated')`
    )
    expect(granted).toEqual([])
  })

  it('added no trigger to Supabase’s auth schema', async () => {
    // The alternative design would have put one here. This asserts the
    // decision held — and would catch someone adding one later, which is
    // the drift the decision was made to avoid.
    const triggers = await names(
      `select t.tgname as name from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'auth' and not t.tgisinternal`
    )
    expect(triggers).toEqual([])
  })

  it('records the migration as applied and not rolled back', async () => {
    const rows = await prisma!.$queryRawUnsafe<
      { name: string; rolled_back_at: Date | null; finished_at: Date | null }[]
    >(
      `select migration_name as name, rolled_back_at, finished_at
       from "_prisma_migrations" order by started_at`
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    for (const row of rows) {
      expect(row.rolled_back_at).toBeNull()
      expect(row.finished_at).not.toBeNull()
    }
  })
})
