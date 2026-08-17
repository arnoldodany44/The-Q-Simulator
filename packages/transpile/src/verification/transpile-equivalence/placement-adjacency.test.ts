/**
 * Independent placement verification — transpile-equivalence lens.
 *
 * Two claims are checked against slow, obviously-correct references:
 *
 *   1. Every `cz` the emitted program contains runs on a pair the device
 *      actually couples, and no physical qubit holds two logical ones.
 *   2. A refusal is a refusal only when no embedding exists. On small devices
 *      that is decidable by enumerating every injective map, which is what the
 *      brute force below does — including the cost, so the search's claim to
 *      pick the *cheapest* embedding is checked too.
 */

import { describe, expect, it } from 'vitest'
import { decomposeCircuit } from '../../decompose.js'
import {
  deviceGraph,
  type CoupledPair,
  type DeviceTarget,
} from '../../device.js'
import { place } from '../../placement.js'
import { TranspileRefusal } from '../../refusal.js'
import { safeTranspile, transpile } from '../../transpile.js'
import { HERON, HERON_UNCALIBRATED } from '../../testing/heron.js'
import { line, op } from './harness.test.js'
import type { Circuit, Operation } from '@qsim/schema'

/* ─────────────────── an independent view of the device ─────────────────── */

/** Usable undirected pairs, recomputed from the target without the package. */
function usablePairs(target: DeviceTarget): ReadonlySet<string> {
  const brokenQubit = new Set<number>()
  for (const [qubit, properties] of (target.qubitProperties ?? []).entries()) {
    if (properties.gateError !== undefined && properties.gateError >= 1) {
      brokenQubit.add(qubit)
    }
  }
  const pairs = new Set<string>()
  for (const pair of target.coupling) {
    if (pair.error !== undefined && pair.error >= 1) continue
    if (brokenQubit.has(pair.a) || brokenQubit.has(pair.b)) continue
    const low = Math.min(pair.a, pair.b)
    const high = Math.max(pair.a, pair.b)
    pairs.add(`${String(low)}-${String(high)}`)
  }
  return pairs
}

/** Girth by the definition: for each edge, the shortest path avoiding it. */
function girthByRemoval(qubits: number, pairs: ReadonlySet<string>): number {
  const neighbours: number[][] = Array.from({ length: qubits }, () => [])
  const edges: [number, number][] = []
  for (const key of pairs) {
    const [a, b] = key.split('-').map(Number) as [number, number]
    neighbours[a]?.push(b)
    neighbours[b]?.push(a)
    edges.push([a, b])
  }
  let best = Infinity
  for (const [from, to] of edges) {
    const distance = new Array<number>(qubits).fill(-1)
    distance[from] = 0
    const queue = [from]
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head] as number
      for (const v of neighbours[u] ?? []) {
        if (u === from && v === to) continue
        if (v === from && u === to) continue
        if (distance[v] !== -1) continue
        distance[v] = (distance[u] as number) + 1
        queue.push(v)
      }
    }
    const reach = distance[to] as number
    if (reach >= 0) best = Math.min(best, reach + 1)
  }
  return best
}

describe('the package agrees with a slow reading of the device', () => {
  it('usable pairs, max degree and girth of the real Heron snapshot', () => {
    const graph = deviceGraph(HERON)
    const pairs = usablePairs(HERON)

    const mine = new Set(
      graph.edges.map((edge) => `${String(edge.a)}-${String(edge.b)}`)
    )
    expect([...mine].sort()).toEqual([...pairs].sort())

    const degree = new Map<number, number>()
    for (const key of pairs) {
      const [a, b] = key.split('-').map(Number) as [number, number]
      degree.set(a, (degree.get(a) ?? 0) + 1)
      degree.set(b, (degree.get(b) ?? 0) + 1)
    }
    expect(graph.maxDegree).toBe(Math.max(...degree.values()))
    expect(graph.girth).toBe(girthByRemoval(HERON.qubits, pairs))
    expect(graph.girth).toBe(12)
  })

  /*
   * The fixture is a vendored copy of a real `/configuration` and
   * `/properties` pair, so it is worth pinning against the numbers the device
   * itself reported: 156 qubits, 176 undirected pairs (352 directed), degrees
   * of at most three, seven pairs whose calibration failed, and the seven-gate
   * native basis. A fixture that drifted from those would make every placement
   * test above a test of nothing.
   */
  it('the snapshot still says what the device said', () => {
    expect(HERON.qubits).toBe(156)
    expect(HERON.coupling).toHaveLength(176)
    expect(HERON.basisGates).toEqual(['cz', 'id', 'rx', 'rz', 'rzz', 'sx', 'x'])
    expect(
      HERON.coupling.filter(
        (pair) => pair.error !== undefined && pair.error >= 1
      )
    ).toHaveLength(7)

    const graph = deviceGraph(HERON)
    expect(graph.maxDegree).toBeLessThanOrEqual(3)
    // 176 of the 12090 a fully connected 156-qubit register would have.
    const complete = (156 * 155) / 2
    expect(complete).toBe(12090)
    expect(HERON.coupling.length / complete).toBeCloseTo(0.0146, 4)
  })
})

/* ─────────────── every emitted cz lands on a coupled pair ──────────────── */

/** The two-qubit operands of every `cz` statement of a hardware-style program. */
function czOperandsOfQasm(
  qasm: string
): readonly (readonly [number, number])[] {
  const out: [number, number][] = []
  for (const raw of qasm.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('//') || !trimmed.startsWith('cz')) continue
    const operands = [...trimmed.matchAll(/\$(\d+)/g)].map((match) =>
      Number(match[1])
    )
    expect(operands).toHaveLength(2)
    out.push([operands[0] as number, operands[1] as number])
  }
  return out
}

const RUNNABLE: readonly { name: string; circuit: Circuit }[] = [
  {
    name: 'bell pair',
    circuit: withMeasure(2, [op('h', [0]), op('cx', [1], { controls: [0] })]),
  },
  {
    name: 'ghz chain of five',
    circuit: withMeasure(5, [
      op('h', [0]),
      op('cx', [1], { controls: [0] }),
      op('cx', [2], { controls: [1] }),
      op('cx', [3], { controls: [2] }),
      op('cx', [4], { controls: [3] }),
    ]),
  },
  {
    name: 'star of degree three',
    circuit: withMeasure(4, [
      op('h', [0]),
      op('cx', [1], { controls: [0] }),
      op('cx', [2], { controls: [0] }),
      op('cx', [3], { controls: [0] }),
    ]),
  },
  {
    name: 'controlled phases along a line',
    circuit: withMeasure(4, [
      op('h', [0]),
      op('cp', [1], { controls: [0], params: [Math.PI / 2] }),
      op('cp', [2], { controls: [1], params: [Math.PI / 4] }),
      op('crz', [3], { controls: [2], params: [0.9] }),
    ]),
  },
  {
    name: 'swap chain',
    circuit: withMeasure(3, [
      op('x', [0]),
      op('swap', [0, 1]),
      op('swap', [1, 2]),
    ]),
  },
  {
    name: 'iswap pair with idle wires',
    circuit: withMeasure(4, [op('h', [1]), op('iswap', [1, 2])]),
  },
]

function withMeasure(qubits: number, gates: readonly Operation[]): Circuit {
  const body = line(qubits, gates)
  const measures = Array.from({ length: qubits }, (_unused, qubit) =>
    op('measure', [qubit], { clbitTargets: [qubit] })
  )
  return {
    ...body,
    clbits: qubits,
    operations: [
      ...body.operations,
      ...measures.map((measure, index) => ({
        ...measure,
        id: `m${String(index)}`,
        column: gates.length,
      })),
    ],
  }
}

describe('a placed program only ever couples qubits the device couples', () => {
  const graph = deviceGraph(HERON)
  const pairs = usablePairs(HERON)

  for (const entry of RUNNABLE) {
    it(entry.name, () => {
      const plan = transpile(entry.circuit, graph, { title: entry.name })

      // The layout is total and injective.
      expect(plan.layout).toHaveLength(entry.circuit.qubits)
      expect(new Set(plan.layout).size).toBe(plan.layout.length)
      for (const physical of plan.layout) {
        expect(graph.usableQubits).toContain(physical)
      }

      // Every cz in the submitted program is on a coupled, usable pair.
      const operands = czOperandsOfQasm(plan.qasm)
      expect(operands.length).toBeGreaterThan(0)
      for (const [a, b] of operands) {
        const key = `${String(Math.min(a, b))}-${String(Math.max(a, b))}`
        expect(pairs.has(key)).toBe(true)
      }

      // And no statement mentions a qubit outside the layout.
      const mentioned = new Set(
        [...plan.qasm.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
      )
      for (const qubit of mentioned) {
        expect(plan.layout).toContain(qubit)
      }
    })
  }

  it('the same holds when the device carries no calibration at all', () => {
    const bare = deviceGraph(HERON_UNCALIBRATED)
    const barePairs = usablePairs(HERON_UNCALIBRATED)
    for (const entry of RUNNABLE) {
      const plan = transpile(entry.circuit, bare)
      for (const [a, b] of czOperandsOfQasm(plan.qasm)) {
        const key = `${String(Math.min(a, b))}-${String(Math.max(a, b))}`
        expect(barePairs.has(key)).toBe(true)
      }
    }
  })

  it('never chooses one of the seven pairs whose calibration failed', () => {
    const broken = HERON.coupling.filter((pair) => pair.error === 1)
    expect(broken.length).toBeGreaterThan(0)
    const forbidden = new Set(
      broken.map((pair) => `${String(pair.a)}-${String(pair.b)}`)
    )
    for (const entry of RUNNABLE) {
      const plan = transpile(entry.circuit, graph)
      for (const [a, b] of czOperandsOfQasm(plan.qasm)) {
        expect(
          forbidden.has(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
        ).toBe(false)
      }
    }
  })
})

/* ───────────── brute force: is the refusal ever a false refusal? ───────── */

function targetOf(
  name: string,
  qubits: number,
  coupling: readonly CoupledPair[],
  qubitProperties?: readonly { gateError?: number; readoutError?: number }[]
): DeviceTarget {
  return {
    name,
    qubits,
    basisGates: ['cz', 'id', 'rx', 'rz', 'rzz', 'sx', 'x'],
    coupling,
    ...(qubitProperties === undefined ? {} : { qubitProperties }),
  }
}

function pathDevice(qubits: number): DeviceTarget {
  const coupling: CoupledPair[] = []
  for (let i = 0; i + 1 < qubits; i++) coupling.push({ a: i, b: i + 1 })
  return targetOf(`path${String(qubits)}`, qubits, coupling)
}

function ringDevice(qubits: number): DeviceTarget {
  const coupling: CoupledPair[] = []
  for (let i = 0; i < qubits; i++) {
    const a = i
    const b = (i + 1) % qubits
    coupling.push({ a: Math.min(a, b), b: Math.max(a, b) })
  }
  return targetOf(`ring${String(qubits)}`, qubits, coupling)
}

function triangleDevice(): DeviceTarget {
  return targetOf('triangle', 4, [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 0, b: 2 },
    { a: 2, b: 3 },
  ])
}

/** Every injective map of `logical` qubits into `qubits`, as an array. */
function* injections(
  logical: number,
  qubits: number
): Generator<readonly number[]> {
  const chosen: number[] = []
  const used = new Set<number>()
  function* walk(): Generator<readonly number[]> {
    if (chosen.length === logical) {
      yield [...chosen]
      return
    }
    for (let physical = 0; physical < qubits; physical++) {
      if (used.has(physical)) continue
      used.add(physical)
      chosen.push(physical)
      yield* walk()
      chosen.pop()
      used.delete(physical)
    }
  }
  yield* walk()
}

function bruteForceEmbeds(circuit: Circuit, target: DeviceTarget): boolean {
  const decomposition = decomposeCircuit(circuit)
  const pairs = usablePairs(target)
  const usable = new Set(
    Array.from({ length: target.qubits }, (_unused, q) => q).filter((q) => {
      const error = target.qubitProperties?.[q]?.gateError
      return error === undefined || error < 1
    })
  )
  for (const layout of injections(circuit.qubits, target.qubits)) {
    if (layout.some((physical) => !usable.has(physical))) continue
    const ok = decomposition.interactions.every((entry) => {
      const a = layout[entry.a] as number
      const b = layout[entry.b] as number
      return pairs.has(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
    })
    if (ok) return true
  }
  return false
}

describe('a refusal only ever means no embedding exists', () => {
  const CASES: readonly {
    name: string
    circuit: Circuit
    device: DeviceTarget
  }[] = [
    {
      name: 'toffoli on a path',
      circuit: line(3, [op('ccx', [2], { controls: [0, 1] })]),
      device: pathDevice(6),
    },
    {
      name: 'toffoli on a device that has a triangle',
      circuit: line(3, [op('ccx', [2], { controls: [0, 1] })]),
      device: triangleDevice(),
    },
    {
      name: 'toffoli on a ring of four',
      circuit: line(3, [op('ccx', [2], { controls: [0, 1] })]),
      device: ringDevice(4),
    },
    {
      name: 'toffoli on a ring of three',
      circuit: line(3, [op('ccx', [2], { controls: [0, 1] })]),
      device: ringDevice(3),
    },
    {
      name: 'chain of four on a path of four',
      circuit: line(4, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
        op('cx', [3], { controls: [2] }),
      ]),
      device: pathDevice(4),
    },
    {
      name: 'chain of five on a path of four',
      circuit: line(5, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
        op('cx', [3], { controls: [2] }),
        op('cx', [4], { controls: [3] }),
      ]),
      device: pathDevice(4),
    },
    {
      name: 'star of three on a path',
      circuit: line(4, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [0] }),
        op('cx', [3], { controls: [0] }),
      ]),
      device: pathDevice(6),
    },
    {
      name: 'square of four on a ring of four',
      circuit: line(4, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
        op('cx', [3], { controls: [2] }),
        op('cx', [0], { controls: [3] }),
      ]),
      device: ringDevice(4),
    },
    {
      name: 'square of four on a ring of five',
      circuit: line(4, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
        op('cx', [3], { controls: [2] }),
        op('cx', [0], { controls: [3] }),
      ]),
      device: ringDevice(5),
    },
    {
      name: 'square of four on a ring of six',
      circuit: line(4, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
        op('cx', [3], { controls: [2] }),
        op('cx', [0], { controls: [3] }),
      ]),
      device: ringDevice(6),
    },
    {
      name: 'the only fitting pair is a broken one',
      circuit: line(2, [op('cx', [1], { controls: [0] })]),
      device: targetOf(
        'broken',
        3,
        [
          { a: 0, b: 1, error: 1 },
          { a: 1, b: 2, error: 1 },
        ],
        [{ gateError: 1e-4 }, { gateError: 1e-4 }, { gateError: 1e-4 }]
      ),
    },
  ]

  for (const entry of CASES) {
    it(entry.name, () => {
      const graph = deviceGraph(entry.device)
      const outcome = safeTranspile(entry.circuit, graph, {
        requireMeasurement: false,
      })
      const expected = bruteForceEmbeds(entry.circuit, entry.device)
      if (outcome.ok !== expected) {
        throw new Error(
          `${entry.name}: brute force says embeddable=${String(expected)}, ` +
            `the package answered ${
              outcome.ok ? 'a plan' : `refusal "${outcome.refusal.code}"`
            }`
        )
      }
      if (outcome.ok) {
        const pairs = usablePairs(entry.device)
        const decomposition = decomposeCircuit(entry.circuit)
        for (const interaction of decomposition.interactions) {
          const a = outcome.value.layout[interaction.a] as number
          const b = outcome.value.layout[interaction.b] as number
          expect(
            pairs.has(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
          ).toBe(true)
        }
      }
    })
  }
})

/* ──────────── the cheapest embedding really is the cheapest ───────────── */

function infidelity(error: number | undefined): number {
  if (error === undefined || !Number.isFinite(error) || error <= 0) return 0
  return error >= 1 ? Infinity : -Math.log(1 - error)
}

function bruteForceBestCost(
  circuit: Circuit,
  target: DeviceTarget
): number | null {
  const decomposition = decomposeCircuit(circuit)
  const pairs = new Map<string, number | undefined>()
  const brokenQubit = new Set<number>()
  for (const [qubit, properties] of (target.qubitProperties ?? []).entries()) {
    if (properties.gateError !== undefined && properties.gateError >= 1) {
      brokenQubit.add(qubit)
    }
  }
  for (const pair of target.coupling) {
    if (pair.error !== undefined && pair.error >= 1) continue
    if (brokenQubit.has(pair.a) || brokenQubit.has(pair.b)) continue
    pairs.set(
      `${String(Math.min(pair.a, pair.b))}-${String(Math.max(pair.a, pair.b))}`,
      pair.error
    )
  }
  const measured = new Set(decomposition.measured)

  let best: number | null = null
  for (const layout of injections(circuit.qubits, target.qubits)) {
    if (layout.some((physical) => brokenQubit.has(physical))) continue
    let cost = 0
    let fits = true
    for (const entry of decomposition.interactions) {
      const a = layout[entry.a] as number
      const b = layout[entry.b] as number
      const key = `${String(Math.min(a, b))}-${String(Math.max(a, b))}`
      if (!pairs.has(key)) {
        fits = false
        break
      }
      cost += entry.count * infidelity(pairs.get(key))
    }
    if (!fits) continue
    for (let logical = 0; logical < circuit.qubits; logical++) {
      const physical = layout[logical] as number
      const properties = target.qubitProperties?.[physical]
      cost +=
        (decomposition.pulses[logical] ?? 0) *
          infidelity(properties?.gateError) +
        (measured.has(logical) ? infidelity(properties?.readoutError) : 0)
    }
    if (best === null || cost < best) best = cost
  }
  return best
}

describe('the search returns the cheapest embedding, not merely one', () => {
  const noisy = targetOf(
    'noisy-path',
    6,
    [
      { a: 0, b: 1, error: 0.05 },
      { a: 1, b: 2, error: 0.002 },
      { a: 2, b: 3, error: 0.03 },
      { a: 3, b: 4, error: 0.001 },
      { a: 4, b: 5, error: 0.04 },
    ],
    [
      { gateError: 3e-4, readoutError: 0.02 },
      { gateError: 9e-4, readoutError: 0.3 },
      { gateError: 2e-4, readoutError: 0.01 },
      { gateError: 1e-4, readoutError: 0.005 },
      { gateError: 5e-4, readoutError: 0.4 },
      { gateError: 8e-4, readoutError: 0.05 },
    ]
  )

  const cases: readonly { name: string; circuit: Circuit }[] = [
    {
      name: 'a measured bell pair',
      circuit: withMeasure(2, [op('h', [0]), op('cx', [1], { controls: [0] })]),
    },
    {
      name: 'a measured chain of three',
      circuit: withMeasure(3, [
        op('h', [0]),
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
      ]),
    },
    {
      name: 'an unmeasured chain of three',
      circuit: line(3, [
        op('h', [0]),
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [1] }),
        op('t', [2]),
      ]),
    },
    {
      name: 'a chain with one idle measured wire',
      circuit: withMeasure(3, [op('h', [0]), op('cx', [1], { controls: [0] })]),
    },
  ]

  for (const entry of cases) {
    it(entry.name, () => {
      const graph = deviceGraph(noisy)
      const decomposition = decomposeCircuit(entry.circuit)
      const placement = place(decomposition, graph)
      const expected = bruteForceBestCost(entry.circuit, noisy)
      expect(expected).not.toBeNull()
      expect(placement.cost).toBeCloseTo(expected as number, 12)
    })
  }
})

/* ─────────────────── a refusal that names the wrong thing ─────────────── */

describe('refusal codes', () => {
  it('a toffoli on heavy-hex is refused for the lattice, with both numbers', () => {
    const graph = deviceGraph(HERON)
    const outcome = safeTranspile(
      line(3, [op('ccx', [2], { controls: [0, 1] })]),
      graph,
      { requireMeasurement: false }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal.code).toBe('cycle-too-short')
    expect(outcome.refusal.detail).toMatchObject({
      circuitGirth: 3,
      deviceGirth: 12,
    })
  })

  it('a qubit needing four partners is refused for the degree', () => {
    const graph = deviceGraph(HERON)
    const outcome = safeTranspile(
      line(5, [
        op('cx', [1], { controls: [0] }),
        op('cx', [2], { controls: [0] }),
        op('cx', [3], { controls: [0] }),
        op('cx', [4], { controls: [0] }),
      ]),
      graph,
      { requireMeasurement: false }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal.code).toBe('degree-exceeded')
  })

  it('a refusal is a TranspileRefusal and carries the offending operations', () => {
    const graph = deviceGraph(HERON)
    const outcome = safeTranspile(
      line(3, [op('ccx', [2], { controls: [0, 1] })]),
      graph,
      { requireMeasurement: false }
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal).toBeInstanceOf(TranspileRefusal)
    expect(outcome.refusal.operationIds.length).toBeGreaterThan(0)
  })
})
