/**
 * INDEPENDENT VERIFICATION — known algorithms, end to end (lens: algorithms).
 *
 * Nothing in this file trusts the engine's own test suite. Every expected
 * value comes from one of two sources that were written here, from the
 * textbook definitions, and never from `gates.ts` or `apply.ts`:
 *
 *  1. A CLOSED FORM derived analytically for each algorithm — the Bell
 *     amplitudes, the GHZ pair, the Deutsch–Jozsa Fourier sum, the Grover
 *     rotation angle, the teleported amplitudes.
 *  2. A SLOW REFERENCE SIMULATOR, `refRun`, which does exactly what §5.2
 *     forbids the engine from doing: it builds the full 2ⁿ × 2ⁿ operator of
 *     every step with explicit Kronecker products and multiplies it into a
 *     dense complex vector. It is O(4ⁿ) and allocates freely, which is fine at
 *     the ≤ 6 qubits used here, and it shares no line of code with the kernel.
 *
 * Most algorithm tests therefore assert a THREE-WAY agreement: closed form ==
 * dense reference == engine. When all three agree the result is strong; when
 * the closed form is the lone dissenter the fault is in this file, and when the
 * engine is the lone dissenter the fault is in the engine.
 *
 * ENDIANNESS (D1) IN THE REFERENCE. The reference never does bit arithmetic on
 * statevector indices. It builds the n-qubit operator as
 *
 *     O_{n-1} ⊗ O_{n-2} ⊗ … ⊗ O_1 ⊗ O_0
 *
 * because an index `i = Σ b_q 2^q` has qubit n-1 as its most significant bit,
 * and the most significant bit is the leading Kronecker factor. That single
 * line of reasoning is the whole of D1 as far as this file is concerned, and it
 * is independent of how `apply.ts` chose to enumerate its pairs.
 *
 * Amplitudes are compared as complex numbers, signs included: a test that only
 * checked probabilities would pass on a state with a wrong relative phase, and
 * relative phase is the entire content of Φ⁻ versus Φ⁺.
 */

import { describe, expect, it } from 'vitest'

import { bitOf, formatKet } from '../conventions.js'
import {
  MidCircuitMeasurementError,
  probabilities,
  sampleShots,
  trajectoriesMode,
} from '../measure.js'
import { createRng } from '../rng.js'
import {
  formatRegister,
  run,
  runTrajectory,
  type CircuitLike,
  type OperationLike,
} from '../runner.js'
import type { Statevector } from '../statevector.js'

/** Decision D6: engine tolerance is 1e-10. */
const TOL = 1e-10

const ROOT_HALF = Math.SQRT1_2

/* ══════════════════ complex and dense-matrix toolkit ══════════════════ */

interface Cx {
  readonly re: number
  readonly im: number
}

/** A square complex matrix, dense. Row-major, `m[row][column]`. */
type Mat = readonly (readonly Cx[])[]

/** A dense complex statevector. */
type Vec = readonly Cx[]

const ZERO: Cx = { re: 0, im: 0 }
const ONE: Cx = { re: 1, im: 0 }

function c(re: number, im = 0): Cx {
  return { re, im }
}

function cAdd(a: Cx, b: Cx): Cx {
  return { re: a.re + b.re, im: a.im + b.im }
}

function cSub(a: Cx, b: Cx): Cx {
  return { re: a.re - b.re, im: a.im - b.im }
}

function cMul(a: Cx, b: Cx): Cx {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

function cScale(a: Cx, k: number): Cx {
  return { re: a.re * k, im: a.im * k }
}

/** e^{iθ}, written out so no phase in this file comes from the engine. */
function cPhase(angle: number): Cx {
  return { re: Math.cos(angle), im: Math.sin(angle) }
}

function identity(dim: number): Mat {
  const out: Cx[][] = []
  for (let row = 0; row < dim; row++) {
    const line: Cx[] = []
    for (let column = 0; column < dim; column++) {
      line.push(row === column ? ONE : ZERO)
    }
    out.push(line)
  }
  return out
}

/** Textbook Kronecker product: `(A ⊗ B)[i][j] = A[i÷d][j÷d] · B[i%d][j%d]`. */
function kron(a: Mat, b: Mat): Mat {
  const db = b.length
  const dim = a.length * db
  const out: Cx[][] = []
  for (let row = 0; row < dim; row++) {
    const line: Cx[] = []
    for (let column = 0; column < dim; column++) {
      line.push(
        cMul(
          a[Math.floor(row / db)][Math.floor(column / db)],
          b[row % db][column % db]
        )
      )
    }
    out.push(line)
  }
  return out
}

function matAdd(a: Mat, b: Mat): Mat {
  return a.map((line, row) =>
    line.map((entry, column) => cAdd(entry, b[row][column]))
  )
}

function matSub(a: Mat, b: Mat): Mat {
  return a.map((line, row) =>
    line.map((entry, column) => cSub(entry, b[row][column]))
  )
}

function matMul(a: Mat, b: Mat): Mat {
  const dim = a.length
  const out: Cx[][] = []
  for (let row = 0; row < dim; row++) {
    const line: Cx[] = []
    for (let column = 0; column < dim; column++) {
      let sum = ZERO
      for (let k = 0; k < dim; k++)
        sum = cAdd(sum, cMul(a[row][k], b[k][column]))
      line.push(sum)
    }
    out.push(line)
  }
  return out
}

function matVec(m: Mat, v: Vec): Vec {
  const out: Cx[] = []
  for (let row = 0; row < m.length; row++) {
    let sum = ZERO
    for (let k = 0; k < v.length; k++) sum = cAdd(sum, cMul(m[row][k], v[k]))
    out.push(sum)
  }
  return out
}

/* ═══════════════ gate matrices, written from the textbook ═══════════════ */

const REF_I: Mat = [
  [ONE, ZERO],
  [ZERO, ONE],
]
const REF_X: Mat = [
  [ZERO, ONE],
  [ONE, ZERO],
]
const REF_Y: Mat = [
  [ZERO, c(0, -1)],
  [c(0, 1), ZERO],
]
const REF_Z: Mat = [
  [ONE, ZERO],
  [ZERO, c(-1)],
]
const REF_H: Mat = [
  [c(ROOT_HALF), c(ROOT_HALF)],
  [c(ROOT_HALF), c(-ROOT_HALF)],
]
const REF_S: Mat = [
  [ONE, ZERO],
  [ZERO, c(0, 1)],
]
const REF_SDG: Mat = [
  [ONE, ZERO],
  [ZERO, c(0, -1)],
]
const REF_T: Mat = [
  [ONE, ZERO],
  [ZERO, cPhase(Math.PI / 4)],
]
const REF_TDG: Mat = [
  [ONE, ZERO],
  [ZERO, cPhase(-Math.PI / 4)],
]
/** √X = ½·[[1+i, 1−i], [1−i, 1+i]]. */
const REF_SX: Mat = [
  [c(0.5, 0.5), c(0.5, -0.5)],
  [c(0.5, -0.5), c(0.5, 0.5)],
]

const PROJ_0: Mat = [
  [ONE, ZERO],
  [ZERO, ZERO],
]
const PROJ_1: Mat = [
  [ZERO, ZERO],
  [ZERO, ONE],
]

function refRx(theta: number): Mat {
  const co = Math.cos(theta / 2)
  const si = Math.sin(theta / 2)
  return [
    [c(co), c(0, -si)],
    [c(0, -si), c(co)],
  ]
}

function refRy(theta: number): Mat {
  const co = Math.cos(theta / 2)
  const si = Math.sin(theta / 2)
  return [
    [c(co), c(-si)],
    [c(si), c(co)],
  ]
}

/** Rz(θ) = diag(e^{−iθ/2}, e^{iθ/2}) — Qiskit's symmetric convention. */
function refRz(theta: number): Mat {
  return [
    [cPhase(-theta / 2), ZERO],
    [ZERO, cPhase(theta / 2)],
  ]
}

function refP(phi: number): Mat {
  return [
    [ONE, ZERO],
    [ZERO, cPhase(phi)],
  ]
}

/** U(θ,φ,λ) in Qiskit's convention, including its global phases. */
function refU(theta: number, phi: number, lambda: number): Mat {
  const co = Math.cos(theta / 2)
  const si = Math.sin(theta / 2)
  return [
    [c(co), cScale(cPhase(lambda), -si)],
    [cScale(cPhase(phi), si), cScale(cPhase(phi + lambda), co)],
  ]
}

/* ══════════════════════ the slow reference simulator ══════════════════════ */

interface Control {
  readonly qubit: number
  readonly state: 0 | 1
}

/**
 * One circuit step. Deliberately the *only* thing shared between the reference
 * and the engine: a gate id, its targets, its controls and its angles. Both
 * sides interpret that notation independently.
 */
interface Step {
  readonly gate: string
  readonly targets: readonly number[]
  readonly controls?: readonly Control[]
  readonly params?: readonly number[]
  readonly clbitTargets?: readonly number[]
  readonly condition?: { readonly clbit: number; readonly equals: 0 | 1 }
}

/**
 * Lift one factor per qubit to the full 2ⁿ operator.
 *
 * `factors[q]` acts on qubit q, and qubit n-1 leads the product because it owns
 * the most significant bit of the index (D1). This is the file's only statement
 * about endianness.
 */
function embed(factors: readonly Mat[]): Mat {
  let out = factors[factors.length - 1]
  for (let q = factors.length - 2; q >= 0; q--) out = kron(out, factors[q])
  return out
}

function oneQubitOperator(matrix: Mat, target: number, qubits: number): Mat {
  const factors: Mat[] = []
  for (let q = 0; q < qubits; q++) factors.push(q === target ? matrix : REF_I)
  return embed(factors)
}

/** Projector onto the subspace where every control reads its required value. */
function controlProjector(controls: readonly Control[], qubits: number): Mat {
  const factors: Mat[] = []
  for (let q = 0; q < qubits; q++) {
    const control = controls.find((entry) => entry.qubit === q)
    if (control === undefined) factors.push(REF_I)
    else factors.push(control.state === 1 ? PROJ_1 : PROJ_0)
  }
  return embed(factors)
}

/**
 * `(I − P) + P·U` — the definition of a controlled gate: identity where the
 * controls disagree, U where they agree. P and U act on disjoint qubits so they
 * commute, which is why this one expression covers positive controls, negative
 * controls and any number of them at once.
 */
function controlledOperator(
  base: Mat,
  target: number,
  controls: readonly Control[],
  qubits: number
): Mat {
  const full = oneQubitOperator(base, target, qubits)
  if (controls.length === 0) return full
  const projector = controlProjector(controls, qubits)
  const dim = 1 << qubits
  return matAdd(matSub(identity(dim), projector), matMul(projector, full))
}

/** SWAP as three CNOTs — the textbook identity, so no new primitive is used. */
function swapOperator(q0: number, q1: number, qubits: number): Mat {
  const outer = controlledOperator(REF_X, q1, [{ qubit: q0, state: 1 }], qubits)
  const inner = controlledOperator(REF_X, q0, [{ qubit: q1, state: 1 }], qubits)
  return matMul(outer, matMul(inner, outer))
}

function refBaseMatrix(gate: string, params: readonly number[]): Mat {
  switch (gate) {
    case 'i':
      return REF_I
    case 'x':
    case 'cx':
    case 'ccx':
      return REF_X
    case 'y':
      return REF_Y
    case 'z':
    case 'cz':
      return REF_Z
    case 'h':
      return REF_H
    case 's':
      return REF_S
    case 'sdg':
      return REF_SDG
    case 't':
      return REF_T
    case 'tdg':
      return REF_TDG
    case 'sx':
      return REF_SX
    case 'rx':
      return refRx(params[0])
    case 'ry':
      return refRy(params[0])
    case 'rz':
    case 'crz':
      return refRz(params[0])
    case 'p':
    case 'cp':
      return refP(params[0])
    case 'u':
      return refU(params[0], params[1], params[2])
    default:
      throw new Error(`the reference has no matrix for gate "${gate}"`)
  }
}

function stepOperator(step: Step, qubits: number): Mat {
  const controls = step.controls ?? []
  if (step.gate === 'swap' || step.gate === 'cswap') {
    const plain = swapOperator(step.targets[0], step.targets[1], qubits)
    if (controls.length === 0) return plain
    const projector = controlProjector(controls, qubits)
    const dim = 1 << qubits
    return matAdd(matSub(identity(dim), projector), matMul(projector, plain))
  }
  if (step.gate === 'barrier') return identity(1 << qubits)
  return controlledOperator(
    refBaseMatrix(step.gate, step.params ?? []),
    step.targets[0],
    controls,
    qubits
  )
}

/**
 * The reference run: dense 2ⁿ × 2ⁿ operators applied to |0…0⟩ in order. This is
 * the Kronecker road §5.2 forbids the engine to take, which is exactly why it
 * is worth something as an oracle.
 */
function refRun(qubits: number, steps: readonly Step[]): Vec {
  const dim = 1 << qubits
  let vector: Vec = Array.from({ length: dim }, (_, i) =>
    i === 0 ? ONE : ZERO
  )
  for (const step of steps) vector = matVec(stepOperator(step, qubits), vector)
  return vector
}

/* ═══════════════════════ engine-side helpers ═══════════════════════ */

/** One step per column, so a step's ordering and its column never disagree. */
function circuitOf(
  qubits: number,
  steps: readonly Step[],
  clbits = 0
): CircuitLike {
  const operations: OperationLike[] = steps.map((step, index) => ({
    id: `op_${index}`,
    gate: step.gate,
    targets: step.targets,
    controls: step.controls,
    params: step.params,
    column: index,
    clbitTargets: step.clbitTargets,
    condition: step.condition,
  }))
  return { qubits, clbits, operations }
}

/** Explicit columns, for the cases where simultaneity is the thing under test. */
function circuitAtColumns(
  qubits: number,
  placed: readonly (Step & { readonly column: number })[],
  clbits = 0
): CircuitLike {
  const operations: OperationLike[] = placed.map((step, index) => ({
    id: `op_${index}`,
    gate: step.gate,
    targets: step.targets,
    controls: step.controls,
    params: step.params,
    column: step.column,
    clbitTargets: step.clbitTargets,
    condition: step.condition,
  }))
  return { qubits, clbits, operations }
}

function analyticState(qubits: number, steps: readonly Step[]): Statevector {
  const result = run(circuitOf(qubits, steps))
  if (result.mode !== 'analytic') throw new Error('expected an analytic result')
  return result.state
}

function describeAmplitude(re: number, im: number): string {
  const sign = im < 0 ? '-' : '+'
  return `${re.toFixed(12)} ${sign} ${Math.abs(im).toFixed(12)}i`
}

/** Compare every amplitude, phase included. */
function expectAmplitudes(
  state: Statevector,
  expected: Vec,
  label: string
): void {
  expect(state.size, `${label}: statevector size`).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    const error =
      Math.abs(state.re[i] - expected[i].re) +
      Math.abs(state.im[i] - expected[i].im)
    expect(
      error,
      `${label}: amplitude of |${formatKet(i, state.qubits)}⟩ (index ${i}) is ` +
        `${describeAmplitude(state.re[i], state.im[i])}, expected ` +
        `${describeAmplitude(expected[i].re, expected[i].im)}`
    ).toBeLessThan(TOL)
  }
}

/** A dense expected vector from a sparse `index → amplitude` description. */
function sparse(size: number, entries: readonly [number, Cx][]): Vec {
  const out: Cx[] = Array.from({ length: size }, () => ZERO)
  for (const [index, value] of entries) out[index] = value
  return out
}

/**
 * The ket label of a basis index, derived here from D1 rather than taken from
 * `formatKet`: qubit q is bit q of the index, and the label is printed with the
 * highest qubit first. `ketLabel(5, 3) === '101'`, the worked example in the
 * docstring of `conventions.ts`.
 */
function ketLabel(index: number, qubits: number): string {
  let out = ''
  for (let q = qubits - 1; q >= 0; q--) out += (index >> q) & 1
  return out
}

/** Deterministic generator for test *inputs* only; never for expected values. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/* ═════════════════ 0. the reference against the kernel ═════════════════ */

describe('dense Kronecker reference vs the O(2ⁿ) kernel', () => {
  const POOL = [
    'h',
    'x',
    'y',
    'z',
    's',
    'sdg',
    't',
    'tdg',
    'sx',
    'rx',
    'ry',
    'rz',
    'p',
    'u',
  ] as const

  function randomSteps(
    qubits: number,
    count: number,
    rand: () => number
  ): Step[] {
    const steps: Step[] = []
    for (let k = 0; k < count; k++) {
      const roll = rand()
      const order = Array.from({ length: qubits }, (_, q) => q)
      // Fisher–Yates, so the picked qubits are always distinct.
      for (let i = qubits - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        const swapped = order[i]
        order[i] = order[j]
        order[j] = swapped
      }
      const angle = (rand() * 4 - 2) * Math.PI

      if (roll < 0.45) {
        const gate = POOL[Math.floor(rand() * POOL.length)]
        const params =
          gate === 'u'
            ? [angle, (rand() * 4 - 2) * Math.PI, (rand() * 4 - 2) * Math.PI]
            : gate === 'rx' || gate === 'ry' || gate === 'rz' || gate === 'p'
              ? [angle]
              : undefined
        // 1-qubit gates accept extra controls (GATES.x.acceptsControls), so a
        // fraction of them get one, sometimes negative.
        const controls: Control[] =
          qubits >= 2 && rand() < 0.4
            ? [{ qubit: order[1], state: rand() < 0.5 ? 0 : 1 }]
            : []
        steps.push({ gate, targets: [order[0]], controls, params })
      } else if (roll < 0.6 && qubits >= 2) {
        steps.push({
          gate: 'cx',
          targets: [order[0]],
          controls: [{ qubit: order[1], state: 1 }],
        })
      } else if (roll < 0.7 && qubits >= 2) {
        steps.push({
          gate: 'cz',
          targets: [order[0]],
          controls: [{ qubit: order[1], state: 1 }],
        })
      } else if (roll < 0.8 && qubits >= 3) {
        steps.push({
          gate: 'ccx',
          targets: [order[0]],
          controls: [
            { qubit: order[1], state: 1 },
            { qubit: order[2], state: 1 },
          ],
        })
      } else if (roll < 0.87 && qubits >= 2) {
        steps.push({
          gate: 'crz',
          targets: [order[0]],
          controls: [{ qubit: order[1], state: 1 }],
          params: [angle],
        })
      } else if (roll < 0.94 && qubits >= 2) {
        steps.push({
          gate: 'cp',
          targets: [order[0]],
          controls: [{ qubit: order[1], state: 1 }],
          params: [angle],
        })
      } else if (qubits >= 2) {
        steps.push({ gate: 'swap', targets: [order[0], order[1]] })
      } else {
        steps.push({ gate: 'h', targets: [0] })
      }
    }
    return steps
  }

  for (let qubits = 1; qubits <= 5; qubits++) {
    it(`agrees on 20 random ${qubits}-qubit circuits`, () => {
      const rand = lcg(0x5eed + qubits * 7919)
      for (let trial = 0; trial < 20; trial++) {
        const steps = randomSteps(qubits, 14, rand)
        expectAmplitudes(
          analyticState(qubits, steps),
          refRun(qubits, steps),
          `random ${qubits}-qubit circuit #${trial}: ` +
            steps
              .map(
                (s) =>
                  `${s.gate}(${s.targets.join(',')}` +
                  `${s.controls && s.controls.length > 0 ? '|c' + s.controls.map((x) => `${x.qubit}=${x.state}`).join(',') : ''})`
              )
              .join(' ')
        )
      }
    })
  }
})

/* ══════════════════════════ 1. the Bell basis ══════════════════════════ */

/**
 * All four Bell states. Each preparation is derived by hand below; the ket
 * labels are `|q1 q0⟩` (highest qubit first, as `formatKet` prints them) and
 * the index of `|q1 q0⟩` is `q0 + 2·q1`.
 *
 *   H(0), CX(0→1)              → (|00⟩ + |11⟩)/√2   Φ⁺   indices 0, 3
 *   H(0), CX(0→1), Z(0)        → (|00⟩ − |11⟩)/√2   Φ⁻   index 3 negated
 *   H(0), CX(0→1), X(0)        → (|01⟩ + |10⟩)/√2   Ψ⁺   indices 1, 2
 *   H(0), CX(0→1), Z(0), X(0)  → (|01⟩ − |10⟩)/√2   Ψ⁻   index 2 negated
 *
 * Ψ⁻ is the one that would catch a mirrored register: it is antisymmetric, so
 * swapping the two qubits flips its sign, and nothing else here would notice.
 */
describe('Bell states', () => {
  const H0: Step = { gate: 'h', targets: [0] }
  const CX01: Step = {
    gate: 'cx',
    targets: [1],
    controls: [{ qubit: 0, state: 1 }],
  }
  const Z0: Step = { gate: 'z', targets: [0] }
  const X0: Step = { gate: 'x', targets: [0] }

  const CASES = [
    {
      name: 'Φ⁺ = (|00⟩ + |11⟩)/√2',
      steps: [H0, CX01],
      expected: sparse(4, [
        [0, c(ROOT_HALF)],
        [3, c(ROOT_HALF)],
      ]),
    },
    {
      name: 'Φ⁻ = (|00⟩ − |11⟩)/√2',
      steps: [H0, CX01, Z0],
      expected: sparse(4, [
        [0, c(ROOT_HALF)],
        [3, c(-ROOT_HALF)],
      ]),
    },
    {
      name: 'Ψ⁺ = (|01⟩ + |10⟩)/√2',
      steps: [H0, CX01, X0],
      expected: sparse(4, [
        [1, c(ROOT_HALF)],
        [2, c(ROOT_HALF)],
      ]),
    },
    {
      name: 'Ψ⁻ = (|01⟩ − |10⟩)/√2',
      steps: [H0, CX01, Z0, X0],
      expected: sparse(4, [
        [1, c(ROOT_HALF)],
        [2, c(-ROOT_HALF)],
      ]),
    },
  ] as const

  for (const bell of CASES) {
    it(`${bell.name} matches the closed form`, () => {
      expectAmplitudes(analyticState(2, bell.steps), bell.expected, bell.name)
    })

    it(`${bell.name} matches the dense reference`, () => {
      expectAmplitudes(
        analyticState(2, bell.steps),
        refRun(2, bell.steps),
        `${bell.name} vs dense reference`
      )
    })
  }

  it('every Bell state is maximally entangled: each marginal is exactly ½', () => {
    for (const bell of CASES) {
      const bars = probabilities(analyticState(2, bell.steps))
      for (const qubit of [0, 1]) {
        let sum = 0
        for (let i = 0; i < bars.length; i++) {
          if (bitOf(i, qubit) === 1) sum += bars[i]
        }
        expect(sum, `${bell.name}: P(qubit ${qubit} = 1)`).toBeCloseTo(0.5, 12)
      }
    }
  })

  it('Ψ⁻ is antisymmetric — swapping the qubits negates it', () => {
    // A relabelling of the register maps index q0+2q1 to q1+2q0, i.e. swaps
    // indices 1 and 2. Ψ⁻ must come back as −Ψ⁻; Φ± and Ψ⁺ come back unchanged.
    const psiMinus = analyticState(2, [H0, CX01, Z0, X0])
    const swapped = analyticState(2, [
      H0,
      CX01,
      Z0,
      X0,
      { gate: 'swap', targets: [0, 1] },
    ])
    for (let i = 0; i < 4; i++) {
      expect(swapped.re[i] + psiMinus.re[i], `index ${i}`).toBeCloseTo(0, 12)
    }
  })
})

/* ══════════════════════════════ 2. GHZ ══════════════════════════════════ */

describe('GHZ states', () => {
  /** H on qubit 0, then a CNOT chain 0→1→2→…→n-1. */
  function chain(qubits: number): Step[] {
    const steps: Step[] = [{ gate: 'h', targets: [0] }]
    for (let q = 1; q < qubits; q++) {
      steps.push({
        gate: 'cx',
        targets: [q],
        controls: [{ qubit: q - 1, state: 1 }],
      })
    }
    return steps
  }

  /** H on qubit 0, then a CNOT fan-out 0→k for every k. Same state, depth 2. */
  function star(qubits: number): Step[] {
    const steps: Step[] = [{ gate: 'h', targets: [0] }]
    for (let q = 1; q < qubits; q++) {
      steps.push({
        gate: 'cx',
        targets: [q],
        controls: [{ qubit: 0, state: 1 }],
      })
    }
    return steps
  }

  function ghzExpected(qubits: number): Vec {
    const size = 1 << qubits
    return sparse(size, [
      [0, c(ROOT_HALF)],
      [size - 1, c(ROOT_HALF)],
    ])
  }

  for (const qubits of [3, 4, 5]) {
    it(`GHZ-${qubits} from a CNOT chain is (|0…0⟩ + |1…1⟩)/√2`, () => {
      const steps = chain(qubits)
      expectAmplitudes(
        analyticState(qubits, steps),
        ghzExpected(qubits),
        `GHZ-${qubits} chain closed form`
      )
      expectAmplitudes(
        analyticState(qubits, steps),
        refRun(qubits, steps),
        `GHZ-${qubits} chain vs dense reference`
      )
    })

    it(`GHZ-${qubits} from a CNOT fan-out is the same state`, () => {
      const steps = star(qubits)
      expectAmplitudes(
        analyticState(qubits, steps),
        ghzExpected(qubits),
        `GHZ-${qubits} star closed form`
      )
    })

    it(`GHZ-${qubits} is the same state under a permuted wiring`, () => {
      // Entangle in the order n-1 → 0 → 1 → … instead of 0 → 1 → 2 → …. The
      // state is symmetric under relabelling, so only an indexing bug in the
      // engine could tell the two circuits apart.
      const steps: Step[] = [{ gate: 'h', targets: [qubits - 1] }]
      steps.push({
        gate: 'cx',
        targets: [0],
        controls: [{ qubit: qubits - 1, state: 1 }],
      })
      for (let q = 1; q < qubits - 1; q++) {
        steps.push({
          gate: 'cx',
          targets: [q],
          controls: [{ qubit: q - 1, state: 1 }],
        })
      }
      expectAmplitudes(
        analyticState(qubits, steps),
        ghzExpected(qubits),
        `GHZ-${qubits} permuted wiring`
      )
    })

    it(`GHZ-${qubits} samples only the two all-equal outcomes`, () => {
      const state = analyticState(qubits, chain(qubits))
      const bars = probabilities(state)
      const size = 1 << qubits
      for (let i = 0; i < size; i++) {
        const want = i === 0 || i === size - 1 ? 0.5 : 0
        expect(
          bars[i],
          `GHZ-${qubits}: P(|${formatKet(i, qubits)}⟩)`
        ).toBeCloseTo(want, 12)
      }
    })
  }
})

/* ═══════════════════════ 3. Deutsch–Jozsa ═══════════════════════════════ */

/**
 * Deutsch–Jozsa on 3 input qubits plus a phase-kickback ancilla (qubit 3).
 *
 * Circuit: X on the ancilla, H everywhere, U_f, then H on the inputs only.
 * After the kickback the state is
 *
 *     Σ_z [ 2⁻ⁿ Σ_x (−1)^{f(x) ⊕ x·z} ] |z⟩ ⊗ |−⟩
 *
 * and that bracket is computed here by DIRECT SUMMATION over all 2ⁿ values of
 * x, for whatever `f` the oracle circuit implements. That makes the expected
 * amplitudes exact for constant, affine and non-affine balanced oracles alike,
 * without any appeal to "the answer should be all zeros".
 */
describe('Deutsch–Jozsa', () => {
  const INPUTS = 3
  const ANCILLA = INPUTS

  function parityOf(value: number): 0 | 1 {
    let bits = value
    let odd = 0
    while (bits !== 0) {
      odd ^= bits & 1
      bits >>>= 1
    }
    return odd as 0 | 1
  }

  function djExpected(f: (x: number) => 0 | 1): Vec {
    const size = 1 << INPUTS
    const coefficients: number[] = []
    for (let z = 0; z < size; z++) {
      let sum = 0
      for (let x = 0; x < size; x++) {
        const sign = (f(x) ^ parityOf(x & z)) === 1 ? -1 : 1
        sum += sign
      }
      coefficients.push(sum / size)
    }
    const out: Cx[] = []
    for (let i = 0; i < size * 2; i++) {
      const z = i & (size - 1)
      const ancilla = (i >> INPUTS) & 1
      out.push(c(coefficients[z] * (ancilla === 1 ? -ROOT_HALF : ROOT_HALF)))
    }
    return out
  }

  /** U_f for `f(x) = 1 ⟺ x ∈ set`, one multi-controlled X on the ancilla. */
  function tableOracle(set: readonly number[]): Step[] {
    return set.map((x) => ({
      gate: 'x',
      targets: [ANCILLA],
      controls: Array.from({ length: INPUTS }, (_, q) => ({
        qubit: q,
        state: bitOf(x, q),
      })),
    }))
  }

  const ORACLES = [
    {
      name: 'constant f ≡ 0',
      constant: true,
      f: (): 0 | 1 => 0,
      steps: [] as Step[],
    },
    {
      name: 'constant f ≡ 1',
      constant: true,
      f: (): 0 | 1 => 1,
      steps: [{ gate: 'x', targets: [ANCILLA] }] as Step[],
    },
    {
      name: 'balanced f(x) = x₀',
      constant: false,
      f: (x: number): 0 | 1 => bitOf(x, 0),
      steps: [
        {
          gate: 'cx',
          targets: [ANCILLA],
          controls: [{ qubit: 0, state: 1 }],
        },
      ] as Step[],
    },
    {
      name: 'balanced f(x) = 1 ⊕ x₀ (a negative control)',
      constant: false,
      f: (x: number): 0 | 1 => (bitOf(x, 0) ^ 1) as 0 | 1,
      steps: [
        {
          gate: 'x',
          targets: [ANCILLA],
          controls: [{ qubit: 0, state: 0 }],
        },
      ] as Step[],
    },
    {
      name: 'balanced f(x) = x₁ ⊕ x₂',
      constant: false,
      f: (x: number): 0 | 1 => (bitOf(x, 1) ^ bitOf(x, 2)) as 0 | 1,
      steps: [
        {
          gate: 'cx',
          targets: [ANCILLA],
          controls: [{ qubit: 1, state: 1 }],
        },
        {
          gate: 'cx',
          targets: [ANCILLA],
          controls: [{ qubit: 2, state: 1 }],
        },
      ] as Step[],
    },
    {
      name: 'balanced f(x) = x₀ ⊕ x₁ ⊕ x₂',
      constant: false,
      f: (x: number): 0 | 1 =>
        (bitOf(x, 0) ^ bitOf(x, 1) ^ bitOf(x, 2)) as 0 | 1,
      steps: [
        {
          gate: 'cx',
          targets: [ANCILLA],
          controls: [{ qubit: 0, state: 1 }],
        },
        {
          gate: 'cx',
          targets: [ANCILLA],
          controls: [{ qubit: 1, state: 1 }],
        },
        {
          gate: 'cx',
          targets: [ANCILLA],
          controls: [{ qubit: 2, state: 1 }],
        },
      ] as Step[],
    },
    {
      // Balanced but not affine: f(1) ⊕ f(2) ≠ f(3) ⊕ f(0), so no parity
      // circuit can express it. Exercises multi-controlled X with a mix of
      // positive and negative controls.
      name: 'balanced non-affine f = 1 on {000, 001, 010, 100}',
      constant: false,
      f: (x: number): 0 | 1 => ([0, 1, 2, 4].includes(x) ? 1 : 0),
      steps: tableOracle([0, 1, 2, 4]),
    },
  ] as const

  function djCircuit(oracle: readonly Step[]): Step[] {
    const steps: Step[] = [{ gate: 'x', targets: [ANCILLA] }]
    for (let q = 0; q <= ANCILLA; q++) steps.push({ gate: 'h', targets: [q] })
    steps.push(...oracle)
    for (let q = 0; q < INPUTS; q++) steps.push({ gate: 'h', targets: [q] })
    return steps
  }

  for (const oracle of ORACLES) {
    it(`${oracle.name}: full statevector matches the Fourier sum`, () => {
      const steps = djCircuit(oracle.steps)
      const state = analyticState(INPUTS + 1, steps)
      expectAmplitudes(state, djExpected(oracle.f), `DJ ${oracle.name}`)
      expectAmplitudes(
        state,
        refRun(INPUTS + 1, steps),
        `DJ ${oracle.name} vs dense reference`
      )
    })

    it(`${oracle.name}: the verdict bit is ${oracle.constant ? 'constant' : 'balanced'}`, () => {
      const bars = probabilities(
        analyticState(INPUTS + 1, djCircuit(oracle.steps))
      )
      // The algorithm's answer: P(inputs all read 0) is 1 for a constant f and
      // exactly 0 for a balanced one. Sum over the ancilla, which is |−⟩.
      let allZero = 0
      for (let i = 0; i < bars.length; i++) {
        if ((i & ((1 << INPUTS) - 1)) === 0) allZero += bars[i]
      }
      expect(allZero, `DJ ${oracle.name}: P(inputs = 000)`).toBeCloseTo(
        oracle.constant ? 1 : 0,
        12
      )
    })
  }

  it('a linear oracle f(x) = a·x reads the mask a off the input register', () => {
    // Stronger than "not all zeros": for f(x) = a·x the final input register is
    // the basis state |a⟩ with certainty. Checks the bit *positions*, which is
    // where a mirrored register would show up.
    for (const mask of [1, 2, 4, 3, 5, 6, 7]) {
      const oracle: Step[] = []
      for (let q = 0; q < INPUTS; q++) {
        if (bitOf(mask, q) === 1) {
          oracle.push({
            gate: 'cx',
            targets: [ANCILLA],
            controls: [{ qubit: q, state: 1 }],
          })
        }
      }
      const bars = probabilities(analyticState(INPUTS + 1, djCircuit(oracle)))
      for (let z = 0; z < 1 << INPUTS; z++) {
        let total = 0
        for (let a = 0; a < 2; a++) total += bars[z + (a << INPUTS)]
        expect(
          total,
          `DJ f(x)=${mask}·x: P(inputs = |${formatKet(z, INPUTS)}⟩)`
        ).toBeCloseTo(z === mask ? 1 : 0, 12)
      }
    }
  })
})

/* ═════════════════════════════ 4. Grover ═══════════════════════════════ */

/**
 * Grover on 3 qubits, all 8 marked elements.
 *
 * Oracle: X on every qubit whose bit in `marked` is 0, then a CCZ on
 * (0,1 → 2), then the same X layer again. CCZ flips the phase of |111⟩, so the
 * conjugation moves that phase flip onto |marked⟩: O = I − 2|m⟩⟨m|.
 *
 * Diffuser: H⊗³, X⊗³, CCZ, X⊗³, H⊗³. The inner three layers give
 * I − 2|000⟩⟨000|, and conjugating by H⊗³ gives I − 2|s⟩⟨s|, which is MINUS
 * the textbook diffuser 2|s⟩⟨s| − I. So one iteration of this circuit is −G,
 * and after k iterations the state is (−1)^k times the textbook one. The
 * closed form below carries that factor explicitly — it is a global phase and
 * cannot be observed, but a test that compares amplitudes must account for it.
 *
 * Closed form (Boyer–Brassard–Høyer–Tapp): with sin θ = 1/√N,
 *
 *     |ψ_k⟩ = sin((2k+1)θ)|m⟩ + cos((2k+1)θ)/√(N−1) · Σ_{x≠m} |x⟩
 */
describe('Grover search on 3 qubits', () => {
  const QUBITS = 3
  const N = 1 << QUBITS
  const CCZ: Step = {
    gate: 'z',
    targets: [2],
    controls: [
      { qubit: 0, state: 1 },
      { qubit: 1, state: 1 },
    ],
  }

  function oracleSteps(marked: number): Step[] {
    const flip: Step[] = []
    for (let q = 0; q < QUBITS; q++) {
      if (bitOf(marked, q) === 0) flip.push({ gate: 'x', targets: [q] })
    }
    return [...flip, CCZ, ...flip]
  }

  function diffuserSteps(): Step[] {
    const hLayer: Step[] = []
    const xLayer: Step[] = []
    for (let q = 0; q < QUBITS; q++) {
      hLayer.push({ gate: 'h', targets: [q] })
      xLayer.push({ gate: 'x', targets: [q] })
    }
    return [...hLayer, ...xLayer, CCZ, ...xLayer, ...hLayer]
  }

  function groverCircuit(marked: number, iterations: number): Step[] {
    const steps: Step[] = []
    for (let q = 0; q < QUBITS; q++) steps.push({ gate: 'h', targets: [q] })
    for (let k = 0; k < iterations; k++) {
      steps.push(...oracleSteps(marked), ...diffuserSteps())
    }
    return steps
  }

  function groverExpected(marked: number, iterations: number): Vec {
    const theta = Math.asin(1 / Math.sqrt(N))
    const angle = (2 * iterations + 1) * theta
    const globalSign = iterations % 2 === 0 ? 1 : -1
    const onMark = globalSign * Math.sin(angle)
    const offMark = (globalSign * Math.cos(angle)) / Math.sqrt(N - 1)
    const out: Cx[] = []
    for (let i = 0; i < N; i++) out.push(c(i === marked ? onMark : offMark))
    return out
  }

  for (let marked = 0; marked < N; marked++) {
    it(`marked |${formatKet(marked, QUBITS)}⟩: amplitudes match the rotation formula`, () => {
      for (const iterations of [0, 1, 2, 3]) {
        const steps = groverCircuit(marked, iterations)
        const state = analyticState(QUBITS, steps)
        expectAmplitudes(
          state,
          groverExpected(marked, iterations),
          `Grover m=${marked}, k=${iterations} closed form`
        )
        expectAmplitudes(
          state,
          refRun(QUBITS, steps),
          `Grover m=${marked}, k=${iterations} vs dense reference`
        )
      }
    })
  }

  it('two iterations put more than 0.94 on the marked element (§13)', () => {
    for (let marked = 0; marked < N; marked++) {
      const bars = probabilities(
        analyticState(QUBITS, groverCircuit(marked, 2))
      )
      expect(
        bars[marked],
        `Grover m=${marked}: P(marked) after 2 iterations`
      ).toBeGreaterThan(0.94)
      // The exact value: sin²(5·asin(1/√8)) = 0.945312…
      expect(bars[marked]).toBeCloseTo(
        Math.sin(5 * Math.asin(1 / Math.sqrt(N))) ** 2,
        12
      )
    }
  })

  it('the oracle alone flips exactly the marked amplitude', () => {
    // Isolates the phase-flip construction from the diffuser: on the uniform
    // superposition the marked amplitude must be −1/√N and every other +1/√N.
    for (let marked = 0; marked < N; marked++) {
      const steps: Step[] = []
      for (let q = 0; q < QUBITS; q++) steps.push({ gate: 'h', targets: [q] })
      steps.push(...oracleSteps(marked))
      const state = analyticState(QUBITS, steps)
      const amplitude = 1 / Math.sqrt(N)
      expectAmplitudes(
        state,
        Array.from({ length: N }, (_, i) =>
          c(i === marked ? -amplitude : amplitude)
        ),
        `Grover oracle m=${marked}`
      )
    }
  })

  it('an oracle built from negative controls gives the identical state', () => {
    // A structurally different construction of the same operator: the phase
    // flip is hung off qubit 0 instead of qubit 2 and the pattern is carried by
    // negative controls rather than by an X sandwich. Both must produce the
    // same Grover state to the last bit, which is a direct check that a
    // negative control on qubit q means the bit `(i >> q) & 1` is 0.
    for (let marked = 0; marked < N; marked++) {
      const flip: Step[] =
        bitOf(marked, 0) === 0 ? [{ gate: 'x', targets: [0] }] : []
      const oracle: Step[] = [
        ...flip,
        {
          gate: 'z',
          targets: [0],
          controls: [
            { qubit: 1, state: bitOf(marked, 1) },
            { qubit: 2, state: bitOf(marked, 2) },
          ],
        },
        ...flip,
      ]
      const steps: Step[] = []
      for (let q = 0; q < QUBITS; q++) steps.push({ gate: 'h', targets: [q] })
      for (let k = 0; k < 2; k++) steps.push(...oracle, ...diffuserSteps())
      expectAmplitudes(
        analyticState(QUBITS, steps),
        groverExpected(marked, 2),
        `Grover m=${marked} with a negative-control oracle`
      )
    }
  })

  it('stays on the closed form for 10 iterations (200+ gates, D6 drift)', () => {
    // Grover over-rotates past the optimum and comes back; the formula holds
    // for every k. Ten iterations is ~203 gates, so the run crosses three of
    // D6's 64-gate renormalisation boundaries and any drift accumulates.
    for (const marked of [0, 3, 6]) {
      for (let k = 0; k <= 10; k++) {
        expectAmplitudes(
          analyticState(QUBITS, groverCircuit(marked, k)),
          groverExpected(marked, k),
          `Grover m=${marked}, k=${k} (long run)`
        )
      }
    }
  })

  it('sampled shots agree with the analytic distribution (trajectories path)', () => {
    // Ties the two execution modes together: the same circuit, measured into a
    // classical register, must produce the marked bitstring ~94.5% of the time,
    // and `formatRegister` must label it the same way `formatKet` does.
    const shots = 4000
    // Deliberately non-palindromic bitstrings (1 = "001", 6 = "110"): a marked
    // value like 5 = "101" reads the same in either direction and would let a
    // reversed histogram label through.
    for (const marked of [1, 5, 6]) {
      const steps = [...groverCircuit(marked, 2)]
      for (let q = 0; q < QUBITS; q++) {
        steps.push({ gate: 'measure', targets: [q], clbitTargets: [q] })
      }
      const result = run(
        circuitOf(QUBITS, steps, QUBITS),
        trajectoriesMode(shots, createRng(20260814 + marked))
      )
      if (result.mode !== 'trajectories') throw new Error('expected counts')
      const label = formatKet(marked, QUBITS)
      const hits = result.counts[label] ?? 0
      const expected = shots * Math.sin(5 * Math.asin(1 / Math.sqrt(N))) ** 2
      // ±5σ of a binomial with p ≈ 0.945: about 5·√(4000·0.945·0.055) ≈ 72.
      expect(
        hits,
        `Grover m=${marked}: counts["${label}"] = ${hits}, expected ` +
          `${expected.toFixed(1)} ± 72 out of ${shots}. Full counts: ` +
          JSON.stringify(result.counts)
      ).toBeGreaterThan(expected - 72)
      expect(hits).toBeLessThan(expected + 72)
    }
  })
})

/* ══════════════════════ 5. quantum teleportation ═══════════════════════ */

/**
 * Teleportation with random input states, through the trajectories path.
 *
 * Layout: qubit 0 is Alice's payload, qubit 1 her half of the Bell pair,
 * qubit 2 Bob's half. c0 records qubit 0, c1 records qubit 1.
 *
 * Derivation of the correction order, which is the part a test has to pin:
 * after CX(0→1) and H(0) the joint state is
 *
 *     ½ Σ_{m0,m1} |m0⟩₀|m1⟩₁ ⊗ (X^{m1} Z^{m0} |ψ⟩)₂
 *
 * so Bob recovers |ψ⟩ exactly — no residual phase — by applying X if c1 is 1
 * and then Z if c0 is 1, in that order. `collapse` renormalises by a positive
 * real factor, so the surviving branch keeps its amplitudes verbatim and the
 * final state must be |m1 m0⟩ ⊗ (α|0⟩ + β|1⟩) with α = cos(θ/2) and
 * β = e^{iφ}·sin(θ/2) — the image of |0⟩ under U(θ, φ, λ), which is
 * independent of λ.
 */
describe('quantum teleportation', () => {
  function teleportSteps(theta: number, phi: number, lambda: number): Step[] {
    return [
      { gate: 'u', targets: [0], params: [theta, phi, lambda] },
      { gate: 'h', targets: [1] },
      { gate: 'cx', targets: [2], controls: [{ qubit: 1, state: 1 }] },
      { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
      { gate: 'h', targets: [0] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'measure', targets: [1], clbitTargets: [1] },
      { gate: 'x', targets: [2], condition: { clbit: 1, equals: 1 } },
      { gate: 'z', targets: [2], condition: { clbit: 0, equals: 1 } },
    ]
  }

  it('recovers every random input state exactly, on every branch', () => {
    const rand = lcg(0xbe11)
    const rng = createRng(4242)
    const seen = new Set<string>()

    for (let trial = 0; trial < 48; trial++) {
      const theta = rand() * Math.PI
      const phi = (rand() * 2 - 1) * Math.PI
      // A deliberately non-zero λ: U(θ,φ,λ)|0⟩ does not depend on it, so a
      // λ leaking into the first column of the matrix would show up here.
      const lambda = (rand() * 2 - 1) * Math.PI

      const alpha = c(Math.cos(theta / 2))
      const beta = cScale(cPhase(phi), Math.sin(theta / 2))

      const trajectory = runTrajectory(
        circuitOf(3, teleportSteps(theta, phi, lambda), 2),
        rng
      )
      const c0 = trajectory.register[0]
      const c1 = trajectory.register[1]
      seen.add(`${c1}${c0}`)

      // Qubits 0 and 1 have collapsed onto |c0⟩ and |c1⟩, so only the two
      // indices that agree with them may be non-zero.
      const base = c0 + 2 * c1
      expectAmplitudes(
        trajectory.state,
        sparse(8, [
          [base, alpha],
          [base + 4, beta],
        ]),
        `teleportation trial ${trial} (θ=${theta.toFixed(6)}, ` +
          `φ=${phi.toFixed(6)}, λ=${lambda.toFixed(6)}, outcomes c1c0=${c1}${c0})`
      )
      expect(
        formatRegister(trajectory.register),
        `teleportation trial ${trial}: register label`
      ).toBe(`${c1}${c0}`)
    }

    expect(
      [...seen].sort().join(' '),
      'all four measurement branches must occur over 48 trials'
    ).toBe('00 01 10 11')
  })

  it('works with both measurements packed into one column', () => {
    // The layout the spec's own §6 example implies: the two measurements are
    // simultaneous (disjoint qubits, disjoint clbits) and the corrections come
    // in later columns. The classical register must be visible to them.
    const rand = lcg(0x0c01)
    const rng = createRng(5150)
    for (let trial = 0; trial < 16; trial++) {
      const theta = rand() * Math.PI
      const phi = (rand() * 2 - 1) * Math.PI
      const trajectory = runTrajectory(
        circuitAtColumns(
          3,
          [
            { gate: 'u', targets: [0], params: [theta, phi, 0], column: 0 },
            { gate: 'h', targets: [1], column: 0 },
            {
              gate: 'cx',
              targets: [2],
              controls: [{ qubit: 1, state: 1 }],
              column: 1,
            },
            {
              gate: 'cx',
              targets: [1],
              controls: [{ qubit: 0, state: 1 }],
              column: 2,
            },
            { gate: 'h', targets: [0], column: 3 },
            { gate: 'measure', targets: [0], clbitTargets: [0], column: 4 },
            { gate: 'measure', targets: [1], clbitTargets: [1], column: 4 },
            {
              gate: 'x',
              targets: [2],
              condition: { clbit: 1, equals: 1 },
              column: 5,
            },
            {
              gate: 'z',
              targets: [2],
              condition: { clbit: 0, equals: 1 },
              column: 6,
            },
          ],
          2
        ),
        rng
      )
      const base = trajectory.register[0] + 2 * trajectory.register[1]
      expectAmplitudes(
        trajectory.state,
        sparse(8, [
          [base, c(Math.cos(theta / 2))],
          [base + 4, cScale(cPhase(phi), Math.sin(theta / 2))],
        ]),
        `packed-column teleportation trial ${trial}`
      )
    }
  })

  it('works on a non-adjacent wiring (payload q2, Bell pair q0–q1)', () => {
    // Same protocol with the three roles permuted: payload on qubit 2, Alice's
    // half of the pair on qubit 0, Bob's on qubit 1. Bob's qubit is now between
    // the other two, so any assumption that the teleported qubit is the highest
    // index would show here.
    const rand = lcg(0xfeed)
    const rng = createRng(6060)
    for (let trial = 0; trial < 16; trial++) {
      const theta = rand() * Math.PI
      const phi = (rand() * 2 - 1) * Math.PI
      const trajectory = runTrajectory(
        circuitOf(
          3,
          [
            { gate: 'u', targets: [2], params: [theta, phi, 0.9] },
            { gate: 'h', targets: [0] },
            { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
            { gate: 'cx', targets: [0], controls: [{ qubit: 2, state: 1 }] },
            { gate: 'h', targets: [2] },
            { gate: 'measure', targets: [2], clbitTargets: [0] },
            { gate: 'measure', targets: [0], clbitTargets: [1] },
            { gate: 'x', targets: [1], condition: { clbit: 1, equals: 1 } },
            { gate: 'z', targets: [1], condition: { clbit: 0, equals: 1 } },
          ],
          2
        ),
        rng
      )
      // index = q0 + 2·q1 + 4·q2, with q0 = c1, q2 = c0 and q1 carrying |ψ⟩.
      const base = trajectory.register[1] + 4 * trajectory.register[0]
      expectAmplitudes(
        trajectory.state,
        sparse(8, [
          [base, c(Math.cos(theta / 2))],
          [base + 2, cScale(cPhase(phi), Math.sin(theta / 2))],
        ]),
        `permuted-wiring teleportation trial ${trial}`
      )
    }
  })

  it('the four branches are equiprobable', () => {
    // Each branch carries amplitude ½ before collapse, independent of |ψ⟩.
    const steps = teleportSteps(1.1, 0.7, 0.3)
    const result = run(
      circuitOf(3, steps, 2),
      trajectoriesMode(4000, createRng(777))
    )
    if (result.mode !== 'trajectories') throw new Error('expected counts')
    for (const label of ['00', '01', '10', '11']) {
      const hits = result.counts[label] ?? 0
      // ±5σ of a binomial with p = ¼: 5·√(4000·0.25·0.75) ≈ 137.
      expect(
        hits,
        `teleportation branch ${label}: ${hits} of 4000, expected 1000 ± 137. ` +
          `Full counts: ${JSON.stringify(result.counts)}`
      ).toBeGreaterThan(863)
      expect(hits).toBeLessThan(1137)
    }
  })

  it('analytic mode refuses a teleportation circuit', () => {
    // §5.3: a circuit that measures before it ends has no single final state.
    expect(() => run(circuitOf(3, teleportSteps(0.4, 0.2, 0.1), 2))).toThrow(
      MidCircuitMeasurementError
    )
  })
})

/* ═══════════════════════ 6. superdense coding ══════════════════════════ */

/**
 * Superdense coding: two classical bits down one qubit.
 *
 * Alice holds qubit 0, Bob qubit 1. They share Φ⁺ = (|00⟩ + |11⟩)/√2. To send
 * (b, a) Alice applies X^b then Z^a to qubit 0 and hands it over; Bob undoes
 * the preparation with CX(0→1) then H(0).
 *
 * Which decoded basis state each message produces is derived, not guessed. The
 * preparation H(0), CX(0→1) maps the input |q1 q0⟩ = |b, a⟩ to
 *
 *     (|0⟩₀|b⟩₁ + (−1)^a |1⟩₀|b̄⟩₁)/√2
 *
 * and Alice's Z^a X^b applied to Φ⁺ reproduces exactly that vector, sign
 * included. So the decoder — the inverse of the preparation — returns
 * |q1 q0⟩ = |b, a⟩ with amplitude exactly +1, i.e. statevector index a + 2b.
 */
describe('superdense coding', () => {
  function encodeSteps(a: 0 | 1, b: 0 | 1): Step[] {
    const steps: Step[] = []
    if (b === 1) steps.push({ gate: 'x', targets: [0] })
    if (a === 1) steps.push({ gate: 'z', targets: [0] })
    return steps
  }

  function protocolSteps(a: 0 | 1, b: 0 | 1): Step[] {
    return [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
      ...encodeSteps(a, b),
      { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
      { gate: 'h', targets: [0] },
    ]
  }

  const MESSAGES: readonly [0 | 1, 0 | 1][] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]

  for (const [a, b] of MESSAGES) {
    it(`message (b=${b}, a=${a}) decodes to |${b}${a}⟩ with amplitude 1`, () => {
      const steps = protocolSteps(a, b)
      const state = analyticState(2, steps)
      const index = a + 2 * b
      expectAmplitudes(
        state,
        sparse(4, [[index, ONE]]),
        `superdense (b=${b}, a=${a})`
      )
      expectAmplitudes(
        state,
        refRun(2, steps),
        `superdense (b=${b}, a=${a}) vs dense reference`
      )
    })

    it(`message (b=${b}, a=${a}) is read out with certainty over 256 shots`, () => {
      const steps: Step[] = [
        ...protocolSteps(a, b),
        { gate: 'measure', targets: [0], clbitTargets: [0] },
        { gate: 'measure', targets: [1], clbitTargets: [1] },
      ]
      const result = run(
        circuitOf(2, steps, 2),
        trajectoriesMode(256, createRng(99 + a * 2 + b))
      )
      if (result.mode !== 'trajectories') throw new Error('expected counts')
      // `formatRegister` prints the highest clbit first, so the label is c1c0.
      expect(result.counts, `superdense (b=${b}, a=${a}) counts`).toEqual({
        [`${b}${a}`]: 256,
      })
    })
  }

  it('the four encodings produce four mutually orthogonal Bell states', () => {
    // The protocol only works because Alice's four local operations map Φ⁺ to
    // an orthonormal basis. Checked directly on the pre-decoding states.
    const encoded = MESSAGES.map(([a, b]) =>
      analyticState(2, [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
        ...encodeSteps(a, b),
      ])
    )
    for (let i = 0; i < encoded.length; i++) {
      for (let j = 0; j < encoded.length; j++) {
        let re = 0
        let im = 0
        for (let k = 0; k < 4; k++) {
          // ⟨ψᵢ|ψⱼ⟩ = Σ conj(aᵏᵢ)·aᵏⱼ
          re +=
            encoded[i].re[k] * encoded[j].re[k] +
            encoded[i].im[k] * encoded[j].im[k]
          im +=
            encoded[i].re[k] * encoded[j].im[k] -
            encoded[i].im[k] * encoded[j].re[k]
        }
        expect(re, `⟨ψ${i}|ψ${j}⟩ real part`).toBeCloseTo(i === j ? 1 : 0, 12)
        expect(im, `⟨ψ${i}|ψ${j}⟩ imaginary part`).toBeCloseTo(0, 12)
      }
    }
  })
})

/* ═════════════════ 7. the trajectories path in isolation ═══════════════ */

/* ══════════════ 8. the labelling that ties the two modes ═══════════════ */

/**
 * Every algorithm above is only readable if the amplitude at index `i` and the
 * histogram bar labelled `formatKet(i, n)` are the same outcome. A reversed
 * label is invisible on symmetric states — Bell, GHZ and the palindromic Grover
 * markers all read the same backwards — so it gets its own check on a state
 * that is deliberately asymmetric.
 */
describe('basis-state labelling', () => {
  const QUBITS = 3

  it('labels an index highest-qubit-first, as D1 specifies', () => {
    for (let i = 0; i < 1 << QUBITS; i++) {
      expect(formatKet(i, QUBITS), `formatKet(${i}, ${QUBITS})`).toBe(
        ketLabel(i, QUBITS)
      )
    }
    // The worked example from the docstring of conventions.ts, spelled out.
    expect(formatKet(5, 3)).toBe('101')
    expect(formatKet(4, 3)).toBe('100')
    expect(formatKet(1, 3)).toBe('001')
  })

  for (const index of [1, 4, 3, 6]) {
    it(`|${ketLabel(index, QUBITS)}⟩ is sampled and measured under its own label`, () => {
      // Prepare the basis state |index⟩ with an X on each set qubit. The
      // analytic histogram and the trajectories register must both name it the
      // same way, and that way must be highest-qubit-first.
      const steps: Step[] = []
      for (let q = 0; q < QUBITS; q++) {
        if (bitOf(index, q) === 1) steps.push({ gate: 'x', targets: [q] })
      }
      const label = ketLabel(index, QUBITS)

      const state = analyticState(QUBITS, steps)
      expectAmplitudes(
        state,
        sparse(1 << QUBITS, [[index, ONE]]),
        `basis state ${label}`
      )
      expect(
        sampleShots(state, 32, createRng(11)),
        `sampleShots label for index ${index}`
      ).toEqual({ [label]: 32 })

      const measured = steps.concat(
        Array.from({ length: QUBITS }, (_, q) => ({
          gate: 'measure',
          targets: [q],
          clbitTargets: [q],
        }))
      )
      const result = run(
        circuitOf(QUBITS, measured, QUBITS),
        trajectoriesMode(32, createRng(12))
      )
      if (result.mode !== 'trajectories') throw new Error('expected counts')
      expect(result.counts, `register label for index ${index}`).toEqual({
        [label]: 32,
      })
    })
  }
})

describe('mid-circuit measurement', () => {
  it('a measured Bell pair only ever reads 00 or 11', () => {
    const steps: Step[] = [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'measure', targets: [1], clbitTargets: [1] },
    ]
    const result = run(
      circuitOf(2, steps, 2),
      trajectoriesMode(2000, createRng(31337))
    )
    if (result.mode !== 'trajectories') throw new Error('expected counts')
    expect(
      Object.keys(result.counts).sort().join(' '),
      `a Bell pair cannot produce anticorrelated outcomes. Counts: ${JSON.stringify(result.counts)}`
    ).toBe('00 11')
    const zeros = result.counts['00'] ?? 0
    // ±5σ of a binomial with p = ½: 5·√(2000·0.25) ≈ 112.
    expect(zeros).toBeGreaterThan(888)
    expect(zeros).toBeLessThan(1112)
  })

  it('measuring one half of a Bell pair collapses the other', () => {
    // The defining consequence of entanglement, checked on the state itself
    // rather than on counts: after measuring qubit 0 the state is |mm⟩.
    const rng = createRng(2718)
    for (let trial = 0; trial < 24; trial++) {
      const trajectory = runTrajectory(
        circuitOf(
          2,
          [
            { gate: 'h', targets: [0] },
            { gate: 'cx', targets: [1], controls: [{ qubit: 0, state: 1 }] },
            { gate: 'measure', targets: [0], clbitTargets: [0] },
          ],
          1
        ),
        rng
      )
      const outcome = trajectory.register[0]
      expectAmplitudes(
        trajectory.state,
        sparse(4, [[outcome === 1 ? 3 : 0, ONE]]),
        `Bell collapse trial ${trial}, outcome ${outcome}`
      )
    }
  })

  it('a condition in the measurement’s own column reads the pre-column value', () => {
    // A column is one instant (runner.ts header): conditions read the register
    // as it entered the column, so a write from the same column is not visible
    // until the next one. Without that rule the answer would depend on the
    // order the editor happened to append the two operations.
    //
    // Here c0 is still 0 when the X is evaluated, so qubit 1 never flips and
    // the only labels are 00 and 01 (printed c1c0). The sequential layout in
    // the next test is the one that produces 00 and 11.
    const result = run(
      circuitAtColumns(
        2,
        [
          { gate: 'h', targets: [0], column: 0 },
          { gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
          {
            gate: 'x',
            targets: [1],
            condition: { clbit: 0, equals: 1 },
            column: 1,
          },
          { gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
        ],
        2
      ),
      trajectoriesMode(600, createRng(1234567))
    )
    if (result.mode !== 'trajectories') throw new Error('expected counts')
    expect(
      Object.keys(result.counts).sort().join(' '),
      `a same-column condition must not see the same column's measurement. ` +
        `Counts: ${JSON.stringify(result.counts)}`
    ).toBe('00 01')
  })

  it('a classically conditioned gate reads the bit that was just written', () => {
    // The bare mechanism teleportation depends on: measure qubit 0, then flip
    // qubit 1 iff the result was 1. Qubit 1 must end up equal to qubit 0 with
    // certainty, so only 00 and 11 can appear.
    const steps: Step[] = [
      { gate: 'h', targets: [0] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'x', targets: [1], condition: { clbit: 0, equals: 1 } },
      { gate: 'measure', targets: [1], clbitTargets: [1] },
    ]
    const result = run(
      circuitOf(2, steps, 2),
      trajectoriesMode(1000, createRng(8191))
    )
    if (result.mode !== 'trajectories') throw new Error('expected counts')
    expect(
      Object.keys(result.counts).sort().join(' '),
      `conditioned X must copy the measured bit. Counts: ${JSON.stringify(result.counts)}`
    ).toBe('00 11')
  })
})
