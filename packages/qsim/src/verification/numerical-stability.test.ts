/**
 * Independent adversarial verification of the simulation engine — NUMERICS.
 *
 * This file is deliberately NOT derived from the engine's own test suite. Every
 * expected value below comes from one of three places:
 *
 *  1. the textbook definition of the gate, written out again here as nested
 *     complex pairs (`refFixed`, `refRx`, … `refU`) in a layout that has
 *     nothing in common with `gates.ts`'s flat interleaved `Float64Array`;
 *  2. an obviously-correct but slow oracle — the full 2ⁿ × 2ⁿ operator built by
 *     explicit Kronecker products and applied by dense matrix-vector product.
 *     That is exactly the construction §5.2 forbids in production, which makes
 *     it the ideal reference for the fast index-pairing path;
 *  3. exact arithmetic reasoning about IEEE-754 — where a cancellation is
 *     between two bit-identical operands the result must be exactly ±0, not
 *     "small".
 *
 * WHAT THIS LENS COVERS: norm behaviour under long gate sequences, whether
 * decision D6's renormalisation actually fires and where, whether amplitudes
 * that are mathematically zero are exactly zero rather than accumulated noise,
 * the register-size edges (1 qubit, and the largest count that still runs
 * quickly), and whether any gate in the catalog can put a NaN or an Infinity
 * into the state.
 *
 * Frozen decisions this file holds the engine to: D1 (little-endian qubit
 * order), D6 (Float64, renormalise every 64 gates, test tolerance 1e-10).
 */

import { describe, expect, it } from 'vitest'
import {
  apply1q,
  apply2q,
  applyControlled,
  applyISwap,
  applySwap,
  type ControlSpec,
} from '../apply.js'
import { bitOf } from '../conventions.js'
import { dagger, matrixFor, type OneQubitGateId } from '../gates.js'
import { collapse, marginalProbability, probabilities } from '../measure.js'
import { createRng } from '../rng.js'
import { run, runTrajectory, type OperationLike } from '../runner.js'
import {
  RENORMALIZE_INTERVAL,
  alloc,
  clone,
  norm,
  renormalize,
  type Statevector,
} from '../statevector.js'

/** Decision D6: the tolerance every numerical assertion here is measured at. */
const TOLERANCE = 1e-10

/* ══════════════════ 1. an independent gate catalog ══════════════════ */

/** A complex number as a plain pair. Nothing here shares layout with gates.ts. */
type Cx = readonly [re: number, im: number]

/** A 2×2 as four pairs in reading order: m₀₀, m₀₁, m₁₀, m₁₁. */
type Ref2 = readonly [Cx, Cx, Cx, Cx]

const R2 = Math.sqrt(2)

/**
 * The fixed one-qubit gates, transcribed from the standard definitions rather
 * than from the implementation. `sx` is written as the half-sum form
 * ½[[1+i, 1−i], [1−i, 1+i]], which is the definition; that it squares to X is
 * asserted below rather than assumed.
 */
const refFixed: Readonly<Record<string, Ref2>> = {
  i: [
    [1, 0],
    [0, 0],
    [0, 0],
    [1, 0],
  ],
  x: [
    [0, 0],
    [1, 0],
    [1, 0],
    [0, 0],
  ],
  y: [
    [0, 0],
    [0, -1],
    [0, 1],
    [0, 0],
  ],
  z: [
    [1, 0],
    [0, 0],
    [0, 0],
    [-1, 0],
  ],
  h: [
    [1 / R2, 0],
    [1 / R2, 0],
    [1 / R2, 0],
    [-1 / R2, 0],
  ],
  s: [
    [1, 0],
    [0, 0],
    [0, 0],
    [0, 1],
  ],
  sdg: [
    [1, 0],
    [0, 0],
    [0, 0],
    [0, -1],
  ],
  t: [
    [1, 0],
    [0, 0],
    [0, 0],
    [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)],
  ],
  tdg: [
    [1, 0],
    [0, 0],
    [0, 0],
    [Math.cos(Math.PI / 4), -Math.sin(Math.PI / 4)],
  ],
  sx: [
    [0.5, 0.5],
    [0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
  ],
}

/** Rx(θ) = [[cos θ/2, −i sin θ/2], [−i sin θ/2, cos θ/2]]. */
function refRx(theta: number): Ref2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [c, 0],
    [0, -s],
    [0, -s],
    [c, 0],
  ]
}

/** Ry(θ) = [[cos θ/2, −sin θ/2], [sin θ/2, cos θ/2]]. */
function refRy(theta: number): Ref2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [c, 0],
    [-s, 0],
    [s, 0],
    [c, 0],
  ]
}

/** Rz(θ) = diag(e^{−iθ/2}, e^{iθ/2}). */
function refRz(theta: number): Ref2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [c, -s],
    [0, 0],
    [0, 0],
    [c, s],
  ]
}

/** P(φ) = diag(1, e^{iφ}). */
function refP(phi: number): Ref2 {
  return [
    [1, 0],
    [0, 0],
    [0, 0],
    [Math.cos(phi), Math.sin(phi)],
  ]
}

/**
 * U(θ,φ,λ) = [[cos θ/2, −e^{iλ} sin θ/2], [e^{iφ} sin θ/2, e^{i(φ+λ)} cos θ/2]].
 *
 * The bottom-right phase is built as e^{iφ}·e^{iλ} — the product of two unit
 * complex numbers — rather than as e^{i(φ+λ)} evaluated on the sum of the two
 * angles. The two are the same number in exact arithmetic; they are not the
 * same computation in Float64, because `φ + λ` rounds to an angle that can be
 * arbitrarily far from the true sum once |φ| grows, and it can overflow to
 * Infinity while both operands are finite. Composing the phases instead is
 * unconditionally accurate to a few ulp and cannot overflow, so this reference
 * is the one that stays unitary.
 */
function refU(theta: number, phi: number, lambda: number): Ref2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const cl = Math.cos(lambda)
  const sl = Math.sin(lambda)
  return [
    [c, 0],
    [-cl * s, -sl * s],
    [cp * s, sp * s],
    [(cp * cl - sp * sl) * c, (cp * sl + sp * cl) * c],
  ]
}

/** Every catalog gate, resolved through the engine's own parameter seam. */
function refMatrix(gate: string, params: readonly number[]): Ref2 {
  switch (gate) {
    case 'rx':
      return refRx(params[0])
    case 'ry':
      return refRy(params[0])
    case 'rz':
      return refRz(params[0])
    case 'p':
      return refP(params[0])
    case 'u':
      return refU(params[0], params[1], params[2])
    default: {
      const fixed = refFixed[gate]
      if (fixed === undefined) throw new Error(`no reference for "${gate}"`)
      return fixed
    }
  }
}

/** My own 2×2 in the engine's documented flat layout, for feeding the kernel. */
function flatten(m: Ref2): Float64Array {
  return new Float64Array([
    m[0][0],
    m[0][1],
    m[1][0],
    m[1][1],
    m[2][0],
    m[2][1],
    m[3][0],
    m[3][1],
  ])
}

/** Read a flat 2×2 back into pairs, so the two catalogs can be compared. */
function unflatten(m: Float64Array): Ref2 {
  return [
    [m[0], m[1]],
    [m[2], m[3]],
    [m[4], m[5]],
    [m[6], m[7]],
  ]
}

/**
 * How far `M†M` is from the identity, entry by entry. Zero for a unitary; this
 * is the quantity that has to stay small for the norm to be conserved, and it
 * is computed here by hand rather than inferred from a norm measurement.
 */
function unitarityDefect(m: Ref2): number {
  const columns: Cx[][] = [
    [m[0], m[2]],
    [m[1], m[3]],
  ]
  let worst = 0
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      let re = 0
      let im = 0
      for (let k = 0; k < 2; k++) {
        // conj(column a) · column b
        const [ar, ai] = columns[a][k]
        const [br, bi] = columns[b][k]
        re += ar * br + ai * bi
        im += ar * bi - ai * br
      }
      worst = Math.max(worst, Math.abs(re - (a === b ? 1 : 0)), Math.abs(im))
    }
  }
  return worst
}

/* ══════════════ 2. the slow oracle: dense Kronecker operators ══════════════ */

type Dense = Cx[][]

function denseIdentity(size: number): Dense {
  const out: Dense = []
  for (let r = 0; r < size; r++) {
    const row: Cx[] = []
    for (let c = 0; c < size; c++) row.push(r === c ? [1, 0] : [0, 0])
    out.push(row)
  }
  return out
}

/** A ⊗ B, the textbook Kronecker product. */
function kron(a: Dense, b: Dense): Dense {
  const out: Dense = []
  for (let ar = 0; ar < a.length; ar++) {
    for (let br = 0; br < b.length; br++) {
      const row: Cx[] = []
      for (let ac = 0; ac < a[ar].length; ac++) {
        for (let bc = 0; bc < b[br].length; bc++) {
          const [xr, xi] = a[ar][ac]
          const [yr, yi] = b[br][bc]
          row.push([xr * yr - xi * yi, xr * yi + xi * yr])
        }
      }
      out.push(row)
    }
  }
  return out
}

/**
 * The full 2ⁿ × 2ⁿ operator for a one-qubit gate on `target` — the O(4ⁿ)
 * construction §5.2 bans. Highest qubit is the leftmost Kronecker factor,
 * which is what makes index bit `q` belong to qubit `q` (decision D1).
 */
function denseOne(qubits: number, target: number, m: Ref2): Dense {
  const asMatrix: Dense = [
    [m[0], m[1]],
    [m[2], m[3]],
  ]
  let out: Dense = [[[1, 0]]]
  for (let q = qubits - 1; q >= 0; q--) {
    out = kron(out, q === target ? asMatrix : denseIdentity(2))
  }
  return out
}

/**
 * The dense operator of a controlled gate, built by enumeration: on the
 * subspace where every control reads its required value the block is the gate,
 * everywhere else it is the identity.
 */
function denseControlled(
  qubits: number,
  target: number,
  controls: readonly ControlSpec[],
  m: Ref2
): Dense {
  const size = 1 << qubits
  const gate = denseOne(qubits, target, m)
  const fires = (index: number): boolean =>
    controls.every((control) => bitOf(index, control.qubit) === control.state)
  const out = denseIdentity(size)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (fires(r) && fires(c)) out[r][c] = gate[r][c]
      else out[r][c] = r === c && !fires(r) ? [1, 0] : [0, 0]
    }
  }
  return out
}

/**
 * The dense operator of a two-qubit gate, by enumeration. Row/column index
 * inside the 4×4 is `2·b_{q1} + b_{q0}` — the convention `apply.ts` documents,
 * checked here against an independently built oracle rather than assumed.
 */
function denseTwo(
  qubits: number,
  q0: number,
  q1: number,
  m4: readonly (readonly Cx[])[]
): Dense {
  const size = 1 << qubits
  const out = denseIdentity(size)
  const rest = (index: number): number => index & ~(1 << q0) & ~(1 << q1)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (rest(r) !== rest(c)) {
        out[r][c] = [0, 0]
        continue
      }
      const rowIndex = 2 * bitOf(r, q1) + bitOf(r, q0)
      const columnIndex = 2 * bitOf(c, q1) + bitOf(c, q0)
      out[r][c] = m4[rowIndex][columnIndex]
    }
  }
  return out
}

/** Dense matrix-vector product — O(4ⁿ), the whole point of it being a check. */
function denseApply(state: Statevector, operator: Dense): Statevector {
  const out = alloc(state.qubits)
  out.re[0] = 0
  for (let r = 0; r < state.size; r++) {
    let re = 0
    let im = 0
    for (let c = 0; c < state.size; c++) {
      const [mr, mi] = operator[r][c]
      re += mr * state.re[c] - mi * state.im[c]
      im += mr * state.im[c] + mi * state.re[c]
    }
    out.re[r] = re
    out.im[r] = im
  }
  return out
}

/* ═════════════════════════ 3. small utilities ═════════════════════════ */

/** A deterministic stream, so nothing in this file can be intermittent. */
function lcg(seed: number): () => number {
  let value = seed >>> 0
  return (): number => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 4294967296
  }
}

function maxAmplitudeDelta(a: Statevector, b: Statevector): number {
  let worst = 0
  for (let i = 0; i < a.size; i++) {
    worst = Math.max(
      worst,
      Math.abs(a.re[i] - b.re[i]),
      Math.abs(a.im[i] - b.im[i])
    )
  }
  return worst
}

function bitIdentical(a: Statevector, b: Statevector): boolean {
  for (let i = 0; i < a.size; i++) {
    if (!Object.is(a.re[i], b.re[i])) return false
    if (!Object.is(a.im[i], b.im[i])) return false
  }
  return true
}

function countNonFinite(state: Statevector): number {
  let bad = 0
  for (let i = 0; i < state.size; i++) {
    if (!Number.isFinite(state.re[i])) bad++
    if (!Number.isFinite(state.im[i])) bad++
  }
  return bad
}

/** The full catalog of one-qubit gate ids the engine claims to support. */
const FIXED_IDS = [
  'i',
  'x',
  'y',
  'z',
  'h',
  's',
  'sdg',
  't',
  'tdg',
  'sx',
] as const

/**
 * A random circuit built out of every gate shape the runner accepts. Angles
 * stay in an ordinary range here; the extreme-parameter behaviour has its own
 * section below.
 */
function randomCircuit(
  qubits: number,
  gateCount: number,
  seed: number
): OperationLike[] {
  const random = lcg(seed)
  const operations: OperationLike[] = []
  for (let k = 0; k < gateCount; k++) {
    const target = Math.floor(random() * qubits)
    const kind = random()
    if (kind < 0.35 || qubits < 2) {
      operations.push({
        id: `g${k}`,
        gate: FIXED_IDS[1 + Math.floor(random() * (FIXED_IDS.length - 1))],
        targets: [target],
        column: k,
      })
      continue
    }
    if (kind < 0.6) {
      const gate = (['rx', 'ry', 'rz', 'p'] as const)[Math.floor(random() * 4)]
      operations.push({
        id: `g${k}`,
        gate,
        targets: [target],
        params: [(random() - 0.5) * 12],
        column: k,
      })
      continue
    }
    if (kind < 0.72) {
      operations.push({
        id: `g${k}`,
        gate: 'u',
        targets: [target],
        params: [random() * 6, random() * 6, random() * 6],
        column: k,
      })
      continue
    }
    let other = Math.floor(random() * qubits)
    while (other === target) other = Math.floor(random() * qubits)
    if (kind < 0.86) {
      operations.push({
        id: `g${k}`,
        gate: 'cx',
        targets: [target],
        controls: [{ qubit: other, state: random() < 0.2 ? 0 : 1 }],
        column: k,
      })
    } else if (kind < 0.93) {
      operations.push({
        id: `g${k}`,
        gate: 'swap',
        targets: [target, other],
        column: k,
      })
    } else {
      operations.push({
        id: `g${k}`,
        gate: 'iswap',
        targets: [target, other],
        column: k,
      })
    }
  }
  return operations
}

function analyticState(
  qubits: number,
  operations: readonly OperationLike[]
): Statevector {
  const result = run({ qubits, operations })
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/* ════════════════════ 4. norm under long sequences ════════════════════ */

describe('norm conservation over long gate sequences', () => {
  it.each([1, 2, 3, 6, 10, 12])(
    'keeps |‖ψ‖ − 1| under 1e-10 across 4000 mixed gates at %i qubits',
    (qubits) => {
      const operations = randomCircuit(qubits, 4000, 20260814 + qubits)
      const state = analyticState(qubits, operations)
      expect(countNonFinite(state)).toBe(0)
      expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
    }
  )

  it('holds the norm even with renormalisation switched off entirely', () => {
    // Straight through the kernel, so D6's periodic rescue never runs. If the
    // per-gate arithmetic itself were biased this is where it would show:
    // 20 000 gates of accumulated drift with nothing to correct it.
    const state = alloc(6)
    const random = lcg(4242)
    for (let k = 0; k < 20000; k++) {
      const gate = matrixFor('u', [random() * 7, random() * 7, random() * 7])
      apply1q(state, gate, Math.floor(random() * 6))
    }
    expect(countNonFinite(state)).toBe(0)
    expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
  })

  it('keeps the Born probabilities summing to 1 after a long run', () => {
    const operations = randomCircuit(10, 5000, 77)
    const state = analyticState(10, operations)
    const p = probabilities(state)
    let total = 0
    let smallest = Infinity
    for (let i = 0; i < p.length; i++) {
      total += p[i]
      smallest = Math.min(smallest, p[i])
    }
    expect(smallest).toBeGreaterThanOrEqual(0)
    expect(Math.abs(total - 1)).toBeLessThan(TOLERANCE)
  })

  it('keeps a measuring trajectory normalised through its collapses', () => {
    const operations: OperationLike[] = []
    for (let c = 0; c < 40; c++) {
      operations.push({ id: `h${c}`, gate: 'h', targets: [c % 4], column: c })
    }
    operations.push({
      id: 'm',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 40,
    })
    operations.push({
      id: 'cond',
      gate: 'x',
      targets: [3],
      column: 41,
      condition: { clbit: 0, equals: 1 },
    })
    for (let c = 0; c < 200; c++) {
      operations.push({
        id: `r${c}`,
        gate: 'ry',
        targets: [c % 4],
        params: [0.37],
        column: 42 + c,
      })
    }
    for (let seed = 0; seed < 25; seed++) {
      const trajectory = runTrajectory(
        { qubits: 4, clbits: 1, operations },
        createRng(seed)
      )
      expect(countNonFinite(trajectory.state)).toBe(0)
      expect(Math.abs(norm(trajectory.state) - 1)).toBeLessThan(TOLERANCE)
    }
  })
})

/* ═════════════ 5. does D6's renormalisation actually fire? ═════════════ */

/**
 * Replay a gate list through the kernel directly, renormalising every
 * `interval` gates (or never, when `interval` is 0).
 *
 * This uses the engine's own `applyControlled` on purpose: the arithmetic of a
 * single gate is then bit-for-bit what the runner does, so the ONLY difference
 * between this reference and `run()` is where renormalisation lands. That makes
 * the comparisons below exact equalities rather than tolerance tests, and an
 * exact equality is the only way to prove a rescale did or did not happen —
 * a rescale moves the last mantissa bit, which no tolerance can see.
 */
function replay(
  qubits: number,
  operations: readonly OperationLike[],
  interval: number
): Statevector {
  const state = alloc(qubits)
  let since = 0
  for (const operation of operations) {
    const gate = operation.gate as OneQubitGateId
    const params = (operation.params ?? []) as readonly number[]
    applyControlled(state, matrixFor(gate, params), operation.targets[0], [])
    since++
    if (interval !== 0 && since === interval) {
      renormalize(state)
      since = 0
    }
  }
  return state
}

/** A chain whose norm provably drifts off 1, so a rescale is observable. */
function driftingChain(gateCount: number): OperationLike[] {
  const operations: OperationLike[] = []
  for (let k = 0; k < gateCount; k++) {
    operations.push({
      id: `d${k}`,
      gate: 'rx',
      targets: [k % 3],
      params: [0.3 + k * 0.01],
      column: k,
    })
  }
  return operations
}

describe('decision D6 — renormalisation fires every 64 gates', () => {
  it('publishes the interval D6 froze', () => {
    expect(RENORMALIZE_INTERVAL).toBe(64)
  })

  it('leaves the state untouched for the first 63 gates', () => {
    const operations = driftingChain(63)
    const state = analyticState(3, operations)
    expect(bitIdentical(state, replay(3, operations, 0))).toBe(true)
  })

  it('rescales exactly at the 64th gate', () => {
    const operations = driftingChain(64)
    const never = replay(3, operations, 0)
    // Precondition: without a rescale the norm is genuinely off 1, otherwise
    // the two candidate states would coincide and prove nothing.
    expect(norm(never)).not.toBe(1)

    const state = analyticState(3, operations)
    expect(bitIdentical(state, never)).toBe(false)
    expect(bitIdentical(state, replay(3, operations, 64))).toBe(true)
  })

  it.each([128, 192, 256, 320])(
    'keeps firing on the same period — %i gates',
    (gateCount) => {
      const operations = driftingChain(gateCount)
      const state = analyticState(3, operations)
      expect(bitIdentical(state, replay(3, operations, 64))).toBe(true)
    }
  )

  it('bounds the drift a rescued run carries against one that is not', () => {
    // 6400 phase gates on a superposition drift in one direction, so this is a
    // systematic error rather than a random walk: the un-rescued chain must end
    // up measurably further from 1 than the rescued one.
    const operations: OperationLike[] = [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
    ]
    for (let k = 0; k < 6400; k++) {
      operations.push({
        id: `p${k}`,
        gate: 'p',
        targets: [0],
        params: [0.7],
        column: k + 1,
      })
    }
    const unrescued = Math.abs(norm(replay(1, operations, 0)) - 1)
    const rescued = Math.abs(norm(analyticState(1, operations)) - 1)
    expect(unrescued).toBeGreaterThan(1e-14)
    expect(rescued).toBeLessThan(unrescued / 10)
  })

  it('rescales a state whose norm is far from 1, and reports what it was', () => {
    for (const scale of [1e-150, 1e-3, 3, 1e150]) {
      const state = alloc(2)
      state.re[0] = scale * 0.6
      state.im[1] = scale * 0.8
      const previous = renormalize(state)
      expect(Math.abs(previous / scale - 1)).toBeLessThan(TOLERANCE)
      expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
      expect(Math.abs(state.re[0] - 0.6)).toBeLessThan(TOLERANCE)
      expect(Math.abs(state.im[1] - 0.8)).toBeLessThan(TOLERANCE)
    }
  })

  it('refuses to renormalise rather than filling the state with NaN', () => {
    const zero = alloc(1)
    zero.re[0] = 0
    expect(() => renormalize(zero)).toThrow(RangeError)

    const poisoned = alloc(1)
    poisoned.re[0] = Number.NaN
    expect(() => renormalize(poisoned)).toThrow(RangeError)

    // Every square underflows to 0 below ~1.5e-162, so the computed norm is 0
    // for a direction vector that is perfectly well defined. Failing loudly is
    // the right behaviour; silently returning a state of Infinities is not.
    const underflowing = alloc(1)
    underflowing.re[0] = 1e-200
    underflowing.re[1] = 1e-200
    expect(() => renormalize(underflowing)).toThrow(RangeError)
  })
})

/* ═════════════ 6. amplitudes that must be exactly zero ═════════════ */

describe('amplitudes that are mathematically zero are exactly zero', () => {
  it('leaves the Bell pair with two exact zeros', () => {
    const state = alloc(2)
    apply1q(state, matrixFor('h'), 0)
    applyControlled(state, matrixFor('x'), 1, [{ qubit: 0, state: 1 }])
    for (const index of [1, 2]) {
      expect(state.re[index] === 0).toBe(true)
      expect(state.im[index] === 0).toBe(true)
    }
    expect(Math.abs(state.re[0] - Math.SQRT1_2)).toBeLessThan(TOLERANCE)
    expect(Math.abs(state.re[3] - Math.SQRT1_2)).toBeLessThan(TOLERANCE)
  })

  it.each([3, 5, 8, 12])(
    'leaves every interior amplitude of a %i-qubit GHZ at exactly zero',
    (qubits) => {
      const operations: OperationLike[] = [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
      ]
      for (let q = 1; q < qubits; q++) {
        operations.push({
          id: `cx${q}`,
          gate: 'cx',
          targets: [q],
          controls: [q - 1],
          column: q,
        })
      }
      const state = analyticState(qubits, operations)
      for (let i = 0; i < state.size; i++) {
        if (i === 0 || i === state.size - 1) continue
        expect(state.re[i] === 0).toBe(true)
        expect(state.im[i] === 0).toBe(true)
      }
    }
  )

  it('cancels destructive interference to exactly zero, not to noise', () => {
    // H·Z·H = X, so |0⟩ must land on |1⟩ with the |0⟩ amplitude annihilated.
    // The two contributions are bit-identical operands of a subtraction, so
    // IEEE-754 requires the difference to be exactly zero.
    const state = alloc(1)
    apply1q(state, matrixFor('h'), 0)
    apply1q(state, matrixFor('z'), 0)
    apply1q(state, matrixFor('h'), 0)
    expect(state.re[0] === 0).toBe(true)
    expect(state.im[0] === 0).toBe(true)
    expect(Math.abs(Math.hypot(state.re[1], state.im[1]) - 1)).toBeLessThan(
      TOLERANCE
    )
  })

  it.each([
    ['h', 2],
    ['x', 2],
    ['y', 2],
    ['z', 2],
    ['s', 4],
    ['sdg', 4],
    ['t', 8],
    ['tdg', 8],
    ['sx', 4],
  ] as const)(
    'returns |0⟩ to itself after %s applied %i times, with an exact zero',
    (gate, power) => {
      const state = alloc(1)
      for (let k = 0; k < power; k++) apply1q(state, matrixFor(gate), 0)
      expect(state.re[1] === 0).toBe(true)
      expect(state.im[1] === 0).toBe(true)
      expect(Math.abs(Math.hypot(state.re[0], state.im[0]) - 1)).toBeLessThan(
        TOLERANCE
      )
    }
  )

  it('keeps SWAP and iSWAP exact — they are permutations, not arithmetic', () => {
    const state = alloc(4)
    for (let q = 0; q < 4; q++) apply1q(state, matrixFor('h'), q)
    apply1q(state, matrixFor('t'), 2)
    apply1q(state, matrixFor('rx', [0.83]), 1)
    const before = clone(state)

    applySwap(state, 0, 3)
    applySwap(state, 0, 3)
    expect(maxAmplitudeDelta(state, before)).toBe(0)

    // iSWAP⁴ = I exactly: each application only moves amplitudes and negates.
    for (let k = 0; k < 4; k++) applyISwap(state, 1, 2)
    expect(maxAmplitudeDelta(state, before)).toBe(0)
  })

  it('never leaks amplitude onto an untouched qubit over 500 gates', () => {
    // Qubit 5 is never addressed, so every basis state with bit 5 set must stay
    // at exactly zero for the whole run — no drift, no denormal residue.
    const random = lcg(31337)
    const operations: OperationLike[] = []
    for (let k = 0; k < 500; k++) {
      operations.push({
        id: `g${k}`,
        gate: 'u',
        targets: [Math.floor(random() * 5)],
        params: [random() * 6, random() * 6, random() * 6],
        column: k,
      })
    }
    const state = analyticState(6, operations)
    for (let i = 0; i < state.size; i++) {
      if (bitOf(i, 5) === 0) continue
      expect(state.re[i] === 0).toBe(true)
      expect(state.im[i] === 0).toBe(true)
    }
  })

  it('zeroes the discarded half of a collapse exactly', () => {
    const state = alloc(4)
    for (let q = 0; q < 4; q++) apply1q(state, matrixFor('h'), q)
    apply1q(state, matrixFor('t'), 1)
    const kept = collapse(state, 1, 1)
    expect(Math.abs(kept - 0.5)).toBeLessThan(TOLERANCE)
    for (let i = 0; i < state.size; i++) {
      if (bitOf(i, 1) === 1) continue
      expect(state.re[i] === 0).toBe(true)
      expect(state.im[i] === 0).toBe(true)
    }
    expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
  })
})

/* ═══════ 7. no NaN or Infinity from any gate at any finite parameter ═══════ */

/** Finite angles chosen to stress every corner of the float range. */
const EXTREME_ANGLES = [
  0,
  -0,
  Number.MIN_VALUE,
  1e-320,
  1e-16,
  1e-8,
  Math.PI / 4,
  Math.PI,
  2 * Math.PI,
  -Math.PI,
  1e3,
  1e6,
  1e9,
  1e12,
  1e17,
  1e150,
  1e300,
  1e308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
]

describe('the gate catalog can never produce a NaN or an Infinity', () => {
  it.each(FIXED_IDS)('keeps %s finite and unitary', (gate) => {
    const matrix = matrixFor(gate)
    expect(Array.from(matrix).every(Number.isFinite)).toBe(true)
    expect(unitarityDefect(unflatten(matrix))).toBeLessThan(TOLERANCE)
    expect(unitarityDefect(refFixed[gate])).toBeLessThan(TOLERANCE)
  })

  it.each(['rx', 'ry', 'rz', 'p'] as const)(
    'keeps %s finite and unitary at every extreme angle',
    (gate) => {
      for (const angle of EXTREME_ANGLES) {
        const matrix = matrixFor(gate, [angle])
        expect(
          Array.from(matrix).every(Number.isFinite),
          `${gate}(${angle}) produced a non-finite entry`
        ).toBe(true)
        expect(
          unitarityDefect(unflatten(matrix)),
          `${gate}(${angle}) is not unitary`
        ).toBeLessThan(TOLERANCE)
      }
    }
  )

  it('keeps u finite at every combination of extreme finite parameters', () => {
    const offenders: string[] = []
    for (const theta of [0, Math.PI / 3, Math.PI]) {
      for (const phi of EXTREME_ANGLES) {
        for (const lambda of EXTREME_ANGLES) {
          const matrix = matrixFor('u', [theta, phi, lambda])
          if (!Array.from(matrix).every(Number.isFinite)) {
            offenders.push(`u(${theta}, ${phi}, ${lambda})`)
          }
        }
      }
    }
    expect(offenders.slice(0, 5)).toEqual([])
  })

  it('keeps u unitary at large phase parameters', () => {
    // U(θ,φ,λ) is unitary for every real φ and λ, and the reference above shows
    // it can be evaluated that way in Float64 by composing e^{iφ}·e^{iλ}.
    const offenders: string[] = []
    for (const phi of [1e3, 1e6, 1e9, 1e12, 1e16]) {
      const matrix = matrixFor('u', [Math.PI / 2, phi, 0.3])
      const observed = unitarityDefect(unflatten(matrix))
      const reference = unitarityDefect(refU(Math.PI / 2, phi, 0.3))
      expect(reference).toBeLessThan(TOLERANCE)
      if (!(observed < TOLERANCE)) {
        offenders.push(`u(π/2, ${phi}, 0.3) defect ${observed}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never lets a gate put a NaN into the statevector through run()', () => {
    const offenders: string[] = []
    const cases: Array<[string, number[]]> = [
      ['rx', [Number.MAX_VALUE]],
      ['ry', [Number.MAX_VALUE]],
      ['rz', [Number.MAX_VALUE]],
      ['p', [Number.MAX_VALUE]],
      ['u', [Math.PI / 2, 1e308, 1e308]],
      ['u', [Math.PI / 2, Number.MAX_VALUE, Number.MAX_VALUE]],
      ['u', [Math.PI / 2, -1e308, -1e308]],
      ['u', [1e300, 1e300, 1e300]],
    ]
    for (const [gate, params] of cases) {
      const state = analyticState(2, [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        { id: 'g', gate, targets: [1], params, column: 1 },
      ])
      if (countNonFinite(state) !== 0) {
        offenders.push(`${gate}(${params.join(', ')})`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('rejects non-finite parameters instead of propagating them', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => matrixFor('rx', [bad])).toThrow(RangeError)
      expect(() => matrixFor('p', [bad])).toThrow(RangeError)
      expect(() => matrixFor('u', [bad, 0, 0])).toThrow(RangeError)
      expect(() => matrixFor('u', [0, bad, 0])).toThrow(RangeError)
      expect(() => matrixFor('u', [0, 0, bad])).toThrow(RangeError)
    }
  })

  it('handles denormal-scale amplitudes without a NaN or a spurious throw', () => {
    // sin(5e-161) is a denormal-adjacent amplitude and its square underflows to
    // zero. The state is still perfectly finite and normalised, and the Born
    // probability of the vanishing branch is allowed to read 0.
    const state = alloc(2)
    apply1q(state, matrixFor('rx', [1e-160]), 0)
    expect(countNonFinite(state)).toBe(0)
    expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
    expect(marginalProbability(state, 0)).toBeGreaterThanOrEqual(0)
    expect(marginalProbability(state, 0)).toBeLessThan(1e-300)
    expect(() => collapse(clone(state), 0, 0)).not.toThrow()
  })

  it('keeps U†U back at the start for random and awkward parameters', () => {
    const random = lcg(9091)
    for (let trial = 0; trial < 200; trial++) {
      const state = alloc(3)
      apply1q(state, matrixFor('h'), 0)
      apply1q(state, matrixFor('t'), 1)
      apply1q(state, matrixFor('ry', [0.77]), 2)
      const before = clone(state)
      const matrix = matrixFor('u', [
        (random() - 0.5) * 40,
        (random() - 0.5) * 40,
        (random() - 0.5) * 40,
      ])
      const target = Math.floor(random() * 3)
      apply1q(state, matrix, target)
      apply1q(state, dagger(matrix), target)
      expect(maxAmplitudeDelta(state, before)).toBeLessThan(TOLERANCE)
    }
  })
})

/* ════════════════════ 8. register-size edges ════════════════════ */

describe('register-size edges', () => {
  it('rejects a zero-qubit register and anything past the documented ceiling', () => {
    expect(() => alloc(0)).toThrow(RangeError)
    expect(() => alloc(-1)).toThrow(RangeError)
    expect(() => alloc(29)).toThrow(RangeError)
    expect(() => alloc(1.5)).toThrow(RangeError)
  })

  it('matches the dense oracle for every catalog gate on a single qubit', () => {
    const random = lcg(555)
    for (const gate of FIXED_IDS) {
      const start = alloc(1)
      apply1q(start, matrixFor('h'), 0)
      apply1q(start, matrixFor('t'), 0)
      const fast = clone(start)
      apply1q(fast, matrixFor(gate), 0)
      const slow = denseApply(start, denseOne(1, 0, refMatrix(gate, [])))
      expect(maxAmplitudeDelta(fast, slow)).toBeLessThan(TOLERANCE)
    }
    for (const gate of ['rx', 'ry', 'rz', 'p'] as const) {
      for (let trial = 0; trial < 20; trial++) {
        const angle = (random() - 0.5) * 20
        const start = alloc(1)
        apply1q(start, matrixFor('h'), 0)
        const fast = clone(start)
        apply1q(fast, matrixFor(gate, [angle]), 0)
        const slow = denseApply(start, denseOne(1, 0, refMatrix(gate, [angle])))
        expect(maxAmplitudeDelta(fast, slow)).toBeLessThan(TOLERANCE)
      }
    }
  })

  it('survives 5000 gates on a single qubit', () => {
    const operations = randomCircuit(1, 5000, 8)
    const state = analyticState(1, operations)
    expect(countNonFinite(state)).toBe(0)
    expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
    // A one-qubit state is a point on the Bloch sphere: |a₀|² + |a₁|² = 1 is
    // the whole of its physics, and it has to hold to full double precision.
    const total =
      state.re[0] ** 2 + state.im[0] ** 2 + state.re[1] ** 2 + state.im[1] ** 2
    expect(Math.abs(total - 1)).toBeLessThan(1e-14)
  })

  it('rejects two-qubit gates on a one-qubit register', () => {
    const state = alloc(1)
    expect(() => applySwap(state, 0, 1)).toThrow(RangeError)
    expect(() => applyISwap(state, 0, 1)).toThrow(RangeError)
    expect(() => applySwap(state, 0, 0)).toThrow(RangeError)
  })

  it(
    'stays accurate at 20 qubits, the browser ceiling of §5.1',
    { timeout: 60_000 },
    () => {
      const qubits = 20
      const operations = randomCircuit(qubits, 200, 2024)

      // Completing this at all is the §5.2 guarantee. The kernel applies a
      // gate in O(2ⁿ) by pairing indices in place; the naive Kronecker
      // implementation would build a 2²⁰ × 2²⁰ matrix per gate, which is about
      // a million times more work and roughly 140 TB of memory. So a
      // regression into full-matrix construction cannot reach the assertions
      // below — it exhausts the heap or the timeout first — and no wall-clock
      // threshold is needed to catch it.
      //
      // The precise 1000 ms budget is a different question, and it lives in
      // performance.perf.test.ts, outside the default suite. Asserting it here
      // measured the CI scheduler as much as the engine: identical code took
      // ~480 ms with the CPU to itself and over 1000 ms under a loaded
      // `pnpm verify`. See that file's header for the full reasoning.
      const state = analyticState(qubits, operations)

      expect(countNonFinite(state)).toBe(0)
      expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)

      const p = probabilities(state)
      let total = 0
      for (let i = 0; i < p.length; i++) total += p[i]
      expect(Math.abs(total - 1)).toBeLessThan(TOLERANCE)
    }
  )

  it('addresses the lowest and the highest qubit correctly at 22 qubits', () => {
    // The extreme strides are where an index-pairing walk goes wrong: qubit 0
    // has stride 1 and qubit 21 has stride 2²¹, so these two exercise the outer
    // and inner loop bounds at their limits.
    const qubits = 22
    const state = alloc(qubits)
    for (const target of [0, qubits - 1]) {
      apply1q(state, matrixFor('ry', [2 * Math.acos(Math.sqrt(0.3))]), target)
    }
    expect(countNonFinite(state)).toBe(0)
    expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)

    for (const target of [0, qubits - 1]) {
      const marginal = marginalProbability(state, target)
      // Brute force over every basis state, the definition of the marginal.
      let brute = 0
      for (let i = 0; i < state.size; i++) {
        if (bitOf(i, target) === 1) {
          brute += state.re[i] * state.re[i] + state.im[i] * state.im[i]
        }
      }
      expect(Math.abs(marginal - brute)).toBeLessThan(TOLERANCE)
      expect(Math.abs(marginal - 0.7)).toBeLessThan(TOLERANCE)
    }
    for (const untouched of [1, 10, 20]) {
      expect(marginalProbability(state, untouched)).toBe(0)
    }
  })
})

/* ═══════ 9. the fast path and the slow oracle must agree numerically ═══════ */

describe('index-pairing kernel against the dense Kronecker oracle', () => {
  it('agrees on 60 random one-qubit and controlled gates at 4 qubits', () => {
    const qubits = 4
    const random = lcg(606)
    const fast = alloc(qubits)
    apply1q(fast, matrixFor('h'), 0)
    apply1q(fast, matrixFor('h'), 2)
    apply1q(fast, matrixFor('t'), 1)
    let slow = clone(fast)

    for (let k = 0; k < 60; k++) {
      const target = Math.floor(random() * qubits)
      const angles = [random() * 6, random() * 6, random() * 6]
      const reference = refU(angles[0], angles[1], angles[2])
      const controls: ControlSpec[] = []
      if (random() < 0.5) {
        let control = Math.floor(random() * qubits)
        while (control === target) control = Math.floor(random() * qubits)
        controls.push({ qubit: control, state: random() < 0.25 ? 0 : 1 })
      }
      applyControlled(fast, flatten(reference), target, controls)
      slow = denseApply(
        slow,
        denseControlled(qubits, target, controls, reference)
      )
    }
    expect(maxAmplitudeDelta(fast, slow)).toBeLessThan(TOLERANCE)
    expect(Math.abs(norm(fast) - 1)).toBeLessThan(TOLERANCE)
    expect(Math.abs(norm(slow) - 1)).toBeLessThan(TOLERANCE)
  })

  it('agrees with the dense oracle on SWAP, iSWAP and a general 4×4', () => {
    const qubits = 4
    const random = lcg(707)
    const start = alloc(qubits)
    for (let q = 0; q < qubits; q++) apply1q(start, matrixFor('h'), q)
    apply1q(start, matrixFor('rz', [1.1]), 0)
    apply1q(start, matrixFor('t'), 3)

    const swapRef: Cx[][] = [
      [
        [1, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
        [1, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [1, 0],
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
        [0, 0],
        [1, 0],
      ],
    ]
    const iswapRef: Cx[][] = [
      [
        [1, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
        [0, 1],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 1],
        [0, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
        [0, 0],
        [1, 0],
      ],
    ]

    for (const [q0, q1] of [
      [0, 1],
      [1, 3],
      [0, 3],
      [2, 0],
    ] as const) {
      const fast = clone(start)
      applySwap(fast, q0, q1)
      expect(
        maxAmplitudeDelta(fast, denseApply(start, denseTwo(4, q0, q1, swapRef)))
      ).toBe(0)

      const fastI = clone(start)
      applyISwap(fastI, q0, q1)
      expect(
        maxAmplitudeDelta(
          fastI,
          denseApply(start, denseTwo(4, q0, q1, iswapRef))
        )
      ).toBe(0)
    }

    // A general 4×4: a two-qubit rotation exp(−iθ/2 · Z⊗Z), which is diagonal
    // in the computational basis and therefore easy to write down exactly.
    const theta = 0.9
    const c = Math.cos(theta / 2)
    const s = Math.sin(theta / 2)
    const phase = (sign: number): Cx => [c, sign * s]
    const zz: Cx[][] = [
      [phase(-1), [0, 0], [0, 0], [0, 0]],
      [[0, 0], phase(1), [0, 0], [0, 0]],
      [[0, 0], [0, 0], phase(1), [0, 0]],
      [[0, 0], [0, 0], [0, 0], phase(-1)],
    ]
    const flat = new Float64Array(32)
    for (let r = 0; r < 4; r++) {
      for (let column = 0; column < 4; column++) {
        flat[(r * 4 + column) * 2] = zz[r][column][0]
        flat[(r * 4 + column) * 2 + 1] = zz[r][column][1]
      }
    }
    for (const [q0, q1] of [
      [0, 1],
      [3, 1],
    ] as const) {
      const fast = clone(start)
      apply2q(fast, flat, q0, q1)
      const slow = denseApply(start, denseTwo(4, q0, q1, zz))
      expect(maxAmplitudeDelta(fast, slow)).toBeLessThan(TOLERANCE)
      expect(Math.abs(norm(fast) - 1)).toBeLessThan(TOLERANCE)
    }
    expect(random()).toBeGreaterThanOrEqual(0)
  })

  it('reproduces the engine catalog entry for entry from the textbook forms', () => {
    const random = lcg(808)
    const specs: Array<[OneQubitGateId, number[]]> = []
    for (const gate of FIXED_IDS) specs.push([gate, []])
    for (let k = 0; k < 40; k++) {
      const angle = (random() - 0.5) * 30
      specs.push(
        ['rx', [angle]],
        ['ry', [angle]],
        ['rz', [angle]],
        ['p', [angle]]
      )
    }
    for (let k = 0; k < 40; k++) {
      specs.push([
        'u',
        [(random() - 0.5) * 12, (random() - 0.5) * 12, (random() - 0.5) * 12],
      ])
    }
    for (const [gate, params] of specs) {
      const observed = unflatten(matrixFor(gate, params))
      const expected = refMatrix(gate, params)
      for (let entry = 0; entry < 4; entry++) {
        expect(
          Math.abs(observed[entry][0] - expected[entry][0]),
          `${gate}(${params.join(',')}) real part of entry ${entry}`
        ).toBeLessThan(TOLERANCE)
        expect(
          Math.abs(observed[entry][1] - expected[entry][1]),
          `${gate}(${params.join(',')}) imaginary part of entry ${entry}`
        ).toBeLessThan(TOLERANCE)
      }
    }
  })
})
