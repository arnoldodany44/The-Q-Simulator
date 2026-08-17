import { describe, expect, it } from 'vitest'

import {
  ChallengeTargetError,
  MAX_CHALLENGE_QUBITS,
  MAX_UNITARY_TARGET_QUBITS,
  parseChallengeTarget,
} from './target.js'

/**
 * Reading a stored target.
 *
 * The row is `Json` in Postgres and `unknown` on the way out of `@qsim/db`, so
 * this is the only thing between a column and the engine. What it has to refuse
 * is not malicious input — nothing but the seed writes here — but a row from an
 * older seed, a hand-edited `UPDATE`, or a migration that has not run. The
 * dangerous shape is the *plausible* one: an amplitude array one entry short
 * would compare against a truncated state and quietly call every submission
 * wrong.
 */

const state = (qubits: number, amplitudes: [number, number][]) => ({
  type: 'state',
  qubits,
  amplitudes,
})

describe('a state target', () => {
  it('reads a well-formed row', () => {
    const target = parseChallengeTarget({
      slug: 'superposition',
      targetType: 'state',
      targetData: state(1, [
        [Math.SQRT1_2, 0],
        [Math.SQRT1_2, 0],
      ]),
    })
    expect(target.type).toBe('state')
  })

  it('refuses an amplitude array that is not 2^qubits long', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'bell-pair',
        targetType: 'state',
        targetData: state(2, [
          [1, 0],
          [0, 0],
          [0, 0],
        ]),
      })
    ).toThrow(ChallengeTargetError)
  })

  /**
   * The mirror of the truncated array above, and the more dangerous one.
   *
   * A short array quietly calls everybody wrong, which somebody notices. A
   * target that is not normalised quietly calls everybody RIGHT: `stateFidelity`
   * is |⟨ψ|φ⟩|² and does not normalise, so a target scaled by k reports k²
   * times the true fidelity, and the validator's clamp then caps the impossible
   * number at 1. The |+⟩ target with both amplitudes doubled used to give an
   * `i` gate — final state |0⟩, true fidelity ½ — a fidelity of 1 and a pass.
   */
  it('refuses a state that is not normalised, which would pass everybody', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'superposition',
        targetType: 'state',
        targetData: state(1, [
          [2 * Math.SQRT1_2, 0],
          [2 * Math.SQRT1_2, 0],
        ]),
      })
    ).toThrow(ChallengeTargetError)
  })

  it('refuses a state whose norm is short, too', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'superposition',
        targetType: 'state',
        targetData: state(1, [
          [0.5, 0],
          [0.5, 0],
        ]),
      })
    ).toThrow(ChallengeTargetError)
  })

  it('accepts the drift D6 allows, so a computed target still reads', () => {
    // What `2^-½` squared and summed actually lands on: a few ulps off one.
    expect(() =>
      parseChallengeTarget({
        slug: 'superposition',
        targetType: 'state',
        targetData: state(1, [
          [Math.SQRT1_2 + 1e-12, 0],
          [Math.SQRT1_2 - 1e-12, 0],
        ]),
      })
    ).not.toThrow()
  })

  it('refuses a NaN, which is not a target', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'superposition',
        targetType: 'state',
        targetData: state(1, [
          [Number.NaN, 0],
          [0, 0],
        ]),
      })
    ).toThrow(ChallengeTargetError)
  })

  it('refuses a register wider than the ceiling', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'huge',
        targetType: 'state',
        targetData: {
          type: 'state',
          qubits: MAX_CHALLENGE_QUBITS + 1,
          amplitudes: [
            [1, 0],
            [0, 0],
          ],
        },
      })
    ).toThrow(ChallengeTargetError)
  })
})

describe('a unitary target', () => {
  it('needs 4^qubits entries', () => {
    const identity = [
      [1, 0],
      [0, 0],
      [0, 0],
      [1, 0],
    ]
    expect(
      parseChallengeTarget({
        slug: 'x',
        targetType: 'unitary',
        targetData: { type: 'unitary', qubits: 1, entries: identity },
      }).type
    ).toBe('unitary')

    expect(() =>
      parseChallengeTarget({
        slug: 'x',
        targetType: 'unitary',
        targetData: {
          type: 'unitary',
          qubits: 1,
          entries: identity.slice(0, 3),
        },
      })
    ).toThrow(ChallengeTargetError)
  })

  /** The same argument as the un-normalised state: 2·Z is not an operation. */
  it('refuses a matrix that is not unitary', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'hadamard-conjugation',
        targetType: 'unitary',
        targetData: {
          type: 'unitary',
          qubits: 1,
          entries: [
            [2, 0],
            [0, 0],
            [0, 0],
            [-2, 0],
          ],
        },
      })
    ).toThrow(ChallengeTargetError)
  })

  /**
   * Columns normalised one at a time is not enough: this matrix has two
   * identical columns, which sends |0⟩ and |1⟩ to the same place and is not
   * something any circuit does.
   */
  it('refuses a matrix whose columns are not orthogonal', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'hadamard-conjugation',
        targetType: 'unitary',
        targetData: {
          type: 'unitary',
          qubits: 1,
          entries: [
            [1, 0],
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        },
      })
    ).toThrow(ChallengeTargetError)
  })

  it('is capped far below the state ceiling, because 4^n', () => {
    expect(MAX_UNITARY_TARGET_QUBITS).toBeLessThan(MAX_CHALLENGE_QUBITS)
  })
})

describe('a truth-table target', () => {
  const table = (rows: { input: number; output: number }[]) => ({
    type: 'truth_table',
    qubits: 2,
    rows,
  })

  it('reads a partial table, because a table may name a subset', () => {
    const target = parseChallengeTarget({
      slug: 'partial',
      targetType: 'truth_table',
      targetData: table([{ input: 0, output: 3 }]),
    })
    expect(target.type).toBe('truth_table')
  })

  it('refuses a basis index outside the register', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'partial',
        targetType: 'truth_table',
        targetData: table([{ input: 0, output: 4 }]),
      })
    ).toThrow(ChallengeTargetError)
  })

  /*
   * Two rows for one input is not a function, and the validator would silently
   * score whichever came last. A table that is not a function is a broken row.
   */
  it('refuses the same input twice', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'partial',
        targetType: 'truth_table',
        targetData: table([
          { input: 1, output: 0 },
          { input: 1, output: 2 },
        ]),
      })
    ).toThrow(ChallengeTargetError)
  })
})

describe('the column and the JSON', () => {
  /*
   * They are written by the same seed, so a disagreement is corruption rather
   * than a request — but a corrupted row read as a *different kind* of target
   * would compare a state against a matrix and answer a fidelity, which is the
   * sort of wrong answer nobody notices.
   */
  it('must agree about which kind of target this is', () => {
    expect(() =>
      parseChallengeTarget({
        slug: 'confused',
        targetType: 'unitary',
        targetData: state(1, [
          [1, 0],
          [0, 0],
        ]),
      })
    ).toThrow(/the row says unitary and the JSON says state/)
  })
})
