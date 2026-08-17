/**
 * Does the placer ever refuse a circuit that fits, or accept one that does
 * not — on the real 156-qubit lattice, where brute force over every injective
 * map is not an option.
 *
 * The reference is a second embedding search, written independently of
 * `placement.ts`: plain backtracking over connected components, no cost
 * model, no seed ordering, no node budget. It answers only "does an embedding
 * exist", which is exactly the question a refusal makes a claim about.
 */

import { describe, expect, it } from 'vitest'
import type { Circuit, Operation } from '@qsim/schema'
import { decomposeCircuit, type Interaction } from '../../decompose.js'
import { deviceGraph } from '../../device.js'
import { safeTranspile } from '../../transpile.js'
import { HERON } from '../../testing/heron.js'
import { line, op } from './harness.test.js'

/* ─────────────── an independent "does it embed at all" search ──────────── */

interface Lattice {
  readonly qubits: number
  readonly neighbours: readonly (readonly number[])[]
  readonly usable: ReadonlySet<number>
  adjacent(a: number, b: number): boolean
}

function latticeOf(): Lattice {
  const brokenQubit = new Set<number>()
  for (const [qubit, properties] of (HERON.qubitProperties ?? []).entries()) {
    if (properties.gateError !== undefined && properties.gateError >= 1) {
      brokenQubit.add(qubit)
    }
  }
  const neighbours: number[][] = Array.from(
    { length: HERON.qubits },
    (): number[] => []
  )
  const edges = new Set<string>()
  for (const pair of HERON.coupling) {
    if (pair.error !== undefined && pair.error >= 1) continue
    if (brokenQubit.has(pair.a) || brokenQubit.has(pair.b)) continue
    neighbours[pair.a]?.push(pair.b)
    neighbours[pair.b]?.push(pair.a)
    edges.add(
      `${String(Math.min(pair.a, pair.b))}-${String(Math.max(pair.a, pair.b))}`
    )
  }
  const usable = new Set(
    Array.from({ length: HERON.qubits }, (_unused, q) => q).filter(
      (q) => !brokenQubit.has(q)
    )
  )
  return {
    qubits: HERON.qubits,
    neighbours,
    usable,
    adjacent(a, b) {
      return edges.has(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
    },
  }
}

/** Plain backtracking: does the interaction graph embed in the lattice? */
function embeds(
  interactions: readonly Interaction[],
  qubits: number,
  lattice: Lattice
): boolean {
  const adjacency: number[][] = Array.from(
    { length: qubits },
    (): number[] => []
  )
  for (const entry of interactions) {
    adjacency[entry.a]?.push(entry.b)
    adjacency[entry.b]?.push(entry.a)
  }
  const active = Array.from({ length: qubits }, (_unused, q) => q).filter(
    (q) => (adjacency[q] ?? []).length > 0
  )
  if (active.length === 0) return qubits <= lattice.usable.size

  // A depth-first order in which each qubit after a component root has an
  // already-ordered neighbour. Independent of `searchOrder`: no degree
  // heuristic, no BFS, just the first unvisited neighbour.
  const order: number[] = []
  const seen = new Set<number>()
  const visit = (qubit: number): void => {
    seen.add(qubit)
    order.push(qubit)
    for (const next of adjacency[qubit] ?? []) {
      if (!seen.has(next)) visit(next)
    }
  }
  for (const qubit of active) if (!seen.has(qubit)) visit(qubit)

  const layout = new Map<number, number>()
  const used = new Set<number>()

  const step = (index: number): boolean => {
    if (index === order.length) return true
    const qubit = order[index] as number
    const anchor = (adjacency[qubit] ?? []).find((partner) =>
      layout.has(partner)
    )
    const candidates =
      anchor === undefined
        ? [...lattice.usable]
        : (lattice.neighbours[layout.get(anchor) as number] ?? [])
    for (const physical of candidates) {
      if (used.has(physical) || !lattice.usable.has(physical)) continue
      const ok = (adjacency[qubit] ?? []).every((partner) => {
        const other = layout.get(partner)
        return other === undefined || lattice.adjacent(physical, other)
      })
      if (!ok) continue
      layout.set(qubit, physical)
      used.add(physical)
      if (step(index + 1)) return true
      used.delete(physical)
      layout.delete(qubit)
    }
    return false
  }

  if (!step(0)) return false
  // Idle wires still need distinct homes.
  return qubits - order.length <= lattice.usable.size - used.size
}

/* ─────────────────────────── the random circuits ───────────────────────── */

function randomCircuit(random: () => number): Circuit {
  const qubits = 2 + Math.floor(random() * 4)
  const gates: Operation[] = []
  const entanglers = 1 + Math.floor(random() * 5)
  for (let i = 0; i < entanglers; i++) {
    const a = Math.floor(random() * qubits)
    let b = Math.floor(random() * qubits)
    if (b === a) b = (a + 1) % qubits
    const roll = random()
    if (roll < 0.5) {
      gates.push(op('cx', [b], { controls: [a] }))
    } else if (roll < 0.7) {
      gates.push(op('cz', [b], { controls: [a] }))
    } else if (roll < 0.85) {
      gates.push(op('swap', [a, b]))
    } else {
      gates.push(op('cp', [b], { controls: [a], params: [random() * 3] }))
    }
    gates.push(op('h', [a]))
  }
  const body = line(qubits, gates)
  return {
    ...body,
    clbits: qubits,
    operations: [
      ...body.operations,
      ...Array.from({ length: qubits }, (_unused, qubit) => ({
        id: `m${String(qubit)}`,
        gate: 'measure',
        targets: [qubit],
        clbitTargets: [qubit],
        column: gates.length,
      })),
    ],
  }
}

describe('on the real lattice, a refusal and an acceptance both hold up', () => {
  it('300 random circuits agree with an independent embedding search', () => {
    const graph = deviceGraph(HERON)
    const lattice = latticeOf()
    const pairs = new Set(
      graph.edges.map((edge) => `${String(edge.a)}-${String(edge.b)}`)
    )

    let seed = 0x51f3c9
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    let accepted = 0
    let refused = 0
    for (let trial = 0; trial < 300; trial++) {
      const circuit = randomCircuit(random)
      const decomposition = decomposeCircuit(circuit)
      const expected = embeds(
        decomposition.interactions,
        circuit.qubits,
        lattice
      )
      const outcome = safeTranspile(circuit, graph)

      if (outcome.ok !== expected) {
        throw new Error(
          `trial ${String(trial)}: independent search says embeddable=` +
            `${String(expected)}, package said ${
              outcome.ok ? 'a plan' : `refusal "${outcome.refusal.code}"`
            }. Interactions: ${JSON.stringify(
              decomposition.interactions.map((entry) => [entry.a, entry.b])
            )}`
        )
      }

      if (outcome.ok) {
        accepted++
        for (const interaction of decomposition.interactions) {
          const a = outcome.value.layout[interaction.a] as number
          const b = outcome.value.layout[interaction.b] as number
          expect(
            pairs.has(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
          ).toBe(true)
        }
        expect(new Set(outcome.value.layout).size).toBe(circuit.qubits)
      } else {
        refused++
      }
    }

    // Both branches have to be exercised or the test proves nothing.
    expect(accepted).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })
})

/* ───────────── the program says nothing the backend cannot read ────────── */

describe('the submitted program names only what the backend runs', () => {
  const NATIVE = new Set(['rz', 'sx', 'x', 'id', 'cz', 'barrier', 'reset'])

  it('every statement of every accepted random circuit', () => {
    const graph = deviceGraph(HERON)
    let seed = 0x9a17b3
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    let checked = 0
    for (let trial = 0; trial < 200; trial++) {
      const outcome = safeTranspile(randomCircuit(random), graph)
      if (!outcome.ok) continue
      checked++
      for (const raw of outcome.value.qasm.split('\n')) {
        const trimmed = raw.trim()
        if (trimmed === '' || trimmed.startsWith('//')) continue
        if (
          trimmed === 'OPENQASM 3.0;' ||
          trimmed.startsWith('include ') ||
          /^bit\[\d+]\s+c;$/.test(trimmed)
        ) {
          continue
        }
        if (trimmed.startsWith('c[')) {
          expect(trimmed).toMatch(/^c\[\d+] = measure \$\d+;$/)
          continue
        }
        const head = /^([a-z]+)/.exec(trimmed)?.[1]
        expect(NATIVE.has(head ?? '')).toBe(true)
        // No virtual register survived the rewrite.
        expect(trimmed).not.toContain('q[')
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
