import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A tripwire over the committed migration SQL.
 *
 * This project runs one Supabase database. Development and production are
 * the same rows, there is no second copy, and a migration that drops
 * something drops it for good. So every migration in the folder is scanned
 * for destructive DDL and for any mention of the `auth` schema, which belongs
 * to Supabase and must never appear in a migration this project generates.
 *
 * When a migration legitimately needs to drop something — renaming a column
 * is the usual reason — this test is supposed to fail. That failure is the
 * feature: it forces the change to be looked at by a person, and the
 * exception to be written down here, rather than reviewed by nobody because
 * `prisma migrate deploy` succeeded.
 */

const migrationsDir = path.resolve(
  import.meta.dirname,
  '..',
  'prisma',
  'migrations'
)

interface Migration {
  name: string
  sql: string
}

function readMigrations(): Migration[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(
        path.join(migrationsDir, entry.name, 'migration.sql'),
        'utf8'
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const migrations = readMigrations()

/**
 * Statement forms that destroy data or structure that already exists.
 *
 * The list is longer than the obvious three because the obvious three are not
 * the whole of "destroys data", and a tripwire that misses is worse than no
 * tripwire: it is the same guard with more confidence behind it. Each of the
 * last three was verified to slip past the original patterns.
 */
const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|SCHEMA|DATABASE|TYPE|INDEX|VIEW|COLUMN|CONSTRAINT)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  // `DROP OWNED BY postgres` removes every object the role owns and matches
  // none of the keywords above, because none of them follows the DROP.
  /\bDROP\s+OWNED\b/i,
  // A mass UPDATE overwrites rows just as permanently as a DELETE removes
  // them. `ON UPDATE CASCADE` in a foreign key does not match: this needs a
  // table name and a SET after the verb.
  /\bUPDATE\s+"?\w+"?\s+SET\b/i,
  // Renaming an enum value rewrites the meaning of every row already holding
  // it, and Prisma will generate one for a change to `Visibility`.
  /\bALTER\s+TYPE\b.*\bRENAME\s+VALUE\b/i,
]

/** Lines that carry SQL, with comments and blanks removed. */
function statementLines(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
}

describe('the migration folder', () => {
  it('contains at least the initial migration', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(1)
    expect(migrations[0]?.name).toMatch(/^\d{14}_init$/)
  })

  it('is locked to postgresql', () => {
    const lock = readFileSync(
      path.join(migrationsDir, 'migration_lock.toml'),
      'utf8'
    )
    expect(lock).toContain('provider = "postgresql"')
  })

  it.each(migrations.map((m) => m.name))(
    '%s contains no destructive statement',
    (name) => {
      const migration = migrations.find((m) => m.name === name)
      const offending = statementLines(migration?.sql ?? '').filter((line) =>
        DESTRUCTIVE.some((pattern) => pattern.test(line))
      )
      expect(offending).toEqual([])
    }
  )

  it.each(migrations.map((m) => m.name))(
    '%s never touches the auth schema',
    (name) => {
      const migration = migrations.find((m) => m.name === name)
      const offending = statementLines(migration?.sql ?? '').filter((line) =>
        /\bauth\b/i.test(line)
      )
      expect(offending).toEqual([])
    }
  )

  /**
   * Every table this project creates must be locked to the API in the same
   * migration that creates it.
   *
   * Supabase's Data API serves `public` over PostgREST to anyone holding the
   * publishable key — which ships to browsers by design — and its default
   * privileges grant `anon` and `authenticated` full DML on every table
   * `postgres` creates there. Row-level security with no policy is what turns
   * that off, and nothing in Prisma emits it: a `CREATE TABLE` in a future
   * migration reopens the whole hole silently. So the pairing is asserted
   * here, statically, where a person has to look at it.
   *
   * `20260815181340_lock_public_schema_to_the_api` is the migration that
   * closed it for the fifteen tables of §7; this keeps the sixteenth from
   * arriving unlocked.
   */
  it('locks down every table it creates, in the same migration', () => {
    const unlocked: string[] = []
    for (const migration of migrations) {
      const created = [...migration.sql.matchAll(/CREATE TABLE "(\w+)"/g)].map(
        (match) => match[1] as string
      )
      const lockedHere = new Set(
        [
          ...migration.sql.matchAll(
            /ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY/g
          ),
        ].map((match) => match[1] as string)
      )
      const lockedLater = new Set(
        migrations
          .filter((other) => other.name > migration.name)
          .flatMap((other) => [
            ...other.sql.matchAll(
              /ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY/g
            ),
          ])
          .map((match) => match[1] as string)
      )
      for (const table of created) {
        if (!lockedHere.has(table) && !lockedLater.has(table)) {
          unlocked.push(`${migration.name}: ${table}`)
        }
      }
    }
    expect(unlocked).toEqual([])
  })
})

describe('the initial migration', () => {
  const init = migrations[0]?.sql ?? ''

  function created(kind: 'TABLE' | 'TYPE'): string[] {
    return [...init.matchAll(new RegExp(`CREATE ${kind} "(\\w+)"`, 'g'))]
      .map((match) => match[1] as string)
      .sort()
  }

  it('creates the fifteen tables of §7 and nothing else', () => {
    expect(created('TABLE')).toEqual([
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

  it('creates the four enum types', () => {
    expect(created('TYPE')).toEqual([
      'JobStatus',
      'RunStatus',
      'SimMode',
      'Visibility',
    ])
  })

  it('types User.id as uuid rather than text', () => {
    expect(init).toMatch(/CREATE TABLE "User" \(\s*"id" UUID NOT NULL/)
  })

  it('creates the five secondary indexes the gallery and leaderboard need', () => {
    const indexes = [...init.matchAll(/CREATE INDEX "(\w+)"/g)].map(
      (match) => match[1] as string
    )
    expect(indexes.sort()).toEqual([
      'ChallengeSubmission_challengeId_passed_gateCount_idx',
      'Circuit_ownerId_updatedAt_idx',
      'Circuit_visibility_starCount_idx',
      'HardwareJob_userId_status_idx',
      'SimulationRun_userId_createdAt_idx',
    ])
  })

  it('names the unique constraints that ensureUser matches on', () => {
    // users.ts recognises a P2002 by these constraint names as well as by
    // field name, because Prisma reports one or the other depending on the
    // connector. If a migration renames them, that matcher goes blind.
    expect(init).toContain('CREATE UNIQUE INDEX "User_email_key"')
    expect(init).toContain('CREATE UNIQUE INDEX "User_username_key"')
    expect(init).toContain('CONSTRAINT "User_pkey" PRIMARY KEY ("id")')
  })

  it('cascades deletes from User to everything a user owns', () => {
    const cascading = [
      'Circuit_ownerId_fkey',
      'HardwareCredential_userId_fkey',
      'ChallengeSubmission_userId_fkey',
      'Collection_ownerId_fkey',
      'Star_userId_fkey',
      'Comment_userId_fkey',
      'ApiKey_userId_fkey',
    ]
    for (const constraint of cascading) {
      const statement = init
        .split('\n')
        .find((line) => line.includes(constraint))
      expect(statement, constraint).toContain('ON DELETE CASCADE')
    }
  })

  it('keeps a simulation run when its circuit is deleted', () => {
    // A run is a record of something that happened, so it survives the
    // circuit — hence SET NULL rather than CASCADE (§7).
    const statement = init
      .split('\n')
      .find((line) => line.includes('SimulationRun_circuitId_fkey'))
    expect(statement).toContain('ON DELETE SET NULL')
  })
})
