/**
 * Random circuit fixtures shared by the checkpoint suites.
 *
 * Extracted from checkpoints.test.ts when the wall-clock budget moved into its
 * own `.perf.test.ts` file: both suites need the same generator, and a test
 * file cannot be imported from another without executing its `describe`
 * blocks.
 *
 * Not a test file, so it is excluded from the declaration build explicitly —
 * see the `exclude` list in tsconfig.build.json. It is not re-exported from
 * index.ts either, so no consumer can reach it.
 */

import { expect } from 'vitest'

import type { Rng } from '../rng.js'
import { run, type CircuitLike, type OperationLike } from '../runner.js'
import type { Statevector } from '../statevector.js'

/**
 * The work plan's budget for incremental re-simulation: an incremental result
 * must match a full one to 1e-12. Two orders of magnitude tighter than D6's
 * 1e-10, because the two runs do the same arithmetic in the same order — only
 * the renormalisation points differ, and those move the last bits of the
 * mantissa, nothing more.
 */
export const TOLERANCE = 1e-12

export let nextId = 0

export function id(): string {
  nextId++
  return `op${nextId}`
}

export function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng.next() * values.length)]
}

export const FIXED_1Q = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'sx', 'i']
export const ANGLED_1Q = ['rx', 'ry', 'rz', 'p']
export const CONTROLLED_1Q = ['x', 'z', 'h', 'ry']

/**
 * One random operation over the qubits still free in this column, or
 * `undefined` when too few are left for the shape it drew.
 *
 * The pool deliberately spans every dispatch path in the runner — fixed and
 * parametrised one-qubit gates, symbolic parameters, positive and negative
 * controls, both swap families, the three-qubit gates and barriers — because
 * an edit that only ever produced Hadamards would exercise one branch of the
 * runner and none of the interesting ones.
 */
export function randomOperation(
  rng: Rng,
  free: number[],
  column: number
): OperationLike | undefined {
  const angle = (): number => (rng.next() - 0.5) * 6
  const take = (): number =>
    free.splice(Math.floor(rng.next() * free.length), 1)[0]

  switch (Math.floor(rng.next() * 10)) {
    case 0:
    case 1:
      return { id: id(), gate: pick(rng, FIXED_1Q), targets: [take()], column }
    case 2:
      return {
        id: id(),
        gate: pick(rng, ANGLED_1Q),
        targets: [take()],
        column,
        params: [angle()],
      }
    case 3:
      // Symbolic, so a parameter edit has somewhere to land.
      return {
        id: id(),
        gate: 'rz',
        targets: [take()],
        column,
        params: ['theta'],
      }
    case 4:
      return {
        id: id(),
        gate: 'u',
        targets: [take()],
        column,
        params: [angle(), angle(), angle()],
      }
    case 5: {
      // A one-qubit gate the user added a control to, negative two times in
      // five — the shape `applyControlled` exists for.
      if (free.length < 2) return undefined
      const gate = pick(rng, CONTROLLED_1Q)
      const target = take()
      return {
        id: id(),
        gate,
        targets: [target],
        column,
        controls: [{ qubit: take(), state: rng.next() < 0.4 ? 0 : 1 }],
        ...(gate === 'ry' ? { params: [angle()] } : {}),
      }
    }
    case 6: {
      if (free.length < 2) return undefined
      const gate = pick(rng, ['cx', 'cz', 'crz', 'cp'])
      const target = take()
      return {
        id: id(),
        gate,
        targets: [target],
        column,
        controls: [take()],
        ...(gate === 'crz' || gate === 'cp' ? { params: [angle()] } : {}),
      }
    }
    case 7: {
      if (free.length < 2) return undefined
      return {
        id: id(),
        gate: pick(rng, ['swap', 'iswap']),
        targets: [take(), take()],
        column,
      }
    }
    case 8: {
      if (free.length < 3) return undefined
      if (rng.next() < 0.5) {
        return {
          id: id(),
          gate: 'ccx',
          targets: [take()],
          column,
          controls: [take(), take()],
        }
      }
      return {
        id: id(),
        gate: 'cswap',
        targets: [take(), take()],
        column,
        controls: [take()],
      }
    }
    default:
      return { id: id(), gate: 'barrier', targets: [take()], column }
  }
}

/** A whole column: random operations over disjoint qubits, some left idle. */
export function randomColumn(
  rng: Rng,
  column: number,
  qubits: number
): OperationLike[] {
  const free: number[] = []
  for (let qubit = 0; qubit < qubits; qubit++) free.push(qubit)

  const operations: OperationLike[] = []
  while (free.length > 0) {
    if (rng.next() < 0.15) {
      // An idle wire, so columns are not uniformly packed.
      free.pop()
      continue
    }
    const operation = randomOperation(rng, free, column)
    if (operation === undefined) {
      operations.push({
        id: id(),
        gate: 'h',
        targets: [free.pop() ?? 0],
        column,
      })
      continue
    }
    operations.push(operation)
  }
  return operations
}

/** Largest difference between two states, over every real and imaginary part. */
export function maxDeviation(
  actual: Statevector,
  expected: Statevector
): number {
  let worst = 0
  for (let i = 0; i < expected.size; i++) {
    const dre = Math.abs(actual.re[i] - expected.re[i])
    const dim = Math.abs(actual.im[i] - expected.im[i])
    if (dre > worst) worst = dre
    if (dim > worst) worst = dim
  }
  return worst
}

export function expectSameState(
  actual: Statevector,
  expected: Statevector,
  label = 'largest amplitude difference'
): void {
  expect(actual.size).toBe(expected.size)
  expect(maxDeviation(actual, expected), label).toBeLessThan(TOLERANCE)
}

/** The final state of an analytic run, without a cache. */
export function fullState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') expect.unreachable('expected analytic mode')
  return result.state
}

export interface RandomCircuit {
  readonly columns: OperationLike[][]
  readonly parameters: { name: string; value: number }[]
  readonly build: () => CircuitLike
}

export function randomCircuit(
  rng: Rng,
  qubits: number,
  depth: number
): RandomCircuit {
  const columns: OperationLike[][] = []
  for (let column = 0; column < depth; column++) {
    columns.push(randomColumn(rng, column, qubits))
  }
  const parameters = [{ name: 'theta', value: 0.7 }]
  return {
    columns,
    parameters,
    build: (): CircuitLike => ({
      qubits,
      parameters,
      operations: columns.flat(),
    }),
  }
}
