import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  disconnectPrismaClient,
  getPrismaClient,
  poolSizeFromConnectionString,
} from './client.js'

/**
 * These tests build PrismaClients but never connect one. A `pg` pool is lazy
 * — it opens a socket on the first query — so a syntactically valid URL
 * pointing nowhere is enough to exercise the singleton, and no test here
 * touches the project's only database.
 */

const CLIENT_KEY = Symbol.for('@qsim/db.prisma-client')

/** The connection string is never real, so it is safe to write down. */
const FAKE_URL =
  'postgresql://someone:secret@127.0.0.1:6543/postgres?pgbouncer=true&connection_limit=1'

function clearSingleton(): void {
  delete (globalThis as Record<symbol, unknown>)[CLIENT_KEY]
}

describe('poolSizeFromConnectionString', () => {
  it('reads the connection_limit Prisma 7 no longer parses', () => {
    // Prisma 6 handled this parameter inside the Rust engine. Prisma 7 hands
    // the URL to a driver adapter that ignores it, so an unread value would
    // leave `pg` on its default of ten against a budget of one.
    expect(poolSizeFromConnectionString(FAKE_URL)).toBe(1)
  })

  it('reads a larger limit unchanged', () => {
    expect(
      poolSizeFromConnectionString('postgresql://h/db?connection_limit=17')
    ).toBe(17)
  })

  it('defers to the driver when the parameter is absent', () => {
    expect(
      poolSizeFromConnectionString('postgresql://u:p@h:5432/postgres')
    ).toBeUndefined()
  })

  it('defers to the driver rather than failing on a nonsense value', () => {
    // A malformed hint must not take down a connection string that is
    // otherwise perfectly usable.
    for (const value of ['0', '-3', 'many', '2.5', '']) {
      expect(
        poolSizeFromConnectionString(
          `postgresql://h/db?connection_limit=${value}`
        ),
        value
      ).toBeUndefined()
    }
  })

  it('survives a string that is not a URL at all', () => {
    expect(poolSizeFromConnectionString('not a url')).toBeUndefined()
  })
})

describe('getPrismaClient', () => {
  const originalUrl = process.env.DATABASE_URL

  beforeEach(() => {
    clearSingleton()
    process.env.DATABASE_URL = FAKE_URL
  })

  afterEach(async () => {
    await disconnectPrismaClient()
    clearSingleton()
    if (originalUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalUrl
  })

  it('hands out the same instance every time', () => {
    expect(getPrismaClient()).toBe(getPrismaClient())
  })

  it('survives the module being re-evaluated', () => {
    // What a watcher actually does: it throws away the module registry, not
    // the global object. A module-level `const` would be rebuilt here — and
    // with connection_limit=1, the second pool would wait forever on a
    // connection the first one still holds.
    const first = getPrismaClient()
    const parked = (globalThis as Record<symbol, unknown>)[CLIENT_KEY]
    expect(parked).toBe(first)
  })

  it('builds a fresh client after an explicit disconnect', async () => {
    const first = getPrismaClient()
    await disconnectPrismaClient()
    expect(getPrismaClient()).not.toBe(first)
  })

  it('is safe to disconnect when nothing was ever built', async () => {
    await expect(disconnectPrismaClient()).resolves.toBeUndefined()
  })

  it('fails at first use, not at import, when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL
    expect(() => getPrismaClient()).toThrow(/DATABASE_URL/)
  })

  it('says which URL is wanted when it is missing', () => {
    // The two URLs are easy to swap, and swapping them produces a working
    // process that quietly exhausts the session pooler.
    delete process.env.DATABASE_URL
    expect(() => getPrismaClient()).toThrow(/DIRECT_URL is for migrations/)
  })
})
