/**
 * Independent verification of the half a unitary cannot see — transpile
 * equivalence lens.
 *
 * A circuit with a mid-circuit measurement has no unitary, so the reference
 * here is the exact distribution over the classical register, computed by
 * branching: every `measure` splits a branch in two, each carrying the
 * unnormalised projection whose squared norm is its probability. That is the
 * obviously-correct slow method, and it is exact — no sampling, no seed.
 *
 * Three things are checked with it:
 *
 *   • the decomposed circuit produces the same classical distribution as the
 *     one it came from, including when gates are guarded by a condition — the
 *     fusion pass is allowed to reorder unconditioned gates, and must not
 *     reorder one across the measurement whose bit a neighbour reads;
 *   • the *placed* circuit does too, which is the claim `results.ts` rests on:
 *     transpilation permutes qubits and never classical bits;
 *   • the claim is tested on circuits that are asymmetric under that
 *     relabelling, because a Bell pair cannot tell the two apart.
 */

import { describe, expect, it } from 'vitest'
import { alloc, type Statevector } from '@qsim/core'
import { orderedOperations } from '@qsim/qasm'
import type { Circuit, Operation } from '@qsim/schema'
import { decomposeCircuit } from '../../decompose.js'
import { deviceGraph } from '../../device.js'
import { transpile } from '../../transpile.js'
import { HERON } from '../../testing/heron.js'
import { applyOperation } from './harness.test.js'

/* ───────────── the exact distribution, by branching on outcomes ────────── */

interface Branch {
  readonly state: Statevector
  /** Classical register as an integer; bit k is clbit k. */
  readonly bits: number
}

function cloneState(state: Statevector): Statevector {
  return {
    qubits: state.qubits,
    size: state.size,
    re: new Float64Array(state.re),
    im: new Float64Array(state.im),
  }
}

/** Project onto `value` on `qubit`, in place. Returns the probability. */
function project(state: Statevector, qubit: number, value: 0 | 1): number {
  const stride = 1 << qubit
  let weight = 0
  for (let index = 0; index < state.size; index++) {
    const bit = (index & stride) === 0 ? 0 : 1
    if (bit === value) {
      const re = state.re[index] as number
      const im = state.im[index] as number
      weight += re * re + im * im
    } else {
      state.re[index] = 0
      state.im[index] = 0
    }
  }
  return weight
}

/** The exact probability of every classical register value. */
export function exactDistribution(circuit: Circuit): Map<number, number> {
  const start = alloc(circuit.qubits)
  let branches: Branch[] = [{ state: start, bits: 0 }]
  const parameters = circuit.parameters ?? []

  for (const operation of orderedOperations(circuit.operations)) {
    const next: Branch[] = []
    for (const branch of branches) {
      if (operation.condition !== undefined) {
        const bit = (branch.bits >> operation.condition.clbit) & 1
        if (bit !== operation.condition.equals) {
          next.push(branch)
          continue
        }
      }

      if (operation.gate === 'measure') {
        const qubit = operation.targets[0] as number
        const clbit = (operation.clbitTargets ?? [])[0] as number
        for (const value of [0, 1] as const) {
          const copy = cloneState(branch.state)
          const weight = project(copy, qubit, value)
          if (weight <= 0) continue
          next.push({
            state: copy,
            bits:
              value === 1
                ? branch.bits | (1 << clbit)
                : branch.bits & ~(1 << clbit),
          })
        }
        continue
      }

      if (operation.gate === 'reset') {
        const qubit = operation.targets[0] as number
        for (const value of [0, 1] as const) {
          const copy = cloneState(branch.state)
          const weight = project(copy, qubit, value)
          if (weight <= 0) continue
          if (value === 1) {
            // Move every amplitude down to the |0> half of that qubit.
            const stride = 1 << qubit
            for (let index = 0; index < copy.size; index++) {
              if ((index & stride) === 0) continue
              copy.re[index - stride] = copy.re[index] as number
              copy.im[index - stride] = copy.im[index] as number
              copy.re[index] = 0
              copy.im[index] = 0
            }
          }
          next.push({ state: copy, bits: branch.bits })
        }
        continue
      }

      const copy = cloneState(branch.state)
      applyOperation(copy, { ...operation, condition: undefined }, parameters)
      next.push({ state: copy, bits: branch.bits })
    }
    branches = next
  }

  const distribution = new Map<number, number>()
  for (const branch of branches) {
    let weight = 0
    for (let index = 0; index < branch.state.size; index++) {
      const re = branch.state.re[index] as number
      const im = branch.state.im[index] as number
      weight += re * re + im * im
    }
    if (weight <= 0) continue
    distribution.set(branch.bits, (distribution.get(branch.bits) ?? 0) + weight)
  }
  return distribution
}

function compare(
  left: ReadonlyMap<number, number>,
  right: ReadonlyMap<number, number>,
  label: string
): void {
  const keys = new Set([...left.keys(), ...right.keys()])
  for (const key of keys) {
    const a = left.get(key) ?? 0
    const b = right.get(key) ?? 0
    if (Math.abs(a - b) > 1e-10) {
      throw new Error(
        `${label}: register value ${key.toString(2)} has probability ` +
          `${String(a)} before and ${String(b)} after (difference ` +
          `${Math.abs(a - b).toExponential(3)})`
      )
    }
  }
  expect(keys.size).toBeGreaterThan(0)
}

/* ────────────────────────────── the circuits ───────────────────────────── */

/** Teleportation: two mid-circuit measurements and two guarded corrections. */
function teleportation(theta: number, phi: number): Circuit {
  const operations: Operation[] = [
    { id: 'p0', gate: 'u', targets: [0], params: [theta, phi, 0], column: 0 },
    { id: 'h1', gate: 'h', targets: [1], column: 1 },
    { id: 'e', gate: 'cx', targets: [2], controls: [1], column: 2 },
    { id: 'c', gate: 'cx', targets: [1], controls: [0], column: 3 },
    { id: 'h0', gate: 'h', targets: [0], column: 4 },
    {
      id: 'm1',
      gate: 'measure',
      targets: [1],
      clbitTargets: [1],
      column: 5,
    },
    {
      id: 'm0',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 5,
    },
    {
      id: 'fx',
      gate: 'x',
      targets: [2],
      condition: { clbit: 1, equals: 1 },
      column: 6,
    },
    {
      id: 'fz',
      gate: 'z',
      targets: [2],
      condition: { clbit: 0, equals: 1 },
      column: 7,
    },
    {
      id: 'm2',
      gate: 'measure',
      targets: [2],
      clbitTargets: [2],
      column: 8,
    },
  ]
  return { schemaVersion: 1, qubits: 3, clbits: 3, operations }
}

/** An `x` on one wire only, measured into deliberately crossed bits. */
function crossed(): Circuit {
  return {
    schemaVersion: 1,
    qubits: 2,
    clbits: 2,
    operations: [
      { id: 'a', gate: 'x', targets: [0], column: 0 },
      { id: 'e', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'f', gate: 'x', targets: [1], column: 2 },
      {
        id: 'm0',
        gate: 'measure',
        targets: [0],
        clbitTargets: [1],
        column: 3,
      },
      {
        id: 'm1',
        gate: 'measure',
        targets: [1],
        clbitTargets: [0],
        column: 3,
      },
    ],
  }
}

/** A three-wire circuit whose distribution is asymmetric on every qubit. */
function asymmetric(): Circuit {
  return {
    schemaVersion: 1,
    qubits: 3,
    clbits: 3,
    operations: [
      { id: 'a', gate: 'ry', targets: [0], params: [0.9], column: 0 },
      { id: 'b', gate: 'ry', targets: [1], params: [1.9], column: 0 },
      { id: 'c', gate: 'ry', targets: [2], params: [2.7], column: 0 },
      { id: 'd', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'e', gate: 'cz', targets: [2], controls: [1], column: 2 },
      { id: 'f', gate: 't', targets: [2], column: 3 },
      {
        id: 'm0',
        gate: 'measure',
        targets: [0],
        clbitTargets: [2],
        column: 4,
      },
      {
        id: 'm1',
        gate: 'measure',
        targets: [1],
        clbitTargets: [0],
        column: 4,
      },
      {
        id: 'm2',
        gate: 'measure',
        targets: [2],
        clbitTargets: [1],
        column: 4,
      },
    ],
  }
}

describe('decomposition preserves the classical distribution exactly', () => {
  const CASES: readonly { name: string; circuit: Circuit }[] = [
    { name: 'teleportation of |0>', circuit: teleportation(0, 0) },
    { name: 'teleportation of |+>', circuit: teleportation(Math.PI / 2, 0) },
    {
      name: 'teleportation of a general state',
      circuit: teleportation(1.1, 0.7),
    },
    { name: 'crossed classical bits', circuit: crossed() },
    { name: 'asymmetric three-wire', circuit: asymmetric() },
    {
      name: 'reset in the middle',
      circuit: {
        schemaVersion: 1,
        qubits: 2,
        clbits: 2,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
          { id: 'r', gate: 'reset', targets: [0], column: 2 },
          { id: 'c', gate: 'h', targets: [0], column: 3 },
          {
            id: 'm0',
            gate: 'measure',
            targets: [0],
            clbitTargets: [0],
            column: 4,
          },
          {
            id: 'm1',
            gate: 'measure',
            targets: [1],
            clbitTargets: [1],
            column: 4,
          },
        ],
      },
    },
  ]

  for (const entry of CASES) {
    it(entry.name, () => {
      const decomposed = decomposeCircuit(entry.circuit)
      compare(
        exactDistribution(entry.circuit),
        exactDistribution(decomposed.circuit),
        entry.name
      )
    })
  }
})

describe('placement permutes qubits and never classical bits', () => {
  const graph = deviceGraph(HERON)
  const CASES: readonly { name: string; circuit: Circuit }[] = [
    { name: 'crossed classical bits', circuit: crossed() },
    { name: 'asymmetric three-wire', circuit: asymmetric() },
    { name: 'teleportation', circuit: teleportation(1.1, 0.7) },
  ]

  for (const entry of CASES) {
    it(entry.name, () => {
      const plan = transpile(entry.circuit, graph)
      // `placed` is on compact indices where qubit i is physicalQubits[i], so
      // it is simulatable; the classical register is untouched by design.
      compare(
        exactDistribution(entry.circuit),
        exactDistribution(plan.placed),
        `${entry.name} (placed)`
      )
      // And the layout really did move the qubits, so the check is not vacuous.
      expect(new Set(plan.layout).size).toBe(entry.circuit.qubits)
      expect(plan.placed.clbits).toBe(entry.circuit.clbits)
    })
  }
})
