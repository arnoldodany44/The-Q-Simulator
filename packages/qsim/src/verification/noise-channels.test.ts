/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — NOISE CHANNELS AND READOUT ERROR.
 *
 * Nothing here is derived from `noise.ts`. The oracle in this file does what
 * the module refuses to do on memory grounds and what §5.2 forbids for gates:
 * it builds the full 2ⁿ × 2ⁿ Kraus operator for each term by an explicit
 * Kronecker product, then evaluates Σₖ Aₖ ρ Aₖ† with textbook triple-loop
 * matrix products over nested arrays of `{ re, im }`. It shares no stride, no
 * 2×2 corner, no flat layout and no accumulator with the implementation, which
 * is what lets it disagree. Its Kraus operators are written out from the
 * textbook here rather than read from `noise.ts`, so a wrong coefficient in the
 * module cannot cancel against a wrong coefficient in the check.
 *
 * The eight things this file is looking for:
 *
 *  1. **A 2×2-corner kernel that pairs the wrong index.** The corner argument
 *     says the channel acts inside blocks of ρ selected by one bit of the row
 *     index and the same bit of the column index. Filtering the same index
 *     twice, or transposing the block, leaves ρ Hermitian, unit-trace and
 *     positive; only the full Kronecker comparison sees it.
 *
 *  2. **A channel on the wrong qubit.** D1 is baked into the oracle's
 *     Kronecker order — `I ⊗ K ⊗ I` with the target's factor placed by the
 *     bit position, not by a left-to-right reading — so a target/endianness
 *     slip shows up as a mismatched entry rather than as a plausible answer.
 *
 *  3. **A dagger with a sign the wrong way round.** The four subtractions in
 *     the kernel's `out += T·K†` lines are the whole dagger. The oracle takes
 *     its adjoint with a function that conjugates *and* transposes in two
 *     visibly separate steps.
 *
 *  4. **A map that is trace preserving but not completely positive.** Σ K†K =
 *     I is necessary and not sufficient: the transpose map satisfies it and is
 *     not a physical channel. The Choi matrix of every channel is built by
 *     running the implementation on the matrix units |i⟩⟨j| and required to be
 *     positive — and the transpose map's Choi matrix is built by hand and
 *     required to fail, so the check is known to have teeth.
 *
 *  5. **A kernel that depends on the Kraus representation rather than on the
 *     channel.** A Kraus set is not unique: mixing the operators by any
 *     unitary describes the same physical map. The two-operator channels are
 *     re-expressed through a random unitary mixing and required to produce the
 *     identical ρ.
 *
 *  6. **A block kernel that disagrees with the naive one.** The rejected
 *     copy-accumulate implementation — the one that would need two extra
 *     density matrices — is written out here and required to agree, so the
 *     memory optimisation is held to being an optimisation.
 *
 *  7. **A relaxation conversion that is not Markovian.** T1 and T2 decay
 *     exponentially, which is exactly the statement that the channel for a
 *     duration is a one-parameter semigroup: E(t₁)∘E(t₂) = E(t₁+t₂). A
 *     conversion that used, say, γ = t/T₁ would satisfy every other test in
 *     the suite and fail this one.
 *
 *  8. **A readout map applied along the wrong axis.** The full 2ⁿ × 2ⁿ
 *     confusion matrix is built here by Kronecker product and multiplied out,
 *     against an implementation that never builds a matrix at all.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { applyControlled, apply1q } from '../apply.js'
import {
  alloc,
  apply1q as densityApply1q,
  fromStatevector,
  hermiticityDefect,
  isPositiveSemidefinite,
  trace,
} from '../density.js'
import type { DensityMatrix } from '../density.js'
import { GATE_MATRICES } from '../gates.js'
import {
  NOISE_CHANNEL_KINDS,
  NOISE_PROFILES,
  applyChannel,
  applyChannels,
  applyReadoutError,
  channelFor,
  relaxationFor,
} from '../noise.js'
import type { KrausChannel, NoiseChannelKind, ReadoutError } from '../noise.js'
import { alloc as allocState } from '../statevector.js'
import type { Statevector } from '../statevector.js'

/** D6 again: 1e-10, as a bound and as digits for `toBeCloseTo`. */
const TOLERANCE = 1e-10
const DIGITS = 10

/* ─────────────────────── complex arithmetic, by hand ────────────────────── */

interface Cx {
  readonly re: number
  readonly im: number
}

type Mat = readonly (readonly Cx[])[]

const ZERO: Cx = { re: 0, im: 0 }
const ONE: Cx = { re: 1, im: 0 }

const cx = (re: number, im = 0): Cx => ({ re, im })
const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})

function zeros(dim: number): Cx[][] {
  const out: Cx[][] = []
  for (let r = 0; r < dim; r++) out.push(new Array<Cx>(dim).fill(ZERO))
  return out
}

function identity(dim: number): Mat {
  const out = zeros(dim)
  for (let i = 0; i < dim; i++) out[i][i] = ONE
  return out
}

/** A·B, the O(dim³) way. Slow on purpose. */
function product(a: Mat, b: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      let sum = ZERO
      for (let k = 0; k < dim; k++) sum = add(sum, mul(a[r][k], b[k][c]))
      out[r][c] = sum
    }
  }
  return out
}

/** A + B, entry by entry. */
function sum(a: Mat, b: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) out[r][c] = add(a[r][c], b[r][c])
  }
  return out
}

/** A† — conjugate AND transpose, spelled out where both halves are visible. */
function adjoint(a: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) out[r][c] = conj(a[c][r])
  }
  return out
}

/* ─────────────── the Kraus sets, written out from the textbook ──────────── */

/**
 * The one-qubit Kraus operators of each channel, from the definitions and not
 * from `noise.ts`.
 *
 * Deliberately spelled with the coefficients in a different shape where one is
 * available: √(1−3p/4) is written as √((4−3p)/4) here, so a shared rounding
 * path is not what makes the two agree.
 */
function oracleOperators(kind: string, parameter: number): readonly Mat[] {
  const p = parameter
  switch (kind) {
    case 'depolarizing': {
      const a = Math.sqrt((4 - 3 * p) / 4)
      const b = Math.sqrt(p) / 2
      return [
        [
          [cx(a), ZERO],
          [ZERO, cx(a)],
        ],
        [
          [ZERO, cx(b)],
          [cx(b), ZERO],
        ],
        [
          [ZERO, cx(0, -b)],
          [cx(0, b), ZERO],
        ],
        [
          [cx(b), ZERO],
          [ZERO, cx(-b)],
        ],
      ]
    }
    case 'amplitudeDamping':
      return [
        [
          [ONE, ZERO],
          [ZERO, cx(Math.sqrt(1 - p))],
        ],
        [
          [ZERO, cx(Math.sqrt(p))],
          [ZERO, ZERO],
        ],
      ]
    case 'phaseDamping':
      return [
        [
          [ONE, ZERO],
          [ZERO, cx(Math.sqrt(1 - p))],
        ],
        [
          [ZERO, ZERO],
          [ZERO, cx(Math.sqrt(p))],
        ],
      ]
    case 'bitFlip':
      return [
        [
          [cx(Math.sqrt(1 - p)), ZERO],
          [ZERO, cx(Math.sqrt(1 - p))],
        ],
        [
          [ZERO, cx(Math.sqrt(p))],
          [cx(Math.sqrt(p)), ZERO],
        ],
      ]
    case 'phaseFlip':
      return [
        [
          [cx(Math.sqrt(1 - p)), ZERO],
          [ZERO, cx(Math.sqrt(1 - p))],
        ],
        [
          [cx(Math.sqrt(p)), ZERO],
          [ZERO, cx(-Math.sqrt(p))],
        ],
      ]
    default:
      throw new Error(`No oracle for channel "${kind}".`)
  }
}

/**
 * The full 2ⁿ × 2ⁿ operator for a one-qubit `k` acting on `target`.
 *
 * D1, WRITTEN AS AN INDEX CONDITION RATHER THAN AS A KRONECKER ORDER. The
 * operator is I ⊗ … ⊗ k ⊗ … ⊗ I with k in the slot for qubit `target`, and
 * with qubit 0 the least significant bit that reads: entry (row, column) is
 * zero unless every bit *other than* `target` agrees between them, and is the
 * 2×2's entry indexed by the two target bits otherwise. Building it this way
 * rather than by iterated Kronecker products means the file states D1 in the
 * form the rest of the engine uses it, which is the form a mistake would take.
 */
function fullOperator(k: Mat, target: number, qubits: number): Mat {
  const dim = 1 << qubits
  const rest = ~(1 << target)
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      if ((row & rest) !== (column & rest)) continue
      out[row][column] = k[(row >> target) & 1][(column >> target) & 1]
    }
  }
  return out
}

/** Σₖ Aₖ ρ Aₖ†, with nothing factored and nothing skipped. */
function oracleChannel(rho: Mat, operators: readonly Mat[]): Mat {
  const dim = rho.length
  let out: Mat = zeros(dim)
  for (const a of operators) {
    out = sum(out, product(product(a, rho), adjoint(a)))
  }
  return out
}

/* ─────────────────────── converting between the two ─────────────────────── */

function toMat(rho: DensityMatrix): Mat {
  const out = zeros(rho.dim)
  for (let row = 0; row < rho.dim; row++) {
    for (let column = 0; column < rho.dim; column++) {
      const at = row * rho.dim + column
      out[row][column] = cx(rho.re[at], rho.im[at])
    }
  }
  return out
}

function expectMatches(rho: DensityMatrix, expected: Mat, label: string): void {
  let worst = 0
  for (let row = 0; row < rho.dim; row++) {
    for (let column = 0; column < rho.dim; column++) {
      const at = row * rho.dim + column
      worst = Math.max(
        worst,
        Math.abs(rho.re[at] - expected[row][column].re),
        Math.abs(rho.im[at] - expected[row][column].im)
      )
    }
  }
  expect(worst, label).toBeLessThan(TOLERANCE)
}

/* ─────────────────────────────── fixtures ───────────────────────────────── */

/**
 * A normalised random state built without touching the engine, and without
 * `fc.double`'s exponent range destroying the normalisation on the way — the
 * peak pass `density-evolution.test.ts` explains at length.
 */
function stateFrom(qubits: number, parts: readonly number[]): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)

  let peak = 0
  for (let i = 0; i < size; i++) {
    re[i] = parts[2 * i]
    im[i] = parts[2 * i + 1]
    peak = Math.max(peak, Math.abs(re[i]), Math.abs(im[i]))
  }
  if (peak === 0) {
    re[0] = 1
    return { qubits, size, re, im }
  }

  let total = 0
  for (let i = 0; i < size; i++) {
    re[i] /= peak
    im[i] /= peak
    total += re[i] * re[i] + im[i] * im[i]
  }
  const factor = 1 / Math.sqrt(total)
  for (let i = 0; i < size; i++) {
    re[i] *= factor
    im[i] *= factor
  }
  return { qubits, size, re, im }
}

const component = fc.double({
  min: -1,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
})

/** ρ as an even blend of `parts` random pure states — genuinely mixed. */
function mixtureFrom(
  qubits: number,
  blocks: readonly number[][]
): DensityMatrix {
  const rho = alloc(qubits)
  rho.re[0] = 0
  for (const parts of blocks) {
    const piece = fromStatevector(stateFrom(qubits, parts))
    for (let i = 0; i < rho.size; i++) {
      rho.re[i] += piece.re[i] / blocks.length
      rho.im[i] += piece.im[i] / blocks.length
    }
  }
  return rho
}

function copy(rho: DensityMatrix): DensityMatrix {
  return {
    qubits: rho.qubits,
    dim: rho.dim,
    size: rho.size,
    re: rho.re.slice(),
    im: rho.im.slice(),
  }
}

/** The parameters swept against the oracle. Both endpoints included. */
const PARAMETERS = [0, 0.013, 0.25, 0.5, 0.77, 1] as const

/* ═══════════ 1. entry for entry against the Kronecker oracle ═══════════ */

describe('Σ K ρ K† matches the full-matrix definition', () => {
  it.each([...NOISE_CHANNEL_KINDS])(
    '%s: every parameter, every target, on random pure states',
    (kind) => {
      for (const qubits of [1, 2, 3]) {
        fc.assert(
          fc.property(
            fc.array(component, {
              minLength: 2 << qubits,
              maxLength: 2 << qubits,
            }),
            fc.integer({ min: 0, max: qubits - 1 }),
            fc.constantFrom(...PARAMETERS),
            (parts, target, parameter) => {
              const rho = fromStatevector(stateFrom(qubits, parts))
              const expected = oracleChannel(
                toMat(rho),
                oracleOperators(kind, parameter).map((k) =>
                  fullOperator(k, target, qubits)
                )
              )
              applyChannel(rho, channelFor(kind, parameter), target)
              expectMatches(
                rho,
                expected,
                `${kind}(${parameter}) on q${target} of ${qubits}`
              )
            }
          ),
          { numRuns: 40 }
        )
      }
    }
  )

  it.each([...NOISE_CHANNEL_KINDS])(
    '%s: on genuinely mixed states, where no pure-state shortcut applies',
    (kind) => {
      const qubits = 3
      fc.assert(
        fc.property(
          fc.array(fc.array(component, { minLength: 16, maxLength: 16 }), {
            minLength: 3,
            maxLength: 3,
          }),
          fc.integer({ min: 0, max: 2 }),
          fc.constantFrom(...PARAMETERS),
          (blocks, target, parameter) => {
            const rho = mixtureFrom(qubits, blocks)
            const expected = oracleChannel(
              toMat(rho),
              oracleOperators(kind, parameter).map((k) =>
                fullOperator(k, target, qubits)
              )
            )
            applyChannel(rho, channelFor(kind, parameter), target)
            expectMatches(
              rho,
              expected,
              `${kind}(${parameter}) on mixed q${target}`
            )
          }
        ),
        { numRuns: 30 }
      )
    }
  )

  it('places the channel on the qubit D1 names, not its mirror', () => {
    // A three-qubit register with three *different* channels, one per wire.
    // Any transposition of the target index changes at least one entry, and
    // the oracle's index condition is the only place D1 is stated here.
    const qubits = 3
    const rho = mixtureFrom(qubits, [
      Array.from({ length: 16 }, (_, i) => Math.cos(i * 1.7)),
      Array.from({ length: 16 }, (_, i) => Math.sin(i * 2.3)),
    ])
    let expected = toMat(rho)
    const plan: readonly (readonly [NoiseChannelKind, number, number])[] = [
      ['amplitudeDamping', 0.4, 0],
      ['phaseDamping', 0.3, 1],
      ['bitFlip', 0.2, 2],
    ]
    for (const [kind, parameter, target] of plan) {
      expected = oracleChannel(
        expected,
        oracleOperators(kind, parameter).map((k) =>
          fullOperator(k, target, qubits)
        )
      )
      applyChannel(rho, channelFor(kind, parameter), target)
    }
    expectMatches(rho, expected, 'three channels on three wires')
  })

  it('has Σ A†A = I for the full-register operators too', () => {
    // Trace preservation lifted to 2ⁿ: the module checks the 2×2, the oracle
    // checks that the Kronecker lift of that 2×2 is still trace preserving,
    // which is the statement the kernel actually relies on.
    const qubits = 3
    const dim = 1 << qubits
    for (const kind of NOISE_CHANNEL_KINDS) {
      for (const parameter of PARAMETERS) {
        for (let target = 0; target < qubits; target++) {
          let total: Mat = zeros(dim)
          for (const k of oracleOperators(kind, parameter)) {
            const a = fullOperator(k, target, qubits)
            total = sum(total, product(adjoint(a), a))
          }
          const expected = identity(dim)
          for (let r = 0; r < dim; r++) {
            for (let c = 0; c < dim; c++) {
              expect(
                Math.abs(total[r][c].re - expected[r][c].re),
                `${kind}(${parameter}) q${target} (${r},${c}) re`
              ).toBeLessThan(TOLERANCE)
              expect(Math.abs(total[r][c].im)).toBeLessThan(TOLERANCE)
            }
          }
        }
      }
    }
  })
})

/* ═════════ 2. complete positivity, via the Choi matrix ═════════════════ */

/**
 * The Choi matrix of a one-qubit channel, normalised to a two-qubit state:
 * J = ½·Σ_ij |i⟩⟨j| ⊗ E(|i⟩⟨j|).
 *
 * BUILT BY RUNNING THE IMPLEMENTATION, deliberately. The question this
 * answers is not whether the mathematics is completely positive — it is
 * whether the code is. Feeding it the matrix units |i⟩⟨j|, which are not
 * states, is legitimate: the kernel is a linear map on the buffers and this
 * is precisely the probe that separates a completely positive map from a
 * merely positive one.
 *
 * The row index is i·2 + a, so in D1 terms bit 0 is the system and bit 1 is
 * the reference. Which is which does not matter to positivity, and saying so
 * is cheaper than a convention nobody would check.
 */
function choiMatrix(channel: KrausChannel): DensityMatrix {
  const choi = alloc(2)
  choi.re[0] = 0
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const unit = alloc(1)
      unit.re[0] = 0
      unit.re[i * 2 + j] = 1
      applyChannel(unit, channel, 0)
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          const at = (i * 2 + a) * 4 + (j * 2 + b)
          choi.re[at] = unit.re[a * 2 + b] / 2
          choi.im[at] = unit.im[a * 2 + b] / 2
        }
      }
    }
  }
  return choi
}

describe('every channel is completely positive, not merely positive', () => {
  it.each([...NOISE_CHANNEL_KINDS])('%s has a positive Choi matrix', (kind) => {
    for (const parameter of PARAMETERS) {
      const choi = choiMatrix(channelFor(kind, parameter))
      expect(
        hermiticityDefect(choi),
        `${kind}(${parameter}) Choi Hermitian`
      ).toBeLessThan(TOLERANCE)
      // Tr J = 1 after the ½ is exactly the trace-preservation statement.
      expect(trace(choi), `${kind}(${parameter}) Choi trace`).toBeCloseTo(
        1,
        DIGITS
      )
      expect(
        isPositiveSemidefinite(choi),
        `${kind}(${parameter}) Choi positive`
      ).toBe(true)
    }
  })

  it('rejects the transpose map, which is positive and not completely so', () => {
    // THE CONTROL THAT GIVES THE TEST ABOVE ITS TEETH. ρ → ρᵀ maps every
    // density matrix to a density matrix — Hermitian, unit trace, same
    // eigenvalues — and satisfies every check in this suite except this one.
    // Its Choi matrix is the swap operator, whose spectrum is ±1, so a
    // positivity test that answers "true" here answers "true" by luck.
    const choi = alloc(2)
    choi.re[0] = 0
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        // (|i⟩⟨j|)ᵀ has its 1 at (j, i).
        const at = (i * 2 + j) * 4 + (j * 2 + i)
        choi.re[at] = 0.5
      }
    }
    expect(hermiticityDefect(choi)).toBeLessThan(TOLERANCE)
    expect(trace(choi)).toBeCloseTo(1, DIGITS)
    expect(isPositiveSemidefinite(choi)).toBe(false)
  })
})

/* ═══════ 3. the channel, not the representation, is what is applied ════ */

describe('a channel does not depend on which Kraus set spells it', () => {
  it('is invariant under a unitary mixing of its operators', () => {
    // Two Kraus sets describe the same channel exactly when one is a unitary
    // mixture of the other: Lᵢ = Σⱼ uᵢⱼ Kⱼ. If `applyChannel` produced anything
    // representation-dependent — an order effect, an accumulator that is not a
    // plain sum — this is where it would show.
    const theta = 0.7
    const phi = 1.3
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const cosPhi = Math.cos(phi)
    const sinPhi = Math.sin(phi)

    for (const kind of [
      'amplitudeDamping',
      'phaseDamping',
      'bitFlip',
      'phaseFlip',
    ] as const) {
      for (const parameter of [0.13, 0.5, 0.91]) {
        const base = channelFor(kind, parameter)
        const [k0, k1] = base.operators
        // u = [[c, s·e^{iφ}], [−s·e^{−iφ}, c]] — unitary, and complex enough
        // that a dropped conjugate anywhere would break the equality.
        const mixed: KrausChannel = {
          kind: base.kind,
          parameter: base.parameter,
          operators: [
            combine(k0, c, 0, k1, s * cosPhi, s * sinPhi),
            combine(k0, -s * cosPhi, s * sinPhi, k1, c, 0),
          ],
        }
        const viaBase = mixtureFrom(2, [
          Array.from({ length: 8 }, (_, i) => Math.cos(i * 0.9)),
          Array.from({ length: 8 }, (_, i) => Math.sin(i * 1.4)),
        ])
        const viaMixed = copy(viaBase)
        applyChannel(viaBase, base, 1)
        applyChannel(viaMixed, mixed, 1)
        let worst = 0
        for (let i = 0; i < viaBase.size; i++) {
          worst = Math.max(
            worst,
            Math.abs(viaBase.re[i] - viaMixed.re[i]),
            Math.abs(viaBase.im[i] - viaMixed.im[i])
          )
        }
        expect(worst, `${kind}(${parameter}) under mixing`).toBeLessThan(
          TOLERANCE
        )
      }
    }
  })
})

/** αA + βB for two 2×2s in the flat layout, with complex α and β. */
function combine(
  a: Float64Array,
  ar: number,
  ai: number,
  b: Float64Array,
  br: number,
  bi: number
): Float64Array {
  const out = new Float64Array(8)
  for (let i = 0; i < 8; i += 2) {
    out[i] = ar * a[i] - ai * a[i + 1] + (br * b[i] - bi * b[i + 1])
    out[i + 1] = ar * a[i + 1] + ai * a[i] + (br * b[i + 1] + bi * b[i])
  }
  return out
}

/* ═════════ 4. the block kernel against the rejected naive one ══════════ */

/**
 * Σₖ Kₖ ρ Kₖ† the way `noise.ts` explains it will *not* do it: copy ρ, run the
 * copy through ρ → MρM† for each operator, accumulate.
 *
 * This is the implementation the module rejects for needing two more density
 * matrices — 768 MB at twelve qubits against a 256 MB budget. It is written
 * here because rejecting it on memory grounds is only legitimate if it gives
 * the same answer, and because it goes through `density.apply1q`, which is a
 * completely different loop from the 2×2-corner kernel: two passes over the
 * whole matrix with the row and column walks separated, against one pass with
 * them nested.
 */
function applyChannelNaively(
  rho: DensityMatrix,
  channel: KrausChannel,
  target: number
): void {
  const original = copy(rho)
  const accumulatorRe = new Float64Array(rho.size)
  const accumulatorIm = new Float64Array(rho.size)
  for (const k of channel.operators) {
    const work = copy(original)
    densityApply1q(work, k, target)
    for (let i = 0; i < rho.size; i++) {
      accumulatorRe[i] += work.re[i]
      accumulatorIm[i] += work.im[i]
    }
  }
  rho.re.set(accumulatorRe)
  rho.im.set(accumulatorIm)
}

describe('the corner kernel and the copy-accumulate kernel agree', () => {
  it.each([...NOISE_CHANNEL_KINDS])(
    '%s, on every target of a 4-qubit ρ',
    (kind) => {
      const qubits = 4
      const blocks = [
        Array.from({ length: 32 }, (_, i) => Math.cos(i * 0.61)),
        Array.from({ length: 32 }, (_, i) => Math.sin(i * 1.13)),
        Array.from({ length: 32 }, (_, i) => Math.cos(i * 2.07 + 0.4)),
      ]
      for (const parameter of PARAMETERS) {
        for (let target = 0; target < qubits; target++) {
          const fast = mixtureFrom(qubits, blocks)
          const slow = copy(fast)
          const channel = channelFor(kind, parameter)
          applyChannel(fast, channel, target)
          applyChannelNaively(slow, channel, target)
          let worst = 0
          for (let i = 0; i < fast.size; i++) {
            worst = Math.max(
              worst,
              Math.abs(fast.re[i] - slow.re[i]),
              Math.abs(fast.im[i] - slow.im[i])
            )
          }
          expect(worst, `${kind}(${parameter}) on q${target}`).toBeLessThan(
            TOLERANCE
          )
        }
      }
    }
  )
})

/* ═══════ 5. relaxation is a semigroup, which is what T1 and T2 mean ════ */

describe('relaxation composes over time the way an exponential does', () => {
  it('satisfies E(t₁)∘E(t₂) = E(t₁+t₂)', () => {
    // MARKOVIANITY, AS AN ASSERTION. "T1 = 100 µs" only means anything if the
    // decay is exponential, and exponential decay is exactly the statement
    // that the channel for a duration is a one-parameter semigroup. A
    // conversion using γ = t/T₁ — plausible, linear, and wrong — reproduces
    // the right answer for small t and fails this at every scale.
    const cases: readonly (readonly [number, number])[] = [
      [100_000, 120_000],
      [20_000, 15_000],
      [1e10, 1e9],
      [1000, 2000], // T2 = 2·T1: no pure dephasing, still a semigroup
    ]
    const steps: readonly (readonly [number, number])[] = [
      [10, 30],
      [500, 500],
      [7000, 1],
    ]
    for (const [t1, t2] of cases) {
      for (const [a, b] of steps) {
        const stepA = relaxationFor(t1, t2, a)
        const stepB = relaxationFor(t1, t2, b)
        const together = relaxationFor(t1, t2, a + b)

        const staged = mixtureFrom(1, [
          [0.6, 0.2, -0.5, 0.7],
          [0.1, -0.9, 0.3, 0.2],
        ])
        const direct = copy(staged)
        applyChannels(
          staged,
          [
            channelFor('amplitudeDamping', stepA.gamma),
            channelFor('phaseDamping', stepA.lambda),
            channelFor('amplitudeDamping', stepB.gamma),
            channelFor('phaseDamping', stepB.lambda),
          ],
          0
        )
        applyChannels(
          direct,
          [
            channelFor('amplitudeDamping', together.gamma),
            channelFor('phaseDamping', together.lambda),
          ],
          0
        )
        let worst = 0
        for (let i = 0; i < staged.size; i++) {
          worst = Math.max(
            worst,
            Math.abs(staged.re[i] - direct.re[i]),
            Math.abs(staged.im[i] - direct.im[i])
          )
        }
        expect(worst, `T1=${t1} T2=${t2}, ${a}+${b} ns`).toBeLessThan(TOLERANCE)
      }
    }
  })

  it('is not the linear conversion that would also fit small durations', () => {
    // The negative half: γ = t/T₁ agrees with 1 − e^{−t/T₁} to first order, so
    // a suite that only ever tested short gates would not notice. At one
    // lifetime the two differ by 37 %.
    const { gamma } = relaxationFor(1000, 2000, 1000)
    expect(gamma).toBeCloseTo(1 - Math.exp(-1), DIGITS)
    expect(Math.abs(gamma - 1)).toBeGreaterThan(0.3)
  })

  it('never lets a profile’s derived channels leave the physical range', () => {
    for (const id of ['superconducting', 'trappedIon', 'teaching'] as const) {
      const profile = NOISE_PROFILES[id]
      for (const duration of [0, 1, profile.twoQubitGateNs, 1e12]) {
        const { gamma, lambda } = relaxationFor(
          profile.t1Ns,
          profile.t2Ns,
          duration
        )
        expect(gamma, `${id} γ at ${duration} ns`).toBeGreaterThanOrEqual(0)
        expect(gamma).toBeLessThanOrEqual(1)
        expect(lambda, `${id} λ at ${duration} ns`).toBeGreaterThanOrEqual(0)
        expect(lambda).toBeLessThanOrEqual(1)
      }
    }
  })
})

/* ═══════════ 6. readout error against a full confusion matrix ══════════ */

/**
 * The whole 2ⁿ × 2ⁿ confusion matrix, built by Kronecker product.
 *
 * M[observed][actual] = Πq C_q[observed bit q][actual bit q], the definition of
 * independent per-qubit classifiers. The implementation never builds this — it
 * is n passes of index pairing — so multiplying it out is a genuinely separate
 * computation, and at four qubits it is 256 entries and affordable.
 */
function confusionMatrix(
  errors: readonly ReadoutError[],
  qubits: number
): Float64Array {
  const dim = 1 << qubits
  const out = new Float64Array(dim * dim)
  const byQubit = new Map(errors.map((e) => [e.qubit, e]))
  for (let observed = 0; observed < dim; observed++) {
    for (let actual = 0; actual < dim; actual++) {
      let probability = 1
      for (let q = 0; q < qubits; q++) {
        const error = byQubit.get(q)
        const from = (actual >> q) & 1
        const to = (observed >> q) & 1
        if (error === undefined) {
          probability *= from === to ? 1 : 0
          continue
        }
        const flip = from === 0 ? error.p0to1 : error.p1to0
        probability *= from === to ? 1 - flip : flip
      }
      out[observed * dim + actual] = probability
    }
  }
  return out
}

describe('readout error is the tensor confusion matrix and nothing else', () => {
  it('matches the full matrix product, on random distributions', () => {
    const qubits = 4
    const dim = 1 << qubits
    const errors: readonly ReadoutError[] = [
      { qubit: 0, p0to1: 0.031, p1to0: 0.17 },
      { qubit: 1, p0to1: 0.2, p1to0: 0.004 },
      { qubit: 3, p0to1: 0.5, p1to0: 0.25 },
    ]
    const matrix = confusionMatrix(errors, qubits)

    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: dim,
          maxLength: dim,
        }),
        (weights) => {
          let total = 0
          for (const w of weights) total += w
          if (total === 0) return
          const ideal = new Float64Array(dim)
          for (let i = 0; i < dim; i++) ideal[i] = weights[i] / total

          const expected = new Float64Array(dim)
          for (let observed = 0; observed < dim; observed++) {
            let acc = 0
            for (let actual = 0; actual < dim; actual++) {
              acc += matrix[observed * dim + actual] * ideal[actual]
            }
            expected[observed] = acc
          }

          const actual = applyReadoutError(ideal, errors)
          for (let i = 0; i < dim; i++) {
            expect(actual[i], `outcome ${i}`).toBeCloseTo(expected[i], DIGITS)
          }
        }
      ),
      { numRuns: 60 }
    )
  })

  it('has columns that sum to one — the classical conservation law', () => {
    const qubits = 3
    const dim = 1 << qubits
    const errors: readonly ReadoutError[] = [
      { qubit: 0, p0to1: 0.09, p1to0: 0.4 },
      { qubit: 1, p0to1: 0.6, p1to0: 0.01 },
      { qubit: 2, p0to1: 0, p1to0: 1 },
    ]
    const matrix = confusionMatrix(errors, qubits)
    for (let actual = 0; actual < dim; actual++) {
      let column = 0
      for (let observed = 0; observed < dim; observed++) {
        column += matrix[observed * dim + actual]
      }
      expect(column, `column ${actual}`).toBeCloseTo(1, DIGITS)
    }
  })

  it('leaves ρ alone — it is never given ρ at all', () => {
    // The type signature is the argument, and this is the assertion that says
    // so: the noisy histogram is produced from a distribution, so a subsequent
    // gate sees the state the hardware really had. A Kraus model of readout
    // could not make this promise.
    const state = allocState(2)
    apply1q(state, GATE_MATRICES.h, 0)
    applyControlled(state, GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }])
    const rho = fromStatevector(state)
    const snapshot = copy(rho)

    const ideal = new Float64Array(rho.dim)
    for (let i = 0; i < rho.dim; i++) ideal[i] = rho.re[i * rho.dim + i]
    const observed = applyReadoutError(ideal, [
      { qubit: 0, p0to1: 0.05, p1to0: 0.2 },
      { qubit: 1, p0to1: 0.05, p1to0: 0.2 },
    ])

    for (let i = 0; i < rho.size; i++) {
      expect(rho.re[i]).toBe(snapshot.re[i])
      expect(rho.im[i]).toBe(snapshot.im[i])
    }
    // And the histogram did move — a Bell pair reads |01⟩ and |10⟩ on hardware.
    expect(observed[1]).toBeGreaterThan(0.01)
    expect(observed[2]).toBeGreaterThan(0.01)
  })
})
