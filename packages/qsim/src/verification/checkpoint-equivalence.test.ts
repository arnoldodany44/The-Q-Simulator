/**
 * Independent adversarial verification of the incremental checkpoint cache
 * (specification §5.6.3, work plan M0.4).
 *
 * WHAT MAKES THIS INDEPENDENT. Nothing here compares the engine against
 * itself. The oracle is a second simulator written in this file from the
 * textbook definitions: it materialises the dense matrix of each gate on its
 * target subspace and evaluates `ψ'ᵢ = Σⱼ Mᵢⱼ ψⱼ` by direct summation over the
 * basis states, which is precisely the O(4ⁿ)-shaped method §5.2 forbids the
 * engine from using. Its gate matrices are typed out here from the standard
 * forms rather than imported from `gates.ts`, and its control handling is the
 * plain definition ("on indices where a control does not read its required
 * value the operation is the identity") rather than the engine's mask
 * arithmetic. So a disagreement between the two is a real disagreement, not
 * two copies of one mistake.
 *
 * The checkpoint claim under test is an equivalence: for a fixed circuit,
 * `run()`, `runFrom()` at any column, and `stateAfterColumn()` at any column
 * must all be indistinguishable from that slow simulator to 1e-12. On top of
 * that sits an invariant the cache's own structure has to satisfy — every
 * state it holds must be the state the *current* circuit reaches at that
 * column — because a checkpoint that is merely plausible produces a
 * normalised, physically sensible, silently wrong answer later.
 */

import { describe, expect, it } from 'vitest'

import { analyticMode } from '../measure.js'
import {
  checkpointColumns,
  createCheckpoints,
  invalidateFrom,
  run,
  runFrom,
  stateAfterColumn,
  type CheckpointCache,
  type CircuitLike,
  type OperationLike,
} from '../runner.js'
import type { Statevector } from '../statevector.js'

/**
 * The work plan's budget for M0.4: an incrementally re-simulated state must
 * match a full simulation to 1e-12. The same figure is used against the slow
 * reference — at four or five qubits and a hundred gates the two summation
 * orders differ by a few units in the last place, some ten thousand times
 * under this.
 */
const TOLERANCE = 1e-12

/* ─────────────── an obviously-correct, obviously-slow engine ─────────────── */

/** A complex number as `[real, imaginary]`. */
type Cx = readonly [number, number]

/** A dense complex matrix on `k` target qubits: `dim = 2ᵏ`, row-major. */
interface RefMatrix {
  readonly dim: number
  readonly entries: readonly Cx[]
}

function matrixOf(dim: number, entries: readonly Cx[]): RefMatrix {
  if (entries.length !== dim * dim) {
    throw new Error(`a ${dim}×${dim} matrix needs ${dim * dim} entries`)
  }
  return { dim, entries }
}

const R2 = Math.SQRT1_2
const ZERO: Cx = [0, 0]
const ONE: Cx = [1, 0]

/**
 * The fixed one-qubit gates, written out from the standard definitions:
 * X, Y, Z, H, S = √Z, S†, T = √S, T†, √X. Row-major, so the entries read
 * `[m₀₀, m₀₁, m₁₀, m₁₁]`.
 */
const REF_FIXED = new Map<string, RefMatrix>([
  ['x', matrixOf(2, [ZERO, ONE, ONE, ZERO])],
  ['y', matrixOf(2, [ZERO, [0, -1], [0, 1], ZERO])],
  ['z', matrixOf(2, [ONE, ZERO, ZERO, [-1, 0]])],
  [
    'h',
    matrixOf(2, [
      [R2, 0],
      [R2, 0],
      [R2, 0],
      [-R2, 0],
    ]),
  ],
  ['s', matrixOf(2, [ONE, ZERO, ZERO, [0, 1]])],
  ['sdg', matrixOf(2, [ONE, ZERO, ZERO, [0, -1]])],
  ['t', matrixOf(2, [ONE, ZERO, ZERO, [R2, R2]])],
  ['tdg', matrixOf(2, [ONE, ZERO, ZERO, [R2, -R2]])],
  [
    'sx',
    matrixOf(2, [
      [0.5, 0.5],
      [0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
    ]),
  ],
])

/** Rx(θ) = [[cos θ/2, −i sin θ/2], [−i sin θ/2, cos θ/2]]. */
function refRx(theta: number): RefMatrix {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return matrixOf(2, [
    [c, 0],
    [0, -s],
    [0, -s],
    [c, 0],
  ])
}

/** Ry(θ) = [[cos θ/2, −sin θ/2], [sin θ/2, cos θ/2]]. */
function refRy(theta: number): RefMatrix {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return matrixOf(2, [
    [c, 0],
    [-s, 0],
    [s, 0],
    [c, 0],
  ])
}

/** Rz(θ) = diag(e^{−iθ/2}, e^{iθ/2}) — Qiskit's phase convention. */
function refRz(theta: number): RefMatrix {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return matrixOf(2, [[c, -s], ZERO, ZERO, [c, s]])
}

/** P(φ) = diag(1, e^{iφ}). */
function refP(phi: number): RefMatrix {
  return matrixOf(2, [ONE, ZERO, ZERO, [Math.cos(phi), Math.sin(phi)]])
}

/** U(θ,φ,λ) = [[cos θ/2, −e^{iλ}sin θ/2], [e^{iφ}sin θ/2, e^{i(φ+λ)}cos θ/2]]. */
function refU(theta: number, phi: number, lambda: number): RefMatrix {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return matrixOf(2, [
    [c, 0],
    [-Math.cos(lambda) * s, -Math.sin(lambda) * s],
    [Math.cos(phi) * s, Math.sin(phi) * s],
    [Math.cos(phi + lambda) * c, Math.sin(phi + lambda) * c],
  ])
}

/**
 * The two-qubit exchange family on targets `[a, b]`, indexed `2·bit(b) + bit(a)`
 * — the layout `gates.ts` documents for its 4×4 oracles. SWAP exchanges
 * |01⟩ and |10⟩; iSWAP exchanges them and multiplies both by i.
 */
function refExchange(factor: Cx): RefMatrix {
  return matrixOf(4, [
    ONE,
    ZERO,
    ZERO,
    ZERO,
    ZERO,
    ZERO,
    factor,
    ZERO,
    ZERO,
    factor,
    ZERO,
    ZERO,
    ZERO,
    ZERO,
    ZERO,
    ONE,
  ])
}

const REF_SWAP = refExchange(ONE)
const REF_ISWAP = refExchange([0, 1])

/** A control and the value it must read, after bare numbers are normalised. */
interface RefControl {
  readonly qubit: number
  readonly state: 0 | 1
}

/** The reference's state: 2ⁿ complex amplitudes, nothing clever. */
interface RefState {
  readonly re: Float64Array
  readonly im: Float64Array
}

/**
 * `ψ' = M ψ` by direct summation.
 *
 * For every basis index `i` the amplitude is rebuilt from the 2ᵏ indices that
 * agree with `i` outside the targets. Where the controls do not read their
 * required value the operation is the identity, which is the definition of a
 * control rather than a re-derivation of the engine's index arithmetic. The
 * whole output is written to scratch first, so no read ever sees a partially
 * updated vector — the failure mode an in-place kernel has to avoid and this
 * reference should not be able to have.
 */
function refApply(
  state: RefState,
  targets: readonly number[],
  controls: readonly RefControl[],
  gate: RefMatrix
): void {
  const size = state.re.length
  const outRe = new Float64Array(size)
  const outIm = new Float64Array(size)

  for (let i = 0; i < size; i++) {
    let fires = true
    for (const control of controls) {
      if (((i >> control.qubit) & 1) !== control.state) fires = false
    }
    if (!fires) {
      outRe[i] = state.re[i]
      outIm[i] = state.im[i]
      continue
    }

    let row = 0
    for (let k = 0; k < targets.length; k++) {
      row |= ((i >> targets[k]) & 1) << k
    }

    let sumRe = 0
    let sumIm = 0
    for (let col = 0; col < gate.dim; col++) {
      let j = i
      for (let k = 0; k < targets.length; k++) {
        const bit = (col >> k) & 1
        j = bit === 1 ? j | (1 << targets[k]) : j & ~(1 << targets[k])
      }
      const [mre, mim] = gate.entries[row * gate.dim + col]
      sumRe += mre * state.re[j] - mim * state.im[j]
      sumIm += mre * state.im[j] + mim * state.re[j]
    }
    outRe[i] = sumRe
    outIm[i] = sumIm
  }

  state.re.set(outRe)
  state.im.set(outIm)
}

/** What one operation means to the reference, or `undefined` for a no-op. */
interface RefOperation {
  readonly targets: readonly number[]
  readonly controls: readonly RefControl[]
  readonly gate: RefMatrix
}

function refParams(
  operation: OperationLike,
  circuit: CircuitLike
): readonly number[] {
  const params = operation.params ?? []
  return params.map((param) => {
    if (typeof param === 'number') return param
    const declared = (circuit.parameters ?? []).find(
      (candidate) => candidate.name === param
    )
    if (declared === undefined) {
      throw new Error(`the reference cannot resolve parameter "${param}"`)
    }
    return declared.value
  })
}

function refControls(operation: OperationLike): readonly RefControl[] {
  return (operation.controls ?? []).map((control) =>
    typeof control === 'number'
      ? { qubit: control, state: 1 as const }
      : { qubit: control.qubit, state: control.state }
  )
}

/**
 * The contract's gate ids, expanded to a matrix and a set of controls.
 *
 * `cx`, `cz`, `ccx`, `cswap`, `crz` and `cp` are read the way §6 defines them:
 * an ordinary gate whose controls happen to be spelled into the name. That is
 * the same reading the runner uses, but arrived at from the contract rather
 * than copied from it.
 */
function refOperation(
  operation: OperationLike,
  circuit: CircuitLike
): RefOperation | undefined {
  const controls = refControls(operation)
  const targets = operation.targets
  const params = refParams(operation, circuit)

  switch (operation.gate) {
    case 'barrier':
    case 'i':
      return undefined
    case 'rx':
      return { targets, controls, gate: refRx(params[0]) }
    case 'ry':
      return { targets, controls, gate: refRy(params[0]) }
    case 'rz':
    case 'crz':
      return { targets, controls, gate: refRz(params[0]) }
    case 'p':
    case 'cp':
      return { targets, controls, gate: refP(params[0]) }
    case 'u':
      return {
        targets,
        controls,
        gate: refU(params[0], params[1], params[2]),
      }
    case 'cx':
    case 'ccx':
      return { targets, controls, gate: REF_FIXED.get('x') as RefMatrix }
    case 'cz':
      return { targets, controls, gate: REF_FIXED.get('z') as RefMatrix }
    case 'swap':
    case 'cswap':
      return { targets, controls, gate: REF_SWAP }
    case 'iswap':
      return { targets, controls, gate: REF_ISWAP }
    default: {
      const fixed = REF_FIXED.get(operation.gate)
      if (fixed === undefined) {
        throw new Error(`the reference has no gate "${operation.gate}"`)
      }
      return { targets, controls, gate: fixed }
    }
  }
}

/**
 * The state a circuit reaches once every column up to and including
 * `throughColumn` has run, computed from |0…0⟩ every time. No caching, no
 * renormalisation, no reuse — the point of it is to have nothing in common
 * with the thing it checks.
 */
function referenceState(
  circuit: CircuitLike,
  throughColumn: number = Number.POSITIVE_INFINITY
): RefState {
  const size = 1 << circuit.qubits
  const state: RefState = {
    re: new Float64Array(size),
    im: new Float64Array(size),
  }
  state.re[0] = 1

  const columns = [
    ...new Set(circuit.operations.map((operation) => operation.column)),
  ].sort((a, b) => a - b)

  for (const column of columns) {
    if (column > throughColumn) break
    for (const operation of circuit.operations) {
      if (operation.column !== column) continue
      const resolved = refOperation(operation, circuit)
      if (resolved === undefined) continue
      refApply(state, resolved.targets, resolved.controls, resolved.gate)
    }
  }
  return state
}

/* ─────────────────────────────── comparisons ─────────────────────────────── */

function deviation(actual: Statevector, expected: RefState): number {
  let worst = 0
  for (let i = 0; i < expected.re.length; i++) {
    const dre = Math.abs(actual.re[i] - expected.re[i])
    const dim = Math.abs(actual.im[i] - expected.im[i])
    if (dre > worst) worst = dre
    if (dim > worst) worst = dim
  }
  return worst
}

function expectMatchesReference(
  actual: Statevector,
  expected: RefState,
  label: string
): void {
  expect(actual.size, `${label}: size`).toBe(expected.re.length)
  expect(deviation(actual, expected), label).toBeLessThan(TOLERANCE)
}

function stateDeviation(actual: Statevector, expected: Statevector): number {
  let worst = 0
  for (let i = 0; i < expected.size; i++) {
    const dre = Math.abs(actual.re[i] - expected.re[i])
    const dim = Math.abs(actual.im[i] - expected.im[i])
    if (dre > worst) worst = dre
    if (dim > worst) worst = dim
  }
  return worst
}

/** The final state of a plain analytic run, with no cache in play. */
function fullState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected analytic mode')
  return result.state
}

/**
 * Every state the cache holds must be the state *this* circuit reaches at that
 * column, and the columns must be strictly ascending — `resume()` walks the
 * entries and stops at the first one past its boundary, so an unsorted cache
 * would silently resume from the wrong place.
 */
function expectCacheCoherent(
  cache: CheckpointCache,
  circuit: CircuitLike,
  label: string
): void {
  let previous = Number.NEGATIVE_INFINITY
  for (const entry of cache.entries) {
    expect(entry.column, `${label}: columns ascend`).toBeGreaterThan(previous)
    previous = entry.column
    expectMatchesReference(
      entry.state,
      referenceState(circuit, entry.column),
      `${label}: cached checkpoint at column ${entry.column}`
    )
  }
}

/* ──────────────────────────── random circuits ───────────────────────────── */

/** mulberry32 — a deterministic generator, local so the test data is ours. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]
}

let idCounter = 0

function nextId(): string {
  idCounter++
  return `v${idCounter}`
}

const FIXED_1Q = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'sx', 'i']
const ANGLED_1Q = ['rx', 'ry', 'rz', 'p']

/**
 * One column: operations over disjoint qubits, some wires left idle so the
 * columns are not uniformly packed. The pool spans every dispatch branch the
 * runner has, because a circuit of nothing but Hadamards would let a resumed
 * run agree with a full one for reasons that have nothing to do with the
 * cache.
 */
function randomColumn(
  rng: () => number,
  qubits: number,
  column: number
): OperationLike[] {
  const free: number[] = []
  for (let qubit = 0; qubit < qubits; qubit++) free.push(qubit)
  const take = (): number => free.splice(Math.floor(rng() * free.length), 1)[0]
  const angle = (): number => (rng() - 0.5) * 7

  const operations: OperationLike[] = []
  while (free.length > 0) {
    const roll = rng()

    if (roll < 0.12) {
      free.pop()
    } else if (roll < 0.3) {
      operations.push({
        id: nextId(),
        gate: pick(rng, FIXED_1Q),
        targets: [take()],
        column,
      })
    } else if (roll < 0.42) {
      operations.push({
        id: nextId(),
        gate: pick(rng, ANGLED_1Q),
        targets: [take()],
        column,
        params: [angle()],
      })
    } else if (roll < 0.5) {
      // Symbolic, so a parameter edit has somewhere to land.
      operations.push({
        id: nextId(),
        gate: 'rz',
        targets: [take()],
        column,
        params: ['theta'],
      })
    } else if (roll < 0.58) {
      operations.push({
        id: nextId(),
        gate: 'u',
        targets: [take()],
        column,
        params: [angle(), angle(), angle()],
      })
    } else if (roll < 0.64) {
      operations.push({
        id: nextId(),
        gate: 'barrier',
        targets: [take()],
        column,
      })
    } else if (free.length < 2) {
      operations.push({
        id: nextId(),
        gate: pick(rng, FIXED_1Q),
        targets: [take()],
        column,
      })
    } else if (roll < 0.74) {
      const gate = pick(rng, ['cx', 'cz'])
      operations.push({
        id: nextId(),
        gate,
        targets: [take()],
        column,
        controls: [take()],
      })
    } else if (roll < 0.8) {
      const gate = pick(rng, ['crz', 'cp'])
      operations.push({
        id: nextId(),
        gate,
        targets: [take()],
        column,
        controls: [take()],
        params: [angle()],
      })
    } else if (roll < 0.86) {
      // A plain one-qubit gate the user attached a control to, negative two
      // times in five — the shape `applyControlled` exists for.
      operations.push({
        id: nextId(),
        gate: pick(rng, ['h', 'x']),
        targets: [take()],
        column,
        controls: [{ qubit: take(), state: rng() < 0.4 ? 0 : 1 }],
      })
    } else if (roll < 0.93 || free.length < 3) {
      operations.push({
        id: nextId(),
        gate: pick(rng, ['swap', 'iswap']),
        targets: [take(), take()],
        column,
      })
    } else if (rng() < 0.5) {
      operations.push({
        id: nextId(),
        gate: 'ccx',
        targets: [take()],
        column,
        controls: [take(), take()],
      })
    } else {
      operations.push({
        id: nextId(),
        gate: 'cswap',
        targets: [take(), take()],
        column,
        controls: [take()],
      })
    }
  }
  return operations
}

/**
 * An editable circuit. `slots[k]` is the content of column `k · stride`, so a
 * stride above 1 produces the sparse, non-contiguous column numbering a real
 * editor produces the moment a user drags a gate to the right.
 */
interface Sketch {
  readonly qubits: number
  readonly stride: number
  slots: OperationLike[][]
  theta: number
}

function columnOf(sketch: Sketch, slot: number): number {
  return slot * sketch.stride
}

function build(sketch: Sketch): CircuitLike {
  return {
    qubits: sketch.qubits,
    parameters: [{ name: 'theta', value: sketch.theta }],
    operations: sketch.slots.flat(),
  }
}

function randomSketch(
  rng: () => number,
  qubits: number,
  depth: number,
  stride = 1
): Sketch {
  const sketch: Sketch = { qubits, stride, slots: [], theta: 0.7 }
  for (let slot = 0; slot < depth; slot++) {
    sketch.slots.push(randomColumn(rng, qubits, slot * stride))
  }
  return sketch
}

/** The earliest column that reads `theta`, or 0 if nothing does. */
function firstColumnUsing(sketch: Sketch, name: string): number {
  for (let slot = 0; slot < sketch.slots.length; slot++) {
    for (const operation of sketch.slots[slot]) {
      if ((operation.params ?? []).includes(name)) return columnOf(sketch, slot)
    }
  }
  return 0
}

/* ────────────────────────────────  tests  ───────────────────────────────── */

describe('the reference agrees with an uncached run (the control)', () => {
  it('reproduces a full analytic run of random circuits', () => {
    const rng = makeRng(510011)
    for (let trial = 0; trial < 12; trial++) {
      const circuit = build(randomSketch(rng, 4, 10))
      expectMatchesReference(
        fullState(circuit),
        referenceState(circuit),
        `trial ${trial}`
      )
    }
  })

  it('reproduces the state after every prefix of a circuit', () => {
    const rng = makeRng(77001)
    const circuit = build(randomSketch(rng, 4, 12))
    for (let column = 0; column < 12; column++) {
      const truncated: CircuitLike = {
        ...circuit,
        operations: circuit.operations.filter((op) => op.column <= column),
      }
      expectMatchesReference(
        fullState(truncated),
        referenceState(circuit, column),
        `prefix through column ${column}`
      )
    }
  })
})

describe('runFrom is indistinguishable from the slow path', () => {
  it('resumes from every column at every interval', () => {
    const rng = makeRng(0xbeef01)
    const depth = 14
    for (const interval of [1, 2, 3, 5, 8]) {
      const circuit = build(randomSketch(rng, 4, depth))
      const expected = referenceState(circuit)
      for (let column = -1; column <= depth + 2; column++) {
        const cache = createCheckpoints({ interval })
        run(circuit, analyticMode(), cache)
        invalidateFrom(cache, column)
        expectMatchesReference(
          runFrom(cache, circuit, column).state,
          expected,
          `interval ${interval}, resumed at column ${column}`
        )
      }
    }
  })

  it('resumes correctly when the columns are sparse', () => {
    const rng = makeRng(520202)
    const depth = 9
    const stride = 4
    const sketch = randomSketch(rng, 4, depth, stride)
    const circuit = build(sketch)
    const expected = referenceState(circuit)
    const last = columnOf(sketch, depth - 1)

    for (let column = -1; column <= last + stride; column++) {
      const cache = createCheckpoints({ interval: 2 })
      run(circuit, analyticMode(), cache)
      invalidateFrom(cache, column)
      expectMatchesReference(
        runFrom(cache, circuit, column).state,
        expected,
        `sparse columns, resumed at column ${column}`
      )
    }
  })

  it('resumes repeatedly from a cache only ever fed by resumed runs', () => {
    const rng = makeRng(31337)
    const circuit = build(randomSketch(rng, 4, 18))
    const expected = referenceState(circuit)
    const cache = createCheckpoints({ interval: 3 })

    // No full run ever warms this cache: every entry in it was produced by a
    // resumed run, so any drift the resume path introduces compounds.
    for (let round = 0; round < 40; round++) {
      const column = Math.floor(rng() * 20)
      invalidateFrom(cache, column)
      expectMatchesReference(
        runFrom(cache, circuit, column).state,
        expected,
        `round ${round}, resumed at column ${column}`
      )
      expectCacheCoherent(cache, circuit, `round ${round}`)
    }
  })

  it('runs the whole circuit when asked to resume before it starts', () => {
    const rng = makeRng(9091)
    const circuit = build(randomSketch(rng, 3, 6))
    const cache = createCheckpoints({ interval: 1 })
    run(circuit, analyticMode(), cache)
    invalidateFrom(cache, 0)
    expect(checkpointColumns(cache)).toEqual([])
    expectMatchesReference(
      runFrom(cache, circuit, 0).state,
      referenceState(circuit),
      'resumed at column 0'
    )
    expectMatchesReference(
      runFrom(cache, circuit, -5).state,
      referenceState(circuit),
      'resumed at a negative column'
    )
  })

  it('resumes from the last checkpoint when asked past the end', () => {
    const rng = makeRng(1212)
    const circuit = build(randomSketch(rng, 4, 11))
    const cache = createCheckpoints({ interval: 2 })
    run(circuit, analyticMode(), cache)
    const expected = referenceState(circuit)
    for (const column of [11, 12, 100, 1_000_000]) {
      expectMatchesReference(
        runFrom(cache, circuit, column).state,
        expected,
        `resumed at column ${column}, past the end`
      )
    }
  })
})

describe('stateAfterColumn is indistinguishable from the slow path', () => {
  it('answers every column of a dense circuit, cold and then warm', () => {
    const rng = makeRng(0xc01d)
    const depth = 13
    const circuit = build(randomSketch(rng, 4, depth))
    const cache = createCheckpoints({ interval: 3 })

    for (let column = -2; column <= depth + 2; column++) {
      expectMatchesReference(
        stateAfterColumn(cache, circuit, column),
        referenceState(circuit, column),
        `cold, after column ${column}`
      )
    }
    // Scrubbing back through a warm cache must give the same answers: the
    // second pass reads checkpoints the first pass wrote.
    for (let column = depth + 2; column >= -2; column--) {
      expectMatchesReference(
        stateAfterColumn(cache, circuit, column),
        referenceState(circuit, column),
        `warm, after column ${column}`
      )
    }
    expect(checkpointColumns(cache).length).toBeGreaterThan(0)
    expectCacheCoherent(cache, circuit, 'after scrubbing')
  })

  it('answers columns that fall in the gaps of a sparse circuit', () => {
    const rng = makeRng(0x6a95)
    const stride = 3
    const sketch = randomSketch(rng, 4, 8, stride)
    const circuit = build(sketch)
    const cache = createCheckpoints({ interval: 2 })
    const last = columnOf(sketch, 7)

    for (let column = -1; column <= last + stride; column++) {
      expectMatchesReference(
        stateAfterColumn(cache, circuit, column),
        referenceState(circuit, column),
        `sparse, after column ${column}`
      )
    }
    expectCacheCoherent(cache, circuit, 'sparse scrub')
  })

  it('never hands out a state the cache still owns', () => {
    const rng = makeRng(555)
    const circuit = build(randomSketch(rng, 4, 10))
    const cache = createCheckpoints({ interval: 2 })
    run(circuit, analyticMode(), cache)

    const expected = referenceState(circuit)
    const handed = stateAfterColumn(cache, circuit, 9)
    handed.re.fill(0)
    handed.im.fill(0)
    expectCacheCoherent(cache, circuit, 'after corrupting a handed-out state')
    expectMatchesReference(
      runFrom(cache, circuit, 5).state,
      expected,
      'resumed after corrupting a handed-out state'
    )

    const resumed = runFrom(cache, circuit, 5).state
    resumed.re.fill(0)
    resumed.im.fill(0)
    expectMatchesReference(
      runFrom(cache, circuit, 5).state,
      expected,
      'resumed after corrupting a resumed state'
    )
  })
})

describe('an editing session', () => {
  it('re-simulates 200 random edits to within 1e-12 of the truth', () => {
    const rng = makeRng(20260814)
    const sketch = randomSketch(rng, 4, 16)
    const cache = createCheckpoints({ interval: 3 })
    run(build(sketch), analyticMode(), cache)

    for (let edit = 0; edit < 200; edit++) {
      const kind = Math.floor(rng() * 6)
      let from: number

      if (kind === 0) {
        // A parameter change: it invalidates from the first column that reads
        // the parameter, which is what the editor of M0.5 has to compute.
        sketch.theta = (rng() - 0.5) * 7
        from = firstColumnUsing(sketch, 'theta')
      } else if (kind === 1) {
        // Deleting every gate in a column, which leaves a hole and shifts the
        // position of every column after it within the plan.
        const slot = Math.floor(rng() * sketch.slots.length)
        sketch.slots[slot] = []
        from = columnOf(sketch, slot)
      } else if (kind === 2) {
        // Appending a column past the end — the most common edit of all.
        const slot = sketch.slots.length
        sketch.slots.push(
          randomColumn(rng, sketch.qubits, columnOf(sketch, slot))
        )
        from = columnOf(sketch, slot)
      } else {
        const slot = Math.floor(rng() * sketch.slots.length)
        sketch.slots[slot] = randomColumn(
          rng,
          sketch.qubits,
          columnOf(sketch, slot)
        )
        from = columnOf(sketch, slot)
      }

      const circuit = build(sketch)
      invalidateFrom(cache, from)
      const incremental = runFrom(cache, circuit, from)

      expectMatchesReference(
        incremental.state,
        referenceState(circuit),
        `edit ${edit} (kind ${kind}) at column ${from}`
      )
      expect(
        stateDeviation(incremental.state, fullState(circuit)),
        `edit ${edit} (kind ${kind}) at column ${from}, against a full run`
      ).toBeLessThan(TOLERANCE)

      if (edit % 20 === 0) expectCacheCoherent(cache, circuit, `edit ${edit}`)
    }
  })

  it('re-simulates edits to a sparsely numbered circuit', () => {
    const rng = makeRng(0x5ed17)
    const sketch = randomSketch(rng, 4, 10, 5)
    const cache = createCheckpoints({ interval: 2 })
    run(build(sketch), analyticMode(), cache)

    for (let edit = 0; edit < 60; edit++) {
      const slot = Math.floor(rng() * sketch.slots.length)
      const column = columnOf(sketch, slot)
      sketch.slots[slot] = randomColumn(rng, sketch.qubits, column)
      const circuit = build(sketch)
      invalidateFrom(cache, column)
      expectMatchesReference(
        runFrom(cache, circuit, column).state,
        referenceState(circuit),
        `sparse edit ${edit} at column ${column}`
      )
    }
  })

  it('re-simulates a gate dropped into a column that was empty', () => {
    const rng = makeRng(6161)
    const stride = 4
    const sketch = randomSketch(rng, 4, 8, stride)
    const cache = createCheckpoints({ interval: 2 })
    run(build(sketch), analyticMode(), cache)

    // Column numbers the sketch never occupies, so each edit genuinely adds a
    // new instant between two existing ones rather than replacing one.
    const inserted = new Map<number, OperationLike[]>()
    for (let edit = 0; edit < 30; edit++) {
      const slot = Math.floor(rng() * (sketch.slots.length - 1))
      const offset = 1 + Math.floor(rng() * (stride - 1))
      const column = columnOf(sketch, slot) + offset
      inserted.set(column, randomColumn(rng, sketch.qubits, column))

      const circuit: CircuitLike = {
        ...build(sketch),
        operations: [
          ...build(sketch).operations,
          ...[...inserted.values()].flat(),
        ],
      }
      invalidateFrom(cache, column)
      expectMatchesReference(
        runFrom(cache, circuit, column).state,
        referenceState(circuit),
        `insertion ${edit} into column ${column}`
      )
      expectCacheCoherent(cache, circuit, `insertion ${edit}`)
    }
  })

  it('re-simulates repeated edits to the very last column', () => {
    const rng = makeRng(884400)
    const depth = 21
    const sketch = randomSketch(rng, 4, depth)
    // The default interval, so the end anchor of `recordCheckpoint` is what
    // an edit here resumes from — the case the editor hits most often.
    const cache = createCheckpoints()
    run(build(sketch), analyticMode(), cache)

    const last = depth - 1
    for (let edit = 0; edit < 50; edit++) {
      sketch.slots[last] = randomColumn(rng, sketch.qubits, last)
      const circuit = build(sketch)
      invalidateFrom(cache, last)
      expectMatchesReference(
        runFrom(cache, circuit, last).state,
        referenceState(circuit),
        `edit ${edit} to the last column`
      )
    }
  })

  it('scrubs correctly while the circuit is being edited', () => {
    const rng = makeRng(0xace5)
    const depth = 14
    const sketch = randomSketch(rng, 4, depth)
    const cache = createCheckpoints({ interval: 3 })
    run(build(sketch), analyticMode(), cache)

    for (let edit = 0; edit < 40; edit++) {
      const slot = Math.floor(rng() * sketch.slots.length)
      const column = columnOf(sketch, slot)
      sketch.slots[slot] = randomColumn(rng, sketch.qubits, column)
      const circuit = build(sketch)
      invalidateFrom(cache, column)

      // The scrubber reads the cache the edit just truncated, in whatever
      // order the user happens to drag the handle.
      for (const at of [13, 0, 7, 13, 3, 11]) {
        expectMatchesReference(
          stateAfterColumn(cache, circuit, at),
          referenceState(circuit, at),
          `edit ${edit} at column ${column}, scrubbed to ${at}`
        )
      }
      expectCacheCoherent(cache, circuit, `edit ${edit} at column ${column}`)
    }
  })

  it('handles column numbers spread far apart', () => {
    const rng = makeRng(70707)
    const sketch = randomSketch(rng, 3, 6, 100_000)
    const circuit = build(sketch)
    const cache = createCheckpoints({ interval: 2 })
    run(circuit, analyticMode(), cache)
    expectCacheCoherent(cache, circuit, 'far-apart columns')

    for (const column of [0, 1, 99_999, 100_000, 250_000, 600_000]) {
      invalidateFrom(cache, column)
      expectMatchesReference(
        runFrom(cache, circuit, column).state,
        referenceState(circuit),
        `resumed at column ${column}`
      )
      run(circuit, analyticMode(), cache)
    }
    expectMatchesReference(
      stateAfterColumn(cache, circuit, 250_000),
      referenceState(circuit, 250_000),
      'scrubbed to column 250000'
    )
  })
})

describe('the cache holds only states of the circuit it was run with', () => {
  it('drops every checkpoint at or after an edited column', () => {
    const rng = makeRng(606)
    const circuit = build(randomSketch(rng, 3, 12))
    const cache = createCheckpoints({ interval: 1 })
    run(circuit, analyticMode(), cache)
    expect(checkpointColumns(cache).length).toBeGreaterThan(1)

    for (let column = 12; column >= 0; column--) {
      invalidateFrom(cache, column)
      for (const cached of checkpointColumns(cache)) {
        expect(cached, `invalidated from ${column}`).toBeLessThan(column)
      }
    }
    expect(checkpointColumns(cache)).toEqual([])
  })

  it('holds nothing from a previous circuit after a full run', () => {
    const rng = makeRng(0xfeed)
    const cache = createCheckpoints({ interval: 4 })

    const long = build(randomSketch(rng, 4, 20))
    run(long, analyticMode(), cache)
    expect(checkpointColumns(cache).length).toBeGreaterThan(0)

    // A full `run()` re-simulates from |0…0⟩, so afterwards the cache must
    // describe this circuit and no other. Anything it kept from the previous
    // one is a state no operation of `short` ever produced, and the next
    // `runFrom` or `stateAfterColumn` will resume from it without complaint.
    const short = build(randomSketch(rng, 4, 8))
    run(short, analyticMode(), cache)
    expectCacheCoherent(cache, short, 'after a second full run')
  })

  it('answers stateAfterColumn from the circuit last run, not an earlier one', () => {
    const cache = createCheckpoints({ interval: 4 })

    // Twelve columns, every one of them acting on qubit 0: a Hadamard and
    // then eleven phase kicks, so the state at each column is distinct.
    const long: CircuitLike = {
      qubits: 2,
      operations: [
        { id: 'l0', gate: 'h', targets: [0], column: 0 },
        ...Array.from({ length: 11 }, (_, k) => ({
          id: `l${k + 1}`,
          gate: 'p',
          targets: [0],
          params: [0.37],
          column: k + 1,
        })),
      ],
    }
    run(long, analyticMode(), cache)
    expect(checkpointColumns(cache)).toEqual([3, 7, 10, 11])

    // Six columns, and every one of them acts on qubit 1 instead — no state
    // this circuit ever holds resembles a state of the one above.
    const short: CircuitLike = {
      qubits: 2,
      operations: [
        { id: 's0', gate: 'h', targets: [1], column: 0 },
        ...Array.from({ length: 5 }, (_, k) => ({
          id: `s${k + 1}`,
          gate: 'p',
          targets: [1],
          params: [0.11],
          column: k + 1,
        })),
      ],
    }
    run(short, analyticMode(), cache)

    // `short` has nothing past column 5, so its state after column 8 is just
    // its final state. The cache still holds `long`'s checkpoint at column 7,
    // and that is what the scrubber of M0.8 would be shown.
    expectMatchesReference(
      stateAfterColumn(cache, short, 8),
      referenceState(short, 8),
      'state after column 8 of the circuit that was just run'
    )
  })

  it('empties itself when the register changes size', () => {
    const rng = makeRng(202)
    const cache = createCheckpoints({ interval: 2 })
    run(build(randomSketch(rng, 4, 10)), analyticMode(), cache)

    const wider = build(randomSketch(rng, 6, 5))
    expectMatchesReference(
      runFrom(cache, wider, 3).state,
      referenceState(wider),
      'resumed on a wider register'
    )
    expectCacheCoherent(cache, wider, 'after a register change')
  })
})

describe('the cache does not perturb the run it observes', () => {
  it('gives bit-identical amplitudes with and without a cache', () => {
    const rng = makeRng(848484)
    for (let trial = 0; trial < 6; trial++) {
      const circuit = build(randomSketch(rng, 4, 14))
      const cache = createCheckpoints({ interval: 2 })
      const cached = run(circuit, analyticMode(), cache)
      const plain = run(circuit, analyticMode())
      if (cached.mode !== 'analytic' || plain.mode !== 'analytic') {
        throw new Error('expected analytic mode')
      }
      expect(
        stateDeviation(cached.state, plain.state),
        `trial ${trial}: a checkpoint must copy the state, never touch it`
      ).toBe(0)
    }
  })

  it('stays inside the checkpoint count it was given', () => {
    const rng = makeRng(170017)
    const circuit = build(randomSketch(rng, 3, 24))
    for (const limit of [1, 2, 3, 5, 8]) {
      const cache = createCheckpoints({ interval: 1, limit })
      run(circuit, analyticMode(), cache)
      expect(
        checkpointColumns(cache).length,
        `limit ${limit} — the ceiling is a memory budget, so exceeding it by ` +
          `even one copy is 2ⁿ×16 bytes over`
      ).toBeLessThanOrEqual(limit)
      expectCacheCoherent(cache, circuit, `limit ${limit}`)
    }
  })
})

describe('degenerate circuits', () => {
  it('handles a circuit with no operations at all', () => {
    const empty: CircuitLike = { qubits: 3, operations: [] }
    const cache = createCheckpoints({ interval: 1 })
    const ground = referenceState(empty)

    expectMatchesReference(fullState(empty), ground, 'full run')
    run(empty, analyticMode(), cache)
    expect(checkpointColumns(cache)).toEqual([])
    expectMatchesReference(runFrom(cache, empty, 0).state, ground, 'resumed')
    expectMatchesReference(
      stateAfterColumn(cache, empty, 5),
      ground,
      'after column 5 of an empty circuit'
    )
  })

  it('handles a circuit of a single column', () => {
    const single: CircuitLike = {
      qubits: 2,
      operations: [
        { id: 's1', gate: 'h', targets: [0], column: 0 },
        { id: 's2', gate: 'x', targets: [1], column: 0 },
      ],
    }
    const cache = createCheckpoints({ interval: 1 })
    run(single, analyticMode(), cache)
    expectCacheCoherent(cache, single, 'single column')
    expectMatchesReference(
      runFrom(cache, single, 0).state,
      referenceState(single),
      'resumed at column 0'
    )
    expectMatchesReference(
      stateAfterColumn(cache, single, 0),
      referenceState(single, 0),
      'after column 0'
    )
    expectMatchesReference(
      stateAfterColumn(cache, single, -1),
      referenceState(single, -1),
      'before column 0'
    )
  })

  it('does not care what order the operations arrive in', () => {
    const rng = makeRng(580881)
    const sketch = randomSketch(rng, 4, 10)
    const ordered = build(sketch)

    // The contract says a column is one instant, so the order operations
    // happen to sit in the array cannot change the state — nor which
    // checkpoints the cache takes.
    const shuffled = [...ordered.operations]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const swap = shuffled[i]
      shuffled[i] = shuffled[j]
      shuffled[j] = swap
    }
    const jumbled: CircuitLike = { ...ordered, operations: shuffled }

    const cacheA = createCheckpoints({ interval: 3 })
    const cacheB = createCheckpoints({ interval: 3 })
    run(ordered, analyticMode(), cacheA)
    run(jumbled, analyticMode(), cacheB)
    expect(checkpointColumns(cacheB)).toEqual(checkpointColumns(cacheA))

    expectMatchesReference(
      runFrom(cacheB, jumbled, 4).state,
      referenceState(ordered),
      'resumed on a jumbled operation list'
    )
  })
})
