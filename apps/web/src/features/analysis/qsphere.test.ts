/**
 * The Q-sphere's presentation model.
 *
 * Three claims carry the picture, and none of them is visible in a screenshot:
 *
 *  1. **Latitude is the Hamming weight.** |0…0⟩ is the north pole and |1…1⟩ the
 *     south, whatever the register size. If that slipped, a GHZ state would
 *     stop being two poles and start being two arbitrary dots — and the shape
 *     is the whole reason to draw a sphere rather than a chart.
 *  2. **Longitude is a bijection onto the ring.** `weightRank` has to visit
 *     every position of `C(n, k)` exactly once for the states of weight k, or
 *     two basis states land on top of each other and the reader sees one point
 *     where there are two.
 *  3. **The geometry does not depend on the cap.** A state's place is computed
 *     from the register, not from what is drawn, so hiding points never moves
 *     the ones that remain.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  LABEL_RADIUS,
  NODE_RADIUS,
  STAGE_PIXELS,
  STAGE_RADIUS,
  STAGE_UNITS,
  binomial,
  buildQSphere,
  placeOn,
  popcount,
  weightRank,
} from './qsphere'

const DIGITS = 10

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** |0…0⟩ → H on 0 → CNOT 0→1 …: a GHZ state on `qubits` wires. */
function ghz(qubits: number): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      ...Array.from({ length: qubits - 1 }, (_unused, index) => ({
        id: `cx${index}`,
        gate: 'x',
        targets: [index + 1],
        controls: [index],
        column: index + 1,
      })),
    ],
  })
}

describe('binomial', () => {
  it('agrees with Pascal’s rule everywhere a register can reach', () => {
    for (let n = 0; n <= 20; n++) {
      for (let k = 0; k <= n; k++) {
        const expected =
          k === 0 || k === n ? 1 : binomial(n - 1, k - 1) + binomial(n - 1, k)
        expect(binomial(n, k), `C(${n}, ${k})`).toBe(expected)
      }
    }
  })

  it('stays an exact integer at the twenty-qubit ceiling', () => {
    // 184 756 is the largest coefficient this app can produce. A multiplicative
    // formula that divided in the wrong order would land a hair off it, and
    // `weightRank` would then place two states on almost the same longitude.
    expect(binomial(20, 10)).toBe(184_756)
    expect(Number.isInteger(binomial(20, 10))).toBe(true)
  })

  it('is zero outside the triangle', () => {
    expect(binomial(4, -1)).toBe(0)
    expect(binomial(4, 5)).toBe(0)
  })
})

describe('weightRank', () => {
  it.each([1, 2, 3, 4, 6, 8])(
    'ranks every state of a weight exactly once on %i qubits',
    (qubits) => {
      const byWeight = new Map<number, number[]>()
      for (let index = 0; index < 1 << qubits; index++) {
        const weight = popcount(index)
        const ranks = byWeight.get(weight) ?? []
        ranks.push(weightRank(index, qubits))
        byWeight.set(weight, ranks)
      }

      for (const [weight, ranks] of byWeight) {
        // A bijection onto [0, C(n, k)) — which is what stops two basis states
        // from sharing a longitude, and therefore a point.
        expect(
          [...ranks].sort((a, b) => a - b),
          `weight ${weight}`
        ).toEqual(
          Array.from({ length: binomial(qubits, weight) }, (_u, i) => i)
        )
      }
    }
  )

  it('is ascending in the index within a weight class', () => {
    // Colex rank on the set bits is ascending order on the masks, which is
    // what makes the ring's order the register's own order rather than an
    // arbitrary permutation nobody can predict.
    const ofWeightTwo = []
    for (let index = 0; index < 32; index++) {
      if (popcount(index) === 2) ofWeightTwo.push(weightRank(index, 5))
    }
    expect(ofWeightTwo).toEqual([...ofWeightTwo].sort((a, b) => a - b))
  })
})

describe('placeOn', () => {
  it('puts the all-zero state at the north pole and the all-one at the south', () => {
    for (const qubits of [1, 2, 3, 7, 12]) {
      expect(placeOn(0, qubits)).toEqual({ x: 0, y: 0, z: 1 })
      const bottom = placeOn((1 << qubits) - 1, qubits)
      expect(bottom.z).toBeCloseTo(-1, DIGITS)
      expect(Math.hypot(bottom.x, bottom.y)).toBeCloseTo(0, DIGITS)
    }
  })

  it('places every basis state on the unit sphere', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.nat(), (qubits, seed) => {
        const index = seed % (1 << qubits)
        const point = placeOn(index, qubits)
        const radius = Math.hypot(point.x, point.y, point.z)
        expect(radius).toBeCloseTo(1, DIGITS)
      })
    )
  })

  it('gives every state of one weight the same latitude and a distinct longitude', () => {
    const qubits = 4
    const ring = []
    for (let index = 0; index < 1 << qubits; index++) {
      if (popcount(index) === 2) ring.push(placeOn(index, qubits))
    }
    expect(ring).toHaveLength(6)
    for (const point of ring) expect(point.z).toBeCloseTo(0, DIGITS)

    const angles = ring.map((point) => Math.atan2(point.y, point.x))
    expect(new Set(angles.map((a) => a.toFixed(9))).size).toBe(6)
  })
})

describe('the stage', () => {
  it('gives the canvas and the overlay one scale', () => {
    /*
     * The scene builds its orthographic frustum `STAGE_UNITS` wide and the
     * canvas is `STAGE_PIXELS` across, so a sphere radius has to be
     * `STAGE_RADIUS` pixels in both renderings. If it were not, the pole labels
     * — which are SVG on top of the canvas, because `Notation` is the only
     * sanctioned route for a ket — would sit a few pixels off the poles. That
     * does not read as a rounding error; it reads as a mislabelled diagram,
     * which `bloch.ts` calls the one thing a picture must never do.
     */
    expect(STAGE_RADIUS * STAGE_UNITS).toBeCloseTo(STAGE_PIXELS, DIGITS)
  })

  it('leaves room for a label and for a node on the silhouette', () => {
    // The frame has to clear the label ring plus a full-sized node, or the
    // largest amplitude in a one-state register is clipped by the canvas edge.
    expect(STAGE_UNITS / 2).toBeGreaterThanOrEqual(LABEL_RADIUS + NODE_RADIUS)
  })
})

describe('buildQSphere', () => {
  it('draws a GHZ state as exactly two points, at the two poles', () => {
    // The shape §3.2 is asking for, and the one no histogram can show: two
    // outcomes at opposite ends of the register rather than two adjacent rows.
    const model = buildQSphere(ghz(4))
    expect(model.nodes).toHaveLength(2)
    expect(model.nodes.map((node) => node.weight)).toEqual([0, 4])
    expect(model.nodes[0]?.position.z).toBeCloseTo(1, DIGITS)
    expect(model.nodes[1]?.position.z).toBeCloseTo(-1, DIGITS)
  })

  it('sizes a node by the amplitude, never by the probability', () => {
    // §3.2 says "radio proporcional a la amplitud". Half of a Bell pair is
    // probability ½ and amplitude 1/√2, and those are visibly different radii.
    const model = buildQSphere(ghz(2))
    for (const node of model.nodes) {
      expect(node.magnitude).toBeCloseTo(Math.SQRT1_2, DIGITS)
      expect(node.radius).toBeCloseTo(NODE_RADIUS * Math.SQRT1_2, DIGITS)
      expect(node.radius).not.toBeCloseTo(NODE_RADIUS * node.probability, 6)
    }
  })

  it('never inflates a vanishing amplitude to something visible', () => {
    // The histogram's ruling about its bars, and here it matters more: the
    // radius is the only quantity a node carries, so a floor under it would
    // not be a distortion of the encoding, it would be the encoding.
    const model = buildQSphere(
      stateOf({
        schemaVersion: 1,
        qubits: 2,
        operations: [
          { id: 'ry', gate: 'ry', targets: [0], params: [1e-5], column: 0 },
        ],
      })
    )
    const small = model.nodes.find((node) => node.index === 1)
    expect(small).toBeDefined()
    expect(small!.radius).toBeLessThan(NODE_RADIUS * 1e-4)
  })

  it('keeps a state’s place when the cap hides its neighbours', () => {
    // The geometry is computed from the register, so the drawn subset never
    // moves. A cap that changed the picture would be a cap that lied about it.
    const state = stateOf({
      schemaVersion: 1,
      qubits: 5,
      operations: Array.from({ length: 5 }, (_unused, wire) => ({
        id: `h${wire}`,
        gate: 'h',
        targets: [wire],
        column: 0,
      })),
    })
    const whole = buildQSphere(state, 32)
    const capped = buildQSphere(state, 4)

    expect(capped.nodes).toHaveLength(4)
    expect(capped.hidden).toBe(28)
    for (const node of capped.nodes) {
      const same = whole.nodes.find((other) => other.index === node.index)
      expect(same?.position).toEqual(node.position)
    }
  })

  it('reports the cap the way the histogram does', () => {
    const state = stateOf({
      schemaVersion: 1,
      qubits: 4,
      operations: Array.from({ length: 4 }, (_unused, wire) => ({
        id: `h${wire}`,
        gate: 'h',
        targets: [wire],
        column: 0,
      })),
    })
    const model = buildQSphere(state, 6)
    expect(model.occupied).toBe(16)
    expect(model.size).toBe(16)
    expect(model.nodes).toHaveLength(6)
    expect(model.hidden).toBe(10)
    expect(model.hiddenProbability).toBeCloseTo(10 / 16, DIGITS)
  })
})
