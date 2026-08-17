/**
 * Circuit fixtures shared between suites.
 *
 * A test file cannot be imported from another without executing its `describe`
 * blocks, and the decomposition suite, the placement suite and the endianness
 * suite all need the same handful of shapes — so they live here, the same
 * arrangement `packages/qsim/src/testing/` uses. Excluded from the build by
 * `tsconfig.build.json` and never re-exported from `index.ts`.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  type Circuit,
  type Control,
  type Operation,
} from '@qsim/schema'

/** One gate on its own wires, for the exhaustive decomposition test. */
export function gateCircuit(
  qubits: number,
  gate: string,
  targets: readonly number[],
  options: {
    readonly controls?: readonly Control[]
    readonly params?: readonly number[]
  } = {}
): Circuit {
  const operation: Operation = {
    id: 'g0',
    gate,
    targets: [...targets],
    column: 0,
    ...(options.controls === undefined
      ? {}
      : { controls: [...options.controls] }),
    ...(options.params === undefined ? {} : { params: [...options.params] }),
  }
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations: [operation],
  }
}

/** A circuit from a plain list of operations, columns assigned in order. */
export function sequence(
  qubits: number,
  clbits: number,
  operations: readonly Omit<Operation, 'id' | 'column'>[]
): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits,
    operations: operations.map((operation, index) => ({
      ...operation,
      id: `o${String(index)}`,
      column: index,
    })),
  }
}

/**
 * Deliberately asymmetric: `x` on qubit 0 only, and the two wires measured
 * into *crossed* classical bits.
 *
 * Every endianness claim in this package is tested against a circuit like
 * this rather than against a Bell pair. A Bell pair's distribution is
 * invariant under swapping the two wires and under reversing the bit order, so
 * it agrees with a mirrored implementation of itself and proves nothing. This
 * one answers `10` under the right convention and `01` under any of the three
 * wrong ones.
 */
export function asymmetricPair(): Circuit {
  return sequence(2, 2, [
    { gate: 'x', targets: [0] },
    { gate: 'measure', targets: [0], clbitTargets: [1] },
    { gate: 'measure', targets: [1], clbitTargets: [0] },
  ])
}

/** A Bell pair, measured straight through. Adjacency: one pair. */
export function bellPair(): Circuit {
  return sequence(2, 2, [
    { gate: 'h', targets: [0] },
    { gate: 'cx', targets: [1], controls: [0] },
    { gate: 'measure', targets: [0], clbitTargets: [0] },
    { gate: 'measure', targets: [1], clbitTargets: [1] },
  ])
}

/** A three-qubit chain: 0–1 and 1–2 interact, 0 and 2 never do. */
export function chain(): Circuit {
  return sequence(3, 3, [
    { gate: 'h', targets: [0] },
    { gate: 'cx', targets: [1], controls: [0] },
    { gate: 'cx', targets: [2], controls: [1] },
    { gate: 'measure', targets: [0], clbitTargets: [0] },
    { gate: 'measure', targets: [1], clbitTargets: [1] },
    { gate: 'measure', targets: [2], clbitTargets: [2] },
  ])
}

/** A star: qubit 0 interacts with 1, 2, 3 and 4 — degree four. */
export function star(points: number): Circuit {
  return sequence(points + 1, 0, [
    { gate: 'h', targets: [0] },
    ...Array.from({ length: points }, (_unused, index) => ({
      gate: 'cx',
      targets: [index + 1],
      controls: [0] as Control[],
    })),
  ])
}

/** A triangle: every pair of three qubits interacts. What a Toffoli needs. */
export function triangle(): Circuit {
  return sequence(3, 0, [
    { gate: 'cx', targets: [1], controls: [0] },
    { gate: 'cx', targets: [2], controls: [1] },
    { gate: 'cx', targets: [0], controls: [2] },
  ])
}

/** A tiny device: a path of `qubits` vertices, with even error rates. */
export function lineDevice(qubits: number): {
  readonly name: string
  readonly qubits: number
  readonly coupling: readonly { readonly a: number; readonly b: number }[]
} {
  return {
    name: 'line',
    qubits,
    coupling: Array.from({ length: qubits - 1 }, (_unused, index) => ({
      a: index,
      b: index + 1,
    })),
  }
}
