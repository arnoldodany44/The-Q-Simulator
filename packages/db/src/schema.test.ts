import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `prisma/schema.prisma` itself, read as text.
 *
 * These need no database, which is the point: the invariants below are the
 * ones whose violation is expensive precisely because it is silent. Dropping
 * `@db.Uuid` off `User.id` still generates a valid migration, still compiles,
 * and only fails when a real Supabase UUID meets a `text` column somewhere
 * downstream. A test that reads the schema catches it in the edit that
 * caused it.
 *
 * Reading text rather than the generated client is deliberate too: the
 * generated client is derived from this file, so asserting against it would
 * only prove the generator is self-consistent.
 */

const packageRoot = path.resolve(import.meta.dirname, '..')
const schemaPath = path.join(packageRoot, 'prisma', 'schema.prisma')
const schemaSource = readFileSync(schemaPath, 'utf8')

/**
 * Strips `//` and `///` comment lines. Without this the assertions would be
 * satisfiable by prose — and this schema's comments discuss `auth` and
 * `passwordHash` at length, precisely because they are what it excludes.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

const code = withoutComments(schemaSource)

/** The body of a top-level block, e.g. `block('model', 'User')`. */
function block(kind: string, name: string): string {
  const match = new RegExp(
    `^${kind}\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`,
    'm'
  ).exec(code)
  if (match === null) throw new Error(`No ${kind} named ${name} in the schema`)
  return match[1] ?? ''
}

function blockNames(kind: string): string[] {
  return [...code.matchAll(new RegExp(`^${kind}\\s+(\\w+)\\s*\\{`, 'gm'))].map(
    (match) => match[1] as string
  )
}

/** Enum members, in declaration order. */
function enumMembers(name: string): string[] {
  return block('enum', name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The declaration line for a field, whitespace collapsed. */
function field(model: string, name: string): string {
  const line = block('model', model)
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => new RegExp(`^${name}\\s`).test(entry))
  if (line === undefined) {
    throw new Error(`Model ${model} has no field ${name}`)
  }
  return line.replace(/\s+/g, ' ')
}

function hasField(model: string, name: string): boolean {
  return block('model', model)
    .split('\n')
    .some((entry) => new RegExp(`^\\s*${name}\\s`).test(entry))
}

describe('Supabase Auth owns identity', () => {
  it('has no Account model — Supabase keeps provider links in auth', () => {
    expect(blockNames('model')).not.toContain('Account')
  })

  it('stores no password hash anywhere', () => {
    // Not just on User: the whole file, because the point is that this
    // project never holds a credential it could leak.
    expect(code).not.toMatch(/passwordHash/)
  })

  it('types User.id as the UUID Supabase issues, with no default', () => {
    const id = field('User', 'id')
    expect(id).toContain('@id')
    expect(id).toContain('@db.Uuid')
    // A @default would mean this schema mints ids, which would immediately
    // desynchronise public.User from auth.users.
    expect(id).not.toContain('@default')
  })

  it('never names the auth schema', () => {
    // Prisma manages `public` only (§12.6). @@schema, or a raw reference,
    // would put Supabase's tables inside our migration history.
    expect(code).not.toMatch(/auth\./)
    expect(code).not.toMatch(/@@schema/)
  })

  it('gives every column that references User.id the matching UUID type', () => {
    // A type mismatch here is rejected by Postgres when the foreign key is
    // created, but SimulationRun.userId and HardwareJob.userId carry no
    // foreign key at all — so nothing but this test would notice them
    // drifting to `text`.
    const uuidColumns: ReadonlyArray<readonly [string, string]> = [
      ['Circuit', 'ownerId'],
      ['SimulationRun', 'userId'],
      ['HardwareCredential', 'userId'],
      ['HardwareJob', 'userId'],
      ['ChallengeSubmission', 'userId'],
      ['Collection', 'ownerId'],
      ['Star', 'userId'],
      ['Comment', 'userId'],
      ['ApiKey', 'userId'],
    ]
    for (const [model, column] of uuidColumns) {
      expect(field(model, column), `${model}.${column}`).toContain('@db.Uuid')
    }
  })
})

describe('the datamodel of §7', () => {
  /*
   * Fifteen from §7, plus two the specification gives no model for and that
   * were each added with an argument written down beside them: `CustomGate`
   * (M2.3 — §3.1 asks for blocks that are "saved per user and publishable")
   * and `LessonProgress` (Phase 3 — §3.6 asks for guided lessons, and a reader
   * with an account expects the account to remember where they stopped). Kept
   * as an exhaustive list rather than a count so that adding a model is a
   * decision somebody wrote down.
   */
  it('declares exactly the eighteen models', () => {
    expect(blockNames('model').sort()).toEqual([
      'ApiKey',
      'Challenge',
      'ChallengeSubmission',
      'Circuit',
      'CircuitSession',
      'CircuitTag',
      'CircuitVersion',
      'Collection',
      'CollectionItem',
      'Comment',
      'CustomGate',
      'HardwareCredential',
      'HardwareJob',
      'LessonProgress',
      'SimulationRun',
      'Star',
      'Tag',
      'User',
    ])
  })

  it('declares the four enums with their members in order', () => {
    // Order matters: Postgres enum values are ordered, and a reordering is a
    // migration that rewrites the type rather than a no-op.
    expect(enumMembers('Visibility')).toEqual(['PRIVATE', 'UNLISTED', 'PUBLIC'])
    expect(enumMembers('SimMode')).toEqual([
      'STATEVECTOR',
      'DENSITY_MATRIX',
      'TRAJECTORIES',
    ])
    expect(enumMembers('RunStatus')).toEqual([
      'QUEUED',
      'RUNNING',
      'DONE',
      'FAILED',
    ])
    expect(enumMembers('JobStatus')).toEqual([
      'SUBMITTED',
      'QUEUED',
      'RUNNING',
      'DONE',
      'FAILED',
      'CANCELLED',
    ])
  })

  it('keeps the circuit as JSON rather than normalised gate rows', () => {
    expect(field('CircuitVersion', 'data')).toMatch(/^data Json/)
  })

  it('keeps the denormalised counters the gallery sorts on', () => {
    for (const counter of ['gateCount', 'depth', 'starCount', 'viewCount']) {
      expect(hasField('Circuit', counter), counter).toBe(true)
    }
    expect(field('Circuit', 'starCount')).toContain('@default(0)')
    expect(field('Circuit', 'viewCount')).toContain('@default(0)')
  })

  it('keeps the indexes those counters exist for', () => {
    const circuit = block('model', 'Circuit')
    expect(circuit).toContain('@@index([visibility, starCount])')
    expect(circuit).toContain('@@index([ownerId, updatedAt])')
  })

  it('indexes the whole tuple the gallery cursor compares (M1.5)', () => {
    /*
     * A cursor orders by the entire tie-break tuple, so an index that stops
     * at `starCount` leaves Postgres sorting every row that shares a star
     * count — which, since most circuits have none, is most of the gallery,
     * on every page, on an unauthenticated route.
     */
    const circuit = block('model', 'Circuit')
    expect(circuit).toContain(
      '@@index([visibility, starCount(sort: Desc), createdAt(sort: Desc), id(sort: Desc)])'
    )
    expect(circuit).toContain(
      '@@index([visibility, createdAt(sort: Desc), id(sort: Desc)])'
    )
  })

  it('indexes title and description for trigram search, not for equality', () => {
    // A B-tree cannot serve `ILIKE '%grov%'` at all. Without GIN over
    // trigrams the gallery's search is a sequential scan of the table.
    const circuit = block('model', 'Circuit')
    expect(circuit).toMatch(
      /@@index\(\[title\(ops: raw\("gin_trgm_ops"\)\)\], type: Gin/
    )
    expect(circuit).toMatch(
      /@@index\(\[description\(ops: raw\("gin_trgm_ops"\)\)\], type: Gin/
    )
  })

  it('indexes the tag join by tag, which its primary key cannot', () => {
    // The key is (circuitId, tagId) and a composite key is not probeable by
    // its second column, so `?tag=` would scan the join table without this.
    expect(block('model', 'CircuitTag')).toContain('@@index([tagId])')
  })

  it('keeps the remaining §7 indexes and unique constraints', () => {
    expect(block('model', 'CircuitVersion')).toContain(
      '@@unique([circuitId, versionNum])'
    )
    expect(block('model', 'SimulationRun')).toContain(
      '@@index([userId, createdAt])'
    )
    expect(block('model', 'HardwareJob')).toContain('@@index([userId, status])')
    // Phase 3 adds the two the leaderboard and the challenge page need, and
    // keeps this one because §7 asks for it.
    expect(block('model', 'ChallengeSubmission')).toContain(
      'map: "ChallengeSubmission_leaderboard_idx"'
    )
    expect(block('model', 'ChallengeSubmission')).toContain(
      'map: "ChallengeSubmission_userId_challengeId_idx"'
    )
    expect(block('model', 'ChallengeSubmission')).toContain(
      '@@index([challengeId, passed, gateCount])'
    )
  })

  it('gives a collection the timestamps its listing orders by (M1.9)', () => {
    /*
     * §7 gives Collection no dates. Without one, `ORDER BY` has nothing to
     * say and two requests for the same page of a profile may disagree about
     * which rows are on it.
     */
    expect(field('Collection', 'createdAt')).toContain('@default(now())')
    expect(field('Collection', 'updatedAt')).toContain('@updatedAt')
    expect(block('model', 'Collection')).toContain(
      '@@index([ownerId, updatedAt])'
    )
  })

  it('indexes CollectionItem by the column with no foreign key (M1.9)', () => {
    /*
     * `circuitId` is one of the four columns §7 deliberately leaves without a
     * key, so the application deletes these rows itself — by circuitId, which
     * the composite primary key cannot be probed by. Without this index every
     * circuit deletion scans the join table.
     */
    expect(block('model', 'CollectionItem')).toContain('@@index([circuitId])')
  })

  it('defaults circuits and collections to PRIVATE', () => {
    // The safe default is the one that leaks nothing if a create forgets to
    // pass a visibility.
    expect(field('Circuit', 'visibility')).toContain('@default(PRIVATE)')
    expect(field('Collection', 'visibility')).toContain('@default(PRIVATE)')
  })

  it('stores hardware tokens as bytes, never as text', () => {
    expect(field('HardwareCredential', 'encryptedToken')).toMatch(
      /^encryptedToken Bytes/
    )
    expect(field('HardwareCredential', 'iv')).toMatch(/^iv Bytes/)
  })
})

describe('the two connection URLs stay on their own side (§12.6)', () => {
  const config = readFileSync(
    path.join(packageRoot, 'prisma.config.ts'),
    'utf8'
  )
  const client = readFileSync(
    path.join(packageRoot, 'src', 'client.ts'),
    'utf8'
  )

  it('declares only a provider in the datasource', () => {
    // Prisma 7 rejects `url` here, but a stale copy of the §12.6 snippet is
    // exactly the kind of thing that gets pasted back in.
    const datasource = block('datasource', 'db')
    expect(datasource).toContain('provider = "postgresql"')
    expect(datasource).not.toMatch(/\burl\b/)
    expect(datasource).not.toMatch(/directUrl/)
  })

  it('gives the migration CLI DIRECT_URL and nothing else', () => {
    expect(config).toMatch(/process\.env\.DIRECT_URL/)
    // The transaction pooler cannot carry DDL in a long transaction, so a
    // CLI pointed at it produces migrations that half apply. Matching the
    // read rather than the word lets the comments keep explaining that.
    expect(config).not.toMatch(/process\.env\.DATABASE_URL/)
  })

  it('gives the runtime client DATABASE_URL and nothing else', () => {
    expect(client).toMatch(/process\.env\.DATABASE_URL/)
    // Reading DIRECT_URL at runtime would put every request on the session
    // pooler, which is not sized for it.
    expect(client).not.toMatch(/process\.env\.DIRECT_URL/)
  })
})
