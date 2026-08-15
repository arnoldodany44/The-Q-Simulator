import { describe, expect, it } from 'vitest'
import {
  isUniqueConstraintError,
  uniqueConstraintTargets,
  violatedConstraintMentions,
} from './prisma-errors.js'

/**
 * The fixtures below are not invented. The `driverAdapterError` one is the
 * exact object Prisma 7.9.1 produced against the project's PostgreSQL 17.6
 * when `circuits.db.test.ts` inserted a duplicate `versionNum` — captured
 * because the hand-written `meta.target` fixtures everyone starts from
 * (including the ones in this repository, until that test ran) describe a
 * shape this configuration never emits.
 *
 * Keeping both here is the point: the code has to read whichever it gets.
 */

/** Prisma 6, and Prisma 7 without a driver adapter. */
function withTarget(target: string | string[]): unknown {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  })
}

/** Prisma 7 with @prisma/adapter-pg — verified against the real database. */
function fromDriverAdapter(
  fields: string[],
  constraintName = 'CircuitVersion_circuitId_versionNum_key'
): unknown {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta: {
      modelName: 'CircuitVersion',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          kind: 'UniqueConstraintViolation',
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
          constraint: { fields },
        },
      },
    },
  })
}

describe('recognising a unique-constraint violation', () => {
  it('is the P2002 code and nothing else', () => {
    expect(isUniqueConstraintError(withTarget('slug'))).toBe(true)
    expect(isUniqueConstraintError(fromDriverAdapter(['"slug"']))).toBe(true)
    expect(
      isUniqueConstraintError(Object.assign(new Error(), { code: 'P1001' }))
    ).toBe(false)
    expect(isUniqueConstraintError(new Error('boom'))).toBe(false)
    expect(isUniqueConstraintError(null)).toBe(false)
    expect(isUniqueConstraintError('P2002')).toBe(false)
  })
})

describe('reading which constraint fired', () => {
  it('reads meta.target as a list', () => {
    expect(
      uniqueConstraintTargets(withTarget(['circuitId', 'versionNum']))
    ).toEqual(['circuitId', 'versionNum'])
  })

  it('reads meta.target as a single name', () => {
    expect(uniqueConstraintTargets(withTarget('Circuit_slug_key'))).toEqual([
      'Circuit_slug_key',
    ])
  })

  it('reads the driver adapter’s quoted column list', () => {
    /*
     * The shape that broke everything, and the quotes are the second half of
     * it: the adapter reports `"versionNum"`, with the SQL quoting intact, so
     * even code that found this field would fail an equality check against
     * the column name.
     */
    const error = fromDriverAdapter(['"circuitId"', '"versionNum"'])
    expect(uniqueConstraintTargets(error)).toEqual(['circuitId', 'versionNum'])
  })

  it('falls back to the driver message when nothing structured is there', () => {
    const error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: {
        driverAdapterError: {
          cause: {
            originalMessage:
              'duplicate key value violates unique constraint "Circuit_slug_key"',
          },
        },
      },
    })
    expect(violatedConstraintMentions(error, ['slug'])).toBe(true)
  })

  it('says nothing at all when the error says nothing', () => {
    // "Do not know" must not be answered as "yes": a retry loop that believes
    // every P2002 is its own conflict retries a violation it cannot resolve.
    expect(uniqueConstraintTargets(withTarget([]))).toEqual([])
    expect(
      uniqueConstraintTargets(Object.assign(new Error(), { code: 'P2002' }))
    ).toEqual([])
    expect(uniqueConstraintTargets(new Error('boom'))).toEqual([])
    expect(violatedConstraintMentions(new Error('boom'), ['slug'])).toBe(false)
  })

  it('matches a column name or the index that contains it', () => {
    expect(
      violatedConstraintMentions(fromDriverAdapter(['"versionNum"']), [
        'versionNum',
      ])
    ).toBe(true)
    expect(
      violatedConstraintMentions(
        withTarget('CircuitVersion_circuitId_versionNum_key'),
        ['versionNum']
      )
    ).toBe(true)
    expect(
      violatedConstraintMentions(fromDriverAdapter(['"slug"']), ['versionNum'])
    ).toBe(false)
  })
})
