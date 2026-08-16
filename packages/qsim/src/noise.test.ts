/**
 * `noise.ts` — Kraus channels, readout error and device profiles.
 *
 * WHAT THIS SUITE IS DEFENDING AGAINST. A wrong coefficient in a noise channel
 * does not throw, does not produce a NaN and does not make ρ stop looking like
 * a state. Depolarising built with √(p/2) instead of √(p/4) returns a
 * Hermitian, positive matrix whose diagonal is a normalised probability
 * distribution — and since nobody has an intuition for what a noisy
 * distribution should look like (§3.3), the wrong answer would ship. So no
 * test here asserts "it ran"; every one of them pins the arithmetic to
 * something that was true before the code was written:
 *
 *  1. **Σₖ Kₖ†Kₖ = I**, for every channel and every parameter. This is what
 *     makes a Kraus set a channel at all, every coefficient appears squared in
 *     it, and it is four complex entries to check.
 *
 *  2. **A closed form per channel.** Depolarising is (1−p)ρ + p·I/2. Amplitude
 *     damping at γ = 1 is |0⟩⟨0| from anywhere. Phase damping moves no
 *     diagonal entry. Every channel's Bloch action is three numbers and they
 *     are all asserted.
 *
 *  3. **ρ is still a state afterwards** — Hermitian, unit trace, positive
 *     semidefinite — after every channel, on pure and genuinely mixed inputs.
 *     Positivity is the one with teeth (see `density.isPositiveSemidefinite`).
 *
 *  4. **Composition laws that are derived, not assumed.** Amplitude damping
 *     twice is not amplitude damping at twice the rate, and the suite asserts
 *     both halves of that: that it equals 1 − (1−γ)², and that it visibly does
 *     not equal 2γ.
 *
 *  5. **A Bell pair decaying at the rate the closed form predicts.** ⟨ZZ⟩,
 *     ⟨XX⟩ and ⟨YY⟩ under local noise on one half, against formulas worked out
 *     by hand in the comments beside them.
 *
 * `verification/noise-channels.test.ts` is the independent half: an oracle
 * that builds the full 2ⁿ × 2ⁿ Kraus operators by Kronecker product and shares
 * no loop with this module.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { applyControlled, apply1q } from './apply.js'
import {
  alloc,
  entry,
  fromStatevector,
  hermiticityDefect,
  isPositiveSemidefinite,
  probabilities,
  purity,
  trace,
} from './density.js'
import type { DensityMatrix } from './density.js'
import { GATE_MATRICES, uMatrix } from './gates.js'
import {
  NOISE_CHANNEL_KINDS,
  NOISE_PROFILES,
  NOISE_PROFILE_IDS,
  NoiseProfileError,
  NotTracePreservingError,
  amplitudeDampingChannel,
  applyChannel,
  applyChannels,
  applyReadoutError,
  bitFlipChannel,
  channelFor,
  channelsForGate,
  channelsForIdle,
  customProfile,
  depolarizingChannel,
  depolarizingFromGateError,
  isTracePreserving,
  krausDefect,
  localDepolarizingFromPairError,
  phaseDampingChannel,
  phaseFlipChannel,
  readoutErrorsFor,
  relaxationFor,
  relaxationInfidelity,
  sampleReadout,
  validateProfile,
} from './noise.js'
import type { KrausChannel, ReadoutError } from './noise.js'
import { createRng } from './rng.js'
import type { Rng } from './rng.js'
import { alloc as allocState } from './statevector.js'
import type { Statevector } from './statevector.js'

/** D6: 1e-10, as a bound and as digits for `toBeCloseTo`. */
const TOLERANCE = 1e-10
const DIGITS = 10

/**
 * The parameter sweep every channel is put through.
 *
 * Both endpoints are in it because both are singular in their own way: 0 must
 * be the exact identity and 1 is where a coefficient's square root reaches
 * zero, which is where a sign error stops being cancelled by a square. 0.5 is
 * in it because the flip channels are worst there rather than at 1.
 */
const PARAMETERS = [0, 1e-9, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1] as const

/* ─────────────────────────────── fixtures ───────────────────────────────── */

/**
 * A generic entangled state — the same fixture `density.test.ts` uses, and for
 * the same reason: three layers of arbitrary `U(θ,φ,λ)` with a CNOT ladder
 * between them leaves no symmetry, no zero amplitude and no real amplitude for
 * a mispaired index to hide behind.
 */
function randomState(qubits: number, rng: Rng): Statevector {
  const angle = (): number => (rng.next() - 0.5) * 6
  const state = allocState(qubits)
  for (let layer = 0; layer < 3; layer++) {
    for (let q = 0; q < qubits; q++) {
      apply1q(state, uMatrix(angle(), angle(), angle()), q)
    }
    for (let q = 0; q + 1 < qubits; q++) {
      applyControlled(state, GATE_MATRICES.x, q + 1, [{ qubit: q, state: 1 }])
    }
  }
  return state
}

/** ρ = |ψ⟩⟨ψ| for a random entangled |ψ⟩. Pure, so purity 1 on the way in. */
function randomPure(qubits: number, rng: Rng): DensityMatrix {
  return fromStatevector(randomState(qubits, rng))
}

/** ρ = |Φ⁺⟩⟨Φ⁺| — (|00⟩ + |11⟩)/√2, via the audited statevector path. */
function bellPair(): DensityMatrix {
  const state = allocState(2)
  apply1q(state, GATE_MATRICES.h, 0)
  applyControlled(state, GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }])
  return fromStatevector(state)
}

/**
 * A genuinely mixed ρ: an even blend of four random pure states. Built by
 * averaging outer products, which is the definition of a mixture and uses none
 * of the machinery under test.
 */
function randomMixed(qubits: number, rng: Rng, parts = 4): DensityMatrix {
  const rho = alloc(qubits)
  rho.re[0] = 0
  for (let k = 0; k < parts; k++) {
    const part = randomPure(qubits, rng)
    for (let i = 0; i < rho.size; i++) {
      rho.re[i] += part.re[i] / parts
      rho.im[i] += part.im[i] / parts
    }
  }
  return rho
}

/** An independent copy — `density.clone` restated so the test owns its own. */
function copy(rho: DensityMatrix): DensityMatrix {
  return {
    qubits: rho.qubits,
    dim: rho.dim,
    size: rho.size,
    re: rho.re.slice(),
    im: rho.im.slice(),
  }
}

/** Largest entry-wise difference between two density matrices. */
function maxDeviation(actual: DensityMatrix, expected: DensityMatrix): number {
  let worst = 0
  for (let i = 0; i < expected.size; i++) {
    const dr = Math.abs(actual.re[i] - expected.re[i])
    const di = Math.abs(actual.im[i] - expected.im[i])
    if (dr > worst) worst = dr
    if (di > worst) worst = di
  }
  return worst
}

/** The three statements that make a matrix a state, asserted together. */
function expectValidDensity(rho: DensityMatrix, label: string): void {
  expect(hermiticityDefect(rho), `${label}: Hermitian`).toBeLessThan(TOLERANCE)
  expect(trace(rho), `${label}: unit trace`).toBeCloseTo(1, DIGITS)
  expect(isPositiveSemidefinite(rho), `${label}: positive semidefinite`).toBe(
    true
  )
}

/** ρ = ½(I + x·X + y·Y + z·Z) — one qubit, written from the Bloch vector. */
function densityFromBloch(x: number, y: number, z: number): DensityMatrix {
  const rho = alloc(1)
  rho.re[0] = (1 + z) / 2
  rho.re[1] = x / 2
  rho.im[1] = -y / 2
  rho.re[2] = x / 2
  rho.im[2] = y / 2
  rho.re[3] = (1 - z) / 2
  return rho
}

/** The inverse reading: x = 2·Re ρ₀₁, y = −2·Im ρ₀₁, z = ρ₀₀ − ρ₁₁ (§5.5). */
function blochOfDensity(rho: DensityMatrix): {
  x: number
  y: number
  z: number
} {
  return {
    x: 2 * rho.re[1],
    y: -2 * rho.im[1],
    z: rho.re[0] - rho.re[3],
  }
}

/**
 * ⟨P⟩ = Tr(ρ·P) for a tensor product of one-qubit Paulis, `paulis[q]` naming
 * the factor on qubit q (D1: index 0 is the least significant bit).
 *
 * No 2ⁿ × 2ⁿ matrix is built. A Pauli product is a signed permutation —
 * P|i⟩ = φ(i)|π(i)⟩ — so Tr(ρP) = Σᵢ φ(i)·ρ_{i,π(i)}, one pass. The phases are
 * the textbook ones: X|b⟩ = |b̄⟩, Y|0⟩ = i|1⟩, Y|1⟩ = −i|0⟩, Z|1⟩ = −|1⟩.
 */
function pauliExpectation(rho: DensityMatrix, paulis: string): number {
  const { re, im, dim } = rho
  let sumRe = 0
  let sumIm = 0
  for (let i = 0; i < dim; i++) {
    let image = i
    let phaseRe = 1
    let phaseIm = 0
    for (let q = 0; q < paulis.length; q++) {
      const bit = (i >> q) & 1
      switch (paulis[q]) {
        case 'I':
          break
        case 'X':
          image ^= 1 << q
          break
        case 'Y': {
          image ^= 1 << q
          // × i for |0⟩, × −i for |1⟩.
          const sign = bit === 0 ? 1 : -1
          const nextRe = -sign * phaseIm
          phaseIm = sign * phaseRe
          phaseRe = nextRe
          break
        }
        case 'Z':
          if (bit === 1) {
            phaseRe = -phaseRe
            phaseIm = -phaseIm
          }
          break
        default:
          throw new Error(`Unknown Pauli "${paulis[q]}".`)
      }
    }
    const at = i * dim + image
    sumRe += phaseRe * re[at] - phaseIm * im[at]
    sumIm += phaseRe * im[at] + phaseIm * re[at]
  }
  // A Pauli is Hermitian, so its expectation in any state is real. A non-zero
  // imaginary part here would mean ρ stopped being Hermitian, not that the
  // observable is complex — so it is asserted rather than discarded.
  expect(Math.abs(sumIm), `⟨${paulis}⟩ should be real`).toBeLessThan(TOLERANCE)
  return sumRe
}

/** ρ for one qubit of a larger register, with the others traced out. */
function reducedOf(
  rho: DensityMatrix,
  qubit: number
): { rho00: number; rho11: number; re01: number; im01: number } {
  const { re, im, dim } = rho
  const stride = 1 << qubit
  let rho00 = 0
  let rho11 = 0
  let re01 = 0
  let im01 = 0
  for (let base = 0; base < dim; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const zero = base + offset
      const one = zero + stride
      rho00 += re[zero * dim + zero]
      rho11 += re[one * dim + one]
      re01 += re[zero * dim + one]
      im01 += im[zero * dim + one]
    }
  }
  return { rho00, rho11, re01, im01 }
}

/**
 * The Bloch transfer coefficients of a channel list, measured by running it:
 * M_xx, M_yy, M_zz of the affine map r → M·r + c.
 *
 * Each axis is probed from both poles and the results differenced, which
 * cancels the affine shift c. That matters for amplitude damping and only for
 * it — it is the one non-unital channel here — and reading M_zz off the +z
 * probe alone would attribute its shift towards |0⟩ to a contraction it did
 * not perform.
 */
function blochTransfer(channels: readonly KrausChannel[]): {
  xx: number
  yy: number
  zz: number
} {
  const probe = (
    x: number,
    y: number,
    z: number
  ): {
    x: number
    y: number
    z: number
  } => {
    const rho = densityFromBloch(x, y, z)
    applyChannels(rho, channels, 0)
    return blochOfDensity(rho)
  }
  return {
    xx: (probe(1, 0, 0).x - probe(-1, 0, 0).x) / 2,
    yy: (probe(0, 1, 0).y - probe(0, -1, 0).y) / 2,
    zz: (probe(0, 0, 1).z - probe(0, 0, -1).z) / 2,
  }
}

/**
 * The average gate infidelity implied by a Bloch transfer:
 * r = 1 − F_avg = ½ − (M_xx + M_yy + M_zz)/6.
 *
 * Written here from the definition rather than imported, so the profile
 * round-trip below compares `noise.ts`'s derivation against an independent
 * spelling of the same formula and not against itself.
 */
function infidelityOfTransfer(transfer: {
  xx: number
  yy: number
  zz: number
}): number {
  return 0.5 - (transfer.xx + transfer.yy + transfer.zz) / 6
}

/* ═════════════════════════ 1. Σ K†K = I ═════════════════════════════════ */

describe('every channel is trace preserving', () => {
  it.each([...NOISE_CHANNEL_KINDS])(
    '%s: Σ K†K = I to 1e-10 across the parameter range',
    (kind) => {
      for (const parameter of PARAMETERS) {
        const channel = channelFor(kind, parameter)
        expect(krausDefect(channel), `${kind} at ${parameter}`).toBeLessThan(
          TOLERANCE
        )
        expect(isTracePreserving(channel)).toBe(true)
      }
    }
  )

  it.each([...NOISE_CHANNEL_KINDS])(
    '%s: Σ K†K = I for arbitrary parameters',
    (kind) => {
      fc.assert(
        fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (parameter) => {
          expect(krausDefect(channelFor(kind, parameter))).toBeLessThan(
            TOLERANCE
          )
        }),
        { numRuns: 200 }
      )
    }
  )

  it('uses §5.4’s depolarising coefficients, entry for entry', () => {
    // The specification gives √(1−3p/4)·I, √(p/4)·X, √(p/4)·Y, √(p/4)·Z, and
    // the check above says that set is trace preserving. This one says the
    // code contains that set and not another one that also happens to be.
    const p = 0.36
    const [i, x, y, z] = depolarizingChannel(p).operators
    const identity = Math.sqrt(1 - (3 * p) / 4)
    const pauli = Math.sqrt(p / 4)
    expect([...i]).toEqual([identity, 0, 0, 0, 0, 0, identity, 0])
    expect([...x]).toEqual([0, 0, pauli, 0, pauli, 0, 0, 0])
    expect([...y]).toEqual([0, 0, 0, -pauli, 0, pauli, 0, 0])
    expect([...z]).toEqual([pauli, 0, 0, 0, 0, 0, -pauli, 0])
  })

  it('rejects the coefficient error the check exists to catch', () => {
    // √(p/2) instead of √(p/4) on the Paulis — the single most likely way to
    // get this wrong, and one that still returns a positive, unit-trace ρ once
    // D6's renormalisation has run. Σ K†K comes out as (1 + 3p/4)·I.
    const p = 0.4
    const wrong = Math.sqrt(p / 2)
    const broken: KrausChannel = {
      kind: 'depolarizing',
      parameter: p,
      operators: [
        new Float64Array([
          Math.sqrt(1 - (3 * p) / 4),
          0,
          0,
          0,
          0,
          0,
          Math.sqrt(1 - (3 * p) / 4),
          0,
        ]),
        new Float64Array([0, 0, wrong, 0, wrong, 0, 0, 0]),
        new Float64Array([0, 0, 0, -wrong, 0, wrong, 0, 0]),
        new Float64Array([wrong, 0, 0, 0, 0, 0, -wrong, 0]),
      ],
    }
    expect(krausDefect(broken)).toBeCloseTo((3 * p) / 4, DIGITS)
    expect(isTracePreserving(broken)).toBe(false)

    const rho = randomPure(2, createRng(1))
    const before = copy(rho)
    expect(() => {
      applyChannel(rho, broken, 0)
    }).toThrow(NotTracePreservingError)
    // Rejected before anything was written: the caller keeps a usable state.
    expect(maxDeviation(rho, before)).toBe(0)
  })

  it('rejects an operator that is not a 2×2', () => {
    const broken: KrausChannel = {
      kind: 'bitFlip',
      parameter: 0,
      operators: [new Float64Array(32)],
    }
    expect(() => krausDefect(broken)).toThrow(RangeError)
  })

  it('refuses a parameter outside [0, 1]', () => {
    for (const kind of NOISE_CHANNEL_KINDS) {
      expect(() => channelFor(kind, -1e-9)).toThrow(RangeError)
      expect(() => channelFor(kind, 1.5)).toThrow(RangeError)
      expect(() => channelFor(kind, Number.NaN)).toThrow(RangeError)
    }
  })
})

/* ═════════════ 2. ρ is still a state after every channel ════════════════ */

describe('ρ stays a density matrix', () => {
  it.each([...NOISE_CHANNEL_KINDS])(
    '%s leaves ρ Hermitian, unit-trace and positive, on pure and mixed inputs',
    (kind) => {
      const rng = createRng(7)
      for (const qubits of [1, 2, 3]) {
        for (const parameter of PARAMETERS) {
          const channel = channelFor(kind, parameter)
          for (let target = 0; target < qubits; target++) {
            const pure = randomPure(qubits, rng)
            applyChannel(pure, channel, target)
            expectValidDensity(
              pure,
              `${kind}(${parameter}) on pure q${target} of ${qubits}`
            )

            const mixed = randomMixed(qubits, rng)
            applyChannel(mixed, channel, target)
            expectValidDensity(
              mixed,
              `${kind}(${parameter}) on mixed q${target} of ${qubits}`
            )
          }
        }
      }
    }
  )

  it('never raises the purity, for the unital channels', () => {
    // A UNITAL channel — one that fixes I/2 — is doubly stochastic, so it can
    // only mix: E(ρ) is majorised by ρ and the purity cannot go up. Four of
    // the five channels here are unital and are held to that.
    //
    // Amplitude damping is deliberately excluded, and the exclusion is the
    // physics rather than a loosened assertion: it drives every state towards
    // |0⟩, so it *raises* the purity of a mixed one and takes I/2 to a state
    // of purity 5/8 at γ = ½. The test below says so out loud, because a
    // blanket "noise lowers purity" is the intuition that would make somebody
    // "fix" the non-unital term back out of the channel.
    const rng = createRng(11)
    for (const kind of NOISE_CHANNEL_KINDS) {
      if (kind === 'amplitudeDamping') continue
      for (const parameter of PARAMETERS) {
        const rho = randomMixed(2, rng)
        const before = purity(rho)
        applyChannel(rho, channelFor(kind, parameter), 1)
        expect(purity(rho), `${kind}(${parameter})`).toBeLessThan(
          before + TOLERANCE
        )
      }
    }
  })

  it('raises the purity under amplitude damping, because it is not unital', () => {
    const rho = densityFromBloch(0, 0, 0)
    expect(purity(rho)).toBeCloseTo(0.5, DIGITS)
    applyChannel(rho, amplitudeDampingChannel(0.5), 0)
    // Bloch (0,0,0) → (0,0,γ), so the purity is (1 + γ²)/2 = 0.625.
    expect(purity(rho)).toBeCloseTo(0.625, DIGITS)
    applyChannel(rho, amplitudeDampingChannel(1), 0)
    expect(purity(rho)).toBeCloseTo(1, DIGITS)
  })
})

/* ══════════════════════ 3. the closed forms ════════════════════════════ */

describe('depolarising', () => {
  it('is ρ → (1−p)·ρ + p·I/2 on one qubit', () => {
    // The closed form is what separates §5.4's convention (p is the
    // probability of being replaced by the maximally mixed state) from the
    // other one in the literature (p is the probability of each Pauli). Both
    // sets are trace preserving; only this identity tells them apart.
    const rng = createRng(3)
    for (const p of PARAMETERS) {
      const rho = randomMixed(1, rng)
      const original = copy(rho)
      applyChannel(rho, depolarizingChannel(p), 0)
      for (let row = 0; row < 2; row++) {
        for (let column = 0; column < 2; column++) {
          const mixedEntry = row === column ? 0.5 : 0
          const actual = entry(rho, row, column)
          const source = entry(original, row, column)
          expect(actual.re, `p=${p} re(${row},${column})`).toBeCloseTo(
            (1 - p) * source.re + p * mixedEntry,
            DIGITS
          )
          expect(actual.im, `p=${p} im(${row},${column})`).toBeCloseTo(
            (1 - p) * source.im,
            DIGITS
          )
        }
      }
    }
  })

  it('shrinks the Bloch vector by exactly (1−p), isotropically', () => {
    for (const p of PARAMETERS) {
      const transfer = blochTransfer([depolarizingChannel(p)])
      expect(transfer.xx, `p=${p}`).toBeCloseTo(1 - p, DIGITS)
      expect(transfer.yy, `p=${p}`).toBeCloseTo(1 - p, DIGITS)
      expect(transfer.zz, `p=${p}`).toBeCloseTo(1 - p, DIGITS)
    }
  })

  it('leaves the maximally mixed state alone, at every p including 1', () => {
    for (const p of PARAMETERS) {
      const rho = densityFromBloch(0, 0, 0)
      const before = copy(rho)
      applyChannel(rho, depolarizingChannel(p), 0)
      expect(maxDeviation(rho, before), `p=${p}`).toBeLessThan(TOLERANCE)
    }
    // And on a larger register, where "maximally mixed" is I/2ⁿ.
    const rho = alloc(3)
    rho.re[0] = 0
    for (let i = 0; i < rho.dim; i++) rho.re[i * rho.dim + i] = 1 / rho.dim
    const before = copy(rho)
    applyChannel(rho, depolarizingChannel(1), 2)
    expect(maxDeviation(rho, before)).toBeLessThan(TOLERANCE)
  })

  it('at p = 1 sends any state to the maximally mixed one', () => {
    const rng = createRng(5)
    for (let trial = 0; trial < 8; trial++) {
      const rho = randomPure(1, rng)
      applyChannel(rho, depolarizingChannel(1), 0)
      expect(maxDeviation(rho, densityFromBloch(0, 0, 0))).toBeLessThan(
        TOLERANCE
      )
    }
  })

  it('at p = 1 on one qubit of an entangled pair kills the correlations', () => {
    // Not the same statement as the one above: the pair's ρ does not become
    // I/4, it becomes (I/2) ⊗ ρ₁. The target's reduced state is maximally
    // mixed and every correlator involving it is zero, while qubit 1's own
    // reduced state is untouched — which is what "local" means.
    const rho = bellPair()
    applyChannel(rho, depolarizingChannel(1), 0)
    expect(pauliExpectation(rho, 'ZZ')).toBeCloseTo(0, DIGITS)
    expect(pauliExpectation(rho, 'XX')).toBeCloseTo(0, DIGITS)
    expect(pauliExpectation(rho, 'ZI')).toBeCloseTo(0, DIGITS)
    const other = reducedOf(rho, 1)
    expect(other.rho00).toBeCloseTo(0.5, DIGITS)
    expect(other.rho11).toBeCloseTo(0.5, DIGITS)
  })
})

describe('amplitude damping (T1)', () => {
  it('at γ = 1 sends every state to |0⟩, whatever it started as', () => {
    const rng = createRng(13)
    const ground = densityFromBloch(0, 0, 1)
    for (let trial = 0; trial < 8; trial++) {
      const rho = randomMixed(1, rng)
      applyChannel(rho, amplitudeDampingChannel(1), 0)
      expect(maxDeviation(rho, ground)).toBeLessThan(TOLERANCE)
    }
    // And from the excited state, which is the case a channel that merely
    // shrinks coherences would also pass.
    const excited = densityFromBloch(0, 0, -1)
    applyChannel(excited, amplitudeDampingChannel(1), 0)
    expect(maxDeviation(excited, ground)).toBeLessThan(TOLERANCE)
  })

  it('at γ = 1 grounds one qubit of an entangled pair', () => {
    const rho = bellPair()
    applyChannel(rho, amplitudeDampingChannel(1), 0)
    const target = reducedOf(rho, 0)
    expect(target.rho00).toBeCloseTo(1, DIGITS)
    expect(target.rho11).toBeCloseTo(0, DIGITS)
    expectValidDensity(rho, 'Bell pair after γ = 1')
  })

  it('moves populations and coherences at the rates its operators say', () => {
    // ρ₀₀ → ρ₀₀ + γ·ρ₁₁,  ρ₁₁ → (1−γ)·ρ₁₁,  ρ₀₁ → √(1−γ)·ρ₀₁.
    const rng = createRng(17)
    for (const gamma of PARAMETERS) {
      const rho = randomMixed(1, rng)
      const before = copy(rho)
      applyChannel(rho, amplitudeDampingChannel(gamma), 0)
      expect(rho.re[0], `γ=${gamma} ρ₀₀`).toBeCloseTo(
        before.re[0] + gamma * before.re[3],
        DIGITS
      )
      expect(rho.re[3], `γ=${gamma} ρ₁₁`).toBeCloseTo(
        (1 - gamma) * before.re[3],
        DIGITS
      )
      const kept = Math.sqrt(1 - gamma)
      expect(rho.re[1], `γ=${gamma} Re ρ₀₁`).toBeCloseTo(
        kept * before.re[1],
        DIGITS
      )
      expect(rho.im[1], `γ=${gamma} Im ρ₀₁`).toBeCloseTo(
        kept * before.im[1],
        DIGITS
      )
    }
  })

  it('is the only channel here that moves the maximally mixed state', () => {
    // Non-unitality, asserted rather than described: a cold qubit relaxes
    // downwards, so I/2 does not survive amplitude damping.
    const rho = densityFromBloch(0, 0, 0)
    applyChannel(rho, amplitudeDampingChannel(0.5), 0)
    expect(blochOfDensity(rho).z).toBeCloseTo(0.5, DIGITS)
    for (const kind of NOISE_CHANNEL_KINDS) {
      if (kind === 'amplitudeDamping') continue
      const other = densityFromBloch(0, 0, 0)
      applyChannel(other, channelFor(kind, 0.5), 0)
      expect(maxDeviation(other, densityFromBloch(0, 0, 0)), kind).toBeLessThan(
        TOLERANCE
      )
    }
  })

  it('composes multiplicatively in (1−γ), not additively in γ', () => {
    // DERIVED, NOT ASSUMED. The population survives each application by a
    // factor (1−γₖ), so two applications leave (1−γ₁)(1−γ₂) and the composed
    // rate is γ = γ₁ + γ₂ − γ₁γ₂. The coherence survives by √(1−γₖ), whose
    // product is √((1−γ₁)(1−γ₂)) — the same composed γ. One law, both rows.
    const rng = createRng(19)
    const pairs: readonly (readonly [number, number])[] = [
      [0.1, 0.1],
      [0.3, 0.3],
      [0.2, 0.7],
      [0.5, 1],
      [0, 0.4],
    ]
    for (const [g1, g2] of pairs) {
      const composed = g1 + g2 - g1 * g2
      const twice = randomMixed(2, rng)
      const once = copy(twice)
      applyChannel(twice, amplitudeDampingChannel(g1), 1)
      applyChannel(twice, amplitudeDampingChannel(g2), 1)
      applyChannel(once, amplitudeDampingChannel(composed), 1)
      expect(maxDeviation(twice, once), `γ=${g1} then ${g2}`).toBeLessThan(
        TOLERANCE
      )
    }

    // And the negative half, so the test above cannot pass by the two rates
    // being close: γ twice is visibly not 2γ.
    const gamma = 0.3
    const twice = randomMixed(1, createRng(23))
    const naive = copy(twice)
    applyChannel(twice, amplitudeDampingChannel(gamma), 0)
    applyChannel(twice, amplitudeDampingChannel(gamma), 0)
    applyChannel(naive, amplitudeDampingChannel(2 * gamma), 0)
    expect(maxDeviation(twice, naive)).toBeGreaterThan(0.01)
    // 2γ − γ² is the right answer and 2γ is not.
    const derived = randomMixed(1, createRng(23))
    applyChannel(derived, amplitudeDampingChannel(2 * gamma - gamma * gamma), 0)
    expect(maxDeviation(twice, derived)).toBeLessThan(TOLERANCE)
  })
})

describe('phase damping (T2)', () => {
  it('leaves every diagonal entry untouched', () => {
    // The whole point of this channel: a computational-basis histogram cannot
    // see it at all. Checked on a three-qubit register so the statement covers
    // the diagonal entries whose target bit is set as well as those where it
    // is clear.
    const rng = createRng(29)
    for (const lambda of PARAMETERS) {
      const rho = randomMixed(3, rng)
      const before = probabilities(rho)
      applyChannel(rho, phaseDampingChannel(lambda), 1)
      const after = probabilities(rho)
      for (let i = 0; i < before.length; i++) {
        expect(after[i], `λ=${lambda} P(${i})`).toBeCloseTo(before[i], DIGITS)
      }
    }
  })

  it('drives the target’s coherences to zero at λ = 1', () => {
    const rho = randomMixed(2, createRng(31))
    applyChannel(rho, phaseDampingChannel(1), 0)
    // Every entry whose row and column disagree on bit 0 must be exactly zero;
    // every entry where they agree must be untouched.
    for (let row = 0; row < rho.dim; row++) {
      for (let column = 0; column < rho.dim; column++) {
        const at = row * rho.dim + column
        if (((row ^ column) & 1) === 1) {
          expect(Math.abs(rho.re[at]), `re(${row},${column})`).toBeLessThan(
            TOLERANCE
          )
          expect(Math.abs(rho.im[at]), `im(${row},${column})`).toBeLessThan(
            TOLERANCE
          )
        }
      }
    }
    expectValidDensity(rho, 'λ = 1')
  })

  it('squashes x and y by √(1−λ) and fixes z', () => {
    for (const lambda of PARAMETERS) {
      const transfer = blochTransfer([phaseDampingChannel(lambda)])
      const kept = Math.sqrt(1 - lambda)
      expect(transfer.xx, `λ=${lambda}`).toBeCloseTo(kept, DIGITS)
      expect(transfer.yy, `λ=${lambda}`).toBeCloseTo(kept, DIGITS)
      expect(transfer.zz, `λ=${lambda}`).toBeCloseTo(1, DIGITS)
    }
  })

  it('is the phase-flip channel at 1 − 2q = √(1−λ)', () => {
    // The two spellings §3.3 lists separately are the same map. Asserting it
    // is what keeps a later "simplification" from replacing one with the other
    // at the same numeric parameter, which would be a silent reparameterisation.
    const lambda = 0.36
    const q = (1 - Math.sqrt(1 - lambda)) / 2
    const viaDamping = randomMixed(2, createRng(37))
    const viaFlip = copy(viaDamping)
    applyChannel(viaDamping, phaseDampingChannel(lambda), 1)
    applyChannel(viaFlip, phaseFlipChannel(q), 1)
    expect(maxDeviation(viaDamping, viaFlip)).toBeLessThan(TOLERANCE)
  })

  it('composes multiplicatively in (1−λ)', () => {
    const rng = createRng(41)
    for (const [l1, l2] of [
      [0.2, 0.2],
      [0.15, 0.6],
    ] as const) {
      const composed = 1 - (1 - l1) * (1 - l2)
      const twice = randomMixed(2, rng)
      const once = copy(twice)
      applyChannel(twice, phaseDampingChannel(l1), 0)
      applyChannel(twice, phaseDampingChannel(l2), 0)
      applyChannel(once, phaseDampingChannel(composed), 0)
      expect(maxDeviation(twice, once)).toBeLessThan(TOLERANCE)
    }
  })
})

describe('bit flip and phase flip', () => {
  it('bit flip fixes x and shrinks y and z by (1 − 2p)', () => {
    for (const p of PARAMETERS) {
      const transfer = blochTransfer([bitFlipChannel(p)])
      expect(transfer.xx, `p=${p}`).toBeCloseTo(1, DIGITS)
      expect(transfer.yy, `p=${p}`).toBeCloseTo(1 - 2 * p, DIGITS)
      expect(transfer.zz, `p=${p}`).toBeCloseTo(1 - 2 * p, DIGITS)
    }
  })

  it('phase flip fixes z and shrinks x and y by (1 − 2p)', () => {
    for (const p of PARAMETERS) {
      const transfer = blochTransfer([phaseFlipChannel(p)])
      expect(transfer.xx, `p=${p}`).toBeCloseTo(1 - 2 * p, DIGITS)
      expect(transfer.yy, `p=${p}`).toBeCloseTo(1 - 2 * p, DIGITS)
      expect(transfer.zz, `p=${p}`).toBeCloseTo(1, DIGITS)
    }
  })

  it('at p = 1 each is its Pauli, applied deterministically', () => {
    // p is a probability, not an error rate: the worst case is p = ½, and at
    // p = 1 the channel is a unitary that preserves purity exactly.
    const rng = createRng(43)
    for (const [kind, gate] of [
      ['bitFlip', GATE_MATRICES.x],
      ['phaseFlip', GATE_MATRICES.z],
    ] as const) {
      const viaChannel = randomPure(2, rng)
      const viaGate = copy(viaChannel)
      applyChannel(viaChannel, channelFor(kind, 1), 1)
      densityApply1qLocal(viaGate, gate, 1)
      expect(maxDeviation(viaChannel, viaGate), kind).toBeLessThan(TOLERANCE)
      expect(purity(viaChannel)).toBeCloseTo(1, DIGITS)
    }
  })

  it('at p = ½ each destroys exactly two Bloch components', () => {
    const flipped = blochTransfer([bitFlipChannel(0.5)])
    expect(flipped.xx).toBeCloseTo(1, DIGITS)
    expect(flipped.yy).toBeCloseTo(0, DIGITS)
    expect(flipped.zz).toBeCloseTo(0, DIGITS)
  })
})

describe('a channel at parameter 0', () => {
  it.each([...NOISE_CHANNEL_KINDS])(
    '%s is the identity to the last bit, on every target',
    (kind) => {
      const rng = createRng(47)
      const channel = channelFor(kind, 0)
      for (const qubits of [1, 2, 3]) {
        for (let target = 0; target < qubits; target++) {
          const rho = randomMixed(qubits, rng)
          const before = copy(rho)
          applyChannel(rho, channel, target)
          // Not `toBeLessThan(TOLERANCE)`: exactly zero. Every constructor
          // yields the exact identity plus exact zeros at parameter 0, and
          // `channelsForGate` drops such channels on the strength of it.
          expect(
            maxDeviation(rho, before),
            `${kind} on q${target} of ${qubits}`
          ).toBe(0)
        }
      }
    }
  )
})

/* ══════════════ 4. a Bell pair under local noise ═══════════════════════ */

describe('a Bell pair losing its correlations', () => {
  it('starts with the correlators |Φ⁺⟩ is defined by', () => {
    const rho = bellPair()
    expect(pauliExpectation(rho, 'ZZ')).toBeCloseTo(1, DIGITS)
    expect(pauliExpectation(rho, 'XX')).toBeCloseTo(1, DIGITS)
    expect(pauliExpectation(rho, 'YY')).toBeCloseTo(-1, DIGITS)
    // And no local information at all: each half is maximally mixed (§5.5).
    expect(pauliExpectation(rho, 'ZI')).toBeCloseTo(0, DIGITS)
    expect(pauliExpectation(rho, 'IZ')).toBeCloseTo(0, DIGITS)
  })

  it('decays every correlator by (1−p) under local depolarising', () => {
    // A depolarising channel on qubit 0 damps every Pauli word containing a
    // non-identity factor on qubit 0 by (1−p) — which is all three of these.
    for (const p of PARAMETERS) {
      const rho = bellPair()
      applyChannel(rho, depolarizingChannel(p), 0)
      expect(pauliExpectation(rho, 'ZZ'), `p=${p} ZZ`).toBeCloseTo(
        1 - p,
        DIGITS
      )
      expect(pauliExpectation(rho, 'XX'), `p=${p} XX`).toBeCloseTo(
        1 - p,
        DIGITS
      )
      expect(pauliExpectation(rho, 'YY'), `p=${p} YY`).toBeCloseTo(
        -(1 - p),
        DIGITS
      )
      expectValidDensity(rho, `Bell after depolarising ${p}`)
    }
  })

  it('decays ⟨ZZ⟩ as (1−γ) and ⟨XX⟩ as √(1−γ) under local amplitude damping', () => {
    // WORKED BY HAND. ρ = ½(|00⟩⟨00| + |00⟩⟨11| + |11⟩⟨00| + |11⟩⟨11|). Damping
    // qubit 0 leaves |00⟩⟨00| alone, sends |11⟩⟨11| to (1−γ)|11⟩⟨11| + γ|10⟩⟨10|
    // — the excitation on qubit 0 decays while qubit 1 keeps its own — and
    // multiplies the cross terms by √(1−γ), since only one of the two indices
    // carries the damped factor. So the populations are
    //     P(00) = ½,  P(11) = ½(1−γ),  P(10) = ½γ,  P(01) = 0
    // and ⟨ZZ⟩ = ½ + ½(1−γ) − ½γ = 1 − γ, while ⟨XX⟩ = 2·Re ρ₀₀,₁₁ = √(1−γ).
    // The two rates differ, and that difference is the whole content of T1
    // decohering at half the rate it depopulates.
    //
    // WHICH INDEX GETS THE LEAKED POPULATION IS THE POINT OF ASSERTING ALL
    // FOUR. Both singly-excited states have ZZ = −1, so ⟨ZZ⟩ = 1 − γ holds
    // whichever of them receives it, and a channel wired to the wrong qubit
    // would pass the correlator check on its own. Kets print highest-qubit
    // first (`formatKet`), so |10⟩ is index 2: qubit 1 excited, qubit 0 —
    // the damped one — in the ground state.
    for (const gamma of PARAMETERS) {
      const rho = bellPair()
      applyChannel(rho, amplitudeDampingChannel(gamma), 0)
      const p = probabilities(rho)
      expect(p[0b00], `γ=${gamma} P(00)`).toBeCloseTo(0.5, DIGITS)
      expect(p[0b01], `γ=${gamma} P(01)`).toBeCloseTo(0, DIGITS)
      expect(p[0b10], `γ=${gamma} P(10)`).toBeCloseTo(0.5 * gamma, DIGITS)
      expect(p[0b11], `γ=${gamma} P(11)`).toBeCloseTo(0.5 * (1 - gamma), DIGITS)
      expect(pauliExpectation(rho, 'ZZ'), `γ=${gamma} ZZ`).toBeCloseTo(
        1 - gamma,
        DIGITS
      )
      expect(pauliExpectation(rho, 'XX'), `γ=${gamma} XX`).toBeCloseTo(
        Math.sqrt(1 - gamma),
        DIGITS
      )
      expectValidDensity(rho, `Bell after amplitude damping ${gamma}`)
    }
  })

  it('leaves ⟨ZZ⟩ alone and decays ⟨XX⟩ as √(1−λ) under local dephasing', () => {
    // The sharpest statement in this file. Phase damping destroys the pair's
    // ability to interfere while leaving its computational-basis correlation
    // *exactly* intact — a reader watching only the histogram would see a
    // perfect Bell pair, and ⟨XX⟩ would say it is gone.
    for (const lambda of PARAMETERS) {
      const rho = bellPair()
      applyChannel(rho, phaseDampingChannel(lambda), 0)
      expect(pauliExpectation(rho, 'ZZ'), `λ=${lambda} ZZ`).toBeCloseTo(
        1,
        DIGITS
      )
      expect(pauliExpectation(rho, 'XX'), `λ=${lambda} XX`).toBeCloseTo(
        Math.sqrt(1 - lambda),
        DIGITS
      )
      expect(pauliExpectation(rho, 'YY'), `λ=${lambda} YY`).toBeCloseTo(
        -Math.sqrt(1 - lambda),
        DIGITS
      )
    }
  })

  it('decays ⟨XX⟩ by the product when both halves are dephased', () => {
    // Independent channels on the two wires, so the damping factors multiply.
    const lambda = 0.19
    const rho = bellPair()
    applyChannel(rho, phaseDampingChannel(lambda), 0)
    applyChannel(rho, phaseDampingChannel(lambda), 1)
    expect(pauliExpectation(rho, 'XX')).toBeCloseTo(1 - lambda, DIGITS)
    expect(pauliExpectation(rho, 'ZZ')).toBeCloseTo(1, DIGITS)
  })
})

/* ═══════════════════════ 5. readout error ══════════════════════════════ */

describe('readout error', () => {
  const uniform = (qubits: number): Float64Array => {
    const dim = 1 << qubits
    return new Float64Array(dim).fill(1 / dim)
  }

  it('preserves total probability — the classical trace preservation', () => {
    const errors: readonly ReadoutError[] = [
      { qubit: 0, p0to1: 0.03, p1to0: 0.11 },
      { qubit: 1, p0to1: 0.2, p1to0: 0.007 },
      { qubit: 2, p0to1: 0.5, p1to0: 0.5 },
    ]
    const rng = createRng(53)
    for (let trial = 0; trial < 20; trial++) {
      const rho = randomMixed(3, rng)
      const observed = applyReadoutError(probabilities(rho), errors)
      let total = 0
      for (const value of observed) {
        expect(value).toBeGreaterThanOrEqual(-TOLERANCE)
        total += value
      }
      expect(total).toBeCloseTo(1, DIGITS)
    }
  })

  it('is the identity at zero error, and leaves the input untouched', () => {
    const ideal = uniform(3)
    const observed = applyReadoutError(ideal, [
      { qubit: 0, p0to1: 0, p1to0: 0 },
      { qubit: 2, p0to1: 0, p1to0: 0 },
    ])
    expect([...observed]).toEqual([...ideal])
    expect(observed).not.toBe(ideal)
  })

  it('reads every qubit backwards at p = 1', () => {
    const ideal = new Float64Array([0.1, 0.2, 0.3, 0.4])
    const observed = applyReadoutError(ideal, [
      { qubit: 0, p0to1: 1, p1to0: 1 },
      { qubit: 1, p0to1: 1, p1to0: 1 },
    ])
    // Both bits inverted: index i is reported as i ^ 3.
    expect([...observed]).toEqual([0.4, 0.3, 0.2, 0.1])
    // And the ideal distribution is still there to compare against (§3.3).
    expect([...ideal]).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('is asymmetric, which no single Pauli channel can be', () => {
    // THE REASON THIS IS NOT A KRAUS CHANNEL, part one. A bit-flip channel has
    // one probability and therefore misreads 0→1 and 1→0 equally often. Real
    // readout does not: relaxation during integration only goes one way.
    const errors: readonly ReadoutError[] = [
      { qubit: 0, p0to1: 0.01, p1to0: 0.2 },
    ]
    const fromZero = applyReadoutError(new Float64Array([1, 0]), errors)
    const fromOne = applyReadoutError(new Float64Array([0, 1]), errors)
    expect(fromZero[1]).toBeCloseTo(0.01, DIGITS)
    expect(fromOne[0]).toBeCloseTo(0.2, DIGITS)

    // The channel with the same average error gets both of them wrong.
    const p = (0.01 + 0.2) / 2
    const ground = densityFromBloch(0, 0, 1)
    applyChannel(ground, bitFlipChannel(p), 0)
    const excited = densityFromBloch(0, 0, -1)
    applyChannel(excited, bitFlipChannel(p), 0)
    expect(probabilities(ground)[1]).toBeCloseTo(p, DIGITS)
    expect(probabilities(excited)[0]).toBeCloseTo(p, DIGITS)
    expect(probabilities(ground)[1]).not.toBeCloseTo(0.01, 3)
  })

  it('costs the state nothing, where a bit-flip channel costs it purity', () => {
    // THE REASON THIS IS NOT A KRAUS CHANNEL, part two. The misread happens
    // after the projector fired; the qubit is untouched and a later gate sees
    // the state the hardware really had. `applyReadoutError` cannot disturb ρ
    // because it is never given ρ — it takes a distribution. The channel that
    // would have been used instead does disturb it, measurably.
    const rho = densityFromBloch(0, 0, 1)
    applyChannel(rho, bitFlipChannel(0.1), 0)
    expect(purity(rho)).toBeCloseTo((1 + 0.8 * 0.8) / 2, DIGITS)
    expect(purity(rho)).toBeLessThan(1 - 0.1)
  })

  it('applies qubit by qubit, in any order, independently', () => {
    const ideal = new Float64Array([0.05, 0.15, 0.3, 0.5])
    const a: ReadoutError = { qubit: 0, p0to1: 0.07, p1to0: 0.13 }
    const b: ReadoutError = { qubit: 1, p0to1: 0.21, p1to0: 0.02 }
    const both = applyReadoutError(ideal, [a, b])
    const reversed = applyReadoutError(ideal, [b, a])
    const staged = applyReadoutError(applyReadoutError(ideal, [a]), [b])
    for (let i = 0; i < 4; i++) {
      expect(reversed[i]).toBeCloseTo(both[i], DIGITS)
      expect(staged[i]).toBeCloseTo(both[i], DIGITS)
    }
  })

  it('matches the closed form on the all-zeros outcome', () => {
    // P(read all zeros | prepared all zeros) = (1 − p0to1)ⁿ, because the
    // qubits are independent. A confusion matrix applied to the wrong index
    // would still be stochastic and would not satisfy this.
    const qubits = 4
    const p0to1 = 0.09
    const ideal = new Float64Array(1 << qubits)
    ideal[0] = 1
    const errors: ReadoutError[] = []
    for (let q = 0; q < qubits; q++)
      errors.push({ qubit: q, p0to1, p1to0: 0.3 })
    const observed = applyReadoutError(ideal, errors)
    expect(observed[0]).toBeCloseTo((1 - p0to1) ** qubits, DIGITS)
    // And exactly one qubit misread, for each qubit.
    for (let q = 0; q < qubits; q++) {
      expect(observed[1 << q]).toBeCloseTo(
        p0to1 * (1 - p0to1) ** (qubits - 1),
        DIGITS
      )
    }
  })

  it('samples per shot to the same distribution it maps', () => {
    // The two modes of §5.3 have to agree about the device. `applyReadoutError`
    // is what analytic mode uses and `sampleReadout` is what a trajectories run
    // uses; if they disagreed, the same circuit would tell a user two different
    // stories depending on a toggle.
    const errors: readonly ReadoutError[] = [
      { qubit: 0, p0to1: 0.1, p1to0: 0.25 },
      { qubit: 1, p0to1: 0.05, p1to0: 0.15 },
    ]
    const ideal = new Float64Array([0.4, 0.1, 0.2, 0.3])
    const expected = applyReadoutError(ideal, errors)

    const rng = createRng(59)
    const shots = 200_000
    const tally = new Float64Array(4)
    for (let shot = 0; shot < shots; shot++) {
      // Draw the ideal outcome, then corrupt it the way a run would.
      const draw = rng.next()
      let outcome = 3
      let cumulative = 0
      for (let i = 0; i < 4; i++) {
        cumulative += ideal[i]
        if (draw < cumulative) {
          outcome = i
          break
        }
      }
      tally[sampleReadout(outcome, errors, rng)]++
    }
    for (let i = 0; i < 4; i++) {
      // 3.5 standard errors of a binomial at this sample size — loose enough
      // to never flake, tight enough that a wrong branch cannot pass.
      const bound = 3.5 * Math.sqrt((expected[i] * (1 - expected[i])) / shots)
      expect(tally[i] / shots, `outcome ${i}`).toBeCloseTo(expected[i], 2)
      expect(Math.abs(tally[i] / shots - expected[i])).toBeLessThan(bound)
    }
  })

  it('refuses a malformed request', () => {
    expect(() => applyReadoutError(new Float64Array(3), [])).toThrow(RangeError)
    expect(() => applyReadoutError(new Float64Array(1), [])).toThrow(RangeError)
    expect(() =>
      applyReadoutError(uniform(2), [{ qubit: 2, p0to1: 0, p1to0: 0 }])
    ).toThrow(RangeError)
    expect(() =>
      applyReadoutError(uniform(2), [
        { qubit: 0, p0to1: 0, p1to0: 0 },
        { qubit: 0, p0to1: 0.1, p1to0: 0 },
      ])
    ).toThrow(RangeError)
    expect(() =>
      applyReadoutError(uniform(2), [{ qubit: 0, p0to1: 1.5, p1to0: 0 }])
    ).toThrow(RangeError)
  })
})

/* ═══════════════════════ 6. device profiles ════════════════════════════ */

describe('device profiles', () => {
  it.each([...NOISE_PROFILE_IDS])('%s is physical', (id) => {
    const profile = NOISE_PROFILES[id]
    expect(profile.id).toBe(id)
    expect(() => validateProfile(profile)).not.toThrow()
    expect(profile.t2Ns).toBeLessThanOrEqual(2 * profile.t1Ns)
  })

  it('rejects T2 above 2·T1, the units mistake that produces it', () => {
    expect(() =>
      customProfile(NOISE_PROFILES.superconducting, {
        t1Ns: 100_000,
        t2Ns: 250_000,
      })
    ).toThrow(NoiseProfileError)
    try {
      customProfile(NOISE_PROFILES.superconducting, { t2Ns: 1e9 })
    } catch (error) {
      // The field is carried, not only described: the custom-profile panel has
      // to know which input to mark, in three languages (D2).
      expect(error).toBeInstanceOf(NoiseProfileError)
      expect((error as NoiseProfileError).field).toBe('t2Ns')
      expect((error as NoiseProfileError).value).toBe(1e9)
    }
    // Exactly 2·T1 is allowed: that is the pure-T1 limit, not an error.
    expect(() =>
      customProfile(NOISE_PROFILES.superconducting, {
        t1Ns: 50_000,
        t2Ns: 100_000,
      })
    ).not.toThrow()
  })

  it('builds a custom profile from a base plus overrides', () => {
    const base = NOISE_PROFILES.trappedIon
    const tuned = customProfile(base, { t1Ns: 5e9, readoutP1to0: 0.01 })
    expect(tuned.id).toBe('custom')
    expect(tuned.t1Ns).toBe(5e9)
    expect(tuned.readoutP1to0).toBe(0.01)
    expect(tuned.twoQubitGateNs).toBe(base.twoQubitGateNs)
    expect(() => customProfile(base, { oneQubitGateError: 1.4 })).toThrow(
      NoiseProfileError
    )
    expect(() => customProfile(base, { t1Ns: 0 })).toThrow(NoiseProfileError)
  })

  it('turns T1 and T2 into decays that reproduce the exponentials', () => {
    // THE DEFINING PROPERTY OF THE CONVERSION. After a duration t the
    // population must survive as e^{−t/T₁} and the coherence as e^{−t/T₂}.
    // Both are checked by running the two channels on a real ρ rather than by
    // re-deriving the formula, so this test would catch the conversion and the
    // kernel disagreeing as readily as the conversion being wrong.
    const cases: readonly (readonly [number, number, number])[] = [
      [100_000, 120_000, 35],
      [100_000, 200_000, 5000], // T2 = 2·T1 exactly: no pure dephasing left
      [20_000, 15_000, 400],
      [1e10, 1e9, 200_000],
      [50, 30, 500], // many lifetimes: the deep-decay end of the range
    ]
    for (const [t1, t2, t] of cases) {
      const { gamma, lambda } = relaxationFor(t1, t2, t)
      const rho = densityFromBloch(1 / Math.SQRT2, 0, -1 / Math.SQRT2)
      const excited = rho.re[3]
      const coherence = Math.hypot(rho.re[1], rho.im[1])
      applyChannels(
        rho,
        [amplitudeDampingChannel(gamma), phaseDampingChannel(lambda)],
        0
      )
      expect(rho.re[3] / excited, `T1=${t1} t=${t}`).toBeCloseTo(
        Math.exp(-t / t1),
        DIGITS
      )
      expect(
        Math.hypot(rho.re[1], rho.im[1]) / coherence,
        `T2=${t2} t=${t}`
      ).toBeCloseTo(Math.exp(-t / t2), DIGITS)
      expectValidDensity(rho, `relaxation T1=${t1} T2=${t2} t=${t}`)
    }
  })

  it('has no pure dephasing at T2 = 2·T1, and none with infinite times', () => {
    expect(relaxationFor(1000, 2000, 500).lambda).toBe(0)
    const none = relaxationFor(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      1000
    )
    expect(none.gamma).toBe(0)
    expect(none.lambda).toBe(0)
    // A finite T2 with an infinite T1 is pure dephasing, and legal.
    const dephasingOnly = relaxationFor(Number.POSITIVE_INFINITY, 1000, 1000)
    expect(dephasingOnly.gamma).toBe(0)
    expect(dephasingOnly.lambda).toBeCloseTo(1 - Math.exp(-2), DIGITS)
  })

  it('grows both damping rates monotonically with the duration', () => {
    let lastGamma = -1
    let lastLambda = -1
    for (const t of [0, 1, 10, 100, 1000, 10_000]) {
      const { gamma, lambda } = relaxationFor(20_000, 15_000, t)
      expect(gamma).toBeGreaterThanOrEqual(lastGamma)
      expect(lambda).toBeGreaterThanOrEqual(lastLambda)
      lastGamma = gamma
      lastLambda = lambda
    }
    expect(relaxationFor(20_000, 15_000, 0)).toEqual({ gamma: 0, lambda: 0 })
  })

  it('prices relaxation in the same units as a benchmark', () => {
    // `relaxationInfidelity` is the formula the subtraction below rests on. It
    // is checked against the infidelity the two channels *actually* produce,
    // measured from their Bloch transfer — so a wrong constant in it cannot
    // hide behind the same wrong constant in `channelsForGate`.
    for (const [gamma, lambda] of [
      [0, 0],
      [1e-4, 1e-4],
      [0.0025, 0.0042],
      [0.02, 0.033],
      [0.2, 0.3],
      [1, 1],
    ] as const) {
      const measured = infidelityOfTransfer(
        blochTransfer([
          amplitudeDampingChannel(gamma),
          phaseDampingChannel(lambda),
        ])
      )
      expect(
        relaxationInfidelity(gamma, lambda),
        `γ=${gamma} λ=${lambda}`
      ).toBeCloseTo(measured, DIGITS)
    }
    expect(relaxationInfidelity(0, 0)).toBe(0)
  })

  it('converts a benchmarked error rate at r = (d−1)/d · p', () => {
    expect(depolarizingFromGateError(0)).toBe(0)
    expect(depolarizingFromGateError(1e-3)).toBeCloseTo(2e-3, 15)
    expect(depolarizingFromGateError(0.5)).toBeCloseTo(1, 15)
    // And the depolarising channel it names really does have that infidelity.
    for (const r of [1e-4, 1e-3, 0.01, 0.1]) {
      const p = depolarizingFromGateError(r)
      const measured = infidelityOfTransfer(
        blochTransfer([depolarizingChannel(p)])
      )
      expect(measured, `r=${r}`).toBeCloseTo(r, DIGITS)
    }
  })

  it('inverts the two-qubit local-depolarising formula', () => {
    // Forward, written out here from the Pauli transfer matrix of D_p ⊗ D_p:
    // F_pro = ((1 + 3u)/4)² with u = 1 − p, and r = (4/5)(1 − F_pro).
    const forward = (p: number): number => {
      const u = 1 - p
      const processFidelity = ((1 + 3 * u) / 4) ** 2
      return (4 / 5) * (1 - processFidelity)
    }
    for (const r of [0, 1e-4, 3e-3, 8e-3, 0.05, 0.2, 0.5]) {
      const p = localDepolarizingFromPairError(r)
      expect(forward(p), `r=${r}`).toBeCloseTo(r, DIGITS)
      // 5r/6 to first order — the reading in the docstring.
      if (r > 0 && r <= 0.01) expect(p / r).toBeCloseTo(5 / 6, 2)
    }
    expect(() => localDepolarizingFromPairError(0.9)).toThrow(NoiseProfileError)
  })

  it('reproduces each profile’s benchmarked gate error, without double counting', () => {
    // THE END-TO-END CHECK ON THE WHOLE DERIVATION. Run the channels the
    // profile produces, measure the Bloch transfer they actually cause,
    // convert it back to an average gate infidelity with the formula written
    // independently above, and require the profile's own number back.
    //
    // If the relaxation were not subtracted from the benchmarked rate, this
    // would come out roughly double for the teaching profile's two-qubit gate,
    // where relaxation is the dominant term.
    for (const id of ['superconducting', 'trappedIon', 'teaching'] as const) {
      const profile = NOISE_PROFILES[id]

      const oneQubit = infidelityOfTransfer(
        blochTransfer(channelsForGate(profile, 1))
      )
      expect(
        oneQubit / profile.oneQubitGateError,
        `${id} one-qubit gate error`
      ).toBeCloseTo(1, 1)

      // The two-qubit case runs the same measurement per qubit and then goes
      // back through the D_p ⊗ D_p relation, because that is the model the
      // conversion assumed — an approximation, held to a few percent rather
      // than to D6's tolerance, and deliberately not to more.
      const perQubit = infidelityOfTransfer(
        blochTransfer(channelsForGate(profile, 2))
      )
      const u = 1 - 2 * perQubit
      const pair = (4 / 5) * (1 - ((1 + 3 * u) / 4) ** 2)
      expect(
        pair / profile.twoQubitGateError,
        `${id} two-qubit gate error`
      ).toBeCloseTo(1, 1)
    }
  })

  it('produces no channels at all for the ideal profile', () => {
    // The property `channelsForGate` drops zero-parameter channels on the
    // strength of: with nothing to apply, the noisy path is the unitary path.
    expect(channelsForGate(NOISE_PROFILES.ideal, 1)).toEqual([])
    expect(channelsForGate(NOISE_PROFILES.ideal, 2)).toEqual([])
    expect(channelsForIdle(NOISE_PROFILES.ideal, 1e6)).toEqual([])
    expect(readoutErrorsFor(NOISE_PROFILES.ideal, 3)).toEqual([
      { qubit: 0, p0to1: 0, p1to0: 0 },
      { qubit: 1, p0to1: 0, p1to0: 0 },
      { qubit: 2, p0to1: 0, p1to0: 0 },
    ])
    const ideal = probabilities(randomPure(3, createRng(61)))
    expect([
      ...applyReadoutError(ideal, readoutErrorsFor(NOISE_PROFILES.ideal, 3)),
    ]).toEqual([...ideal])
  })

  it('emits trace-preserving channels for every profile and arity', () => {
    for (const id of NOISE_PROFILE_IDS) {
      for (const arity of [1, 2] as const) {
        for (const channel of channelsForGate(NOISE_PROFILES[id], arity)) {
          expect(channel.parameter).toBeGreaterThan(0)
          expect(channel.parameter).toBeLessThanOrEqual(1)
          expect(krausDefect(channel), `${id}/${arity}`).toBeLessThan(TOLERANCE)
        }
      }
    }
  })

  it('makes the two-qubit gate the worse one, on every real profile', () => {
    // Not decoration: it is the relationship every device report shows, and a
    // conversion that inverted an arity would still produce valid channels.
    for (const id of ['superconducting', 'trappedIon', 'teaching'] as const) {
      const profile = NOISE_PROFILES[id]
      const one = infidelityOfTransfer(
        blochTransfer(channelsForGate(profile, 1))
      )
      const two = infidelityOfTransfer(
        blochTransfer(channelsForGate(profile, 2))
      )
      expect(two, id).toBeGreaterThan(one)
    }
  })

  it('leaves an idle qubit only its relaxation', () => {
    const idle = channelsForIdle(NOISE_PROFILES.teaching, 400)
    expect(idle.map((c) => c.kind)).toEqual([
      'amplitudeDamping',
      'phaseDamping',
    ])
    const { gamma, lambda } = relaxationFor(20_000, 15_000, 400)
    expect(idle[0].parameter).toBe(gamma)
    expect(idle[1].parameter).toBe(lambda)
  })

  it('accumulates visibly over a teaching-scale circuit', () => {
    // §3.3 is a study mode, so its loudest profile has to produce something a
    // reader can see inside a lesson: a Bell pair that has measurably stopped
    // being one after a dozen gates, while staying a valid state throughout.
    const rho = bellPair()
    const channels = channelsForGate(NOISE_PROFILES.teaching, 2)
    for (let round = 0; round < 6; round++) {
      applyChannels(rho, channels, 0)
      applyChannels(rho, channels, 1)
      expectValidDensity(rho, `teaching round ${round}`)
    }
    const zz = pauliExpectation(rho, 'ZZ')
    expect(zz).toBeLessThan(0.9)
    expect(zz).toBeGreaterThan(0.3)
    expect(purity(rho)).toBeLessThan(0.9)
  })
})

/* ═══════════════════════ 7. kernel guards ══════════════════════════════ */

describe('applyChannel guards', () => {
  it('refuses a target outside the register', () => {
    const rho = alloc(2)
    const channel = depolarizingChannel(0.1)
    expect(() => applyChannel(rho, channel, -1)).toThrow(RangeError)
    expect(() => applyChannel(rho, channel, 2)).toThrow(RangeError)
    expect(() => applyChannel(rho, channel, 1.5)).toThrow(RangeError)
  })

  it('applies a list in the order it is given', () => {
    // Amplitude damping and a bit flip do not commute, so the list order is a
    // real choice and `applyChannels` must not reorder it.
    const forward = randomMixed(1, createRng(67))
    const backward = copy(forward)
    applyChannels(
      forward,
      [amplitudeDampingChannel(0.4), bitFlipChannel(0.3)],
      0
    )
    applyChannels(
      backward,
      [bitFlipChannel(0.3), amplitudeDampingChannel(0.4)],
      0
    )
    expect(maxDeviation(forward, backward)).toBeGreaterThan(0.01)
  })

  it('touches only the target qubit', () => {
    // A channel on qubit t must leave every other qubit's reduced state alone,
    // because it is trace preserving and acts as the identity elsewhere. A
    // kernel pairing the wrong bit on one of the two sides would break this
    // while keeping ρ a perfectly valid state.
    const rng = createRng(71)
    for (const kind of NOISE_CHANNEL_KINDS) {
      const rho = randomMixed(3, rng)
      const before = [0, 1, 2].map((q) => reducedOf(rho, q))
      applyChannel(rho, channelFor(kind, 0.37), 1)
      const after = [0, 1, 2].map((q) => reducedOf(rho, q))
      for (const q of [0, 2]) {
        expect(after[q].rho00, `${kind}: q${q} ρ₀₀`).toBeCloseTo(
          before[q].rho00,
          DIGITS
        )
        expect(after[q].re01, `${kind}: q${q} Re ρ₀₁`).toBeCloseTo(
          before[q].re01,
          DIGITS
        )
        expect(after[q].im01, `${kind}: q${q} Im ρ₀₁`).toBeCloseTo(
          before[q].im01,
          DIGITS
        )
      }
      // ...and did something to the one it was aimed at.
      expect(
        Math.abs(after[1].re01 - before[1].re01) +
          Math.abs(after[1].rho11 - before[1].rho11),
        `${kind} changed nothing at all`
      ).toBeGreaterThan(1e-6)
    }
  })

  it('costs O(4ⁿ) and allocates nothing per entry', () => {
    // A register where the copy-and-accumulate implementation would be
    // conspicuous: 4⁸ entries is 1 MB per matrix, and the rejected design
    // needs three of them. This asserts the result, not the memory — but it
    // runs the kernel at a size where an accidental O(8ⁿ) would not finish.
    const rho = alloc(8)
    fillWithSpreadState(rho)
    for (let q = 0; q < 8; q++) {
      applyChannel(rho, depolarizingChannel(0.02), q)
    }
    expect(trace(rho)).toBeCloseTo(1, DIGITS)
    expect(hermiticityDefect(rho)).toBeLessThan(TOLERANCE)
  })
})

/* ─────────────────────── small local helpers ────────────────────────────── */

/**
 * ρ → UρU† for a 2×2 on `target`, written here instead of imported.
 *
 * `density.apply1q` would do it, and using it would make the p = 1 flip test
 * an assertion that two functions in the same package agree. This one is the
 * definition: build the full operator for one qubit and multiply, slowly.
 */
function densityApply1qLocal(
  rho: DensityMatrix,
  matrix: Float64Array,
  target: number
): void {
  const { dim } = rho
  const outRe = new Float64Array(rho.size)
  const outIm = new Float64Array(rho.size)
  const at = (row: number, column: number): number => row * dim + column
  const u = (row: number, column: number): readonly [number, number] => {
    // U = I ⊗ … ⊗ matrix ⊗ … ⊗ I, evaluated entry by entry: the other bits
    // must agree, and the target's bits index the 2×2.
    if ((row & ~(1 << target)) !== (column & ~(1 << target))) return [0, 0]
    const r = (row >> target) & 1
    const c = (column >> target) & 1
    const base = (2 * r + c) * 2
    return [matrix[base], matrix[base + 1]]
  }
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      let sumRe = 0
      let sumIm = 0
      for (let a = 0; a < dim; a++) {
        const [ur, ui] = u(row, a)
        if (ur === 0 && ui === 0) continue
        for (let b = 0; b < dim; b++) {
          const [vr, vi] = u(column, b)
          if (vr === 0 && vi === 0) continue
          // U_ra · ρ_ab · conj(U_cb)
          const pr = rho.re[at(a, b)]
          const pi = rho.im[at(a, b)]
          const t1r = ur * pr - ui * pi
          const t1i = ur * pi + ui * pr
          sumRe += t1r * vr + t1i * vi
          sumIm += t1i * vr - t1r * vi
        }
      }
      outRe[at(row, column)] = sumRe
      outIm[at(row, column)] = sumIm
    }
  }
  rho.re.set(outRe)
  rho.im.set(outIm)
}

/** Put a large ρ into a state with no zero entries, cheaply. */
function fillWithSpreadState(rho: DensityMatrix): void {
  const state = allocState(rho.qubits)
  for (let q = 0; q < rho.qubits; q++) apply1q(state, GATE_MATRICES.h, q)
  for (let q = 0; q + 1 < rho.qubits; q++) {
    applyControlled(state, GATE_MATRICES.t, q, [{ qubit: q + 1, state: 1 }])
  }
  const built = fromStatevector(state)
  rho.re.set(built.re)
  rho.im.set(built.im)
}
