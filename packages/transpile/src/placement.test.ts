import { describe, expect, it } from 'vitest'

import { decomposeCircuit } from './decompose.js'
import { deviceGraph, type DeviceTarget } from './device.js'
import { place } from './placement.js'
import { TranspileRefusal, type RefusalCode } from './refusal.js'
import { HERON, HERON_UNCALIBRATED } from './testing/heron.js'
import {
  bellPair,
  chain,
  sequence,
  star,
  triangle,
} from './testing/circuits.js'

const heron = deviceGraph(HERON)

function refusalOf(run: () => unknown): TranspileRefusal {
  try {
    run()
  } catch (cause) {
    if (cause instanceof TranspileRefusal) return cause
    throw cause
  }
  throw new Error('expected a refusal and got an answer')
}

function expectRefusal(
  run: () => unknown,
  code: RefusalCode
): TranspileRefusal {
  const refusal = refusalOf(run)
  expect(refusal.code).toBe(code)
  return refusal
}

describe('what a placement is', () => {
  it('is total and injective', () => {
    const placement = place(decomposeCircuit(chain()), heron)
    expect(placement.layout).toHaveLength(3)
    expect(new Set(placement.layout).size).toBe(3)
    for (const physical of placement.layout) {
      expect(heron.usableQubits).toContain(physical)
    }
  })

  it('puts every interacting pair on qubits that are genuinely wired', () => {
    const decomposition = decomposeCircuit(chain())
    const placement = place(decomposition, heron)
    for (const pair of decomposition.interactions) {
      const a = placement.layout[pair.a] as number
      const b = placement.layout[pair.b] as number
      expect(heron.areAdjacent(a, b)).toBe(true)
    }
  })

  it('gives idle wires a home too, so the layout can be inverted', () => {
    // Qubit 2 is declared and never touched: it still needs a physical qubit,
    // or `layout[2]` would be a hole and every reverse lookup a special case.
    const circuit = sequence(3, 1, [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
    ])
    const placement = place(decomposeCircuit(circuit), heron)
    expect(placement.layout).toHaveLength(3)
    expect(placement.layout[2]).toBeGreaterThanOrEqual(0)
    expect(new Set(placement.layout).size).toBe(3)
  })

  it('reports an estimated fidelity below one and near it', () => {
    const placement = place(decomposeCircuit(bellPair()), heron)
    expect(placement.estimatedFidelity).toBeLessThan(1)
    expect(placement.estimatedFidelity).toBeGreaterThan(0.9)
    expect(placement.estimatedFidelity).toBeCloseTo(
      Math.exp(-placement.cost),
      12
    )
  })
})

describe('calibration is what decides between two legal placements', () => {
  it('takes the best pair when only the two-qubit error differs', () => {
    // A path of four qubits. Every pair is legal; only (2,3) is quiet.
    const target: DeviceTarget = {
      name: 'graded-line',
      qubits: 4,
      coupling: [
        { a: 0, b: 1, error: 0.05 },
        { a: 1, b: 2, error: 0.02 },
        { a: 2, b: 3, error: 0.001 },
      ],
      qubitProperties: Array.from({ length: 4 }, () => ({
        gateError: 0.0001,
        readoutError: 0.01,
      })),
    }
    const placement = place(decomposeCircuit(bellPair()), deviceGraph(target))
    expect([...placement.layout].sort((a, b) => a - b)).toEqual([2, 3])
    expect(placement.couplings[0]?.error).toBe(0.001)
  })

  it('takes the quiet readout when the two-qubit errors are equal', () => {
    const target: DeviceTarget = {
      name: 'graded-readout',
      qubits: 4,
      coupling: [
        { a: 0, b: 1, error: 0.01 },
        { a: 1, b: 2, error: 0.01 },
        { a: 2, b: 3, error: 0.01 },
      ],
      qubitProperties: [
        { gateError: 0.0001, readoutError: 0.4 },
        { gateError: 0.0001, readoutError: 0.4 },
        { gateError: 0.0001, readoutError: 0.001 },
        { gateError: 0.0001, readoutError: 0.001 },
      ],
    }
    const placement = place(decomposeCircuit(bellPair()), deviceGraph(target))
    expect([...placement.layout].sort((a, b) => a - b)).toEqual([2, 3])
  })

  it('finds the globally cheapest pair on the real device', () => {
    // Brute force: for a two-qubit circuit the search space is every coupled
    // pair in both orders, so the claim "this is the minimum" is checkable.
    const decomposition = decomposeCircuit(bellPair())
    const placement = place(decomposition, heron)

    const costOf = (a: number, b: number): number => {
      const infidelity = (error: number | undefined): number =>
        error === undefined || error <= 0 ? 0 : -Math.log(1 - error)
      const wire = (logical: number, physical: number): number =>
        (decomposition.pulses[logical] ?? 0) *
          infidelity(HERON.qubitProperties?.[physical]?.gateError) +
        infidelity(HERON.qubitProperties?.[physical]?.readoutError)
      return wire(0, a) + wire(1, b) + infidelity(heron.errorOf(a, b))
    }

    let best = Infinity
    for (const pair of heron.edges) {
      best = Math.min(best, costOf(pair.a, pair.b), costOf(pair.b, pair.a))
    }
    expect(placement.cost).toBeCloseTo(best, 12)
  })

  it('never lands on a pair the calibration says is broken', () => {
    const decomposition = decomposeCircuit(bellPair())
    const placement = place(decomposition, heron)
    const [a, b] = [...placement.layout].sort((left, right) => left - right)
    for (const excluded of heron.excludedPairs) {
      expect(excluded.a === a && excluded.b === b).toBe(false)
    }
  })

  it('still places when the device carries no calibration at all', () => {
    const bare = deviceGraph(HERON_UNCALIBRATED)
    const placement = place(decomposeCircuit(bellPair()), bare)
    expect(placement.cost).toBe(0)
    expect(placement.estimatedFidelity).toBe(1)
    expect(
      bare.areAdjacent(
        placement.layout[0] as number,
        placement.layout[1] as number
      )
    ).toBe(true)
  })
})

describe('the refusals, with the numbers that justify them', () => {
  it('refuses a circuit wider than the device', () => {
    const small = deviceGraph({
      name: 'two',
      qubits: 2,
      coupling: [{ a: 0, b: 1 }],
    })
    const refusal = expectRefusal(
      () => place(decomposeCircuit(chain()), small),
      'too-many-qubits'
    )
    expect(refusal.detail.needed).toBe(3)
    expect(refusal.detail.available).toBe(2)
  })

  it('refuses a qubit that needs more neighbours than any physical one has', () => {
    const refusal = expectRefusal(
      () => place(decomposeCircuit(star(4)), heron),
      'degree-exceeded'
    )
    expect(refusal.detail.qubit).toBe(0)
    expect(refusal.detail.needed).toBe(4)
    expect(refusal.detail.available).toBe(3)
    expect(refusal.message).toContain(
      'no choice of the other qubits changes that'
    )
    expect(refusal.operationIds.length).toBeGreaterThan(0)
  })

  it('accepts a star of three, which is exactly the degree the lattice has', () => {
    expect(() => place(decomposeCircuit(star(3)), heron)).not.toThrow()
  })

  it('refuses a triangle, naming the lattice s own shortest cycle', () => {
    const refusal = expectRefusal(
      () => place(decomposeCircuit(triangle()), heron),
      'cycle-too-short'
    )
    expect(refusal.detail.circuitGirth).toBe(3)
    expect(refusal.detail.deviceGirth).toBe(12)
  })

  it('refuses a Toffoli for the same reason, since it is a triangle', () => {
    const toffoli = sequence(3, 0, [
      { gate: 'ccx', targets: [2], controls: [0, 1] },
    ])
    const refusal = expectRefusal(
      () => place(decomposeCircuit(toffoli), heron),
      'cycle-too-short'
    )
    expect(refusal.detail.circuitGirth).toBe(3)
    expect(refusal.message).toContain('no triangles')
  })

  it('refuses a four-cycle too, because the lattice has no square either', () => {
    const square = sequence(4, 0, [
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'cx', targets: [2], controls: [1] },
      { gate: 'cx', targets: [3], controls: [2] },
      { gate: 'cx', targets: [0], controls: [3] },
    ])
    const refusal = expectRefusal(
      () => place(decomposeCircuit(square), heron),
      'cycle-too-short'
    )
    expect(refusal.detail.circuitGirth).toBe(4)
  })

  it('refuses when the search finishes without finding anything', () => {
    // Two disjoint pairs on a device with a single coupled pair: no degree is
    // exceeded, no cycle is too short, and it still does not fit.
    const oneEdge = deviceGraph({
      name: 'one-edge-plus-loners',
      qubits: 4,
      coupling: [{ a: 0, b: 1 }],
    })
    const two = sequence(4, 0, [
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'cx', targets: [3], controls: [2] },
    ])
    const refusal = expectRefusal(
      () => place(decomposeCircuit(two), oneEdge),
      'no-placement'
    )
    expect(refusal.message).toContain('Every one of the')
    expect(refusal.detail.pairs).toBe(2)
  })

  it('says so when the budget stopped it rather than the geometry', () => {
    const refusal = expectRefusal(
      () => place(decomposeCircuit(chain()), heron, { nodeBudget: 1 }),
      'search-exhausted'
    )
    expect(refusal.message).toContain('not a proof')
  })
})

describe('shapes that do fit a heavy-hex lattice', () => {
  it('places a chain of five', () => {
    const line = sequence(5, 0, [
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'cx', targets: [2], controls: [1] },
      { gate: 'cx', targets: [3], controls: [2] },
      { gate: 'cx', targets: [4], controls: [3] },
    ])
    const decomposition = decomposeCircuit(line)
    const placement = place(decomposition, heron)
    for (const pair of decomposition.interactions) {
      expect(
        heron.areAdjacent(
          placement.layout[pair.a] as number,
          placement.layout[pair.b] as number
        )
      ).toBe(true)
    }
  })

  it('places two independent Bell pairs on disjoint qubits', () => {
    const two = sequence(4, 0, [
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'cx', targets: [3], controls: [2] },
    ])
    const decomposition = decomposeCircuit(two)
    const placement = place(decomposition, heron)
    expect(new Set(placement.layout).size).toBe(4)
    for (const pair of decomposition.interactions) {
      expect(
        heron.areAdjacent(
          placement.layout[pair.a] as number,
          placement.layout[pair.b] as number
        )
      ).toBe(true)
    }
  })

  it('places a circuit with no two-qubit gates at all', () => {
    const solo = sequence(2, 2, [
      { gate: 'h', targets: [0] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'measure', targets: [1], clbitTargets: [1] },
    ])
    const placement = place(decomposeCircuit(solo), heron)
    expect(new Set(placement.layout).size).toBe(2)
    // With nothing to entangle, the quietest readout wins outright.
    expect(placement.layout[0]).toBe(10)
  })
})
