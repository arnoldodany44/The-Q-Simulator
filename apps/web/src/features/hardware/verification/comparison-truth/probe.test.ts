/**
 * Independent verification of §3.7's three columns. Throwaway probe.
 *
 * Nothing here imports the feature's own tests. Every expectation is either
 * derived from the specification or computed by an obviously-correct slow
 * method (enumerate every basis state, sum over it) and compared against what
 * the shipped code answers.
 */

import { describe, expect, it } from 'vitest'
import { run, formatKet, type Statevector } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'

import {
  alignMeasurements,
  basisIndexOf,
  distributionFromCounts,
} from '../../alignment'
import { buildHardwareComparison, overlaysOf } from '../../comparison'
import { idealCircuitOf } from '../../ideal'

/* ─────────────────────── slow, obviously-correct oracles ───────────────── */

/** F(p, q) = (Σ √(pᵢqᵢ))², written as literally as the formula reads. */
function slowFidelity(p: readonly number[], q: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < p.length; i++) sum += Math.sqrt((p[i] ?? 0) * (q[i] ?? 0))
  return sum * sum
}

function slowTv(p: readonly number[], q: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < p.length; i++) sum += Math.abs((p[i] ?? 0) - (q[i] ?? 0))
  return sum / 2
}

/**
 * What a device would send back for one shot, decided by enumerating the
 * classical register bit by bit from the *document's* measurements.
 *
 * `bits[q]` is the measured value of qubit q. The register value is
 * Σ 2^c over classical bits c whose measured qubit read 1 — which is the
 * definition of "bit k of the sample integer is classical bit k" in
 * `@qsim/transpile`'s results.ts, applied by hand.
 */
function registerValue(
  bits: readonly number[],
  measurements: readonly { q: number; c: number }[]
): number {
  let value = 0
  for (const { q, c } of measurements) {
    if (bits[q] === 1) value += 2 ** c
  }
  return value
}

/**
 * The worker's `countsFromSamples`, re-derived here from the documented wire
 * format rather than imported — `@qsim/transpile` is deliberately not a
 * dependency of the browser app, and a second implementation is what makes
 * this a check rather than a tautology.
 *
 * "Bit k of the sample integer is classical bit k"; the label is written
 * highest classical bit first.
 */
function countsFromSamples(
  samples: readonly string[],
  clbits: number
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const sample of samples) {
    const value = BigInt(sample)
    let label = ''
    for (let bit = clbits - 1; bit >= 0; bit--) {
      label += (value >> BigInt(bit)) & 1n ? '1' : '0'
    }
    counts[label] = (counts[label] ?? 0) + 1
  }
  return counts
}

/** Statevector index of a bit assignment, straight from D1. */
function indexOfBits(bits: readonly number[]): number {
  let index = 0
  for (let q = 0; q < bits.length; q++) if (bits[q] === 1) index += 2 ** q
  return index
}

function circuitOf(
  operations: Circuit['operations'],
  qubits: number,
  clbits: number
): Circuit {
  return { schemaVersion: CIRCUIT_SCHEMA_VERSION, qubits, clbits, operations }
}

/** The analytic state of a circuit, narrowed out of `run`'s union. */
function analyticState(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') {
    throw new Error('the default execution mode is analytic')
  }
  return result.state
}

function probabilitiesOf(state: Statevector): number[] {
  const out: number[] = []
  for (let i = 0; i < state.size; i++) {
    const re = state.re[i] ?? 0
    const im = state.im[i] ?? 0
    out.push(re * re + im * im)
  }
  return out
}

/* ──────────────────────────── 1. endianness ─────────────────────────────── */

describe('the device column lands on the states the circuit reaches', () => {
  /*
   * Asymmetric on purpose and measured into CROSSED bits: `c[1] = measure q[0]`
   * and `c[0] = measure q[1]`. A Bell pair cannot detect the relabelling being
   * tested (00 and 11 are fixed points of a bit swap); this circuit can.
   */
  const crossed = circuitOf(
    [
      { id: 'g1', gate: 'x', targets: [0], column: 0 },
      { id: 'm1', gate: 'measure', targets: [0], clbitTargets: [1], column: 1 },
      { id: 'm0', gate: 'measure', targets: [1], clbitTargets: [0], column: 1 },
    ],
    2,
    2
  )

  it('agrees with a hand-computed register for every basis state', () => {
    const measurements = [
      { q: 0, c: 1 },
      { q: 1, c: 0 },
    ]
    const aligned = alignMeasurements(crossed, 2)
    expect(aligned.ok).toBe(true)
    if (!aligned.ok) return

    for (let index = 0; index < 4; index++) {
      const bits = [index & 1, (index >> 1) & 1]
      const value = registerValue(bits, measurements)
      const sample = `0x${value.toString(16)}`
      const counts = countsFromSamples([sample], 2)
      const key = Object.keys(counts)[0] as string
      // The whole path, and the answer must be the state we started from.
      expect(basisIndexOf(key, aligned.qubitOfClbit)).toBe(indexOfBits(bits))
      expect(indexOfBits(bits)).toBe(index)
    }
  })

  it('puts a device peak on the same row as the ideal peak', () => {
    const ideal = idealCircuitOf(crossed)
    expect(ideal.ok).toBe(true)
    if (!ideal.ok) return

    const state = analyticState(ideal.circuit)
    const p = probabilitiesOf(state)
    // x on q0 only: the state is |01⟩ (highest qubit first), index 1.
    expect(p[1]).toBeCloseTo(1, 12)
    expect(formatKet(1, 2)).toBe('01')

    const aligned = alignMeasurements(crossed, 2)
    if (!aligned.ok) throw new Error('alignment refused')

    // The register the device would send: c[1] = q0 = 1, c[0] = q1 = 0 → 0b10.
    const counts = countsFromSamples(
      Array.from({ length: 1000 }, () => '0x2'),
      2
    )
    expect(counts).toEqual({ '10': 1000 })

    const real = distributionFromCounts(counts, 2, aligned.qubitOfClbit)
    expect([...real]).toEqual([0, 1, 0, 0])

    const comparison = buildHardwareComparison(state, real, 1000, null, null)
    expect(comparison.deviceVsIdeal.fidelity).toBeCloseTo(1, 12)
    expect(comparison.deviceVsIdeal.totalVariation).toBeCloseTo(0, 12)
  })
})

/* ──────────────────── 2. the five numbers, against oracles ─────────────── */

describe('the headline figures are the formulas they are labelled with', () => {
  const bell = circuitOf(
    [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      { id: 'cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
      { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
    ],
    2,
    2
  )

  it('device fidelity and total variation match a brute-force sum', () => {
    const ideal = idealCircuitOf(bell)
    if (!ideal.ok) throw new Error('refused')
    const state = analyticState(ideal.circuit)
    const p = probabilitiesOf(state)

    // A plausible Heron answer: 45/45 on the pair, 5/5 leaking to the others.
    const counts = { '00': 450, '11': 450, '01': 55, '10': 45 }
    const aligned = alignMeasurements(bell, 2)
    if (!aligned.ok) throw new Error('alignment refused')
    const real = distributionFromCounts(counts, 2, aligned.qubitOfClbit)

    const comparison = buildHardwareComparison(state, real, 1000, null, null)
    expect(comparison.deviceVsIdeal.fidelity).toBeCloseTo(
      slowFidelity(p, [...real]),
      12
    )
    expect(comparison.deviceVsIdeal.totalVariation).toBeCloseTo(
      slowTv(p, [...real]),
      12
    )
    // And the value the formula actually gives, computed here by hand:
    // (√(.5·.45)·2 + 0 + 0)² = (2·0.474341649)² = 0.9
    expect(comparison.deviceVsIdeal.fidelity).toBeCloseTo(0.9, 6)
  })

  it('rows are chosen by ideal probability, so device-only outcomes are the remainder', () => {
    const ideal = idealCircuitOf(bell)
    if (!ideal.ok) throw new Error('refused')
    const state = analyticState(ideal.circuit)
    const counts = { '00': 450, '11': 450, '01': 55, '10': 45 }
    const aligned = alignMeasurements(bell, 2)
    if (!aligned.ok) throw new Error('alignment refused')
    const real = distributionFromCounts(counts, 2, aligned.qubitOfClbit)

    const comparison = buildHardwareComparison(state, real, 1000, null, null)
    expect(comparison.rows.map((row) => row.label)).toEqual(['00', '11'])
    expect(comparison.remainder).not.toBeNull()
    expect(comparison.remainder?.real).toBeCloseTo(0.1, 12)
    expect(comparison.remainder?.ideal).toBeCloseTo(0, 12)
    // The remainder is drawn, so the chart is not lying by omission.
    const overlays = overlaysOf(comparison, {
      noisy: 'n',
      noisyDelta: 'nd',
      real: 'r',
      realDelta: 'rd',
    })
    expect(overlays).toHaveLength(1)
    expect(overlays[0]?.remainder).toBeCloseTo(0.1, 12)
  })

  it('the listed rows plus the remainder account for every shot', () => {
    const ideal = idealCircuitOf(bell)
    if (!ideal.ok) throw new Error('refused')
    const state = analyticState(ideal.circuit)
    const counts = { '00': 450, '11': 450, '01': 55, '10': 45 }
    const aligned = alignMeasurements(bell, 2)
    if (!aligned.ok) throw new Error('alignment refused')
    const real = distributionFromCounts(counts, 2, aligned.qubitOfClbit)
    const comparison = buildHardwareComparison(state, real, 1000, null, null)

    const drawn =
      comparison.rows.reduce((sum, row) => sum + row.real, 0) +
      (comparison.remainder?.real ?? 0)
    expect(drawn).toBeCloseTo(1, 12)
  })
})

/* ─────────────────── 3. what the ideal column is allowed to be ─────────── */

describe('the ideal column is the circuit the device measured', () => {
  it('refuses a mid-circuit measurement rather than deleting it', () => {
    const teleport = circuitOf(
      [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        {
          id: 'm',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        { id: 'x', gate: 'x', targets: [0], column: 2 },
        {
          id: 'm2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 3,
        },
        {
          id: 'm3',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
        },
      ],
      2,
      2
    )
    const outcome = idealCircuitOf(teleport)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('mid-circuit-measurement')
  })

  it('treats staggered terminal measurements as terminal', () => {
    const staggered = circuitOf(
      [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        { id: 'x', gate: 'x', targets: [1], column: 1 },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
      ],
      2,
      2
    )
    const outcome = idealCircuitOf(staggered)
    expect(outcome.ok).toBe(true)
  })
})
