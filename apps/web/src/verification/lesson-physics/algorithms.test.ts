/**
 * The claims the lesson prose makes *beyond* the circuit it draws.
 *
 * Each lesson says something general — "every balanced function gives
 * something else", "the diffuser is the same nine gates whatever is marked",
 * "it will point at `|+⟩` whatever state you started it in". The catalog only
 * draws one or two cases of each. This file derives the general statement from
 * the definitions and runs every case, against a reference simulator that
 * shares no code with `@qsim/core` (`reference.ts`).
 */

import { describe, expect, it } from 'vitest'

import {
  ket,
  refBloch,
  refEntropy,
  refProbabilities,
  refRun,
  type C,
  type RefOp,
} from './reference'

/** Probability of each basis state, keyed by the ket the app prints. */
function distribution(state: readonly C[], n: number): Record<string, number> {
  const probs = refProbabilities(state)
  const out: Record<string, number> = {}
  probs.forEach((p, index) => {
    if (p > 1e-12) out[ket(index, n)] = p
  })
  return out
}

/** The one basis state carrying all of the probability, or null. */
function certainOutcome(state: readonly C[], n: number): string | null {
  const dist = distribution(state, n)
  const entries = Object.entries(dist)
  if (entries.length !== 1) return null
  const [label, p] = entries[0]!
  return Math.abs(p - 1) < 1e-9 ? label : null
}

describe('Deutsch–Jozsa separates constant from balanced in one query', () => {
  /**
   * The oracle as a phase, built directly from the truth table rather than
   * from gates: for each input x, multiply the amplitude by (−1)^{f(x)}. That
   * is what a `U_f` acting on an answer wire in `|−⟩` does, and writing it this
   * way means the test does not assume the lesson's construction is right.
   */
  function djOutcome(f: (x0: number, x1: number) => number): string {
    const n = 2
    let state = refRun(n, [
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
    ])
    state = state.map((amp, index) => {
      const sign = f(index & 1, (index >> 1) & 1) === 1 ? -1 : 1
      return { re: amp.re * sign, im: amp.im * sign }
    })
    // Fold the two closing Hadamards through the same reference machinery by
    // continuing from this state: applying them by hand keeps the file honest.
    const h = (s: readonly C[], q: number): C[] => {
      const out: C[] = s.map(() => ({ re: 0, im: 0 }))
      for (let i = 0; i < s.length; i += 1) {
        const zero = i & ~(1 << q)
        const one = i | (1 << q)
        const sign = ((i >> q) & 1) === 1 ? -1 : 1
        out[zero]!.re += s[i]!.re * Math.SQRT1_2
        out[zero]!.im += s[i]!.im * Math.SQRT1_2
        out[one]!.re += sign * s[i]!.re * Math.SQRT1_2
        out[one]!.im += sign * s[i]!.im * Math.SQRT1_2
      }
      return out
    }
    state = h(h(state, 0), 1)
    const outcome = certainOutcome(state, n)
    expect(outcome).not.toBeNull()
    return outcome!
  }

  const constants = [
    { name: 'f = 0', f: () => 0 },
    { name: 'f = 1', f: () => 1 },
  ]

  // All six balanced functions of two bits: two of the four inputs give 1.
  const balanced = [
    { name: 'f = x0', f: (x0: number) => x0 },
    { name: 'f = ¬x0', f: (x0: number) => 1 - x0 },
    { name: 'f = x1', f: (_x0: number, x1: number) => x1 },
    { name: 'f = ¬x1', f: (_x0: number, x1: number) => 1 - x1 },
    { name: 'f = x0⊕x1', f: (x0: number, x1: number) => x0 ^ x1 },
    { name: 'f = ¬(x0⊕x1)', f: (x0: number, x1: number) => 1 - (x0 ^ x1) },
  ]

  it.each(constants)('$name reads 00 on the input wires', ({ f }) => {
    expect(djOutcome(f)).toBe('00')
  })

  it.each(balanced)('$name reads something other than 00', ({ f }) => {
    expect(djOutcome(f)).not.toBe('00')
  })

  /**
   * The lesson's own construction, oracle and uncomputation included, for the
   * two balanced functions it draws — checked against the ket its prose names.
   */
  it.each([
    { control: 0, expected: '001' },
    { control: 1, expected: '010' },
  ])(
    'the lesson circuit with the oracle on q$control reads $expected',
    ({ control, expected }) => {
      const ops: RefOp[] = [
        { gate: 'x', targets: [2] },
        { gate: 'h', targets: [2] },
        { gate: 'h', targets: [0] },
        { gate: 'h', targets: [1] },
        { gate: 'cx', targets: [2], controls: [control] },
        { gate: 'h', targets: [0] },
        { gate: 'h', targets: [1] },
        { gate: 'h', targets: [2] },
        { gate: 'x', targets: [2] },
      ]
      expect(certainOutcome(refRun(3, ops), 3)).toBe(expected)
    }
  )

  /** The hint's claim: a bare `Z` on the input wire is the same oracle. */
  it('a bare Z on the second input wire gives the same answer as the CNOT', () => {
    const withZ: RefOp[] = [
      { gate: 'x', targets: [2] },
      { gate: 'h', targets: [2] },
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
      { gate: 'z', targets: [1] },
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
      { gate: 'h', targets: [2] },
      { gate: 'x', targets: [2] },
    ]
    expect(certainOutcome(refRun(3, withZ), 3)).toBe('010')
  })
})

describe('Grover amplifies whichever element is marked', () => {
  /**
   * One round for a mark given as (q1, q0). The oracle is `CZ` conjugated by
   * `X` on whichever wire must read 0, which is the lesson's construction
   * generalised; the diffuser is the lesson's nine gates, unchanged.
   */
  function groverRound(mark: readonly [number, number], rounds: number): C[] {
    const [m1, m0] = mark
    const oracle: RefOp[] = [
      ...(m0 === 0 ? [{ gate: 'x', targets: [0] } as RefOp] : []),
      ...(m1 === 0 ? [{ gate: 'x', targets: [1] } as RefOp] : []),
      { gate: 'cz', targets: [1], controls: [0] },
      ...(m0 === 0 ? [{ gate: 'x', targets: [0] } as RefOp] : []),
      ...(m1 === 0 ? [{ gate: 'x', targets: [1] } as RefOp] : []),
    ]
    const diffuser: RefOp[] = [
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
      { gate: 'x', targets: [0] },
      { gate: 'x', targets: [1] },
      { gate: 'cz', targets: [1], controls: [0] },
      { gate: 'x', targets: [0] },
      { gate: 'x', targets: [1] },
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
    ]
    const ops: RefOp[] = [
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
    ]
    for (let r = 0; r < rounds; r += 1) ops.push(...oracle, ...diffuser)
    return refRun(2, ops)
  }

  it.each([
    { mark: [0, 0] as const, label: '00' },
    { mark: [0, 1] as const, label: '01' },
    { mark: [1, 0] as const, label: '10' },
    { mark: [1, 1] as const, label: '11' },
  ])('one round lands on $label with probability 1', ({ mark, label }) => {
    expect(certainOutcome(groverRound(mark, 1), 2)).toBe(label)
  })

  it.each([
    { mark: [0, 1] as const, label: '01' },
    { mark: [1, 0] as const, label: '10' },
  ])(
    'a second round on $label puts every item back at a quarter',
    ({ mark }) => {
      const dist = distribution(groverRound(mark, 2), 2)
      for (const label of ['00', '01', '10', '11']) {
        expect(dist[label] ?? 0).toBeCloseTo(0.25, 12)
      }
    }
  )
})

describe('Teleportation reproduces any input state on the third qubit', () => {
  function teleport(theta: number, phi: number): C[] {
    return refRun(3, [
      { gate: 'ry', targets: [0], params: [theta] },
      { gate: 'rz', targets: [0], params: [phi] },
      { gate: 'h', targets: [1] },
      { gate: 'cx', targets: [2], controls: [1] },
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [2], controls: [1] },
      { gate: 'cz', targets: [2], controls: [0] },
    ])
  }

  /** Bloch vector of the payload as it would have been, on its own wire. */
  function payloadBloch(theta: number, phi: number): [number, number, number] {
    const state = refRun(1, [
      { gate: 'ry', targets: [0], params: [theta] },
      { gate: 'rz', targets: [0], params: [phi] },
    ])
    return refBloch(state, 0, 1)
  }

  // A deterministic spread of inputs, including the poles and the lesson's own.
  const inputs = [
    [0, 0],
    [Math.PI, 0],
    [Math.PI / 2, 0],
    [(3 * Math.PI) / 8, Math.PI / 4],
    [1.234, -2.345],
    [2.9, 5.1],
    [0.37, 3.01],
  ] as const

  it.each(inputs)(
    'Ry(%f) Rz(%f) arrives on q2 unchanged, and q0 is left at |+⟩',
    (theta, phi) => {
      const state = teleport(theta, phi)
      const arrived = refBloch(state, 2, 3)
      const wanted = payloadBloch(theta, phi)
      for (let axis = 0; axis < 3; axis += 1) {
        expect(arrived[axis]).toBeCloseTo(wanted[axis]!, 12)
      }
      // The register ends as a product state: nothing of the payload is left
      // behind, which is no-cloning drawn on screen.
      expect(refEntropy(state, 0, 3)).toBeCloseTo(0, 12)
      expect(refEntropy(state, 1, 3)).toBeCloseTo(0, 12)
      expect(refEntropy(state, 2, 3)).toBeCloseTo(0, 12)
      const first = refBloch(state, 0, 3)
      expect(first[0]).toBeCloseTo(1, 12)
      const second = refBloch(state, 1, 3)
      expect(second[0]).toBeCloseTo(1, 12)
    }
  )

  it('the four Bell outcomes are equally likely, whatever is being sent', () => {
    const partial = refRun(3, [
      { gate: 'ry', targets: [0], params: [1.234] },
      { gate: 'rz', targets: [0], params: [-2.345] },
      { gate: 'h', targets: [1] },
      { gate: 'cx', targets: [2], controls: [1] },
      { gate: 'cx', targets: [1], controls: [0] },
      { gate: 'h', targets: [0] },
    ])
    const probs = refProbabilities(partial)
    for (let outcome = 0; outcome < 4; outcome += 1) {
      let total = 0
      probs.forEach((p, index) => {
        if ((index & 0b011) === outcome) total += p
      })
      expect(total).toBeCloseTo(0.25, 12)
    }
    // And Bob holds nothing at all until the two bits arrive.
    const bob = refBloch(partial, 2, 3)
    expect(Math.hypot(...bob)).toBeCloseTo(0, 12)
  })
})

describe('Superdense coding recovers all four messages', () => {
  function superdense(encoding: readonly RefOp[]): string | null {
    return certainOutcome(
      refRun(2, [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [0] },
        ...encoding,
        { gate: 'cx', targets: [1], controls: [0] },
        { gate: 'h', targets: [0] },
      ]),
      2
    )
  }

  it.each([
    { name: 'nothing', encoding: [], expected: '00' },
    { name: 'Z', encoding: [{ gate: 'z', targets: [0] }], expected: '01' },
    { name: 'X', encoding: [{ gate: 'x', targets: [0] }], expected: '10' },
    {
      name: 'Z then X',
      encoding: [
        { gate: 'z', targets: [0] },
        { gate: 'x', targets: [0] },
      ],
      expected: '11',
    },
    { name: 'Y', encoding: [{ gate: 'y', targets: [0] }], expected: '11' },
  ])('$name delivers $expected', ({ encoding, expected }) => {
    expect(superdense(encoding as RefOp[])).toBe(expected)
  })
})

describe('BB84 agrees when the bases match and not when they do not', () => {
  /**
   * One round. `bit` is Alice's, `alice`/`bob`/`eve` are bases: 'z' straight,
   * 'x' diagonal. Eve is a `CNOT` onto a fresh wire, conjugated by her basis
   * choice — the substitution the lesson makes for a measurement.
   */
  function round(
    bit: 0 | 1,
    alice: 'z' | 'x',
    bob: 'z' | 'x',
    eve: 'z' | 'x' | null
  ): { state: C[]; qubits: number } {
    const qubits = eve === null ? 1 : 2
    const ops: RefOp[] = []
    if (bit === 1) ops.push({ gate: 'x', targets: [0] })
    if (alice === 'x') ops.push({ gate: 'h', targets: [0] })
    if (eve !== null) {
      if (eve === 'x') ops.push({ gate: 'h', targets: [0] })
      ops.push({ gate: 'cx', targets: [1], controls: [0] })
      if (eve === 'x') ops.push({ gate: 'h', targets: [0] })
    }
    if (bob === 'x') ops.push({ gate: 'h', targets: [0] })
    return { state: refRun(qubits, ops), qubits }
  }

  /** Bob reads qubit 0, so his marginal is what the key bit is. */
  function bobProbabilityOfOne(state: readonly C[]): number {
    const probs = refProbabilities(state)
    let total = 0
    probs.forEach((p, index) => {
      if ((index & 1) === 1) total += p
    })
    return total
  }

  it.each([
    { bit: 0 as const, basis: 'z' as const },
    { bit: 1 as const, basis: 'z' as const },
    { bit: 0 as const, basis: 'x' as const },
    { bit: 1 as const, basis: 'x' as const },
  ])(
    'matching bases ($basis) deliver bit $bit with certainty',
    ({ bit, basis }) => {
      const { state } = round(bit, basis, basis, null)
      expect(bobProbabilityOfOne(state)).toBeCloseTo(bit, 12)
    }
  )

  it.each([
    { bit: 0 as const, alice: 'z' as const, bob: 'x' as const },
    { bit: 1 as const, alice: 'z' as const, bob: 'x' as const },
    { bit: 0 as const, alice: 'x' as const, bob: 'z' as const },
    { bit: 1 as const, alice: 'x' as const, bob: 'z' as const },
  ])('mismatched bases give Bob a fair coin', ({ bit, alice, bob }) => {
    const { state } = round(bit, alice, bob, null)
    expect(bobProbabilityOfOne(state)).toBeCloseTo(0.5, 12)
  })

  it('an Eve in the wrong basis makes a certain round a coin, and shows up', () => {
    const { state } = round(1, 'x', 'x', 'z')
    expect(bobProbabilityOfOne(state)).toBeCloseTo(0.5, 12)
    expect(refEntropy(state, 0, 2)).toBeCloseTo(1, 12)
  })

  it('an Eve in the right basis learns the bit and leaves no mark', () => {
    const { state } = round(1, 'x', 'x', 'x')
    expect(certainOutcome(state, 2)).toBe('11')
    expect(refEntropy(state, 0, 2)).toBeCloseTo(0, 12)
    expect(refEntropy(state, 1, 2)).toBeCloseTo(0, 12)
  })

  it('a quarter of the sifted bits disagree when Eve guesses at random', () => {
    // Averaged over Eve's two basis choices and Alice's two, by hand: the only
    // error comes from a mismatch, and then Bob is wrong half the time.
    let errors = 0
    let rounds = 0
    for (const basis of ['z', 'x'] as const) {
      for (const eve of ['z', 'x'] as const) {
        for (const bit of [0, 1] as const) {
          const { state } = round(bit, basis, basis, eve)
          const one = bobProbabilityOfOne(state)
          errors += bit === 1 ? 1 - one : one
          rounds += 1
        }
      }
    }
    expect(errors / rounds).toBeCloseTo(0.25, 12)
  })
})

describe('Phase estimation recovers a phase that fits in three wires', () => {
  /** The lesson's circuit with the three controlled phases set from φ. */
  function qpe(phi: number): C[] {
    return refRun(4, [
      { gate: 'x', targets: [3] },
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [1] },
      { gate: 'h', targets: [2] },
      { gate: 'cp', targets: [3], controls: [0], params: [phi] },
      { gate: 'cp', targets: [3], controls: [1], params: [2 * phi] },
      { gate: 'cp', targets: [3], controls: [2], params: [4 * phi] },
      { gate: 'swap', targets: [0, 2] },
      { gate: 'h', targets: [0] },
      { gate: 'cp', targets: [1], controls: [0], params: [-Math.PI / 2] },
      { gate: 'h', targets: [1] },
      { gate: 'cp', targets: [2], controls: [0], params: [-Math.PI / 4] },
      { gate: 'cp', targets: [2], controls: [1], params: [-Math.PI / 2] },
      { gate: 'h', targets: [2] },
    ])
  }

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'φ = 2π·%i/8 reads back as that same number',
    (k) => {
      const state = qpe((2 * Math.PI * k) / 8)
      const outcome = certainOutcome(state, 4)
      expect(outcome).not.toBeNull()
      // q3 is the eigenstate wire and leads the printed ket; the counting
      // register is the last three characters, printed q2 q1 q0.
      expect(outcome!.slice(0, 1)).toBe('1')
      expect(parseInt(outcome!.slice(1), 2)).toBe(k)
    }
  )

  /**
   * The textbook distribution for a phase that does not fit, derived from the
   * Fourier sum rather than from the circuit: P(k) = |Σ_j e^{2πij(θ−k/8)}/8|².
   */
  function textbookQpe(theta: number, k: number): number {
    let re = 0
    let im = 0
    for (let j = 0; j < 8; j += 1) {
      const angle = 2 * Math.PI * j * (theta - k / 8)
      re += Math.cos(angle)
      im += Math.sin(angle)
    }
    return (re * re + im * im) / 64
  }

  it('θ = 0.3 spreads exactly as the Fourier sum says it must', () => {
    const state = qpe(2 * Math.PI * 0.3)
    const probs = refProbabilities(state)
    for (let k = 0; k < 8; k += 1) {
      // Index of |q3=1, counting = k⟩ is 8 + k under D1.
      expect(probs[8 + k]!).toBeCloseTo(textbookQpe(0.3, k), 12)
    }
    expect(probs[8 + 2]!).toBeCloseTo(0.5775, 4)
    expect(probs[8 + 3]!).toBeCloseTo(0.2593, 3)
    expect(probs[8 + 2]! + probs[8 + 3]!).toBeGreaterThan(8 / Math.PI ** 2)
  })
})
