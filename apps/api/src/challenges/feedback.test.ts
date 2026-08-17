import { alloc, circuitUnitary, type Statevector } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  MAX_FEEDBACK,
  diagnoseState,
  diagnoseUnitary,
  reverseIndexBits,
  reverseQubits,
} from './feedback.js'

/**
 * The diagnoses, as arithmetic.
 *
 * `routes/challenges.test.ts` reaches most of these through a real request,
 * against the seeded ladder — which is the right way to assert the ones a
 * seeded challenge can produce. Two cannot be reached that way, because no
 * challenge in the catalog has an asymmetric target: the reversed-register
 * reading is the most useful thing this file says to a learner (it is D1 in
 * disguise, and staring at a fidelity will never reveal it), so it is exercised
 * here on states and matrices built for the purpose.
 */

const THRESHOLD = 0.99

function stateOf(amplitudes: readonly [number, number][]): Statevector {
  const qubits = Math.log2(amplitudes.length)
  const state = alloc(qubits)
  state.re[0] = 0
  amplitudes.forEach(([re, im], index) => {
    state.re[index] = re
    state.im[index] = im
  })
  return state
}

const ZERO: [number, number] = [0, 0]
const ONE: [number, number] = [1, 0]
const HALF = Math.SQRT1_2

/** |01⟩ — qubit 0 set, in D1's little-endian order. */
const KET_01 = stateOf([ZERO, ONE, ZERO, ZERO])
/** |10⟩ — the same configuration with the wires the other way round. */
const KET_10 = stateOf([ZERO, ZERO, ONE, ZERO])

const codes = (found: { code: string }[]): string[] =>
  found.map((entry) => entry.code)

describe('the reversed register', () => {
  it('reverses an index bit by bit', () => {
    expect(reverseIndexBits(0b001, 3)).toBe(0b100)
    expect(reverseIndexBits(0b110, 3)).toBe(0b011)
    expect(reverseIndexBits(0b101, 3)).toBe(0b101)
  })

  it('moves the amplitudes with it', () => {
    const reversed = reverseQubits(KET_01)
    expect(reversed.re[2]).toBeCloseTo(1, 12)
    expect(reversed.re[1]).toBeCloseTo(0, 12)
  })

  /*
   * THE READING THIS FILE EXISTS FOR. The learner built the right circuit on
   * the wrong wires — the single most common mistake D1 produces — and a
   * fidelity of 0 says nothing about it.
   */
  it('is named when it would have solved the challenge', () => {
    const found = diagnoseState({
      actual: KET_10,
      target: KET_01,
      fidelity: 0,
      threshold: THRESHOLD,
    })
    expect(codes(found)).toContain('qubit-order-reversed')
  })

  it('is named for an operation too', () => {
    const circuit = (operations: Circuit['operations']): Circuit => ({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations,
    })
    // The same CNOT with control and target exchanged.
    const target = circuitUnitary(
      circuit([{ id: 'a', gate: 'cx', targets: [1], controls: [0], column: 0 }])
    )
    const actual = circuitUnitary(
      circuit([{ id: 'a', gate: 'cx', targets: [0], controls: [1], column: 0 }])
    )
    const found = diagnoseUnitary({
      actual,
      target,
      fidelity: 0.25,
      threshold: THRESHOLD,
    })
    expect(codes(found)).toContain('qubit-order-reversed')
  })
})

describe('a state that is wrong in a particular way', () => {
  it('separates identical magnitudes from a wrong phase', () => {
    const plus = stateOf([
      [HALF, 0],
      [HALF, 0],
    ])
    const minus = stateOf([
      [HALF, 0],
      [-HALF, 0],
    ])
    const found = diagnoseState({
      actual: plus,
      target: minus,
      fidelity: 0,
      threshold: THRESHOLD,
    })
    expect(codes(found)).toContain('relative-phase')
    // …and it is not reported when the magnitudes genuinely differ.
    const off = diagnoseState({
      actual: stateOf([ONE, ZERO]),
      target: minus,
      fidelity: 0.5,
      threshold: THRESHOLD,
    })
    expect(codes(off)).not.toContain('relative-phase')
  })

  it('names entanglement in both directions', () => {
    const bell = stateOf([[HALF, 0], ZERO, ZERO, [HALF, 0]])
    const product = stateOf([
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
    ])
    expect(
      codes(
        diagnoseState({
          actual: product,
          target: bell,
          fidelity: 0.5,
          threshold: THRESHOLD,
        })
      )
    ).toContain('entanglement-missing')
    expect(
      codes(
        diagnoseState({
          actual: bell,
          target: product,
          fidelity: 0.5,
          threshold: THRESHOLD,
        })
      )
    ).toContain('entanglement-unwanted')
  })

  it('counts outcomes when the magnitudes disagree', () => {
    const one = stateOf([ONE, ZERO, ZERO, ZERO])
    const four = stateOf([
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
    ])
    const few = diagnoseState({
      actual: one,
      target: four,
      fidelity: 0.25,
      threshold: THRESHOLD,
    })
    expect(few.find((entry) => entry.code === 'too-few-outcomes')?.value).toBe(
      1
    )

    const many = diagnoseState({
      actual: four,
      target: one,
      fidelity: 0.25,
      threshold: THRESHOLD,
    })
    expect(codes(many)).toContain('too-many-outcomes')
  })

  it('says nothing more than three things', () => {
    const found = diagnoseState({
      actual: KET_10,
      target: KET_01,
      fidelity: 0,
      threshold: THRESHOLD,
    })
    expect(found.length).toBeLessThanOrEqual(MAX_FEEDBACK)
  })
})

describe('a state that is right', () => {
  it('is solved, and its global phase is announced rather than penalised', () => {
    const plus = stateOf([
      [HALF, 0],
      [HALF, 0],
    ])
    const negated = stateOf([
      [-HALF, 0],
      [-HALF, 0],
    ])
    const found = diagnoseState({
      actual: negated,
      target: plus,
      fidelity: 1,
      threshold: THRESHOLD,
    })
    expect(codes(found)).toEqual(['solved', 'global-phase-ignored'])
    expect(
      found.find((entry) => entry.code === 'global-phase-ignored')?.value
    ).toBeCloseTo(Math.PI, 9)
  })

  it('says nothing about a phase of zero, which is the ordinary case', () => {
    const plus = stateOf([
      [HALF, 0],
      [HALF, 0],
    ])
    const found = diagnoseState({
      actual: plus,
      target: plus,
      fidelity: 1,
      threshold: THRESHOLD,
    })
    expect(codes(found)).toEqual(['solved'])
  })
})
