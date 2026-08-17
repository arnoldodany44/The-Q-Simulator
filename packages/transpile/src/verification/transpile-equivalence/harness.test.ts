/**
 * Independent verification harness — transpile-equivalence lens.
 *
 * Everything here is derived from the mathematics rather than from the
 * package's own tests. The dense unitary is built the obviously-correct slow
 * way: run the circuit once from each computational basis state and write the
 * resulting amplitudes into a column. Nothing in this file reuses
 * `@qsim/transpile`'s helpers for that, and the dispatch table below is
 * written out from the contract's `controlCount` metadata rather than imported
 * from `euler.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  alloc,
  apply1q,
  applyControlled,
  applyISwap,
  applySwap,
  circuitUnitary,
  matrixFor,
  type ControlSpec,
  type Statevector,
} from '@qsim/core'
import {
  controlsOf,
  resolveParams,
  type Circuit,
  type Operation,
  type Parameter,
} from '@qsim/schema'
import { orderedOperations } from '@qsim/qasm'

/* ─────────────────────── the dense unitary, slowly ────────────────────── */

export interface Dense {
  readonly dim: number
  /** Column-major: entry (row, col) at `col * dim + row`. */
  readonly re: Float64Array
  readonly im: Float64Array
}

/**
 * Which one-qubit matrix a multi-qubit catalog entry carries, written from the
 * contract's own `controlCount`/`targetCount` metadata. `swap`, `iswap` and
 * `cswap` are not on this table: they are permutations, handled separately.
 */
const CONTROLLED_BASE: Readonly<Record<string, string>> = {
  cx: 'x',
  cz: 'z',
  crz: 'rz',
  cp: 'p',
  ccx: 'x',
}

export function applyOperation(
  state: Statevector,
  operation: Operation,
  parameters: readonly Parameter[]
): void {
  if (operation.gate === 'barrier') return
  if (operation.gate === 'measure' || operation.gate === 'reset') {
    throw new Error(`"${operation.gate}" is not unitary.`)
  }
  if (operation.condition !== undefined) {
    throw new Error('A conditioned operation has no unitary.')
  }

  const params = resolveParams(operation, parameters)
  const controls: readonly ControlSpec[] = controlsOf(operation)
  const [t0, t1] = operation.targets as [number, number]

  if (operation.gate === 'swap' || operation.gate === 'cswap') {
    applySwap(state, t0, t1, controls)
    return
  }
  if (operation.gate === 'iswap') {
    applyISwap(state, t0, t1)
    return
  }

  const base = CONTROLLED_BASE[operation.gate] ?? operation.gate
  const matrix = matrixFor(base as never, params)
  if (controls.length === 0) apply1q(state, matrix, t0)
  else applyControlled(state, matrix, t0, controls)
}

/** The circuit as a matrix, one column per basis state. */
export function denseUnitary(circuit: Circuit): Dense {
  const dim = 1 << circuit.qubits
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  const ops = orderedOperations(circuit.operations)
  const parameters = circuit.parameters ?? []

  for (let col = 0; col < dim; col++) {
    const state = alloc(circuit.qubits)
    state.re[0] = 0
    state.re[col] = 1
    for (const operation of ops) applyOperation(state, operation, parameters)
    for (let row = 0; row < dim; row++) {
      re[col * dim + row] = state.re[row] as number
      im[col * dim + row] = state.im[row] as number
    }
  }
  return { dim, re, im }
}

/* ──────────────────── comparison up to a GLOBAL phase ─────────────────── */

export interface PhaseComparison {
  readonly equal: boolean
  /** Largest entrywise deviation from `b = e^{i phase} a`. */
  readonly worst: number
  readonly phase: number
  /** Where the worst deviation is, as `row,col`. */
  readonly at: string
}

/**
 * `b === e^{i phase} · a` for one real `phase`, entry for entry.
 *
 * Deliberately not a fidelity: `|Tr(A†B)|²/d²` is 1 for a global phase but
 * degrades smoothly, so a small relative phase on one branch reads as 0.999
 * and a tolerance chosen to absorb float dust would accept it. Fixing the
 * phase from the largest-modulus entry and then checking *every* entry against
 * it accepts exactly the global-phase family and nothing else.
 */
export function sameUpToGlobalPhase(
  a: Dense,
  b: Dense,
  tolerance = 1e-9
): PhaseComparison {
  if (a.dim !== b.dim) {
    return { equal: false, worst: Infinity, phase: 0, at: 'dimension' }
  }
  let pivot = 0
  let best = 0
  for (let i = 0; i < a.re.length; i++) {
    const modulus = Math.hypot(a.re[i] as number, a.im[i] as number)
    if (modulus > best) {
      best = modulus
      pivot = i
    }
  }
  if (best === 0) return { equal: false, worst: Infinity, phase: 0, at: 'zero' }

  // ratio = b[pivot] / a[pivot]
  const ar = a.re[pivot] as number
  const ai = a.im[pivot] as number
  const br = b.re[pivot] as number
  const bi = b.im[pivot] as number
  const denominator = ar * ar + ai * ai
  const rr = (br * ar + bi * ai) / denominator
  const ri = (bi * ar - br * ai) / denominator
  const phase = Math.atan2(ri, rr)
  const modulusDefect = Math.abs(Math.hypot(rr, ri) - 1)

  let worst = modulusDefect
  let at = 'modulus'
  for (let i = 0; i < a.re.length; i++) {
    const er = (a.re[i] as number) * rr - (a.im[i] as number) * ri
    const ei = (a.re[i] as number) * ri + (a.im[i] as number) * rr
    const deviation = Math.hypot(
      (b.re[i] as number) - er,
      (b.im[i] as number) - ei
    )
    if (deviation > worst) {
      worst = deviation
      at = `${String(i % a.dim)},${String(Math.floor(i / a.dim))}`
    }
  }
  return { equal: worst <= tolerance, worst, phase, at }
}

/* ─────────────────────── the harness checks itself ────────────────────── */

function circuit(qubits: number, operations: readonly Operation[]): Circuit {
  return {
    schemaVersion: 1,
    qubits,
    clbits: 0,
    operations: operations.map((operation, index) => ({
      ...operation,
      id: operation.id === '' ? `o${String(index)}` : operation.id,
    })),
  }
}

export function op(
  gate: string,
  targets: readonly number[],
  extra: Partial<Operation> = {}
): Operation {
  return {
    id: '',
    gate,
    targets: [...targets],
    column: 0,
    ...extra,
  }
}

export function line(qubits: number, gates: readonly Operation[]): Circuit {
  return circuit(
    qubits,
    gates.map((gate, index) => ({ ...gate, column: index }))
  )
}

describe('the harness agrees with @qsim/core about what a circuit means', () => {
  const cases: readonly { name: string; value: Circuit }[] = [
    {
      name: 'h then cx',
      value: line(2, [op('h', [0]), op('cx', [1], { controls: [0] })]),
    },
    { name: 'swap', value: line(2, [op('x', [0]), op('swap', [0, 1])]) },
    { name: 'iswap', value: line(2, [op('h', [0]), op('iswap', [0, 1])]) },
    {
      name: 'ccx',
      value: line(3, [
        op('h', [0]),
        op('h', [1]),
        op('ccx', [2], { controls: [0, 1] }),
      ]),
    },
    {
      name: 'cswap',
      value: line(3, [
        op('x', [1]),
        op('h', [0]),
        op('cswap', [1, 2], { controls: [0] }),
      ]),
    },
    {
      name: 'negative control',
      value: line(2, [
        op('h', [0]),
        op('x', [1], { controls: [{ qubit: 0, state: 0 }] }),
      ]),
    },
    {
      name: 'crz and cp differ',
      value: line(2, [
        op('h', [0]),
        op('crz', [1], { controls: [0], params: [0.7] }),
      ]),
    },
  ]

  for (const entry of cases) {
    it(entry.name, () => {
      const mine = denseUnitary(entry.value)
      const theirs = circuitUnitary(entry.value)
      const wrapped: Dense = {
        dim: mine.dim,
        re: theirs.re,
        im: theirs.im,
      }
      const comparison = sameUpToGlobalPhase(mine, wrapped, 1e-12)
      expect(comparison.worst).toBeLessThan(1e-12)
      expect(comparison.phase).toBeCloseTo(0, 12)
    })
  }

  it('rejects a relative phase, which is the whole point', () => {
    const crz = denseUnitary(
      line(2, [op('crz', [1], { controls: [0], params: [0.7] })])
    )
    const cp = denseUnitary(
      line(2, [op('cp', [1], { controls: [0], params: [0.7] })])
    )
    expect(sameUpToGlobalPhase(crz, cp).equal).toBe(false)
  })
})
