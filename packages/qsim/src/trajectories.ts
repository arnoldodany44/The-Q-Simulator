/**
 * Monte Carlo quantum trajectories — the 2ⁿ way to run a noisy circuit (§5.4).
 *
 * `density.ts` and `noise.ts` answer "what does the ensemble look like" by
 * carrying the whole ensemble: ρ is 4ⁿ complex numbers, which is 256 MB at
 * twelve qubits and a terabyte at eighteen. §5.4 names the alternative and
 * this file is it — keep **one statevector**, 2ⁿ numbers, and let the
 * randomness happen. Each shot suffers a definite sequence of errors and ends
 * in a definite pure state; the ensemble is rebuilt by averaging over shots
 * instead of being stored.
 *
 *   | qubits | ρ = 4ⁿ × 16 B | ψ = 2ⁿ × 16 B |
 *   | ------ | ------------- | ------------- |
 *   | 12     | 256 MB        | 64 KB         |
 *   | 14     | 4 GB          | 256 KB        |
 *   | 18     | 1 TB          | 4 MB          |
 *
 * The trade is exact and it is a trade. ρ gives the answer once and exactly;
 * trajectories give it with a sampling error that falls as 1/√N, so the price
 * of the eighteenth qubit is shots. Which is why both exist and why the
 * strongest test in this milestone runs them against each other on a circuit
 * small enough for both (`verification/noise-trajectories.test.ts`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE UNRAVELLING, DERIVED — WHY AVERAGING TRAJECTORIES GIVES ρ BACK
 *
 * A channel is ε(ρ) = Σₖ Kₖ ρ Kₖ†. Take a normalised pure state |ψ⟩ and draw
 * one operator index k with probability
 *
 *     pₖ = ⟨ψ| Kₖ†Kₖ |ψ⟩ = ‖Kₖ|ψ⟩‖²
 *
 * then jump to the normalised state that operator produces,
 *
 *     |ψₖ⟩ = Kₖ|ψ⟩ / √pₖ.
 *
 * Those two lines are the whole method, and this is why they are the right
 * two lines. **They are a probability distribution** because the Kraus set is
 * trace preserving:
 *
 *     Σₖ pₖ = ⟨ψ| Σₖ Kₖ†Kₖ |ψ⟩ = ⟨ψ|I|ψ⟩ = 1.
 *
 * Σ K†K = I is not decoration here — it is exactly the statement that makes
 * the weights sum to one, so the check `noise.ts` runs to validate a channel
 * is the same check that validates this sampler. A Kraus set that fails it
 * produces branch probabilities that do not add up, and `prepareChannel`
 * refuses it for that reason rather than out of politeness.
 *
 * **And the average is the channel**, exactly:
 *
 *     E[ |ψₖ⟩⟨ψₖ| ] = Σₖ pₖ · (Kₖ|ψ⟩)(⟨ψ|Kₖ†) / pₖ
 *                   = Σₖ Kₖ |ψ⟩⟨ψ| Kₖ†
 *                   = ε(|ψ⟩⟨ψ|).
 *
 * The pₖ cancels — that cancellation *is* the reason the weights must be the
 * ones above and not any others. Sample with the wrong weights and the
 * factor left behind is qₖ/pₖ, a reweighted ensemble that is still a
 * perfectly normalised distribution over perfectly normalised states, and
 * still the wrong physics. Nothing throws.
 *
 * By linearity the same argument composes: if the average state after column
 * c is ρ_c, then applying one more gate and one more channel to every
 * trajectory gives an average of ε(U ρ_c U†), which is what the density
 * matrix does in that column. So the equality holds gate by gate for the
 * whole circuit, not just for one channel.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY UNIFORM SAMPLING IS WRONG, IN ONE CONCRETE CASE
 *
 * Amplitude damping has two operators, K₀ = diag(1, √(1−γ)) and K₁ = √γ·|0⟩⟨1|
 * — "the qubit emitted a photon" and "it did not". On the ground state |0⟩,
 *
 *     p₀ = ‖K₀|0⟩‖² = 1,        p₁ = ‖K₁|0⟩‖² = 0,
 *
 * because a cold qubit has no energy to lose. Drawing uniformly would emit
 * from the ground state half the time, and K₁|0⟩ is the **zero vector**: the
 * jump would divide by a norm of zero. So the failure would be loud here —
 * but only here. On |1⟩ the same uniform draw gives an emission rate of ½
 * instead of γ = 0.003, a state that is perfectly normalised and a T1 three
 * hundred times worse than the profile says, and the histogram it produces
 * looks like the histogram of a worse machine rather than like a bug.
 *
 * That is the whole hazard of this file in one sentence: the weights are not
 * equal, they are not fixed, and getting them wrong returns a plausible
 * answer.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE WEIGHTS DEPEND ON THE CURRENT STATE — EXCEPT WHEN THEY DO NOT
 *
 * pₖ = ⟨ψ|Kₖ†Kₖ|ψ⟩ is a function of ψ, so in general it has to be recomputed
 * at every single application: for amplitude damping p₁ = γ·⟨ψ|1⟩⟨1|ψ⟩ is
 * literally γ times the excited population, which changes with every gate.
 * That costs one pass over the state per application.
 *
 * There is one family where it does not, and it is worth recognising because
 * it covers the channels a circuit meets most often. If Kₖ†Kₖ = cₖ²·I — i.e.
 * the operator is a scalar times a unitary, which is what every Pauli channel
 * is built from — then
 *
 *     pₖ = ⟨ψ| cₖ²·I |ψ⟩ = cₖ²·‖ψ‖²
 *
 * for *any* ψ. The state cancels out. Depolarising, bit flip and phase flip
 * are all of this form, so their branch probabilities are read off the
 * operators once at `prepareChannel` time and no pass over the state is ever
 * needed. Amplitude and phase damping are not (K₀†K₀ = diag(1, 1−γ) is not a
 * multiple of I), so they take the general path.
 *
 * This is a *derived* property, tested per operator with the arithmetic
 * above, and emphatically not a switch on `channel.kind`: a hand-built Kraus
 * set gets the fast path if and only if it earns it, and the tests hold the
 * fast path to reproducing the general one exactly.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE COMMON BRANCH IS FREE, AND THAT IS WHY THIS IS FAST
 *
 * On any device worth simulating, the overwhelmingly likely branch is "no
 * error": p₀ = 1 − 3p/4 ≈ 0.9994 for a one-qubit gate on the superconducting
 * profile. That branch's operator is a positive multiple of the identity, and
 * a positive multiple of the identity, renormalised, is the identity **to the
 * last bit** — (c·I)ψ / ‖(c·I)ψ‖ = ψ exactly, no arithmetic required. So it
 * is skipped, not computed, and a depolarising channel on a wire costs one
 * random draw and nothing else 999 times in 1000.
 *
 * That is the asymmetry that makes the method viable: ρ pays for every
 * operator of every channel on every gate, whereas a trajectory usually pays
 * for none of them. What it pays instead is N shots.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ONE DRAW PER APPLICATION, ALWAYS
 *
 * Both paths — fast and general, identity branch and jump — consume exactly
 * one `rng.next()` per channel per application. That is a deliberate contract
 * and not an accident of the code: the RNG is shared with the measurement
 * trajectories of `measure.ts` (same generator, same stream, one seed for the
 * whole run), so a branch that consumed a different number of draws would
 * make every later collapse in that shot depend on which Kraus operator was
 * chosen, and the "same seed, same answer" guarantee would hold only until
 * someone optimised a path. The tests count the draws.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT THIS SHARES WITH MID-CIRCUIT MEASUREMENT, AND WHY THAT IS THE POINT
 *
 * `measure.ts` already had a trajectories mode: a measurement picks an
 * outcome with its Born probability, projects the state onto it and
 * renormalises. A noise channel picks a Kraus operator with the probability
 * above, applies it and renormalises. **These are the same operation** — a
 * projector is a Kraus operator, and {|0⟩⟨0|, |1⟩⟨1|} is a trace-preserving
 * Kraus set whose weights are exactly the Born probabilities. So this file
 * adds a sampler beside `measureQubit`, both of them driven by the one `Rng`
 * on `TrajectoriesOptions`, and the runner interleaves them in one loop
 * rather than running two kinds of trajectory.
 */

import { apply1q } from './apply.js'
import type { Matrix2 } from './gates.js'
import { NotTracePreservingError, krausDefect } from './noise.js'
import type { KrausChannel } from './noise.js'
import type { Rng } from './rng.js'
import type { Statevector } from './statevector.js'

/** D6's tolerance, absolute — the same bound `noise.ts` and `density.ts` use. */
const DEFAULT_TOLERANCE = 1e-10

/**
 * A channel with everything that does not depend on the state worked out
 * once: the flattened operators, the branch weights when they are fixed, and
 * which operators are the identity in disguise.
 *
 * WHY PREPARE AT ALL. A trajectory run applies the same three channels to the
 * same wires a few million times (shots × gates × wires), and every field
 * here would otherwise be recomputed inside that loop from operators that
 * cannot have changed. The preparation is also where the Kraus set is
 * validated, which is the right place: an invalid set has no branch
 * probabilities, so there is nothing to sample and no reason to discover that
 * once per shot.
 *
 * NOT REENTRANT, ON PURPOSE. `weights` and `scaled` are scratch buffers owned
 * by this object, refilled on every `sampleKraus` and consumed before it
 * returns. JavaScript is single-threaded and `apply1q` reads its eight
 * doubles into locals before touching the state, so reuse is safe and it is
 * what keeps the hot loop free of allocation. Two concurrent runs need two
 * prepared channels; `prepareChannels` gives each run its own.
 */
export interface TrajectoryChannel {
  /** The channel this was built from. Its operators are not copied. */
  readonly channel: KrausChannel
  /**
   * Branch probabilities that do not depend on the state, or `undefined` when
   * they do — see the header. When present these are exactly ‖Kₖψ‖² for every
   * normalised ψ, so no pass over the state is needed to sample.
   */
  readonly fixedWeights: Float64Array | undefined
  /**
   * Per operator: is it a **positive real multiple of the identity**? Those
   * are the jumps that can be skipped outright, which is the no-error branch
   * of every Pauli channel. Tested exactly rather than to a tolerance — an
   * operator that is merely close to the identity must take the arithmetic,
   * because "close" is what a wrong coefficient looks like.
   */
  readonly identity: readonly boolean[]
  /** All operators end to end, 8 doubles each — one array, no pointer chase. */
  readonly flat: Float64Array
  /** Scratch for the general weights pass. Length = operator count. */
  readonly weights: Float64Array
  /** Scratch for Kₖ/√pₖ, the matrix actually applied. Eight doubles. */
  readonly scaled: Matrix2
}

/**
 * Validate a Kraus set and work out everything about it that is independent
 * of the state.
 *
 * Throws `NotTracePreservingError` when Σ Kₖ†Kₖ ≠ I to 1e-10 — the same check
 * and the same error `applyChannel` raises, because the sampler needs it for
 * a sharper reason than the density kernel does: there the defect is a
 * distortion of ρ, here it is branch probabilities that do not sum to one.
 */
export function prepareChannel(channel: KrausChannel): TrajectoryChannel {
  const count = channel.operators.length
  if (count === 0) {
    throw new RangeError(
      `The "${channel.kind}" channel has no Kraus operators, so there is ` +
        `nothing to sample. A channel has at least one.`
    )
  }
  const defect = krausDefect(channel)
  if (!(defect <= DEFAULT_TOLERANCE)) {
    throw new NotTracePreservingError(channel.kind, defect, DEFAULT_TOLERANCE)
  }

  const flat = new Float64Array(count * 8)
  const identity: boolean[] = []
  const fixed = new Float64Array(count)
  let allScalar = true

  for (let k = 0; k < count; k++) {
    const operator = channel.operators[k]
    flat.set(operator, k * 8)
    identity.push(isScaledIdentity(operator))
    const weight = scalarWeight(operator)
    if (weight === undefined) allScalar = false
    else fixed[k] = weight
  }

  return {
    channel,
    fixedWeights: allScalar ? fixed : undefined,
    identity,
    flat,
    weights: new Float64Array(count),
    scaled: new Float64Array(8),
  }
}

/** Prepare a list of channels, in order. One array per run — see the type. */
export function prepareChannels(
  channels: readonly KrausChannel[]
): readonly TrajectoryChannel[] {
  return channels.map(prepareChannel)
}

/**
 * The branch probabilities pₖ = ‖Kₖ|ψ⟩‖² of `channel` acting on `target`, in
 * operator order.
 *
 * The reference reading of the weights: it always walks the state, never
 * consults `fixedWeights`, and allocates its own answer. Exported because it
 * is the quantity the derivation is about — a UI can show it, and the tests
 * hold the sampler's fast path to reproducing it — and because a caller that
 * wants to *look* at the branch probabilities should not have to prepare a
 * channel to do it.
 *
 * For a normalised ψ these sum to 1; for a state that has drifted they sum to
 * ‖ψ‖², which is why the sampler scales its draw by the total rather than
 * assuming it (the argument in `measure.measureQubit`, unchanged).
 */
export function krausWeights(
  state: Statevector,
  channel: KrausChannel,
  target: number
): Float64Array {
  checkQubit(state, target)
  const count = channel.operators.length
  const flat = new Float64Array(count * 8)
  for (let k = 0; k < count; k++) flat.set(channel.operators[k], k * 8)
  const out = new Float64Array(count)
  accumulateWeights(state, flat, count, target, out)
  return out
}

/**
 * Draw one Kraus operator of `prepared` for `target`, apply it and renormalise
 * — one step of a trajectory. Returns which operator was drawn.
 *
 * The index is returned rather than discarded because it is the only record
 * that an error happened: a caller can count jumps per channel to report an
 * error budget, and the tests use it to check the draw distribution directly
 * instead of inferring it from the state.
 *
 * Exactly one `rng.next()`, whichever branch is taken — see the header.
 */
export function sampleKraus(
  state: Statevector,
  prepared: TrajectoryChannel,
  target: number,
  rng: Rng
): number {
  checkQubit(state, target)
  const operators = prepared.channel.operators
  const count = operators.length

  let weights = prepared.fixedWeights
  if (weights === undefined) {
    weights = prepared.weights
    accumulateWeights(state, prepared.flat, count, target, weights)
  }

  // The total and the last branch that can actually be drawn, in one pass.
  // `last` is the fallback for a draw that lands exactly on the total through
  // rounding: it must be an operator with mass, because dividing by the norm
  // of a zero vector is how "the qubit emitted from the ground state" would
  // present itself.
  let total = 0
  let last = -1
  for (let k = 0; k < count; k++) {
    const weight = weights[k]
    total += weight
    if (weight > 0) last = k
  }
  // Reachable only on the general path, and only from a state that has lost
  // its probability: the weights are ‖Kₖψ‖² and Σ = ‖ψ‖². A unitary-mixture
  // channel never looks at the state, so it cannot notice — nor need it. Its
  // branch is a unitary applied by the ordinary kernel, which maps a zero
  // vector to a zero vector without dividing by anything, exactly as
  // `apply1q` does for a gate. The check lives where the division does.
  if (!(total > 0) || !Number.isFinite(total) || last < 0) {
    throw new RangeError(
      `Cannot sample the "${prepared.channel.kind}" channel on qubit ` +
        `${target}: the branch probabilities sum to ${total}. That is a ` +
        `state with no probability left, not a channel with no outcome.`
    )
  }

  // Scaled by the total rather than compared against 1, for the reason
  // `measure.ts` gives: after a collapse the norm is 1 − 2e-14, and handing
  // the missing mass to a branch whose amplitudes are exactly zero is how a
  // trajectory dies on the one draw in 10¹⁴ that lands there.
  const draw = rng.next() * total
  let chosen = last
  let cumulative = 0
  for (let k = 0; k < count; k++) {
    cumulative += weights[k]
    if (draw < cumulative) {
      chosen = k
      break
    }
  }

  // (c·I)ψ / ‖(c·I)ψ‖ = ψ, exactly, for real c > 0. Not applying it is both
  // faster than applying it and *more* accurate: the multiply-then-divide
  // round trip is a rounding error per amplitude per gate, on the branch that
  // happens almost every time.
  if (prepared.identity[chosen]) return chosen

  const norm = Math.sqrt(weights[chosen])
  const operator = operators[chosen]
  const scaled = prepared.scaled
  // Divided, not multiplied by a reciprocal: x/x is exactly 1 in IEEE 754, so
  // a √(p/4)·X operator drawn from a depolarising channel is applied as
  // exactly X, and a Pauli branch introduces no drift either.
  for (let i = 0; i < 8; i++) scaled[i] = operator[i] / norm
  apply1q(state, scaled, target)
  return chosen
}

/**
 * Apply several prepared channels to one wire, in order, sampling each.
 *
 * Order matters and is the caller's — `channelsForGate` fixes one and says
 * why. This is the trajectory twin of `noise.applyChannels`, and the two must
 * be given the same list in the same order or the two modes are simulating
 * two different devices.
 */
export function applyTrajectoryChannels(
  state: Statevector,
  channels: readonly TrajectoryChannel[],
  target: number,
  rng: Rng
): void {
  for (const channel of channels) sampleKraus(state, channel, target, rng)
}

/* ────────────────────────────── the kernel ──────────────────────────────── */

/**
 * Σ over basis pairs of |Kₖψ|² for every k, in one sweep of the state.
 *
 * The walk is `apply.ts`'s index pairing: a one-qubit operator mixes the two
 * amplitudes that differ only in bit `target`, so the pair (i₀, i₁) is
 * everything Kₖ sees. Both amplitudes are read once and all `count` operators
 * are evaluated against them before moving on, which is why the operator loop
 * is on the inside — the alternative walks the state once per operator, which
 * at 18 qubits is the difference between one 4 MB sweep and four.
 *
 * The result is written into `out` rather than returned: the caller owns a
 * scratch buffer, and a trajectory run allocating a Float64Array per channel
 * per gate per shot would spend more time in the collector than in the
 * arithmetic.
 */
function accumulateWeights(
  state: Statevector,
  flat: Float64Array,
  count: number,
  target: number,
  out: Float64Array
): void {
  out.fill(0)
  const { re, im, size } = state
  const stride = 1 << target

  for (let base = 0; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const i0 = base + offset
      const i1 = i0 + stride
      const a0r = re[i0]
      const a0i = im[i0]
      const a1r = re[i1]
      const a1i = im[i1]

      for (let k = 0, at = 0; k < count; k++, at += 8) {
        const m00r = flat[at]
        const m00i = flat[at + 1]
        const m01r = flat[at + 2]
        const m01i = flat[at + 3]
        const m10r = flat[at + 4]
        const m10i = flat[at + 5]
        const m11r = flat[at + 6]
        const m11i = flat[at + 7]

        const u0r = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i)
        const u0i = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r)
        const u1r = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i)
        const u1i = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r)

        out[k] += u0r * u0r + u0i * u0i + (u1r * u1r + u1i * u1i)
      }
    }
  }
}

/* ────────────────────────────── the operators ───────────────────────────── */

/**
 * `c²` when K†K = c²·I, otherwise `undefined` — the test for a branch whose
 * probability does not depend on the state (see the header).
 *
 *     (K†K)₀₀ = |K₀₀|² + |K₁₀|²
 *     (K†K)₁₁ = |K₀₁|² + |K₁₁|²
 *     (K†K)₀₁ = conj(K₀₀)·K₀₁ + conj(K₁₀)·K₁₁
 *
 * so the condition is "the two diagonal entries agree and the off-diagonal
 * vanishes", to D6's tolerance. The tolerance is right here and the exact
 * comparison used for the identity test is right there: this one only decides
 * whether a pass over the state can be skipped, and skipping it is worth an
 * error of 1e-10 in a weight; that one decides whether arithmetic is skipped
 * on the state itself.
 */
function scalarWeight(operator: Matrix2): number | undefined {
  const m00r = operator[0]
  const m00i = operator[1]
  const m01r = operator[2]
  const m01i = operator[3]
  const m10r = operator[4]
  const m10i = operator[5]
  const m11r = operator[6]
  const m11i = operator[7]

  const first = m00r * m00r + m00i * m00i + (m10r * m10r + m10i * m10i)
  const second = m01r * m01r + m01i * m01i + (m11r * m11r + m11i * m11i)
  const crossR = m00r * m01r + m00i * m01i + (m10r * m11r + m10i * m11i)
  const crossI = m00r * m01i - m00i * m01r + (m10r * m11i - m10i * m11r)

  if (Math.abs(first - second) > DEFAULT_TOLERANCE) return undefined
  if (Math.abs(crossR) > DEFAULT_TOLERANCE) return undefined
  if (Math.abs(crossI) > DEFAULT_TOLERANCE) return undefined
  return first
}

/**
 * Is this operator `c·I` for a real `c > 0`? Exact comparisons, deliberately.
 *
 * The answer decides whether the jump is skipped entirely, and the
 * justification for skipping is an algebraic identity — (c·I)ψ renormalised is
 * ψ — which holds for c·I and for nothing else. A tolerance here would let an
 * operator that is *nearly* the identity be treated as the identity, which is
 * precisely the shape of a coefficient error: √(1 − 3p/4) with p mistaken for
 * a per-Pauli probability is 0.99925 instead of 0.99850, and both are "nearly
 * one". A complex c is excluded too — it would be a global phase, physically
 * nothing, but the amplitudes would differ and the tests compare amplitudes.
 */
function isScaledIdentity(operator: Matrix2): boolean {
  return (
    operator[1] === 0 &&
    operator[2] === 0 &&
    operator[3] === 0 &&
    operator[4] === 0 &&
    operator[5] === 0 &&
    operator[7] === 0 &&
    operator[0] === operator[6] &&
    operator[0] > 0
  )
}

function checkQubit(state: Statevector, target: number): void {
  if (!Number.isInteger(target) || target < 0 || target >= state.qubits) {
    throw new RangeError(
      `Trajectory noise target ${target} is outside [0, ${state.qubits}).`
    )
  }
}
