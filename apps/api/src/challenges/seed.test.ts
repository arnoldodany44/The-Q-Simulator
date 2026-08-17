import { CHALLENGE_SLUGS } from '@qsim/contract'
import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { CHALLENGES } from './catalog.js'
import { challengeSeedRows, targetFor } from './seed.js'
import { parseChallengeTarget } from './target.js'

/**
 * The seed, and the promise it makes: **no target is typed by hand**.
 *
 * Every one is computed by @qsim/core from a reference circuit, which means
 * there is nothing here to transcribe wrongly — and it means the catalog itself
 * has to hold up. So this file checks the catalog as data: that the references
 * are legal circuits, that the ladder climbs, and that the rows a re-seed
 * produces are byte-identical to the ones before them.
 *
 * The stronger property — that each reference actually *passes* the validator
 * it seeded — is asserted in `routes/challenges.test.ts`, where the whole path
 * from a request to a stored row is real.
 */

describe('the catalog', () => {
  it('is exactly the published slug vocabulary, in order', () => {
    expect(CHALLENGES.map((entry) => entry.slug)).toEqual([...CHALLENGE_SLUGS])
  })

  it.each(CHALLENGES.map((entry) => entry.slug))(
    '%s has a reference circuit the contract accepts',
    (slug) => {
      const definition = CHALLENGES.find((entry) => entry.slug === slug)
      expect(definition?.reference.schemaVersion).toBe(CIRCUIT_SCHEMA_VERSION)
      expect(() => parseCircuit(definition?.reference)).not.toThrow()
    }
  )

  it('climbs: difficulty never decreases along the ladder', () => {
    const difficulties = CHALLENGES.map((entry) => entry.difficulty)
    for (let i = 1; i < difficulties.length; i++) {
      expect(difficulties[i]).toBeGreaterThanOrEqual(
        difficulties[i - 1] as number
      )
    }
  })

  it('reaches all three kinds of target', () => {
    expect(new Set(CHALLENGES.map((entry) => entry.targetType))).toEqual(
      new Set(['state', 'unitary', 'truth_table'])
    )
  })

  /*
   * A budget equal to the best answer makes the leaderboard a table of ties.
   * The reference is a solution by construction, so its gate count is an upper
   * bound on the optimum — and the budget has to be above it.
   */
  it('leaves the leaderboard something to rank', () => {
    for (const entry of CHALLENGES) {
      if (entry.maxGates === null) continue
      expect(
        entry.maxGates,
        `${entry.slug} has no slack above its reference`
      ).toBeGreaterThan(entry.reference.operations.length)
    }
  })
})

describe('the targets', () => {
  it.each(CHALLENGES.map((entry) => entry.slug))(
    '%s produces a target its own parser accepts',
    (slug) => {
      const definition = CHALLENGES.find((entry) => entry.slug === slug)
      const target = targetFor(definition!)
      const parsed = parseChallengeTarget({
        slug,
        targetType: target.targetType,
        targetData: target.targetData,
      })
      expect(parsed.qubits).toBe(target.qubitCount)
    }
  )

  /*
   * Computed, so a second computation must agree exactly. The rounding in
   * `tidy` is what makes this byte-for-byte rather than approximately true, and
   * it is why a re-seed shows an empty diff instead of a full table of
   * last-bit changes.
   */
  it('are stable across runs, to the byte', () => {
    const first = JSON.stringify(challengeSeedRows())
    const second = JSON.stringify(challengeSeedRows())
    expect(second).toBe(first)
  })

  /*
   * `-0` and `0` compare equal and only one of them survives a JSON round trip
   * looking like what it is. An amplitude of "minus nothing" in a stored target
   * is the sort of thing a reader stops and thinks about.
   */
  it('carries no negative zero', () => {
    // A minus sign followed by a zero that is not the start of a real number:
    // `-0.7071…` is fine, a bare `-0` is not.
    expect(JSON.stringify(challengeSeedRows())).not.toMatch(/-0(?![.\d])/)
  })

  it('numbers the rows by their place in the ladder', () => {
    expect(challengeSeedRows().map((row) => row.orderIndex)).toEqual(
      CHALLENGES.map((_entry, index) => index)
    )
  })

  /**
   * A truth table can only describe a circuit that maps basis states to basis
   * states. Deriving one from a circuit that produces a superposition would
   * record whichever outcome happened to be largest, and every learner would be
   * scored against a fiction — so the seed refuses rather than guesses.
   */
  it('refuses a truth table over a reference that superposes', () => {
    expect(() =>
      targetFor({
        slug: 'superposition',
        title: 'x',
        prompt: 'x',
        difficulty: 1,
        targetType: 'truth_table',
        reference: {
          schemaVersion: CIRCUIT_SCHEMA_VERSION,
          qubits: 1,
          clbits: 0,
          operations: [{ id: 'a', gate: 'h', targets: [0], column: 0 }],
        },
        truthTableInputs: [0],
        allowedGates: [],
        maxGates: null,
        fidelityThreshold: 0.99,
      })
    ).toThrow(/does not land on a basis state/)
  })
})
