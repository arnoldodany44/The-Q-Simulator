import { describe, expect, it } from 'vitest'
import type { PrismaClient, User } from './generated/prisma/client.js'
import { isUniqueConstraintError } from './prisma-errors.js'
import {
  baseUsernameFrom,
  ensureUser,
  uniqueConflictField,
  UserIdentityConflictError,
  withUsernameSuffix,
  type NewUserData,
  type UserStore,
} from './users.js'

/**
 * A stand-in for the `User` table that enforces its three unique constraints
 * the way Postgres does: atomically, inside the insert.
 *
 * The check and the insert are deliberately synchronous with no `await`
 * between them. That is not a shortcut — it is the property being modelled.
 * If the fake yielded in the middle, two concurrent inserts could both pass
 * the check and both land, and the test would be exercising a database that
 * does not exist.
 */
class FakeUserTable {
  readonly rows = new Map<string, User>()
  createCalls = 0
  findCalls = 0

  /**
   * Runs just before an insert is validated, to stage a race. Receives the
   * row about to be written, because a username is now suffixed randomly from
   * the first attempt — so a test that wants to collide with it has to read
   * it rather than predict it.
   */
  beforeCreate: ((data: NewUserData) => void) | null = null

  /** Overrides the error an insert conflict reports, to test odd shapes. */
  conflictError: ((field: string) => Error) | null = null

  readonly user = {
    findUnique: ({
      where,
    }: {
      where: { id: string }
    }): Promise<User | null> => {
      this.findCalls += 1
      return Promise.resolve(this.rows.get(where.id) ?? null)
    },
    create: ({ data }: { data: NewUserData }): Promise<User> => {
      this.createCalls += 1
      this.beforeCreate?.(data)

      const conflict = this.conflictingField(data)
      if (conflict !== null) return Promise.reject(this.makeError(conflict))

      // `leaderboardOptOut` is not among the columns an identity supplies, so
      // a fresh row takes the column default: nobody has expressed a
      // preference about being listed yet.
      const row: User = {
        ...data,
        leaderboardOptOut: false,
        createdAt: new Date(),
      }
      this.rows.set(row.id, row)
      return Promise.resolve(row)
    },
  }

  private conflictingField(data: NewUserData): string | null {
    if (this.rows.has(data.id)) return 'id'
    for (const row of this.rows.values()) {
      if (row.email === data.email) return 'email'
      if (row.username === data.username) return 'username'
    }
    return null
  }

  private makeError(field: string): Error {
    if (this.conflictError !== null) return this.conflictError(field)
    return uniqueViolation([field])
  }

  seed(row: Partial<User> & Pick<User, 'id' | 'email' | 'username'>): User {
    const full: User = {
      displayName: null,
      avatarUrl: null,
      leaderboardOptOut: false,
      createdAt: new Date(),
      ...row,
    }
    this.rows.set(full.id, full)
    return full
  }
}

/** The shape Prisma throws for a unique constraint violation. */
function uniqueViolation(target: string[] | string | undefined): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: target === undefined ? {} : { target },
  })
}

const alice = {
  id: '3f7c8a52-0d1e-4a7b-9c2f-6e5d4b3a2109',
  email: 'alice@example.com',
}

const bob = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  email: 'alice@example.com',
}

describe('baseUsernameFrom', () => {
  it('never derives a handle from the email address', () => {
    /*
     * The regression this function was rewritten for. `username` travels in
     * `OwnerRef`, `OwnerRef` is in every circuit response, and
     * `GET /circuits/:id` accepts an anonymous caller — so an email-derived
     * username published the owner's email local part to the whole internet,
     * and made a permanent public URL out of it. An address arriving as a
     * *display* name is refused for the same reason rather than folded, since
     * folding `@` into a hyphen would reintroduce exactly what this avoids.
     */
    expect(baseUsernameFrom('ada.lovelace@analytical-engine.org')).toBe('user')
    expect(baseUsernameFrom('ceo@acme-stealth.io')).toBe('user')
  })

  it('takes the display name, which the user supplied to be displayed', () => {
    expect(baseUsernameFrom('Ada Lovelace')).toBe('ada-lovelace')
  })

  it('lowercases, because the username lives in a URL', () => {
    expect(baseUsernameFrom('Alice Cooper')).toBe('alice-cooper')
  })

  it('folds anything outside [a-z0-9_-] into a single hyphen', () => {
    expect(baseUsernameFrom('a..b++c')).toBe('a-b-c')
    expect(baseUsernameFrom('maría')).toBe('mar-a')
  })

  it('trims hyphens off both ends', () => {
    expect(baseUsernameFrom('.alice.')).toBe('alice')
  })

  it('falls back to a stem when nothing usable survives', () => {
    expect(baseUsernameFrom(null)).toBe('user')
    expect(baseUsernameFrom('+')).toBe('user')
    expect(baseUsernameFrom('...')).toBe('user')
    // Two characters is too short to be worth showing; the suffix will
    // carry the identity instead.
    expect(baseUsernameFrom('jo')).toBe('user')
  })

  it('leaves room for a suffix inside the length limit', () => {
    const base = baseUsernameFrom('x'.repeat(80))
    expect(base.length).toBe(27)
    expect(withUsernameSuffix(base, 'ab12').length).toBeLessThanOrEqual(32)
  })
})

describe('uniqueConflictField', () => {
  it('reads a list of field names', () => {
    expect(uniqueConflictField(uniqueViolation(['username']))).toBe('username')
  })

  it('reads a bare field name', () => {
    expect(uniqueConflictField(uniqueViolation('email'))).toBe('email')
  })

  it('reads a Postgres constraint identifier', () => {
    // Which of the three shapes Prisma uses has changed across connectors
    // and versions, so all three are matched rather than one guessed at.
    expect(uniqueConflictField(uniqueViolation(['User_username_key']))).toBe(
      'username'
    )
    expect(uniqueConflictField(uniqueViolation('User_pkey'))).toBe('id')
  })

  it('reads what Prisma 7’s driver adapter actually sends', () => {
    /*
     * The three shapes above are the documented ones, and this project emits
     * none of them: Prisma 7 talks to Postgres through `@prisma/adapter-pg`,
     * which reports the violated columns under `meta.driverAdapterError`,
     * quoted, and populates no `meta.target` at all. Captured from the real
     * database in `circuits.db.test.ts`.
     *
     * Until this was fixed, the username-collision retry in `ensureUser` was
     * unreachable: `uniqueConflictField` answered null, the `throw error`
     * branch ran, and a second person whose e-mail local part matched an
     * existing username got a 500 on their first save.
     */
    const error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: {
        modelName: 'User',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            kind: 'UniqueConstraintViolation',
            originalCode: '23505',
            originalMessage:
              'duplicate key value violates unique constraint ' +
              '"User_username_key"',
            constraint: { fields: ['"username"'] },
          },
        },
      },
    })
    expect(uniqueConflictField(error)).toBe('username')
  })

  it('answers null when the error does not say', () => {
    expect(uniqueConflictField(uniqueViolation(undefined))).toBeNull()
    expect(uniqueConflictField(uniqueViolation(['something_else']))).toBeNull()
    expect(uniqueConflictField(new Error('nope'))).toBeNull()
  })

  it('recognises P2002 whatever its metadata', () => {
    expect(isUniqueConstraintError(uniqueViolation(undefined))).toBe(true)
    expect(isUniqueConstraintError({ code: 'P2025' })).toBe(false)
    expect(isUniqueConstraintError(null)).toBe(false)
    expect(isUniqueConstraintError('P2002')).toBe(false)
  })
})

describe('ensureUser', () => {
  it('creates the row on the first authenticated request', async () => {
    const table = new FakeUserTable()

    const user = await ensureUser(table, {
      ...alice,
      displayName: 'Alice',
      avatarUrl: 'https://example.com/a.png',
    })

    expect(user.id).toBe(alice.id)
    // Suffixed on the very first insert, so the handle is not predictable
    // from a display name somebody already knows.
    expect(user.username).toMatch(/^alice-[0-9a-z]{4}$/)
    expect(user.displayName).toBe('Alice')
    expect(table.rows.size).toBe(1)
  })

  it('does not put the email local part in the username', async () => {
    const table = new FakeUserTable()
    const user = await ensureUser(table, {
      id: '9f9e5c86-2b1a-4a5e-9f3d-2c4b6d8e0a11',
      email: 'ada.lovelace@analytical-engine.org',
      displayName: null,
    })

    expect(user.username).toMatch(/^user-[0-9a-z]{4}$/)
    expect(user.username).not.toContain('ada')
    expect(user.username).not.toContain('lovelace')
  })

  it('defaults the optional profile fields to null, not undefined', async () => {
    const table = new FakeUserTable()
    const user = await ensureUser(table, alice)
    expect(user.displayName).toBeNull()
    expect(user.avatarUrl).toBeNull()
  })

  it('returns the existing row without attempting an insert', async () => {
    const table = new FakeUserTable()
    await ensureUser(table, alice)
    table.createCalls = 0
    table.findCalls = 0

    const again = await ensureUser(table, alice)

    expect(again.id).toBe(alice.id)
    // The steady-state cost of this function: one primary-key read.
    expect(table.createCalls).toBe(0)
    expect(table.findCalls).toBe(1)
  })

  it('creates exactly one row when two first requests race', async () => {
    const table = new FakeUserTable()

    const [first, second] = await Promise.all([
      ensureUser(table, alice),
      ensureUser(table, alice),
    ])

    expect(table.rows.size).toBe(1)
    expect(first.id).toBe(alice.id)
    expect(second.id).toBe(alice.id)
    expect(second.createdAt).toEqual(first.createdAt)
    // Both callers tried to insert — the race really happened, rather than
    // the second one having quietly taken the fast path.
    expect(table.createCalls).toBe(2)
  })

  it('yields the winner even when the conflict names no constraint', async () => {
    // The re-read happens before the error is inspected, so a P2002 whose
    // shape this code has never seen still resolves the race correctly. That
    // is the property that keeps a Prisma upgrade from turning a handled
    // race into a 500.
    const table = new FakeUserTable()
    table.conflictError = () => uniqueViolation(undefined)

    // The winner lands between this caller's read and its write.
    table.beforeCreate = () => {
      table.seed({ ...alice, username: 'alice' })
      table.beforeCreate = null
    }

    const user = await ensureUser(table, alice)

    expect(user.id).toBe(alice.id)
    expect(user.username).toBe('alice')
    expect(table.rows.size).toBe(1)
  })

  it('retries with a fresh suffix when the first candidate is taken', async () => {
    const table = new FakeUserTable()
    // The candidate is random, so the collision is staged against whatever
    // this caller actually picked rather than against a guess.
    table.beforeCreate = (data) => {
      table.seed({
        id: 'ffffffff-0000-4000-8000-000000000000',
        email: 'someone@other.example',
        username: data.username,
      })
      table.beforeCreate = null
    }

    const user = await ensureUser(table, { ...alice, displayName: 'Alice' })

    expect(user.username).toMatch(/^alice-[0-9a-z]{4}$/)
    expect(table.createCalls).toBe(2)
    expect(table.rows.size).toBe(2)
  })

  it('refuses to hand back another identity holding the same email', async () => {
    // Returning the existing row here would be an account takeover: two
    // different Supabase subjects would resolve to one profile.
    const table = new FakeUserTable()
    await ensureUser(table, alice)

    await expect(ensureUser(table, bob)).rejects.toBeInstanceOf(
      UserIdentityConflictError
    )
    expect(table.rows.size).toBe(1)
  })

  it('carries a machine-readable code the client can translate', async () => {
    const table = new FakeUserTable()
    await ensureUser(table, alice)

    await expect(ensureUser(table, bob)).rejects.toMatchObject({
      code: 'USER_EMAIL_ALREADY_LINKED',
    })
  })

  it('rethrows an error that is not a unique violation', async () => {
    const table = new FakeUserTable()
    table.beforeCreate = () => {
      throw new Error('connection terminated')
    }

    await expect(ensureUser(table, alice)).rejects.toThrow(
      'connection terminated'
    )
  })

  it('rethrows a unique violation it cannot attribute', async () => {
    const table = new FakeUserTable()
    table.beforeCreate = () => {
      throw uniqueViolation(['Circuit_slug_key'])
    }

    await expect(ensureUser(table, alice)).rejects.toMatchObject({
      code: 'P2002',
    })
  })

  it('accepts a real PrismaClient', () => {
    // A type-level assertion that costs one line at runtime. `UserStore`
    // exists so the retry logic above can be tested without a database, and
    // it is worth nothing if the genuine client has stopped satisfying it —
    // which a Prisma upgrade could do silently, since no production code
    // would have to change for the two to diverge.
    const accepts = (_store: UserStore): void => undefined
    const stillFits: (client: PrismaClient) => void = accepts
    expect(typeof stillFits).toBe('function')
  })
})
