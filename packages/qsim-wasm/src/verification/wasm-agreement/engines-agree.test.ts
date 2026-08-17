/**
 * INDEPENDENT VERIFICATION — lens: wasm-agreement.
 *
 * The two engines against each other, driven from the specification rather
 * than from the package's own suite:
 *
 *   §5.2  index pairing is the definition of a gate; both sides must pair the
 *         same indices
 *   §5.6  WASM is phase 2 of a performance plan whose phase 1 is complete on
 *         its own, so the accelerator must be removable without changing an
 *         answer and absent without breaking anything
 *   §5.5  the reduced density the analysis panel draws from
 *   D1    qubit 0 is the least significant bit
 *   D6    Float64; the work plan's cross-engine budget is 1e-12
 *
 * The candidate is the crate's own algorithm, transcribed loop for loop in
 * `rust-transliteration.ts` — see that file's header for why the stand-in the
 * package ships cannot play this role.
 *
 * COMPARISON IS STRICT AND NaN-AWARE. `Math.abs(a - b)` is not a usable
 * verdict when either side can be NaN: `NaN > tolerance` is false, so a
 * kernel that filled the state with NaN would be scored as agreeing. Every
 * comparison below goes through `worstDifference`, which answers `Infinity`
 * when one side is NaN and the other is not, and 0 when both are.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  GATE_MATRICES,
  acceleratedApplyControlled,
  acceleratedApplyISwap,
  acceleratedApplySwap,
  activeStatevectorKernel,
  alloc,
  applyControlled,
  applyISwap,
  applySwap,
  blochVectors,
  createRng,
  installStatevectorKernel,
  matrixFor,
  probabilities as tsProbabilities,
  reducedDensity as tsReducedDensity,
  uninstallStatevectorKernel,
  type ControlSpec,
  type FixedGateId,
  type Matrix2,
  type Rng,
  type Statevector,
} from '@qsim/core'

import { maxDeviation, verifyEquivalence } from '../../equivalence.js'
import { createExtras, createKernel } from '../../kernel.js'
import { loadKernel } from '../../load.js'
import { createSession, type KernelSession } from '../../session.js'
import { createTransliteratedExports } from './rust-transliteration.js'

/** The work plan's cross-engine budget. Both sides should land on 0. */
const TOLERANCE = 1e-12

const FIXED: readonly FixedGateId[] = [
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
]

/**
 * The largest difference between two states, counting a NaN on one side and a
 * number on the other as infinitely far apart.
 *
 * `Math.abs(NaN - 0.5)` is NaN and every comparison against NaN is false, so
 * the obvious formulation reports agreement for the one corruption this
 * design exists to prevent — an amplitude computed from a detached view.
 */
function worstDifference(a: Statevector, b: Statevector): number {
  let worst = 0
  const check = (x: number, y: number): void => {
    if (Number.isNaN(x) !== Number.isNaN(y)) {
      worst = Number.POSITIVE_INFINITY
      return
    }
    if (Number.isNaN(x)) return // both NaN: the same answer, however useless
    const d = Math.abs(x - y)
    if (d > worst) worst = d
  }
  for (let i = 0; i < a.size; i++) {
    check(a.re[i], b.re[i])
    check(a.im[i], b.im[i])
  }
  return worst
}

/** Two states holding the identical doubles, one on the heap, one in WASM. */
interface Pair {
  readonly session: KernelSession
  readonly reference: Statevector
  readonly candidate: () => Statevector
  readonly release: () => void
}

function pairOf(qubits: number, rng: Rng | undefined): Pair {
  const session = createSession(createTransliteratedExports())
  const kernel = createKernel(session)
  installStatevectorKernel(kernel)

  const handle = session.allocState(qubits)
  if (handle === undefined) throw new Error('the transliteration refused')
  const reference = alloc(qubits)

  if (rng !== undefined) {
    // A dense random state: |0…0⟩ hides a mis-paired index and satisfies every
    // control mask whatever it examines.
    const state = handle.statevector
    let sum = 0
    for (let i = 0; i < reference.size; i++) {
      const re = rng.next() * 2 - 1
      const im = rng.next() * 2 - 1
      reference.re[i] = re
      reference.im[i] = im
      sum += re * re + im * im
    }
    const scale = 1 / Math.sqrt(sum)
    for (let i = 0; i < reference.size; i++) {
      reference.re[i] *= scale
      reference.im[i] *= scale
      state.re[i] = reference.re[i]
      state.im[i] = reference.im[i]
    }
  }

  return {
    session,
    reference,
    candidate: () => handle.statevector,
    release: () => {
      handle.release()
      session.dispose()
    },
  }
}

afterEach(() => {
  uninstallStatevectorKernel()
})

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE WHOLE CATALOGUE, GATE BY GATE
 * ══════════════════════════════════════════════════════════════════════ */

describe('every dispatch path agrees with apply.ts', () => {
  it('reproduces the ten fixed one-qubit gates at every target', () => {
    for (let qubits = 1; qubits <= 6; qubits++) {
      for (const gate of FIXED) {
        for (let target = 0; target < qubits; target++) {
          const pair = pairOf(qubits, createRng(0x9e37 + target))
          try {
            applyControlled(pair.reference, GATE_MATRICES[gate], target, [])
            acceleratedApplyControlled(
              pair.candidate(),
              GATE_MATRICES[gate],
              target,
              []
            )
            expect(
              worstDifference(pair.reference, pair.candidate()),
              `${gate} on qubit ${target} of ${qubits}`
            ).toBe(0)
          } finally {
            pair.release()
          }
        }
      }
    }
  })

  it('reproduces every control shape, positive, negative and doubled', () => {
    const qubits = 5
    const shapes: readonly ControlSpec[][] = [
      [{ qubit: 0, state: 1 }],
      [{ qubit: 0, state: 0 }],
      [{ qubit: 4, state: 1 }],
      [{ qubit: 4, state: 0 }],
      [
        { qubit: 0, state: 1 },
        { qubit: 4, state: 1 },
      ],
      [
        { qubit: 0, state: 0 },
        { qubit: 4, state: 1 },
      ],
      [
        { qubit: 0, state: 1 },
        { qubit: 3, state: 0 },
        { qubit: 4, state: 0 },
      ],
    ]
    for (const controls of shapes) {
      for (let target = 0; target < qubits; target++) {
        if (controls.some((c) => c.qubit === target)) continue
        const pair = pairOf(qubits, createRng(0xbeef))
        try {
          applyControlled(pair.reference, GATE_MATRICES.x, target, controls)
          acceleratedApplyControlled(
            pair.candidate(),
            GATE_MATRICES.x,
            target,
            controls
          )
          expect(
            worstDifference(pair.reference, pair.candidate()),
            `target ${target} controls ${JSON.stringify(controls)}`
          ).toBe(0)
        } finally {
          pair.release()
        }
      }
    }
  })

  it('reproduces swap, cswap and iswap at every qubit pair', () => {
    const qubits = 5
    for (let q0 = 0; q0 < qubits; q0++) {
      for (let q1 = 0; q1 < qubits; q1++) {
        if (q0 === q1) continue
        const control = [0, 1, 2, 3, 4].find((q) => q !== q0 && q !== q1)
        const shapes: readonly ControlSpec[][] = [
          [],
          [{ qubit: control as number, state: 1 }],
          [{ qubit: control as number, state: 0 }],
        ]
        for (const controls of shapes) {
          const swapPair = pairOf(qubits, createRng(0x1234 + q0 * 8 + q1))
          try {
            applySwap(swapPair.reference, q0, q1, controls)
            acceleratedApplySwap(swapPair.candidate(), q0, q1, controls)
            expect(
              worstDifference(swapPair.reference, swapPair.candidate()),
              `swap ${q0}<->${q1} controls ${JSON.stringify(controls)}`
            ).toBe(0)
          } finally {
            swapPair.release()
          }
        }

        const iswapPair = pairOf(qubits, createRng(0x4321 + q0 * 8 + q1))
        try {
          applyISwap(iswapPair.reference, q0, q1)
          acceleratedApplyISwap(iswapPair.candidate(), q0, q1)
          expect(
            worstDifference(iswapPair.reference, iswapPair.candidate()),
            `iswap ${q0}<->${q1}`
          ).toBe(0)
        } finally {
          iswapPair.release()
        }
      }
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 2. RANDOM CIRCUITS OVER THE WHOLE CATALOGUE
 * ══════════════════════════════════════════════════════════════════════ */

interface Move {
  readonly label: string
  readonly reference: (state: Statevector) => void
  readonly accelerated: (state: Statevector) => void
}

/**
 * Draw one gate. Written independently of `equivalence.ts`'s `drawMove` so the
 * two do not share a blind spot; in particular this one draws two-qubit shapes
 * whenever the register can hold them rather than only from three qubits up,
 * and it reaches the parametrised gates at their extremes as well as at
 * ordinary angles.
 */
function drawMove(rng: Rng, qubits: number): Move {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rng.next() * items.length)]

  const distinct = (count: number): number[] => {
    const pool = Array.from({ length: qubits }, (_, q) => q)
    const chosen: number[] = []
    for (let i = 0; i < count; i++) {
      chosen.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0])
    }
    return chosen
  }

  const ANGLES = [
    0,
    Math.PI,
    -Math.PI,
    Math.PI / 2,
    2 * Math.PI,
    1e-300,
    -1e-300,
    Number.EPSILON,
    1e15,
    -1e15,
    1e300,
  ]
  const angle = (): number =>
    rng.next() < 0.35 ? pick(ANGLES) : (rng.next() - 0.5) * 6

  const controlled = (
    matrix: Matrix2,
    label: string,
    target: number,
    controls: readonly ControlSpec[]
  ): Move => ({
    label: `${label} t=${target} c=${JSON.stringify(controls)}`,
    reference: (s) => applyControlled(s, matrix, target, controls),
    accelerated: (s) => acceleratedApplyControlled(s, matrix, target, controls),
  })

  const oneQubit = (): Move => {
    const [target] = distinct(1)
    const roll = rng.next()
    if (roll < 0.4) {
      const gate = pick(FIXED)
      return controlled(GATE_MATRICES[gate], gate, target, [])
    }
    if (roll < 0.85) {
      const gate = pick(['rx', 'ry', 'rz', 'p'] as const)
      return controlled(matrixFor(gate, [angle()]), gate, target, [])
    }
    return controlled(
      matrixFor('u', [angle(), angle(), angle()]),
      'u',
      target,
      []
    )
  }

  if (qubits === 1) return oneQubit()

  const roll = rng.next()
  if (roll < 0.4) return oneQubit()

  if (roll < 0.55) {
    const [target, control] = distinct(2)
    const controls: ControlSpec[] = [
      { qubit: control, state: rng.next() < 0.4 ? 0 : 1 },
    ]
    const gate = pick(['x', 'z', 'h', 'y'] as const)
    return controlled(GATE_MATRICES[gate], `c${gate}`, target, controls)
  }

  if (roll < 0.68) {
    // crz / cp — a controlled *parametrised* gate, which is a shape the
    // package's own drawer never produces.
    const [target, control] = distinct(2)
    const gate = pick(['rz', 'p'] as const)
    return controlled(matrixFor(gate, [angle()]), `c${gate}`, target, [
      { qubit: control, state: 1 },
    ])
  }

  if (roll < 0.8) {
    const [q0, q1] = distinct(2)
    return {
      label: `iswap ${q0}<->${q1}`,
      reference: (s) => applyISwap(s, q0, q1),
      accelerated: (s) => acceleratedApplyISwap(s, q0, q1),
    }
  }

  if (roll < 0.9 || qubits < 3) {
    const [q0, q1] = distinct(2)
    return {
      label: `swap ${q0}<->${q1}`,
      reference: (s) => applySwap(s, q0, q1, []),
      accelerated: (s) => acceleratedApplySwap(s, q0, q1, []),
    }
  }

  if (rng.next() < 0.5) {
    const [target, c0, c1] = distinct(3)
    const controls: ControlSpec[] = [
      { qubit: c0, state: rng.next() < 0.3 ? 0 : 1 },
      { qubit: c1, state: rng.next() < 0.3 ? 0 : 1 },
    ]
    return controlled(GATE_MATRICES.x, 'ccx', target, controls)
  }

  const [q0, q1, control] = distinct(3)
  const controls: ControlSpec[] = [
    { qubit: control, state: rng.next() < 0.4 ? 0 : 1 },
  ]
  return {
    label: `cswap ${q0}<->${q1} on ${control}`,
    reference: (s) => applySwap(s, q0, q1, controls),
    accelerated: (s) => acceleratedApplySwap(s, q0, q1, controls),
  }
}

function runRandomCircuit(qubits: number, gates: number, seed: number): void {
  const rng = createRng(seed)
  const pair = pairOf(qubits, createRng(seed ^ 0x5f5f))
  try {
    for (let index = 0; index < gates; index++) {
      const move = drawMove(rng, qubits)
      move.reference(pair.reference)
      move.accelerated(pair.candidate())
      const deviation = worstDifference(pair.reference, pair.candidate())
      expect(
        deviation,
        `qubits ${qubits} seed ${seed} gate ${index}: ${move.label}`
      ).toBeLessThanOrEqual(TOLERANCE)
    }
    // The whole point of a transliteration: the answers are the same bits,
    // not merely the same to a budget.
    expect(worstDifference(pair.reference, pair.candidate())).toBe(0)
  } finally {
    pair.release()
  }
}

describe('random circuits over the whole catalogue', () => {
  for (const qubits of [1, 2, 3, 4, 5, 8]) {
    it(`agrees to 1e-12 over 300 random gates on ${qubits} qubits`, () => {
      for (const seed of [1, 2, 3]) runRandomCircuit(qubits, 300, seed * 7919)
    })
  }

  it('agrees at the largest size that still runs quickly (14 qubits)', () => {
    runRandomCircuit(14, 60, 0xc0ffee)
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 3. BOUNDARY CONDITIONS
 * ══════════════════════════════════════════════════════════════════════ */

describe('boundaries', () => {
  it('a circuit with no gates leaves both engines in |0…0⟩', () => {
    for (let qubits = 1; qubits <= 10; qubits++) {
      const pair = pairOf(qubits, undefined)
      try {
        expect(worstDifference(pair.reference, pair.candidate())).toBe(0)
        expect(pair.candidate().re[0]).toBe(1)
      } finally {
        pair.release()
      }
    }
  })

  it('one qubit: every gate, both engines, bit for bit', () => {
    const angles = [
      0,
      Math.PI,
      -Math.PI,
      Math.PI / 4,
      1e-300,
      1e15,
      1e300,
      -1e300,
      Number.MIN_VALUE,
    ]
    for (const gate of ['rx', 'ry', 'rz', 'p'] as const) {
      for (const theta of angles) {
        const pair = pairOf(1, createRng(0x11))
        try {
          const matrix = matrixFor(gate, [theta])
          applyControlled(pair.reference, matrix, 0, [])
          acceleratedApplyControlled(pair.candidate(), matrix, 0, [])
          expect(
            worstDifference(pair.reference, pair.candidate()),
            `${gate}(${theta}) on the single qubit`
          ).toBe(0)
        } finally {
          pair.release()
        }
      }
    }
  })

  it('parametrised gates at extreme angles agree, NaN for NaN included', () => {
    const extremes = [
      1e-300,
      -1e-300,
      1e300,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.EPSILON,
      2 ** 53,
      -(2 ** 53),
    ]
    for (const theta of extremes) {
      for (const gate of ['rx', 'ry', 'rz', 'p'] as const) {
        const pair = pairOf(4, createRng(0x22))
        try {
          const matrix = matrixFor(gate, [theta])
          applyControlled(pair.reference, matrix, 2, [])
          acceleratedApplyControlled(pair.candidate(), matrix, 2, [])
          expect(
            worstDifference(pair.reference, pair.candidate()),
            `${gate}(${theta})`
          ).toBe(0)
        } finally {
          pair.release()
        }
      }
    }
  })

  it('u at three extreme parameters agrees', () => {
    for (const theta of [0, Math.PI, 1e300]) {
      for (const phi of [0, -Math.PI, 1e-300]) {
        for (const lambda of [0, Math.PI / 2, 1e15]) {
          const pair = pairOf(3, createRng(0x33))
          try {
            const matrix = matrixFor('u', [theta, phi, lambda])
            applyControlled(pair.reference, matrix, 1, [])
            acceleratedApplyControlled(pair.candidate(), matrix, 1, [])
            expect(
              worstDifference(pair.reference, pair.candidate()),
              `u(${theta}, ${phi}, ${lambda})`
            ).toBe(0)
          } finally {
            pair.release()
          }
        }
      }
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE ACCELERATED EXTRAS, WHICH NOTHING PROVES BEFORE INSTALLATION
 * ══════════════════════════════════════════════════════════════════════ */

describe('the extras against their TypeScript definitions', () => {
  it('normSquared, scale, probabilities and reducedDensity agree', () => {
    const qubits = 6
    const session = createSession(createTransliteratedExports())
    const extras = createExtras(session)
    const handle = session.allocState(qubits)
    expect(handle).toBeDefined()
    if (handle === undefined) return
    try {
      const rng = createRng(0x777)
      const state = handle.statevector
      const heap = alloc(qubits)
      let sum = 0
      for (let i = 0; i < state.size; i++) {
        const re = rng.next() * 2 - 1
        const im = rng.next() * 2 - 1
        state.re[i] = re
        state.im[i] = im
        heap.re[i] = re
        heap.im[i] = im
        sum += re * re + im * im
      }

      expect(extras.normSquared(state)).toBeCloseTo(sum, 12)

      for (let qubit = 0; qubit < qubits; qubit++) {
        const accelerated = extras.reducedDensity(state, qubit)
        const reference = tsReducedDensity(heap, qubit)
        expect(accelerated).toBeDefined()
        if (accelerated === undefined) continue
        expect(Math.abs(accelerated[0] - reference.rho00)).toBeLessThan(1e-12)
        expect(Math.abs(accelerated[1] - reference.rho11)).toBeLessThan(1e-12)
        expect(Math.abs(accelerated[2] - reference.re01)).toBeLessThan(1e-12)
        // The sign of Im ρ₀₁ is what §5.5's y component is built from, and it
        // is the entry the analysis panel would draw mirrored if it flipped.
        expect(Math.abs(accelerated[3] - reference.im01)).toBeLessThan(1e-12)
        const bloch = blochVectors(heap)[qubit]
        expect(Math.abs(2 * accelerated[2] - bloch.x)).toBeLessThan(1e-12)
        expect(Math.abs(-2 * accelerated[3] - bloch.y)).toBeLessThan(1e-12)
      }

      // `probabilities` writes through a pointer, so its output buffer must
      // itself live in linear memory. The session exposes no way to allocate
      // one, so this borrows a second state's real half.
      const scratchHandle = session.allocState(qubits)
      expect(scratchHandle).toBeDefined()
      if (scratchHandle !== undefined) {
        const out = scratchHandle.statevector.re
        // Re-read: allocating the scratch may have grown memory.
        const wrote = extras.probabilities(handle.statevector, out)
        expect(wrote).toBe(true)
        const reference = tsProbabilities(heap)
        const fresh = scratchHandle.statevector.re
        for (let i = 0; i < reference.length; i++) {
          expect(Math.abs(fresh[i] - reference[i])).toBeLessThan(1e-12)
        }
        scratchHandle.release()
      }

      expect(extras.scale(handle.statevector, 0.5)).toBe(true)
      const scaled = handle.statevector
      for (let i = 0; i < heap.size; i++) {
        expect(scaled.re[i]).toBe(heap.re[i] * 0.5)
        expect(scaled.im[i]).toBe(heap.im[i] * 0.5)
      }
    } finally {
      session.dispose()
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 5. DEGRADING WITHOUT WASM
 * ══════════════════════════════════════════════════════════════════════ */

describe('the bridge degrades rather than breaks', () => {
  it('reports no-artifact on a checkout with no Rust toolchain', async () => {
    const result = await loadKernel({ load: () => Promise.resolve(undefined) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-artifact')
    expect(activeStatevectorKernel()).toBeUndefined()
  })

  it('reports no-artifact when reading the artifact throws', async () => {
    const result = await loadKernel({
      load: () => Promise.reject(new Error('ENOENT')),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-artifact')
    expect(activeStatevectorKernel()).toBeUndefined()
  })

  it('reports instantiation-failed on bytes that are not a module', async () => {
    const result = await loadKernel({
      load: () => Promise.resolve(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('instantiation-failed')
    expect(activeStatevectorKernel()).toBeUndefined()
  })

  it('reports no-webassembly where WebAssembly is switched off', async () => {
    const saved = globalThis.WebAssembly
    // @ts-expect-error — modelling a runtime that does not have it at all
    delete globalThis.WebAssembly
    try {
      const result = await loadKernel({
        load: () => {
          throw new Error('the loader must not be reached')
        },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('no-webassembly')
    } finally {
      globalThis.WebAssembly = saved
    }
    expect(activeStatevectorKernel()).toBeUndefined()
  })

  it('leaves the engine correct after every failed load', async () => {
    await loadKernel({ load: () => Promise.resolve(undefined) })
    const state = alloc(2)
    acceleratedApplyControlled(state, GATE_MATRICES.h, 0, [])
    acceleratedApplyControlled(state, GATE_MATRICES.x, 1, [
      { qubit: 0, state: 1 },
    ])
    expect(state.re[0]).toBeCloseTo(Math.SQRT1_2, 15)
    expect(state.re[3]).toBeCloseTo(Math.SQRT1_2, 15)
    expect(state.re[1]).toBe(0)
    expect(state.re[2]).toBe(0)
  })

  it('declines a JS-heap statevector and falls back without touching it', () => {
    const session = createSession(createTransliteratedExports())
    installStatevectorKernel(createKernel(session))
    try {
      const heap = alloc(3)
      acceleratedApplyControlled(heap, GATE_MATRICES.h, 0, [])
      const reference = alloc(3)
      applyControlled(reference, GATE_MATRICES.h, 0, [])
      expect(worstDifference(heap, reference)).toBe(0)
    } finally {
      session.dispose()
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 6. WHAT THE INSTALLED GATE ACTUALLY CATCHES
 * ══════════════════════════════════════════════════════════════════════ */

describe('the equivalence gate', () => {
  it('passes the crate algorithm', () => {
    const session = createSession(createTransliteratedExports())
    try {
      const kernel = createKernel(session)
      const report = verifyEquivalence(session, kernel, { qubits: 8 })
      expect(report.agreed).toBe(true)
      expect(report.worstDeviation).toBe(0)
      expect(report.declined).toBe(0)
    } finally {
      session.dispose()
    }
  })

  it('refuses a kernel that fills the state with NaN', () => {
    const session = createSession(createTransliteratedExports())
    try {
      const honest = createKernel(session)
      // A kernel that computes from a detached view writes NaN — the exact
      // corruption session.ts names as the one silent failure mode.
      const corrupt = {
        id: 'nan',
        applyControlled: (
          state: Statevector,
          matrix: Matrix2,
          target: number,
          controls: readonly ControlSpec[]
        ): boolean => {
          const handled = honest.applyControlled(
            state,
            matrix,
            target,
            controls
          )
          if (handled) state.re[0] = Number.NaN
          return handled
        },
        applySwap: honest.applySwap,
        applyISwap: honest.applyISwap,
      }
      const report = verifyEquivalence(session, corrupt, { qubits: 6 })
      /*
       * A disagreement at the first gate, which is what the gate exists for.
       * It used to report agreement with `worstDeviation: 0` — NaN fails every
       * comparison, so `deviation > worst` and `deviation > tolerance` were
       * both false — and `loadKernel` installed the kernel on the strength of
       * it. NaN is the corruption a detached view, uninitialised linear memory
       * and a miscompiled artifact all produce, so it was the one class of
       * failure the gate was blind to and the only one it truly had to see.
       */
      expect(report.agreed).toBe(false)
      expect(report.worstDeviation).toBe(Number.POSITIVE_INFINITY)
      expect(report.failure?.index).toBe(0)
      expect(report.failure?.deviation).toBe(Number.POSITIVE_INFINITY)
    } finally {
      session.dispose()
    }
  })

  it('reads an infinite deviation between a state and its NaN corruption', () => {
    const a = alloc(2)
    const b = alloc(2)
    b.re[0] = Number.NaN
    b.im[3] = Number.NaN
    // The same answer the test harness's own `worstDifference` gives, which is
    // how the disagreement between the two was noticed in the first place.
    expect(maxDeviation(a, b)).toBe(Number.POSITIVE_INFINITY)
    expect(worstDifference(a, b)).toBe(Number.POSITIVE_INFINITY)
  })

  it('reads zero where BOTH sides are NaN, because that is agreement', () => {
    // The reference is `apply.ts`. If it produced NaN — a caller handed the
    // engine a NaN amplitude — then a kernel that produced NaN agreed with it,
    // and reporting an infinite deviation there would fail an honest kernel
    // for reproducing the reference exactly.
    const a = alloc(2)
    const b = alloc(2)
    a.re[1] = Number.NaN
    b.re[1] = Number.NaN
    expect(maxDeviation(a, b)).toBe(0)
  })
})
