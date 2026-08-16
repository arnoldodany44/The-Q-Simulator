// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { hashIdentity, identiconFor, IDENTICON_GRID } from './identicon.js'
import { PHASE_LIGHTNESS_PERCENT } from '../../lib/phase-colour.js'

/**
 * The generated avatar, which is a pure function and is therefore testable
 * exhaustively.
 *
 * The properties that matter are not aesthetic. An avatar has to be *stable*
 * — the same person must draw the same picture on every page and in every
 * session, or it stops being recognisable and becomes noise — and it has to be
 * *symmetric*, which is what makes a 24-pixel square distinguishable at a
 * glance. Both are checkable, so both are checked.
 */

const ADA = '11111111-1111-4111-8111-111111111111'
const GRACE = '22222222-2222-4222-8222-222222222222'

describe('hashIdentity', () => {
  it('is deterministic', () => {
    expect(hashIdentity(ADA)).toBe(hashIdentity(ADA))
  })

  it('separates two ids that differ in one character', () => {
    expect(hashIdentity('a')).not.toBe(hashIdentity('b'))
  })

  it('stays a non-negative 32-bit integer', () => {
    // `Math.imul` leaves a signed value; every consumer indexes bits with it.
    for (const value of ['', 'a', ADA, GRACE, 'x'.repeat(200)]) {
      const hash = hashIdentity(value)
      expect(Number.isSafeInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('identiconFor', () => {
  it('draws the same picture for the same id', () => {
    expect(identiconFor(ADA)).toEqual(identiconFor(ADA))
  })

  it('draws a different picture for a different id', () => {
    expect(identiconFor(ADA).cells).not.toEqual(identiconFor(GRACE).cells)
  })

  it('fills exactly the grid', () => {
    expect(identiconFor(ADA).cells).toHaveLength(
      IDENTICON_GRID * IDENTICON_GRID
    )
  })

  it('is mirrored about the centre column', () => {
    // The property that makes a small identicon read as a shape rather than as
    // noise. Checked over many ids, because a bug in the mirroring would show
    // on some hashes and not on others.
    for (let seed = 0; seed < 64; seed += 1) {
      const { cells } = identiconFor(`user-${String(seed)}`)
      for (let row = 0; row < IDENTICON_GRID; row += 1) {
        for (let column = 0; column < IDENTICON_GRID; column += 1) {
          const mirrored = IDENTICON_GRID - 1 - column
          expect(
            cells[row * IDENTICON_GRID + column],
            `seed ${String(seed)} row ${String(row)} column ${String(column)}`
          ).toBe(cells[row * IDENTICON_GRID + mirrored])
        }
      }
    }
  })

  it('takes its colour from the project’s phase circle (§10)', () => {
    /*
     * Not a cosmetic assertion. Going through `phaseToColour` is what
     * guarantees an avatar carries the lightness M0.7a measured — the value
     * that keeps the worst hue above 3:1 against the panel — rather than an
     * arbitrary `hsl()` a component invented.
     */
    for (const identity of [ADA, GRACE, 'user-0', 'user-31']) {
      const { colour } = identiconFor(identity)
      expect(colour).toMatch(/^hsl\(/)
      expect(colour).toContain(`${String(PHASE_LIGHTNESS_PERCENT)}%`)
    }
  })
})
