/**
 * An independent, deliberately slow reference simulator, written from the
 * textbook definitions rather than from `@qsim/core`.
 *
 * The point of the file is that it shares no code with the thing it checks.
 * `qiskit-agreement.test.ts` already compares the *exporter* against a second
 * simulator; this one exists so the round trip can be judged against a third
 * opinion, and so that "what the circuit computes" is defined here rather than
 * borrowed from `equivalence.ts`, whose fingerprint is a structural comparison
 * and cannot see a wrong matrix at all.
 *
 * Conventions, chosen from Qiskit's published ones and not from this repo:
 *   - amplitude index bit k is the value of qubit k (q0 is least significant)
 *   - U(θ,φ,λ) is the unphased matrix, i.e. Qiskit's UGate
 *   - iSWAP maps |01⟩ and |10⟩ to i|10⟩ and i|01⟩
 */

import type { Circuit, Operation } from '@qsim/schema'

export interface Vec {
  readonly re: Float64Array
  readonly im: Float64Array
}

export type Mat2 = readonly [number, number][] // unused placeholder

/** A 2x2 complex matrix as [re, im] pairs in row-major order. */
export type M2 = readonly [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
]

const HALF_SQRT = Math.SQRT1_2

export function m2(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number]
): M2 {
  return [a, b, c, d]
}

export function fixedMatrix(gate: string): M2 | undefined {
  switch (gate) {
    case 'i':
      return m2([1, 0], [0, 0], [0, 0], [1, 0])
    case 'x':
      return m2([0, 0], [1, 0], [1, 0], [0, 0])
    case 'y':
      return m2([0, 0], [0, -1], [0, 1], [0, 0])
    case 'z':
      return m2([1, 0], [0, 0], [0, 0], [-1, 0])
    case 'h':
      return m2([HALF_SQRT, 0], [HALF_SQRT, 0], [HALF_SQRT, 0], [-HALF_SQRT, 0])
    case 's':
      return m2([1, 0], [0, 0], [0, 0], [0, 1])
    case 'sdg':
      return m2([1, 0], [0, 0], [0, 0], [0, -1])
    case 't':
      return m2([1, 0], [0, 0], [0, 0], [HALF_SQRT, HALF_SQRT])
    case 'tdg':
      return m2([1, 0], [0, 0], [0, 0], [HALF_SQRT, -HALF_SQRT])
    case 'sx':
      return m2([0.5, 0.5], [0.5, -0.5], [0.5, -0.5], [0.5, 0.5])
    default:
      return undefined
  }
}

export function paramMatrix(gate: string, params: readonly number[]): M2 {
  const [a = 0, b = 0, c = 0] = params
  switch (gate) {
    case 'rx': {
      const co = Math.cos(a / 2)
      const si = Math.sin(a / 2)
      return m2([co, 0], [0, -si], [0, -si], [co, 0])
    }
    case 'ry': {
      const co = Math.cos(a / 2)
      const si = Math.sin(a / 2)
      return m2([co, 0], [-si, 0], [si, 0], [co, 0])
    }
    case 'rz':
      return m2(
        [Math.cos(a / 2), -Math.sin(a / 2)],
        [0, 0],
        [0, 0],
        [Math.cos(a / 2), Math.sin(a / 2)]
      )
    case 'p':
      return m2([1, 0], [0, 0], [0, 0], [Math.cos(a), Math.sin(a)])
    case 'u': {
      const co = Math.cos(a / 2)
      const si = Math.sin(a / 2)
      return m2(
        [co, 0],
        [-Math.cos(c) * si, -Math.sin(c) * si],
        [Math.cos(b) * si, Math.sin(b) * si],
        [Math.cos(b + c) * co, Math.sin(b + c) * co]
      )
    }
    default:
      throw new Error(`reference simulator has no matrix for "${gate}"`)
  }
}

export function matrixOf(gate: string, params: readonly number[]): M2 {
  return fixedMatrix(gate) ?? paramMatrix(gate, params)
}

export function alloc(qubits: number): Vec {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re[0] = 1
  return { re, im }
}

export function basis(qubits: number, index: number): Vec {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re[index] = 1
  return { re, im }
}

function bit(index: number, qubit: number): number {
  return (index >> qubit) & 1
}

export interface Ctrl {
  readonly qubit: number
  readonly state: 0 | 1
}

function fires(index: number, controls: readonly Ctrl[]): boolean {
  return controls.every(
    (control) => bit(index, control.qubit) === control.state
  )
}

/** One-qubit matrix on `target`, gated by `controls`. */
export function apply1(
  state: Vec,
  matrix: M2,
  target: number,
  controls: readonly Ctrl[]
): void {
  const [m00, m01, m10, m11] = matrix
  for (let index = 0; index < state.re.length; index++) {
    if (bit(index, target) !== 0) continue
    if (!fires(index, controls)) continue
    const other = index | (1 << target)
    const ar = state.re[index] as number
    const ai = state.im[index] as number
    const br = state.re[other] as number
    const bi = state.im[other] as number
    state.re[index] = m00[0] * ar - m00[1] * ai + (m01[0] * br - m01[1] * bi)
    state.im[index] = m00[0] * ai + m00[1] * ar + (m01[0] * bi + m01[1] * br)
    state.re[other] = m10[0] * ar - m10[1] * ai + (m11[0] * br - m11[1] * bi)
    state.im[other] = m10[0] * ai + m10[1] * ar + (m11[0] * bi + m11[1] * br)
  }
}

/** SWAP or iSWAP on two targets, gated by `controls`. */
export function apply2(
  state: Vec,
  kind: 'swap' | 'iswap',
  a: number,
  b: number,
  controls: readonly Ctrl[]
): void {
  for (let index = 0; index < state.re.length; index++) {
    if (bit(index, a) !== 0 || bit(index, b) !== 1) continue
    if (!fires(index, controls)) continue
    const other = (index | (1 << a)) & ~(1 << b)
    const ar = state.re[index] as number
    const ai = state.im[index] as number
    const br = state.re[other] as number
    const bi = state.im[other] as number
    if (kind === 'swap') {
      state.re[index] = br
      state.im[index] = bi
      state.re[other] = ar
      state.im[other] = ai
    } else {
      // i · (the swapped amplitude)
      state.re[index] = -bi
      state.im[index] = br
      state.re[other] = -ai
      state.im[other] = ar
    }
  }
}

/* ─────────────────── the circuit document, simulated ─────────────────── */

/** A primitive the reference simulator understands. */
export interface RefOp {
  readonly kind: 'gate' | 'measure' | 'reset' | 'barrier'
  readonly gate?: string
  readonly targets: readonly number[]
  readonly controls: readonly Ctrl[]
  readonly params: readonly number[]
  readonly clbit?: number
  readonly condition?: { readonly clbit: number; readonly equals: 0 | 1 }
  readonly column: number
}

function resolveParam(
  value: number | string,
  parameters: readonly { name: string; value: number }[]
): number {
  if (typeof value === 'number') return value
  const found = parameters.find((entry) => entry.name === value)
  if (found === undefined) throw new Error(`unknown parameter "${value}"`)
  return found.value
}

/**
 * Flattens a circuit document to primitives, expanding custom gates by hand so
 * that nothing in this file depends on `expandCircuit`.
 *
 * Columns are preserved for top-level operations; an expanded body keeps its
 * caller's column, which is harmless because everything inside a block acts on
 * the caller's own qubits and the caller occupied them for that column.
 */
export function flatten(circuit: Circuit): RefOp[] {
  const parameters = circuit.parameters ?? []
  const out: RefOp[] = []

  const walk = (
    operations: readonly Operation[],
    wires: readonly number[] | null,
    bindings: ReadonlyMap<string, number>,
    column: number | null,
    depth: number
  ): void => {
    if (depth > 40) throw new Error('custom gate nesting is too deep')
    for (const operation of operations) {
      const targets = operation.targets.map((qubit) =>
        wires === null ? qubit : (wires[qubit] as number)
      )
      const controls: Ctrl[] = (operation.controls ?? []).map((control) =>
        typeof control === 'number'
          ? {
              qubit: wires === null ? control : (wires[control] as number),
              state: 1,
            }
          : {
              qubit:
                wires === null
                  ? control.qubit
                  : (wires[control.qubit] as number),
              state: control.state,
            }
      )
      const params = (operation.params ?? []).map((value) => {
        if (typeof value === 'number') return value
        const bound = bindings.get(value)
        if (bound !== undefined) return bound
        return resolveParam(value, parameters)
      })
      const at = column ?? operation.column

      const definition = circuit.customGates?.[operation.gate]
      if (definition !== undefined) {
        const formals = definition.params ?? []
        const inner = new Map<string, number>()
        formals.forEach((name, index) => {
          inner.set(name, params[index] as number)
        })
        walk(definition.operations, targets, inner, at, depth + 1)
        continue
      }

      if (operation.gate === 'barrier') {
        out.push({
          kind: 'barrier',
          targets,
          controls: [],
          params: [],
          column: at,
        })
        continue
      }
      if (operation.gate === 'reset') {
        out.push({
          kind: 'reset',
          targets,
          controls: [],
          params: [],
          column: at,
          ...(operation.condition === undefined
            ? {}
            : { condition: operation.condition }),
        })
        continue
      }
      if (operation.gate === 'measure') {
        out.push({
          kind: 'measure',
          targets,
          controls: [],
          params: [],
          clbit: (operation.clbitTargets ?? [])[0],
          column: at,
          ...(operation.condition === undefined
            ? {}
            : { condition: operation.condition }),
        })
        continue
      }

      // Catalog names that are a kernel plus built-in controls.
      const builtIn: Record<string, { kernel: string; controls: number }> = {
        cx: { kernel: 'x', controls: 1 },
        cz: { kernel: 'z', controls: 1 },
        crz: { kernel: 'rz', controls: 1 },
        cp: { kernel: 'p', controls: 1 },
        ccx: { kernel: 'x', controls: 2 },
        cswap: { kernel: 'swap', controls: 1 },
      }
      const shape = builtIn[operation.gate]
      const kernel = shape?.kernel ?? operation.gate
      out.push({
        kind: 'gate',
        gate: kernel,
        targets,
        controls,
        params,
        column: at,
        ...(operation.condition === undefined
          ? {}
          : { condition: operation.condition }),
      })
    }
  }

  walk(circuit.operations, null, new Map(), null, 0)
  return out
}

export function applyRefOp(state: Vec, op: RefOp): void {
  if (op.kind !== 'gate') throw new Error('not a unitary op')
  const gate = op.gate as string
  if (gate === 'swap' || gate === 'iswap') {
    apply2(
      state,
      gate,
      op.targets[0] as number,
      op.targets[1] as number,
      op.controls
    )
    return
  }
  apply1(state, matrixOf(gate, op.params), op.targets[0] as number, op.controls)
}

/**
 * The full 2ⁿ × 2ⁿ matrix of a unitary-only circuit, column by column.
 *
 * Slow on purpose: one whole simulation per basis state. It compares *with*
 * global phase, which is what makes it able to see a dropped `gphase` that a
 * probability comparison never could.
 */
export function unitaryOf(circuit: Circuit): Vec[] {
  return unitaryOfOps(flatten(circuit), circuit.qubits)
}

export function unitaryOfOps(all: readonly RefOp[], qubits: number): Vec[] {
  const ops = all.filter((op) => op.kind !== 'barrier')
  if (ops.some((op) => op.kind !== 'gate')) {
    throw new Error('unitaryOf: circuit contains a measurement or a reset')
  }
  const columns: Vec[] = []
  for (let index = 0; index < 1 << qubits; index++) {
    const state = basis(qubits, index)
    for (const op of ops) applyRefOp(state, op)
    columns.push(state)
  }
  return columns
}

/** Largest entrywise difference between two matrices given as column lists. */
export function matrixDistance(left: Vec[], right: Vec[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY
  let worst = 0
  for (let column = 0; column < left.length; column++) {
    const a = left[column] as Vec
    const b = right[column] as Vec
    if (a.re.length !== b.re.length) return Number.POSITIVE_INFINITY
    for (let row = 0; row < a.re.length; row++) {
      worst = Math.max(
        worst,
        Math.abs((a.re[row] as number) - (b.re[row] as number)),
        Math.abs((a.im[row] as number) - (b.im[row] as number))
      )
    }
  }
  return worst
}

/* ───────────────── circuits with a classical register ────────────────── */

export interface Branch {
  readonly state: Vec
  readonly register: number
  readonly probability: number
}

/**
 * Every measurement branch of a circuit, enumerated exactly.
 *
 * Column semantics follow the engine's documented rule: a condition reads the
 * register **as it entered the column**, so the register snapshot is taken
 * once per column and every condition in that column is judged against it.
 */
export function branches(circuit: Circuit): Branch[] {
  return branchesOfOps(flatten(circuit), circuit.qubits)
}

export function branchesOfOps(
  all: readonly RefOp[],
  qubitCount: number
): Branch[] {
  const circuit = { qubits: qubitCount }
  const ops = all.filter((op) => op.kind !== 'barrier')
  const byColumn = new Map<number, RefOp[]>()
  for (const op of ops) {
    const list = byColumn.get(op.column) ?? []
    list.push(op)
    byColumn.set(op.column, list)
  }
  const columns = [...byColumn.keys()].sort((a, b) => a - b)

  let live: Branch[] = [
    { state: alloc(circuit.qubits), register: 0, probability: 1 },
  ]

  for (const column of columns) {
    const ops_ = byColumn.get(column) as RefOp[]
    const next: Branch[] = []
    for (const branch of live) {
      let current: Branch[] = [branch]
      const snapshot = branch.register
      for (const op of ops_) {
        const grown: Branch[] = []
        for (const item of current) {
          const enabled =
            op.condition === undefined ||
            ((snapshot >> op.condition.clbit) & 1) === op.condition.equals
          if (!enabled) {
            grown.push(item)
            continue
          }
          if (op.kind === 'gate') {
            const copy = cloneVec(item.state)
            applyRefOp(copy, op)
            grown.push({ ...item, state: copy })
            continue
          }
          const target = op.targets[0] as number
          const [zero, one] = split(item.state, target)
          if (op.kind === 'reset') {
            // Both outcomes end in |0⟩; the one branch is the |1⟩ branch with
            // the qubit flipped.
            if (zero.probability > 0) {
              grown.push({
                state: zero.state,
                register: item.register,
                probability: item.probability * zero.probability,
              })
            }
            if (one.probability > 0) {
              const flipped = one.state
              apply1(flipped, fixedMatrix('x') as M2, target, [])
              grown.push({
                state: flipped,
                register: item.register,
                probability: item.probability * one.probability,
              })
            }
            continue
          }
          // measure
          const clbit = op.clbit as number
          if (zero.probability > 1e-15) {
            grown.push({
              state: zero.state,
              register: item.register & ~(1 << clbit),
              probability: item.probability * zero.probability,
            })
          }
          if (one.probability > 1e-15) {
            grown.push({
              state: one.state,
              register: item.register | (1 << clbit),
              probability: item.probability * one.probability,
            })
          }
        }
        current = grown
      }
      next.push(...current)
    }
    live = next
  }
  return live
}

function cloneVec(state: Vec): Vec {
  return { re: state.re.slice(), im: state.im.slice() }
}

/** Projects onto qubit = 0 and qubit = 1, each renormalised. */
function split(
  state: Vec,
  qubit: number
): [{ state: Vec; probability: number }, { state: Vec; probability: number }] {
  const zero = cloneVec(state)
  const one = cloneVec(state)
  let p0 = 0
  let p1 = 0
  for (let index = 0; index < state.re.length; index++) {
    const weight =
      (state.re[index] as number) ** 2 + (state.im[index] as number) ** 2
    if (bit(index, qubit) === 0) {
      p0 += weight
      one.re[index] = 0
      one.im[index] = 0
    } else {
      p1 += weight
      zero.re[index] = 0
      zero.im[index] = 0
    }
  }
  normalise(zero, p0)
  normalise(one, p1)
  return [
    { state: zero, probability: p0 },
    { state: one, probability: p1 },
  ]
}

function normalise(state: Vec, probability: number): void {
  if (probability <= 0) return
  const scale = 1 / Math.sqrt(probability)
  for (let index = 0; index < state.re.length; index++) {
    state.re[index] = (state.re[index] as number) * scale
    state.im[index] = (state.im[index] as number) * scale
  }
}

/**
 * P(classical register = r, all qubits measured = b) — the observable a user
 * would actually see, and the one a mirrored convention cannot fake.
 */
export function jointDistribution(circuit: Circuit): Map<string, number> {
  return jointOf(branches(circuit))
}

export function jointDistributionOfOps(
  ops: readonly RefOp[],
  qubits: number
): Map<string, number> {
  return jointOf(branchesOfOps(ops, qubits))
}

function jointOf(list: readonly Branch[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const branch of list) {
    for (let index = 0; index < branch.state.re.length; index++) {
      const weight =
        (branch.state.re[index] as number) ** 2 +
        (branch.state.im[index] as number) ** 2
      if (weight < 1e-15) continue
      const key = `${branch.register.toString(2).padStart(8, '0')}:${index
        .toString(2)
        .padStart(8, '0')}`
      out.set(key, (out.get(key) ?? 0) + branch.probability * weight)
    }
  }
  return out
}

export function distributionDistance(
  left: Map<string, number>,
  right: Map<string, number>
): number {
  let worst = 0
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    worst = Math.max(
      worst,
      Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0))
    )
  }
  return worst
}
