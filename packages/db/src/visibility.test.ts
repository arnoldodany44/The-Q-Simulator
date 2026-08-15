import { describe, expect, it } from 'vitest'
import { Visibility } from './generated/prisma/enums.js'
import {
  canEditCircuit,
  circuitHandleFilter,
  idAddressableCircuitFilter,
  listableCircuitFilter,
  slugAddressableCircuitFilter,
} from './visibility.js'

/**
 * These assert the shape of a `where` fragment, which is unusual for a test
 * and is the only option available: Prisma connects as `postgres` and
 * bypasses row-level security, so the filter *is* the access control. There
 * is no second layer underneath that would catch a mistake here, and a
 * mistake here does not throw — it returns more rows.
 */

const VIEWER = '3f7c8a52-0d1e-4a7b-9c2f-6e5d4b3a2109'

describe('listableCircuitFilter', () => {
  it('shows an anonymous caller public circuits only', () => {
    expect(listableCircuitFilter(null)).toEqual({
      visibility: Visibility.PUBLIC,
    })
  })

  it('adds the viewer’s own circuits, whatever their visibility', () => {
    expect(listableCircuitFilter(VIEWER)).toEqual({
      OR: [{ visibility: Visibility.PUBLIC }, { ownerId: VIEWER }],
    })
  })

  it('never lists an unlisted circuit belonging to somebody else', () => {
    // Unlisted means "reachable with the link", and a listing is the
    // opposite of a link. This is the assertion that would fail if UNLISTED
    // were ever folded in here for symmetry with the slug filter.
    const filter = JSON.stringify(listableCircuitFilter(VIEWER))
    expect(filter).not.toContain(Visibility.UNLISTED)
  })

  it('never lets a private circuit through without an owner match', () => {
    const filter = JSON.stringify(listableCircuitFilter(null))
    expect(filter).not.toContain(Visibility.PRIVATE)
    expect(filter).not.toContain('ownerId')
  })
})

describe('slugAddressableCircuitFilter', () => {
  it('lets anyone holding the slug reach public and unlisted circuits', () => {
    expect(slugAddressableCircuitFilter(null)).toEqual({
      OR: [
        { visibility: Visibility.PUBLIC },
        { visibility: Visibility.UNLISTED },
      ],
    })
  })

  it('adds the viewer’s own circuits so they can open their private ones', () => {
    expect(slugAddressableCircuitFilter(VIEWER)).toEqual({
      OR: [
        { visibility: Visibility.PUBLIC },
        { visibility: Visibility.UNLISTED },
        { ownerId: VIEWER },
      ],
    })
  })

  it('does not reach a private circuit for an anonymous caller', () => {
    const filter = JSON.stringify(slugAddressableCircuitFilter(null))
    expect(filter).not.toContain(Visibility.PRIVATE)
    expect(filter).not.toContain('ownerId')
  })
})

describe('idAddressableCircuitFilter', () => {
  it('does not admit UNLISTED, which the slug filter does', () => {
    /*
     * The distinction the whole `forkedFromId` breach turned on. An id is not
     * a credential: this API published ids — `forkedFromId` rode out in every
     * card — so a caller can hold one without ever having been given a link.
     * A slug is 126 bits minted to be unguessable; a cuid's random block is
     * about 41, and it was never argued as access control at all.
     */
    const anonymous = JSON.stringify(idAddressableCircuitFilter(null))
    const signedIn = JSON.stringify(idAddressableCircuitFilter(VIEWER))

    expect(anonymous).not.toContain(Visibility.UNLISTED)
    expect(signedIn).not.toContain(Visibility.UNLISTED)
    expect(JSON.stringify(slugAddressableCircuitFilter(null))).toContain(
      Visibility.UNLISTED
    )
  })

  it('still lets the owner reach their own circuit by id', () => {
    expect(idAddressableCircuitFilter(VIEWER)).toEqual({
      OR: [{ visibility: Visibility.PUBLIC }, { ownerId: VIEWER }],
    })
  })
})

describe('circuitHandleFilter', () => {
  it('applies the slug rule to a slug and the id rule to an id', () => {
    expect(circuitHandleFilter('handle-abc', null)).toEqual({
      OR: [
        {
          AND: [{ slug: 'handle-abc' }, slugAddressableCircuitFilter(null)],
        },
        {
          AND: [{ id: 'handle-abc' }, idAddressableCircuitFilter(null)],
        },
      ],
    })
  })

  it('never matches a row on nothing', () => {
    // Every branch pairs a visibility rule with an equality, so an empty
    // filter — which matches everything — cannot be produced by accident.
    const filter = JSON.stringify(circuitHandleFilter('x', VIEWER))
    expect(filter).toContain('"slug":"x"')
    expect(filter).toContain('"id":"x"')
  })
})

describe('canEditCircuit', () => {
  it('grants the owner', () => {
    expect(canEditCircuit({ ownerId: VIEWER }, VIEWER)).toBe(true)
  })

  it('refuses everyone else, including on a public circuit', () => {
    // Public is a read grant. Building on someone else's circuit is a fork.
    expect(canEditCircuit({ ownerId: 'someone-else' }, VIEWER)).toBe(false)
  })

  it('refuses an anonymous caller', () => {
    expect(canEditCircuit({ ownerId: VIEWER }, null)).toBe(false)
  })

  it('does not treat a null owner match as ownership', () => {
    // Guards the shape of the check itself: `ownerId === viewerId` alone
    // would grant access if both were ever null.
    expect(canEditCircuit({ ownerId: null as unknown as string }, null)).toBe(
      false
    )
  })
})
