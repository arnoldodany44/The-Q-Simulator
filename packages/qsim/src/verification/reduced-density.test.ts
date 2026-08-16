/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — REDUCED DENSITY LENS.
 *
 * Nothing here is derived from `metrics.ts` or from its own test file. The
 * oracle in this file is a deliberately slow partial trace written from the
 * definition: it enumerates the 2ⁿ⁻¹ configurations of "the rest", weaves the
 * traced qubit's bit back into each of them by explicit shifting, and sums
 * ψ_a·conj(ψ_b) into a full 2×2 complex matrix — including the ρ₁₀ entry the
 * module never stores. It shares no loop, no stride and no accumulator with
 * the implementation, which is what lets it disagree.
 *
 * The five things this file is looking for:
 *
 *   1. **A conjugate on the wrong factor.** ρ₀₁ = Σ ψ₀·conj(ψ₁); taking
 *      conj(ψ₀)·ψ₁ instead flips the sign of y and of nothing else, so every
 *      histogram, every probability and every |r| stays correct while half
 *      the sphere is mirrored. The oracle computes y as §5.5 writes it,
 *      `2·Im(ρ₁₀)`, from an entry the module computes no version of.
 *
 *   2. **The pairing on the wrong bit.** A stride mix-up answers with another
 *      qubit's vector — right shape, wrong wire, invisible on any state that
 *      is symmetric across the register.
 *
 *   3. **A ρ that is not a density matrix.** Trace 1, a real non-negative
 *      diagonal, and Hermitian. Positive semidefiniteness is the same
 *      statement as |r| ≤ 1: the eigenvalues of ½(I + r·σ) are (1 ± |r|)/2,
 *      so a vector longer than the sphere is a negative probability.
 *
 *   4. **A purity that is not the length in disguise.** Tr(ρ²) is computed
 *      here by multiplying the oracle's matrix by itself, entry by entry,
 *      and is required to equal both the module's `purity` and (1 + |r|²)/2.
 *
 *   5. **"Unentangled" asserted rather than measured.** For two qubits the
 *      concurrence C = 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀| is a function of the amplitudes
 *      alone, with no partial trace anywhere in it, and |r|² = 1 − C². So the
 *      claim "purity is 1 exactly when the qubit is unentangled" is checked
 *      against an independent measure of entanglement rather than against a
 *      threshold this file chose.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { blochVector, purity, reducedDensity, trace } from '../metrics.js'
import type { Statevector } from '../statevector.js'

/** D6 again: 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10

interface Cx {
  readonly re: number
  readonly im: number
}

const ZERO: Cx = { re: 0, im: 0 }
const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
const sub = (a: Cx, b: Cx): Cx => ({ re: a.re - b.re, im: a.im - b.im })
const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
const abs = (a: Cx): number => Math.hypot(a.re, a.im)

/** A 2×2 complex matrix as nested arrays. Slow on purpose. */
type Matrix = readonly (readonly Cx[])[]

/**
 * The statevector index that has `bit` on `qubit` and `rest` on every other
 * wire, with the other wires' bits kept in their own order.
 *
 * Written as an explicit split and re-shift rather than as an offset from a
 * stride, which is the whole point: the implementation never forms this
 * number, so an error in its pairing cannot be an error in this one.
 */
function weave(rest: number, bit: number, qubit: number): number {
  const low = rest & ((1 << qubit) - 1)
  const high = rest >>> qubit
  return low | (bit << qubit) | (high << (qubit + 1))
}

function amplitudeAt(state: Statevector, index: number): Cx {
  return { re: state.re[index], im: state.im[index] }
}

/** ρ_q, all four entries, straight from the definition of a partial trace. */
function oracleReduced(state: Statevector, qubit: number): Matrix {
  const configurations = 1 << (state.qubits - 1)
  const rho: Cx[][] = [
    [ZERO, ZERO],
    [ZERO, ZERO],
  ]

  for (let rest = 0; rest < configurations; rest++) {
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const psiA = amplitudeAt(state, weave(rest, a, qubit))
        const psiB = amplitudeAt(state, weave(rest, b, qubit))
        rho[a][b] = add(rho[a][b], mul(psiA, conj(psiB)))
      }
    }
  }
  return rho
}

/** §5.5 verbatim, including the ρ₁₀ form of y. */
function oracleBloch(rho: Matrix): readonly [number, number, number] {
  return [2 * rho[0][1].re, 2 * rho[1][0].im, rho[0][0].re - rho[1][1].re]
}

/** Tr(ρ²), by multiplying the matrix out. */
function oraclePurity(rho: Matrix): number {
  let out = ZERO
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < 2; k++) {
      out = add(out, mul(rho[i][k], rho[k][i]))
    }
  }
  return out.re
}

/**
 * A normalised random state, built without touching the engine.
 *
 * `alloc` and `renormalize` are deliberately not used: this file's job is to
 * disagree with that package, so it brings its own state.
 *
 * THE PEAK PASS IS NOT DEFENSIVE PROGRAMMING, it is the difference between a
 * fixture that is normalised and one that is not. `fc.double` samples the
 * whole exponent range of the interval it is given, so a perfectly ordinary
 * draw is of order 1e-161 — and the *square* of 1e-161 is 1e-322, which is
 * subnormal, where a Float64 keeps a couple of significant bits rather than
 * fifty-three. A sum of squares built from those is wrong by percent, and the
 * state it normalises comes out with a norm of 1.04; every property here then
 * fails against a fixture that was never physical, which reads exactly like
 * the engine being wrong. Dividing by the largest component first puts the
 * biggest square at 1, where the sum is exact to the last bit, and costs one
 * extra pass over a state of at most sixteen amplitudes.
 *
 * `Math.hypot` is not a way out of this, which is worth writing down because
 * it is exactly the function one reaches for. It scales internally and so
 * survives 1e-161 — but at the very bottom of the range it has nowhere to put
 * the answer: `Math.hypot(0, 5e-324, 0, -5e-324)` is √2 × the smallest
 * subnormal there is, and the nearest representable values are that subnormal
 * and twice it. It returns the former, dividing by it yields components of ±1,
 * and the "normalised" state has a norm of √2. Scaling by the peak first sends
 * the same draw to (0, 1, 0, −1) *before* anything is squared, and the norm
 * comes out exact.
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
  // A draw of all zeros has no normalisation; make it |0…0⟩ rather than
  // divide by zero and assert things about NaN.
  if (peak === 0) {
    re[0] = 1
    return { qubits, size, re, im }
  }

  let sum = 0
  for (let i = 0; i < size; i++) {
    re[i] /= peak
    im[i] /= peak
    sum += re[i] * re[i] + im[i] * im[i]
  }
  const scale = 1 / Math.sqrt(sum)
  for (let i = 0; i < size; i++) {
    re[i] *= scale
    im[i] *= scale
  }
  return { qubits, size, re, im }
}

const component = fc.double({
  min: -1,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
})

/**
 * Runs `check` over random states of `qubits` wires, and a random wire of
 * each.
 *
 * THE FIXTURE IS BUILT INSIDE THE PROPERTY, never in a `.map()` on the
 * arbitrary, and that is not a matter of taste. What a failing property
 * prints is the value fast-check drew; behind a `.map()` that value is a pair
 * of `Float64Array`s whose relationship to the draw is a function the report
 * does not contain, so reproducing a failure by hand means guessing. Drawing
 * plain numbers and building the state here makes the counterexample
 * literally the argument list of `stateFrom` — paste it into a test and the
 * failure is back. It also leaves the shrinker working on the numbers, which
 * is where the edges that matter are (0, ±1, subnormals) rather than on a
 * structure it cannot take apart.
 */
function forRandomStates(
  qubits: number,
  runs: number,
  check: (state: Statevector, qubit: number) => void
): void {
  fc.assert(
    fc.property(
      fc.array(component, {
        minLength: 2 << qubits,
        maxLength: 2 << qubits,
      }),
      fc.integer({ min: 0, max: qubits - 1 }),
      (parts, qubit) => {
        check(stateFrom(qubits, parts), qubit)
      }
    ),
    { numRuns: runs }
  )
}

describe('the partial trace agrees with the definition', () => {
  it('matches the oracle entry for entry, on 1 to 4 qubits', () => {
    for (const qubits of [1, 2, 3, 4]) {
      forRandomStates(qubits, 60, (state, qubit) => {
        const rho = oracleReduced(state, qubit)
        const density = reducedDensity(state, qubit)

        expect(density.rho00).toBeCloseTo(rho[0][0].re, DIGITS)
        expect(density.rho11).toBeCloseTo(rho[1][1].re, DIGITS)
        expect(density.re01).toBeCloseTo(rho[0][1].re, DIGITS)
        expect(density.im01).toBeCloseTo(rho[0][1].im, DIGITS)
      })
    }
  })

  it('produces the vector §5.5 writes, including 2·Im(ρ₁₀) for y', () => {
    for (const qubits of [1, 2, 3, 4]) {
      forRandomStates(qubits, 60, (state, qubit) => {
        const [x, y, z] = oracleBloch(oracleReduced(state, qubit))
        const vector = blochVector(state, qubit)

        expect(vector.x).toBeCloseTo(x, DIGITS)
        expect(vector.y).toBeCloseTo(y, DIGITS)
        expect(vector.z).toBeCloseTo(z, DIGITS)
        expect(vector.length).toBeCloseTo(Math.hypot(x, y, z), DIGITS)
      })
    }
  })

  it('lands on the wire it was asked about, not on its neighbour', () => {
    /*
     * Every qubit of a random state at once. A stride mix-up that answered
     * with qubit q+1 would still satisfy the two properties above for *some*
     * qubit, since both sides are asked the same question; here the module's
     * whole answer is matched against the oracle's whole answer, so a
     * permutation of the register is a failure.
     */
    forRandomStates(4, 40, (state) => {
      for (let qubit = 0; qubit < state.qubits; qubit++) {
        const [x, y, z] = oracleBloch(oracleReduced(state, qubit))
        const vector = blochVector(state, qubit)
        expect(vector.x).toBeCloseTo(x, DIGITS)
        expect(vector.y).toBeCloseTo(y, DIGITS)
        expect(vector.z).toBeCloseTo(z, DIGITS)
      }
    })
  })
})

describe('ρ is a density matrix, for any state', () => {
  it('is Hermitian: ρ₁₀ is the conjugate of ρ₀₁', () => {
    for (const qubits of [1, 2, 3]) {
      forRandomStates(qubits, 60, (state, qubit) => {
        const rho = oracleReduced(state, qubit)
        const density = reducedDensity(state, qubit)

        // The oracle's own off-diagonals are conjugates …
        expect(rho[1][0].re).toBeCloseTo(rho[0][1].re, DIGITS)
        expect(rho[1][0].im).toBeCloseTo(-rho[0][1].im, DIGITS)
        // … and the entry the module stores is the ρ₀₁ of that pair, which is
        // the assumption every consumer of `im01` makes.
        expect(density.re01).toBeCloseTo(rho[1][0].re, DIGITS)
        expect(density.im01).toBeCloseTo(-rho[1][0].im, DIGITS)
        // The diagonal is real by construction, not by rounding.
        expect(rho[0][0].im).toBeCloseTo(0, DIGITS)
        expect(rho[1][1].im).toBeCloseTo(0, DIGITS)
      })
    }
  })

  it('has trace 1 and a non-negative diagonal', () => {
    for (const qubits of [1, 2, 3, 4]) {
      forRandomStates(qubits, 60, (state, qubit) => {
        const density = reducedDensity(state, qubit)
        expect(trace(density)).toBeCloseTo(1, DIGITS)
        expect(density.rho00).toBeGreaterThanOrEqual(0)
        expect(density.rho11).toBeGreaterThanOrEqual(0)
      })
    }
  })

  it('never leaves the sphere, which is positive semidefiniteness', () => {
    for (const qubits of [1, 2, 3, 4]) {
      forRandomStates(qubits, 60, (state, qubit) => {
        // The eigenvalues are (1 ± |r|)/2, so |r| > 1 is a negative
        // probability. The slack is D6's tolerance, not a fudge factor.
        expect(blochVector(state, qubit).length).toBeLessThanOrEqual(1 + 1e-10)
      })
    }
  })

  it('has purity in [½, 1], matching both the matrix and the length', () => {
    for (const qubits of [1, 2, 3, 4]) {
      forRandomStates(qubits, 60, (state, qubit) => {
        const density = reducedDensity(state, qubit)
        const measured = purity(density)
        const { length } = blochVector(state, qubit)

        expect(measured).toBeCloseTo(
          oraclePurity(oracleReduced(state, qubit)),
          DIGITS
        )
        expect(measured).toBeCloseTo((1 + length * length) / 2, DIGITS)
        expect(measured).toBeGreaterThan(0.5 - 1e-10)
        expect(measured).toBeLessThan(1 + 1e-10)
      })
    }
  })
})

describe('purity is 1 exactly when the qubit is unentangled', () => {
  /**
   * The concurrence of a two-qubit pure state, straight from the amplitudes:
   * C = 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀|, with the pairs read off the little-endian index
   * (D1). It is zero exactly for a product state and 1 for a Bell pair, and
   * no partial trace appears anywhere in it.
   */
  function concurrence(state: Statevector): number {
    const a = amplitudeAt(state, 0)
    const b = amplitudeAt(state, 1)
    const c = amplitudeAt(state, 2)
    const d = amplitudeAt(state, 3)
    return 2 * abs(sub(mul(a, d), mul(b, c)))
  }

  /*
   * Squared on both sides, deliberately. |r| = √(1 − C²) is the identity, but
   * near a Bell pair C² is 1 − ε and the subtraction keeps only what survives
   * the cancellation: at |r| = 6e-6 the square root divides an absolute error
   * of 1e-16 by 1.2e-5 and lands 6e-11 from the module's answer — a failure
   * of the *identity's* conditioning rather than of the partial trace, and
   * one that would have been "fixed" by loosening the tolerance for every
   * other case too. |r|² and 1 − C² are both well conditioned, and comparing
   * them asserts exactly the same claim.
   */
  it('gives |r|² = 1 − C² on every two-qubit state', () => {
    forRandomStates(2, 200, (state) => {
      const c = concurrence(state)
      for (const qubit of [0, 1]) {
        const { length } = blochVector(state, qubit)
        expect(length * length).toBeCloseTo(1 - c * c, DIGITS)
        expect(purity(reducedDensity(state, qubit))).toBeCloseTo(
          1 - (c * c) / 2,
          DIGITS
        )
      }
    })
  })

  it('gives purity 1 to every qubit of a random product state', () => {
    /*
     * An explicit tensor product of four independent one-qubit states, so
     * "unentangled" is a property of the construction rather than something
     * measured after the fact. Every qubit of it must reach the surface —
     * this is the "exactly when" of the heading read in the other direction,
     * and it is the case a purity that always answered "entangled" would fail
     * while passing every Bell-pair assertion in the project.
     */
    const QUBITS = 4
    fc.assert(
      fc.property(
        fc.array(component, { minLength: 4 * QUBITS, maxLength: 4 * QUBITS }),
        (parts) => {
          const size = 1 << QUBITS
          // Each factor is a normalised one-qubit state built by the same
          // routine the other properties use, so the subnormal draws that
          // routine exists for are handled once rather than twice.
          const factors = Array.from({ length: QUBITS }, (_unused, qubit) =>
            stateFrom(1, parts.slice(4 * qubit, 4 * qubit + 4))
          )
          const re = new Float64Array(size)
          const im = new Float64Array(size)
          for (let index = 0; index < size; index++) {
            let amplitude: Cx = { re: 1, im: 0 }
            for (let qubit = 0; qubit < QUBITS; qubit++) {
              amplitude = mul(
                amplitude,
                amplitudeAt(factors[qubit], (index >> qubit) & 1)
              )
            }
            re[index] = amplitude.re
            im[index] = amplitude.im
          }
          const state: Statevector = { qubits: QUBITS, size, re, im }

          for (let qubit = 0; qubit < QUBITS; qubit++) {
            expect(blochVector(state, qubit).length).toBeCloseTo(1, DIGITS)
            expect(purity(reducedDensity(state, qubit))).toBeCloseTo(1, DIGITS)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
