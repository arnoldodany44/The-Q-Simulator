/**
 * Noise channels — specification §3.3, built on the ρ of §5.4.
 *
 * A unitary is a statement about what the machine *does*. A channel is a
 * statement about what the machine *fails to do*, and the two need different
 * arithmetic: no unitary sends a pure state to a mixed one, so no statevector
 * can hold the answer. Every channel here is a Kraus decomposition,
 *
 *     ρ → Σₖ Kₖ ρ Kₖ†
 *
 * applied to the density matrix `density.ts` owns.
 *
 * ────────────────────────────────────────────────────────────────────────
 * A PHYSICS BUG HERE THROWS NOTHING
 *
 * This is the module where a wrong coefficient is least likely to be noticed.
 * A depolarising channel built with √(p/2) instead of √(p/4) still returns a
 * Hermitian, positive, unit-trace matrix whose diagonal is a normalised
 * probability distribution — and nobody has an intuition for what a noisy
 * distribution should look like (§3.3), so there is no reader who would catch
 * it by eye. Three defences are wired in rather than left to discipline:
 *
 *  1. **Trace preservation is checked, not assumed.** Σₖ Kₖ†Kₖ = I is what
 *     makes a Kraus set a channel, it is four complex entries to compute, and
 *     `applyChannel` verifies it on every call before touching ρ. That single
 *     test catches almost every coefficient error, and its cost next to a 4ⁿ
 *     sweep is not measurable. Each constructor below also carries the
 *     derivation of its own Σ Kₖ†Kₖ in a comment, worked out rather than
 *     quoted, so the check and the code have independent reasons to agree.
 *
 *  2. **Every channel has a closed form and the tests use it.** Depolarising
 *     is ρ → (1−p)ρ + p·I/2, amplitude damping at γ = 1 is |0⟩⟨0| whatever it
 *     started from, phase damping moves no diagonal entry at all. A channel
 *     that matches its closed form on random states is not a channel with a
 *     wrong coefficient.
 *
 *  3. **ρ is re-checked after every application** — Hermitian, unit trace,
 *     positive semidefinite. Positivity is the one that catches a sign, for
 *     the reason `density.isPositiveSemidefinite` sets out.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE KERNEL — 2×2 BLOCKS, AND WHY IT ALLOCATES NOTHING
 *
 * The obvious implementation of Σₖ Kₖ ρ Kₖ† is a loop: copy ρ, run the copy
 * through `densityApply1q` (which is exactly M ρ M† and does not care whether
 * M is unitary), add the result into an accumulator, repeat. It is four lines
 * and it is wrong for this codebase, because it needs **two more density
 * matrices**: at 12 qubits that is 768 MB against a 256 MB budget, and the
 * ceiling `DENSITY_BUDGET_BYTES` promises would become a number that describes
 * ρ and not the program. The failure would arrive as a dead tab.
 *
 * So the sum is taken locally instead. A one-qubit channel on target t acts as
 * the identity on every other qubit, on both sides of ρ, so fix the value of
 * every *other* bit in the row index and in the column index and what is left
 * is a 2×2 corner of ρ:
 *
 *     r₀ = row with bit t clear      c₀ = column with bit t clear
 *     r₁ = r₀ + 2ᵗ                   c₁ = c₀ + 2ᵗ
 *
 *              ⎡ ρ[r₀][c₀]  ρ[r₀][c₁] ⎤
 *          B = ⎣ ρ[r₁][c₀]  ρ[r₁][c₁] ⎦   →   Σₖ Kₖ B Kₖ†
 *
 * and that 2×2 map is the whole channel for that corner. The proof is one line
 * of index bookkeeping: (KρK†)_rc = Σ_ab K_ra ρ_ab conj(K_cb), and K = k ⊗ I
 * on the other wires forces `a` to agree with `r` and `b` to agree with `c`
 * everywhere except bit t. There are 4ⁿ/4 such corners, each costs two 2×2
 * complex products per Kraus operator, and the accumulator is eight doubles in
 * registers. **Nothing is allocated, and ρ is read and written exactly once.**
 *
 * The walk itself is `apply.ts`'s index pairing run twice — once over rows and
 * once over columns — which is the same decomposition `density.ts` uses for
 * ρ → UρU†, with the difference that the two passes cannot be separated here:
 * a sum over k does not factor into a row pass and a column pass.
 *
 * ────────────────────────────────────────────────────────────────────────
 * READOUT ERROR IS NOT IN THIS LIST, AND THAT IS THE POINT
 *
 * See `applyReadoutError`. Misreading a measurement is a classical event in
 * the amplifier chain, after the state is gone. Writing it as a Kraus channel
 * would disturb the state itself — a bit-flip channel changes the coherences,
 * a misread changes nothing — and would be wrong in the one place hardware is
 * most asymmetric.
 *
 * ────────────────────────────────────────────────────────────────────────
 * PROFILES ARE WRITTEN THE WAY DATASHEETS ARE
 *
 * A profile that says `p = 0.001` communicates nothing: nobody can tell
 * whether it is optimistic, and nothing on a device report is called p. Real
 * machines publish T1, T2, gate durations, randomised-benchmarking error rates
 * and readout assignment fidelities, so `NoiseProfile` carries those and the
 * channel parameters are *derived*, with the conversions written out and
 * attributed below. The presets are plausible rather than copied: no number
 * here claims to reproduce a specific machine.
 */

import type { DensityMatrix } from './density.js'
import type { Matrix2 } from './gates.js'
import type { Rng } from './rng.js'

/** D6's tolerance, absolute — the same bound `density.ts` uses, and why. */
const DEFAULT_TOLERANCE = 1e-10

/**
 * The Paulis, in `gates.ts`'s flat interleaved layout.
 *
 * Written out here rather than imported from `GATE_MATRICES` on purpose. That
 * catalog is documented as shared and not to be mutated, and `scaledMatrix`
 * below produces a *new* buffer from these — but the deeper reason is that
 * these four are being used as Kraus operators and not as gates. A future edit
 * that changes a global phase in the catalog (legal for a gate, and Qiskit
 * carries such phases in `rz` and `u`) must not silently change the noise
 * model: a channel is invariant under a phase on a whole operator, and nothing
 * guarantees a gate matrix will keep being scaled as a whole.
 */
const PAULI_I: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, 1, 0])
const PAULI_X: Matrix2 = new Float64Array([0, 0, 1, 0, 1, 0, 0, 0])
const PAULI_Y: Matrix2 = new Float64Array([0, 0, 0, -1, 0, 1, 0, 0])
const PAULI_Z: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, -1, 0])

/* ──────────────────────────── the channel type ──────────────────────────── */

/**
 * The channels of §3.3, as an array first so the union below cannot drift from
 * it. A UI listing the channels and a test sweeping all of them read this.
 */
export const NOISE_CHANNEL_KINDS = [
  'depolarizing',
  'amplitudeDamping',
  'phaseDamping',
  'bitFlip',
  'phaseFlip',
] as const

/** Which channel. Derived from the array, so adding one updates both. */
export type NoiseChannelKind = (typeof NOISE_CHANNEL_KINDS)[number]

/**
 * A one-qubit Kraus channel: the operators, plus the parameter they were built
 * from.
 *
 * The operators are `Matrix2` — the same flat, interleaved, row-major eight
 * doubles `gates.ts` defines and the kernel of `apply.ts` consumes. They are
 * emphatically *not* unitary, and nothing here should be tempted to pass one
 * to `dagger()` expecting an inverse: `K₁` of amplitude damping is singular.
 * The layout is shared because the arithmetic is shared, not the algebra.
 *
 * `parameter` is carried rather than recomputed because two things need it and
 * neither can recover it from the operators without knowing the kind: the UI
 * (a slider has to read back the value it set) and `channelsForGate`, which
 * drops channels whose parameter is 0 — see there for why that is exact.
 */
export interface KrausChannel {
  readonly kind: NoiseChannelKind
  /** p, γ or λ, depending on `kind`. Always in [0, 1]. */
  readonly parameter: number
  readonly operators: readonly Matrix2[]
}

/* ───────────────────────── the channel constructors ─────────────────────── */

/**
 * Depolarising with probability `p` — §5.4's operators, re-derived.
 *
 *     √(1 − 3p/4)·I,  √(p/4)·X,  √(p/4)·Y,  √(p/4)·Z
 *
 * TRACE PRESERVATION, WORKED. Each Pauli is Hermitian and squares to I, so
 * P†P = I for P ∈ {I, X, Y, Z} and
 *
 *     Σ Kₖ†Kₖ = (1 − 3p/4)·I + 3·(p/4)·I = I
 *
 * for every p. The specification's convention is therefore correct and is the
 * one used here — but it is worth saying which p it is, because two live in
 * the literature. This is the p for which the channel is
 *
 *     ρ → (1 − p)·ρ + p·(I/2)
 *
 * i.e. **p is the probability that the state is replaced by the maximally
 * mixed one**, not the probability that a given Pauli is applied (that one is
 * p/4, and a text using it writes the identity coefficient as √(1 − 3p) with
 * p ≤ 1/3). The two differ by a factor of four and both produce a valid ρ, so
 * only the closed form separates them; the tests assert it.
 *
 * The identity ρ → (1−p)ρ + p·I/2 follows from (ρ + XρX + YρY + ZρZ)/4 = I/2
 * for any unit-trace ρ, which is the statement that averaging over the Pauli
 * group erases everything but the trace.
 *
 * Bloch picture: r → (1 − p)·r, every component shrunk by the same factor —
 * the only channel here that is isotropic, and the reason it is the default
 * stand-in for "a gate went slightly wrong in a way nobody measured".
 *
 * p is restricted to [0, 1]. The Kraus set stays completely positive up to
 * p = 4/3 (the point where the identity coefficient hits zero), but past 1 the
 * map over-rotates through the maximally mixed state and p stops being a
 * probability, which is what §3.3 calls it and what the slider will show.
 */
export function depolarizingChannel(p: number): KrausChannel {
  checkProbability('depolarizing p', p)
  const identity = Math.sqrt(1 - (3 * p) / 4)
  const pauli = Math.sqrt(p / 4)
  return {
    kind: 'depolarizing',
    parameter: p,
    operators: [
      scaledMatrix(PAULI_I, identity),
      scaledMatrix(PAULI_X, pauli),
      scaledMatrix(PAULI_Y, pauli),
      scaledMatrix(PAULI_Z, pauli),
    ],
  }
}

/**
 * Amplitude damping with `gamma` — energy leaving the qubit. This is T1.
 *
 *     K₀ = ⎡1    0    ⎤        K₁ = ⎡0  √γ⎤
 *          ⎣0  √(1−γ) ⎦             ⎣0  0 ⎦
 *
 * TRACE PRESERVATION, WORKED. K₀ is real diagonal so K₀†K₀ = diag(1, 1−γ).
 * K₁† = √γ·|1⟩⟨0|, so K₁†K₁ = γ·|1⟩⟨1| = diag(0, γ). The sum is diag(1, 1) = I
 * for every γ ∈ [0, 1].
 *
 * WHAT IT DOES. K₁ is |0⟩⟨1| scaled: it takes the excited state to the ground
 * state and annihilates the ground state, which is spontaneous emission with
 * probability γ. K₀ is what is left over — it does nothing to |0⟩ and shrinks
 * the |1⟩ branch by the amplitude that did not decay. In entries,
 *
 *     ρ₀₀ → ρ₀₀ + γ·ρ₁₁      ρ₁₁ → (1−γ)·ρ₁₁      ρ₀₁ → √(1−γ)·ρ₀₁
 *
 * so γ = 1 sends **every** state to |0⟩⟨0| — the check the tests use, because
 * it is the one statement about this channel that no coefficient error
 * survives. Note the asymmetry: this is the only channel here that is not
 * unital (it moves I/2), and the only one with a preferred direction. That is
 * physics, not a bug: a cold qubit relaxes downwards.
 *
 * COMPOSITION. Two applications do not add their γ. Populations multiply,
 * (1−γ₁)(1−γ₂), so the composed rate is
 *
 *     γ = 1 − (1−γ₁)(1−γ₂) = γ₁ + γ₂ − γ₁γ₂
 *
 * which is also why γ = 1 − exp(−t/T₁) is the right conversion from a T1: it
 * is the unique parameterisation under which composing over consecutive
 * intervals adds the *times*. `relaxationFor` uses it and the tests assert the
 * composition law rather than assuming it.
 */
export function amplitudeDampingChannel(gamma: number): KrausChannel {
  checkProbability('amplitude damping γ', gamma)
  const kept = Math.sqrt(1 - gamma)
  const decayed = Math.sqrt(gamma)
  return {
    kind: 'amplitudeDamping',
    parameter: gamma,
    operators: [
      new Float64Array([1, 0, 0, 0, 0, 0, kept, 0]),
      new Float64Array([0, 0, decayed, 0, 0, 0, 0, 0]),
    ],
  }
}

/**
 * Phase damping with `lambda` — coherence leaving the qubit without energy
 * leaving it. This is the pure-dephasing half of T2.
 *
 *     K₀ = ⎡1    0    ⎤        K₁ = ⎡0    0  ⎤
 *          ⎣0  √(1−λ) ⎦             ⎣0   √λ  ⎦
 *
 * TRACE PRESERVATION, WORKED. Both are real and diagonal, so K₀†K₀ =
 * diag(1, 1−λ) and K₁†K₁ = diag(0, λ), summing to I for every λ ∈ [0, 1].
 *
 * WHAT IT DOES, AND WHY IT IS NOT AMPLITUDE DAMPING. The operators look almost
 * identical to the pair above — the difference is one index, K₁ = √λ·|1⟩⟨1|
 * here against √γ·|0⟩⟨1| there — and it changes everything. Nothing moves
 * between the levels:
 *
 *     ρ₀₀ → ρ₀₀      ρ₁₁ → (1−λ)ρ₁₁ + λρ₁₁ = ρ₁₁      ρ₀₁ → √(1−λ)·ρ₀₁
 *
 * **The diagonal is untouched and only the coherences decay.** A measurement
 * in the computational basis therefore cannot see this channel at all, which
 * is exactly what makes it worth simulating: it destroys interference while
 * leaving the histogram of §3.2 identical, and a reader watching only the bars
 * would conclude nothing happened. The Bloch picture says it plainly — the
 * sphere is squashed towards the z axis, x and y shrink by √(1−λ), z is fixed.
 *
 * EQUIVALENT FORMS. { √(1−λ/2)·I, √(λ/2)·Z } is the same channel, and so is
 * `phaseFlipChannel(q)` with 1 − 2q = √(1−λ). This form is the one kept
 * because it makes "the diagonal does not move" visible in the operators
 * themselves, and because λ is what falls out of a Tφ.
 */
export function phaseDampingChannel(lambda: number): KrausChannel {
  checkProbability('phase damping λ', lambda)
  const kept = Math.sqrt(1 - lambda)
  const dephased = Math.sqrt(lambda)
  return {
    kind: 'phaseDamping',
    parameter: lambda,
    operators: [
      new Float64Array([1, 0, 0, 0, 0, 0, kept, 0]),
      new Float64Array([0, 0, 0, 0, 0, 0, dephased, 0]),
    ],
  }
}

/**
 * Bit flip with probability `p`: { √(1−p)·I, √p·X }.
 *
 * TRACE PRESERVATION: (1−p)·I†I + p·X†X = (1−p)I + pI = I, since X² = I.
 *
 * A classical error written quantum-mechanically — with probability p the
 * qubit is X'd, and X on a computational basis state is exactly "the bit came
 * out wrong". It is *not* a readout error even so: this one happens to the
 * state, so a later gate sees the flipped qubit. See `applyReadoutError`.
 *
 * Bloch: x fixed, y and z shrink by (1 − 2p). At p = 1/2 the qubit keeps only
 * its x component, and at p = 1 the flip is deterministic and the channel is
 * the unitary X — which is why p is a probability and not an error rate: the
 * worst case is p = 1/2, not p = 1.
 */
export function bitFlipChannel(p: number): KrausChannel {
  checkProbability('bit flip p', p)
  return {
    kind: 'bitFlip',
    parameter: p,
    operators: [
      scaledMatrix(PAULI_I, Math.sqrt(1 - p)),
      scaledMatrix(PAULI_X, Math.sqrt(p)),
    ],
  }
}

/**
 * Phase flip with probability `p`: { √(1−p)·I, √p·Z }.
 *
 * TRACE PRESERVATION: (1−p)I + pI = I, since Z² = I.
 *
 * Bloch: z fixed, x and y shrink by (1 − 2p) — the same shape as phase damping
 * and, at 1 − 2p = √(1−λ), the same channel. Kept as its own kind because
 * §3.3 lists it and because a reader reaching for "a phase went wrong with
 * probability p" should not have to invert a square root to say it.
 */
export function phaseFlipChannel(p: number): KrausChannel {
  checkProbability('phase flip p', p)
  return {
    kind: 'phaseFlip',
    parameter: p,
    operators: [
      scaledMatrix(PAULI_I, Math.sqrt(1 - p)),
      scaledMatrix(PAULI_Z, Math.sqrt(p)),
    ],
  }
}

/**
 * Build a channel by kind — the dispatcher a `<select>` and a slider need, and
 * the one the tests sweep so that a channel added to `NOISE_CHANNEL_KINDS`
 * cannot quietly skip the suite.
 */
export function channelFor(
  kind: NoiseChannelKind,
  parameter: number
): KrausChannel {
  switch (kind) {
    case 'depolarizing':
      return depolarizingChannel(parameter)
    case 'amplitudeDamping':
      return amplitudeDampingChannel(parameter)
    case 'phaseDamping':
      return phaseDampingChannel(parameter)
    case 'bitFlip':
      return bitFlipChannel(parameter)
    case 'phaseFlip':
      return phaseFlipChannel(parameter)
  }
}

/* ─────────────────────── is it a channel at all? ────────────────────────── */

/**
 * How far Σₖ Kₖ†Kₖ is from I: the largest |entry − δᵢⱼ| over the 2×2.
 *
 * A number rather than a boolean, because this is what a failing test should
 * print — "0.25" says the coefficient is out by a factor, "1e-16" says the
 * suite is measuring Float64 and should stop.
 *
 * WHY THIS IS THE CHEAP CHECK THAT CATCHES MOST ERRORS. Σ Kₖ†Kₖ = I is
 * equivalent to Tr(Σ Kₖ ρ Kₖ†) = Tr(ρ) for every ρ, i.e. to the channel
 * conserving probability. Every coefficient in every constructor above appears
 * squared in this sum, so getting one wrong by any factor other than a phase
 * moves it — while leaving ρ Hermitian, leaving it positive, and (after the
 * renormalisation D6 already schedules) leaving the histogram summing to one.
 * It is four complex entries and eight multiplications per operator.
 */
export function krausDefect(channel: KrausChannel): number {
  // Σ Kₖ†Kₖ, accumulated in place: (K†K)_ij = Σ_a conj(K_ai)·K_aj.
  let s00r = 0
  let s01r = 0
  let s01i = 0
  let s11r = 0
  // The diagonal of K†K is real by construction (a sum of |·|²), so s00i and
  // s11i are not accumulated: they are zero as arithmetic, not as an accident.
  for (const k of channel.operators) {
    checkOperator(k)
    const a0r = k[0]
    const a0i = k[1]
    const a1r = k[2]
    const a1i = k[3]
    const b0r = k[4]
    const b0i = k[5]
    const b1r = k[6]
    const b1i = k[7]
    // Column 0 of K is (a0, b0); column 1 is (a1, b1).
    s00r += a0r * a0r + a0i * a0i + (b0r * b0r + b0i * b0i)
    s11r += a1r * a1r + a1i * a1i + (b1r * b1r + b1i * b1i)
    // conj(col0)·col1, entry (0,1).
    s01r += a0r * a1r + a0i * a1i + (b0r * b1r + b0i * b1i)
    s01i += a0r * a1i - a0i * a1r + (b0r * b1i - b0i * b1r)
  }
  return Math.max(
    Math.abs(s00r - 1),
    Math.abs(s11r - 1),
    Math.abs(s01r),
    Math.abs(s01i)
  )
}

/** Whether Σₖ Kₖ†Kₖ = I to `tolerance` — the definition of a channel. */
export function isTracePreserving(
  channel: KrausChannel,
  tolerance = DEFAULT_TOLERANCE
): boolean {
  return krausDefect(channel) <= tolerance
}

/**
 * Raised by `applyChannel` when its Kraus set does not sum to the identity.
 *
 * A typed error with the defect on it rather than a bare `RangeError`: the UI
 * has to say this in three languages (D2) and needs the number, and a custom
 * profile is a real path to a hand-built operator set, so this is reachable
 * from user input rather than only from a bug.
 */
export class NotTracePreservingError extends RangeError {
  readonly kind: string
  readonly defect: number
  readonly tolerance: number

  constructor(kind: string, defect: number, tolerance: number) {
    super(
      `The "${kind}" Kraus set is not trace preserving: Σ K†K differs from ` +
        `the identity by ${defect}, over the ${tolerance} tolerance. A set ` +
        `that fails this does not conserve probability, so the ρ it produces ` +
        `is not a state however plausible its histogram looks.`
    )
    this.name = 'NotTracePreservingError'
    this.kind = kind
    this.defect = defect
    this.tolerance = tolerance
  }
}

/* ────────────────────────────── the kernel ──────────────────────────────── */

/**
 * ρ → Σₖ Kₖ ρ Kₖ† for a one-qubit `channel` on `target`, in place.
 *
 * O(4ⁿ) and **no allocation** — see the header for the 2×2-corner derivation
 * and for why the copy-and-accumulate version is not an option at this
 * module's memory budget.
 *
 * The trace-preservation check runs first, on every call. It is O(1) against a
 * 4ⁿ sweep, it is the check that catches the class of bug this file is written
 * around, and it runs before ρ is touched so a rejected call leaves the state
 * it was given intact.
 */
export function applyChannel(
  rho: DensityMatrix,
  channel: KrausChannel,
  target: number
): void {
  checkQubit(rho, target)
  const defect = krausDefect(channel)
  if (!(defect <= DEFAULT_TOLERANCE)) {
    throw new NotTracePreservingError(channel.kind, defect, DEFAULT_TOLERANCE)
  }

  const { re, im, dim } = rho
  const count = channel.operators.length
  const stride = 1 << target
  const step = stride << 1

  // The operators, copied into ONE contiguous Float64Array of 8·count doubles.
  //
  // The inner loop below runs 4ⁿ⁻¹ times and reads all eight entries of every
  // operator on each pass. Reading them from `channel.operators[k]` is an array
  // element load plus a typed-array dereference per operator per corner, on top
  // of the eight doubles — a pointer chase in the hottest loop in the module,
  // and one the engine cannot hoist out because it cannot prove the array is
  // not mutated underneath it. Flattening costs at most 32 doubles of setup and
  // is the same reasoning `apply.ts` gives for hoisting a gate's eight doubles
  // into locals, one level further out.
  //
  // It is worth a few percent and not more, which is worth writing down: the
  // arithmetic here is already close to what scalar Float64 in JavaScript can
  // do, so there is no local rearrangement left that changes the picture. The
  // next real gain is §5.6's phase 2 — SIMD in a WASM core — and the second is
  // specialising the five channels to their closed forms (each has one; see the
  // constructors). Both were left out here deliberately: five specialised paths
  // are five places a silent physics bug can live, and this milestone is about
  // not having any.
  const flat = new Float64Array(count * 8)
  for (let k = 0; k < count; k++) flat.set(channel.operators[k], k * 8)

  for (let rowBase = 0; rowBase < dim; rowBase += step) {
    for (let rowOffset = 0; rowOffset < stride; rowOffset++) {
      const row0 = (rowBase + rowOffset) * dim
      const row1 = row0 + stride * dim

      for (let columnBase = 0; columnBase < dim; columnBase += step) {
        for (let columnOffset = 0; columnOffset < stride; columnOffset++) {
          const c0 = columnBase + columnOffset
          const i00 = row0 + c0
          const i01 = i00 + stride
          const i10 = row1 + c0
          const i11 = i10 + stride

          const b00r = re[i00]
          const b00i = im[i00]
          const b01r = re[i01]
          const b01i = im[i01]
          const b10r = re[i10]
          const b10i = im[i10]
          const b11r = re[i11]
          const b11i = im[i11]

          let o00r = 0
          let o00i = 0
          let o01r = 0
          let o01i = 0
          let o10r = 0
          let o10i = 0
          let o11r = 0
          let o11i = 0

          for (let k = 0, at = 0; k < count; k++, at += 8) {
            const m00r = flat[at]
            const m00i = flat[at + 1]
            const m01r = flat[at + 2]
            const m01i = flat[at + 3]
            const m10r = flat[at + 4]
            const m10i = flat[at + 5]
            const m11r = flat[at + 6]
            const m11i = flat[at + 7]

            // T = K·B — the left multiplication, ordinary complex products.
            const t00r = m00r * b00r - m00i * b00i + (m01r * b10r - m01i * b10i)
            const t00i = m00r * b00i + m00i * b00r + (m01r * b10i + m01i * b10r)
            const t01r = m00r * b01r - m00i * b01i + (m01r * b11r - m01i * b11i)
            const t01i = m00r * b01i + m00i * b01r + (m01r * b11i + m01i * b11r)
            const t10r = m10r * b00r - m10i * b00i + (m11r * b10r - m11i * b10i)
            const t10i = m10r * b00i + m10i * b00r + (m11r * b10i + m11i * b10r)
            const t11r = m10r * b01r - m10i * b01i + (m11r * b11r - m11i * b11i)
            const t11i = m10r * b01i + m10i * b01r + (m11r * b11i + m11i * b11r)

            // out += T·K†. (K†)_bj = conj(K_jb), so out_ij = Σ_b T_ib·conj(K_jb)
            // and each product is (t)·conj(m) = (tr·mr + ti·mi, ti·mr − tr·mi).
            // The four `−` signs on the imaginary lines are the dagger, and
            // they are the first thing to check if a test says ρ stopped being
            // Hermitian: writing `+` there is the mistake that survives the
            // trace test and the positivity test and fails only this one.
            o00r += t00r * m00r + t00i * m00i + (t01r * m01r + t01i * m01i)
            o00i += t00i * m00r - t00r * m00i + (t01i * m01r - t01r * m01i)
            o01r += t00r * m10r + t00i * m10i + (t01r * m11r + t01i * m11i)
            o01i += t00i * m10r - t00r * m10i + (t01i * m11r - t01r * m11i)
            o10r += t10r * m00r + t10i * m00i + (t11r * m01r + t11i * m01i)
            o10i += t10i * m00r - t10r * m00i + (t11i * m01r - t11r * m01i)
            o11r += t10r * m10r + t10i * m10i + (t11r * m11r + t11i * m11i)
            o11i += t10i * m10r - t10r * m10i + (t11i * m11r - t11r * m11i)
          }

          re[i00] = o00r
          im[i00] = o00i
          re[i01] = o01r
          im[i01] = o01i
          re[i10] = o10r
          im[i10] = o10i
          re[i11] = o11r
          im[i11] = o11i
        }
      }
    }
  }
}

/**
 * Apply several channels to the same qubit, in order.
 *
 * Order matters and is the caller's to choose: amplitude damping followed by
 * phase damping is not the same map as the reverse unless one of them is
 * trivial. `channelsForGate` fixes an order and says why.
 */
export function applyChannels(
  rho: DensityMatrix,
  channels: readonly KrausChannel[],
  target: number
): void {
  for (const channel of channels) applyChannel(rho, channel, target)
}

/* ─────────────────────────── readout error ──────────────────────────────── */

/**
 * A qubit's measurement confusion matrix — the probability of reading each
 * value given each prepared value.
 *
 * Two numbers, not one, because real devices are asymmetric: a qubit that
 * relaxes during the microseconds the readout resonator is being integrated
 * reads 0 when it was 1, and nothing makes the reverse equally likely. Device
 * reports usually publish the pair, or publish the *assignment fidelity*
 * F = 1 − (p0to1 + p1to0)/2, which is the average of the two and cannot be
 * un-averaged.
 */
export interface ReadoutError {
  readonly qubit: number
  /** P(read 1 | the qubit was 0). Excitation during readout, usually small. */
  readonly p0to1: number
  /** P(read 0 | the qubit was 1). Relaxation during readout, usually larger. */
  readonly p1to0: number
}

/**
 * Apply per-qubit readout error to a distribution over basis states, returning
 * a new one. The input is untouched.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A KRAUS CHANNEL, AND WHY IT WOULD BE WRONG AS ONE
 *
 * A readout error is not something that happens to the qubit. It happens after
 * the qubit is gone: the projector has already fired, the state has already
 * collapsed, and what is left is a voltage being discriminated into a 0 or a 1
 * by a classifier that is not perfect. Modelling it as a bit-flip channel
 * applied before the measurement would be wrong in three separate ways.
 *
 *  1. **It would disturb the state.** A bit-flip channel with probability p
 *     shrinks the y and z Bloch components by 1 − 2p — it destroys coherence.
 *     A misread destroys nothing; the qubit was in a definite basis state at
 *     the moment it was read, and no coherence was there to lose. Any circuit
 *     that measures mid-circuit and keeps going would then evolve a state the
 *     hardware never had.
 *
 *  2. **It cannot be asymmetric.** A single Pauli channel gives p0to1 =
 *     p1to0 by construction. Relaxation during readout is the dominant term on
 *     most hardware and it only goes one way, so the symmetric model gets the
 *     bias of the histogram wrong even when it gets the total error right.
 *     (The asymmetric map on the qubit *would* be amplitude damping — which is
 *     the point: readout error is not a channel, and the channel that has the
 *     same asymmetry is a physically different process with a different effect
 *     on everything except the diagonal.)
 *
 *  3. **It would be counted twice.** The state already went through T1 and T2
 *     during the circuit. Adding readout error to ρ adds a second, unrelated
 *     decoherence on top of it, while the real thing costs the state nothing
 *     at all.
 *
 * So this is a classical map, applied to the outcome and not to ρ: a 2×2
 * column-stochastic confusion matrix per qubit, tensored across the register
 * because readout electronics are per-qubit and their errors are independent.
 * (Correlated readout crosstalk exists on real chips. It is a full 2ⁿ × 2ⁿ
 * matrix, it cannot be factored, and it is out of scope for §3.3.)
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE WALK. Applying the tensor product means applying each qubit's 2×2 in
 * turn, and each one is the index pairing of `apply.ts`: for the pair of basis
 * states differing only in bit q,
 *
 *     P'(…0…) = (1 − p0to1)·P(…0…) +      p1to0 ·P(…1…)
 *     P'(…1…) =      p0to1 ·P(…0…) + (1 − p1to0)·P(…1…)
 *
 * O(n·2ⁿ) for the whole register, in place on the copy, no 2ⁿ × 2ⁿ matrix
 * anywhere near it. Total probability is preserved exactly the way trace is
 * preserved for a channel: each column of each 2×2 sums to 1, which is the
 * classical statement of the same conservation law, and the tests check it
 * with the same tolerance.
 *
 * OUT OF PLACE ON PURPOSE. §3.3's whole deliverable is the ideal distribution
 * beside the noisy one; a caller that had to clone first to keep the ideal one
 * would eventually forget to.
 */
export function applyReadoutError(
  distribution: Float64Array,
  errors: readonly ReadoutError[]
): Float64Array {
  const dim = distribution.length
  if (dim < 2 || (dim & (dim - 1)) !== 0) {
    throw new RangeError(
      `A distribution over basis states has 2ⁿ entries, got ${dim}.`
    )
  }
  // 2ⁿ → n without a log: the position of the only set bit.
  const qubits = 31 - Math.clz32(dim)

  const out = distribution.slice()
  const seen = new Set<number>()
  for (const error of errors) {
    if (
      !Number.isInteger(error.qubit) ||
      error.qubit < 0 ||
      error.qubit >= qubits
    ) {
      throw new RangeError(
        `Readout qubit ${error.qubit} is outside [0, ${qubits}).`
      )
    }
    if (seen.has(error.qubit)) {
      throw new RangeError(`Qubit ${error.qubit} has two readout errors.`)
    }
    seen.add(error.qubit)
    checkProbability(`readout p0to1 on qubit ${error.qubit}`, error.p0to1)
    checkProbability(`readout p1to0 on qubit ${error.qubit}`, error.p1to0)

    const stride = 1 << error.qubit
    const keep0 = 1 - error.p0to1
    const keep1 = 1 - error.p1to0
    for (let base = 0; base < dim; base += stride << 1) {
      for (let offset = 0; offset < stride; offset++) {
        const zero = base + offset
        const one = zero + stride
        const p0 = out[zero]
        const p1 = out[one]
        out[zero] = keep0 * p0 + error.p1to0 * p1
        out[one] = error.p0to1 * p0 + keep1 * p1
      }
    }
  }
  return out
}

/**
 * Corrupt one sampled outcome, bit by bit — the trajectories-mode counterpart
 * of `applyReadoutError`.
 *
 * `applyReadoutError` transforms a distribution, which is what analytic mode
 * has. A trajectories run has already drawn an integer and has an RNG in hand
 * (`measure.ts`), so there is nothing to transform: each qubit is flipped or
 * not with its own probability, n draws, no allocation. Averaged over shots
 * the two agree by construction — that equality is asserted in the tests,
 * because it is the only thing keeping the two modes from telling a user two
 * different stories about the same device.
 *
 * IT VALIDATES NOTHING, DELIBERATELY. This runs once per shot per qubit — ten
 * thousand shots on twelve wires is 120 000 calls into the body — and the
 * `errors` array is the same one for all of them, so a range check here would
 * be the same check repeated 120 000 times on an argument that cannot have
 * changed. The array comes from `readoutErrorsFor`, which validates, or is
 * handed to `applyReadoutError` for the ideal-vs-noisy comparison, which
 * validates; either way it has been checked once by the time a shot loop
 * starts. That is the same division `measure.ts` makes between `sampleShots`
 * and the guards around it.
 */
export function sampleReadout(
  outcome: number,
  errors: readonly ReadoutError[],
  rng: Rng
): number {
  let result = outcome
  for (const error of errors) {
    const bit = (result >> error.qubit) & 1
    const flipProbability = bit === 0 ? error.p0to1 : error.p1to0
    if (rng.next() < flipProbability) result ^= 1 << error.qubit
  }
  return result
}

/* ──────────────────────────── device profiles ───────────────────────────── */

/** The presets, as an array first so the union cannot drift from it. */
export const NOISE_PROFILE_IDS = [
  'ideal',
  'superconducting',
  'trappedIon',
  'teaching',
  'custom',
] as const

export type NoiseProfileId = (typeof NOISE_PROFILE_IDS)[number]

/**
 * A device, in the terms a device reports itself in.
 *
 * EVERY DURATION IS IN NANOSECONDS AND SAYS SO IN ITS NAME. Coherence times
 * are quoted in microseconds for superconducting qubits and in seconds for
 * trapped ions, gate times in nanoseconds and microseconds respectively, and a
 * profile mixing the two silently would produce channel parameters wrong by
 * three orders of magnitude while still returning a valid ρ. The unit is in
 * the identifier because that is the only place a reader always looks.
 *
 * Infinity is allowed for `t1Ns` and `t2Ns`, and it is the honest way to write
 * "this profile has no relaxation": it makes `ideal` a point in the same space
 * as the others rather than a special case with its own branch.
 */
export interface NoiseProfile {
  readonly id: NoiseProfileId
  /** T1, the energy relaxation time. */
  readonly t1Ns: number
  /**
   * T2, the total coherence time.
   *
   * Bounded by 2·T1 and the bound is not a convention: 1/T2 = 1/(2·T1) + 1/Tφ
   * with Tφ ≥ 0, so relaxation alone already costs half the coherence and no
   * amount of dephasing can give it back. A profile with T2 > 2·T1 is rejected
   * rather than clamped, because clamping would hide a units mistake — which is
   * how that value is produced in practice.
   */
  readonly t2Ns: number
  readonly oneQubitGateNs: number
  readonly twoQubitGateNs: number
  /**
   * Average error per one-qubit gate, as randomised benchmarking reports it:
   * r = 1 − F_avg.
   */
  readonly oneQubitGateError: number
  /** Average error per two-qubit gate, same convention. */
  readonly twoQubitGateError: number
  /** P(read 1 | prepared 0). */
  readonly readoutP0to1: number
  /** P(read 0 | prepared 1). */
  readonly readoutP1to0: number
}

/** Everything about a profile except which one it is. */
export type NoiseProfileValues = Omit<NoiseProfile, 'id'>

/**
 * A profile field that is not physical.
 *
 * Carries the field name and the value rather than only a sentence, for the
 * reason `DensityTooLargeError` does: the custom-profile panel has to say this
 * in three languages (D2), and it needs to know *which input* to mark.
 */
export class NoiseProfileError extends RangeError {
  readonly field: keyof NoiseProfileValues
  readonly value: number

  constructor(field: keyof NoiseProfileValues, value: number, why: string) {
    super(`Noise profile field "${field}" is ${value}: ${why}`)
    this.name = 'NoiseProfileError'
    this.field = field
    this.value = value
  }
}

/**
 * The presets of §3.3 — "predefined profiles that imitate real hardware".
 *
 * IMITATE, NOT REPRODUCE. Every number below is in the range published for its
 * class of device around the time of writing, and none of them is a specific
 * machine's calibration: a calibration is valid for the hours between one
 * recalibration and the next, and a simulator claiming to be a named backend
 * would be making a promise it cannot keep on any day but one. What the
 * profiles do promise is that the *relationships* are right — that the
 * two-qubit gate is an order of magnitude worse than the one-qubit gate, that
 * readout is worse than either, that T2 is below 2·T1, and that ions are slow
 * and coherent where transmons are fast and not.
 */
export const NOISE_PROFILES: Readonly<Record<NoiseProfileId, NoiseProfile>> = {
  /**
   * No noise at all. Not a device — the baseline the side-by-side comparison
   * of §3.3 is drawn against, and a useful assertion in its own right: with
   * this profile `channelsForGate` returns nothing, so the noisy path and the
   * unitary path are the same arithmetic and must agree to the last bit.
   */
  ideal: {
    id: 'ideal',
    t1Ns: Number.POSITIVE_INFINITY,
    t2Ns: Number.POSITIVE_INFINITY,
    oneQubitGateNs: 0,
    twoQubitGateNs: 0,
    oneQubitGateError: 0,
    twoQubitGateError: 0,
    readoutP0to1: 0,
    readoutP1to0: 0,
  },

  /**
   * A transmon-class device: fast gates, coherence in the hundred-microsecond
   * range, readout the worst operation on the chip by a wide margin.
   */
  superconducting: {
    id: 'superconducting',
    t1Ns: 100_000, // 100 µs
    t2Ns: 120_000, // 120 µs, comfortably inside the 200 µs bound
    oneQubitGateNs: 35,
    twoQubitGateNs: 300,
    oneQubitGateError: 3e-4,
    twoQubitGateError: 8e-3,
    readoutP0to1: 0.008,
    readoutP1to0: 0.02, // relaxation during integration; the asymmetry is real
  },

  /**
   * A trapped-ion device: coherence measured in seconds, gates measured in
   * microseconds. The ratio of gate time to T2 is far better than a transmon's
   * and the wall-clock throughput far worse, which is the trade the two
   * technologies actually make and the one this profile exists to show.
   */
  trappedIon: {
    id: 'trappedIon',
    t1Ns: 1e10, // 10 s — for a ground-state qubit this is effectively never
    t2Ns: 1e9, // 1 s
    oneQubitGateNs: 10_000, // 10 µs
    twoQubitGateNs: 200_000, // 200 µs
    oneQubitGateError: 1e-4,
    twoQubitGateError: 3e-3,
    readoutP0to1: 0.001,
    readoutP1to0: 0.003,
  },

  /**
   * Deliberately bad, and deliberately not a real machine.
   *
   * §3.3 is a study mode. On a good device a ten-gate teaching circuit loses
   * about one part in a thousand, which is invisible on a histogram and
   * teaches nobody anything. This profile is roughly thirty times noisier so
   * that a Bell pair visibly stops being a Bell pair inside a lesson, while
   * keeping every relationship above intact — including T2 < 2·T1 and a
   * benchmarked gate error above the coherence limit, so the derivation below
   * has something left over to attribute to control error.
   */
  teaching: {
    id: 'teaching',
    t1Ns: 20_000,
    t2Ns: 15_000,
    oneQubitGateNs: 50,
    twoQubitGateNs: 400,
    oneQubitGateError: 0.01,
    twoQubitGateError: 0.05,
    readoutP0to1: 0.03,
    readoutP1to0: 0.05,
  },

  /**
   * The starting point for §3.3's custom profile. Identical to
   * `superconducting` apart from its id, so the panel opens on something
   * plausible and every slider has somewhere sensible to start.
   */
  custom: {
    id: 'custom',
    t1Ns: 100_000,
    t2Ns: 120_000,
    oneQubitGateNs: 35,
    twoQubitGateNs: 300,
    oneQubitGateError: 3e-4,
    twoQubitGateError: 8e-3,
    readoutP0to1: 0.008,
    readoutP1to0: 0.02,
  },
}

/**
 * A validated custom profile: `base` with `overrides` applied, tagged
 * `custom`.
 *
 * Takes a base rather than starting from a hidden default, because the panel's
 * useful gesture is "this device, but with T1 halved" — a user who has to
 * supply all eight numbers to change one supplies seven of them wrong.
 */
export function customProfile(
  base: NoiseProfile,
  overrides: Partial<NoiseProfileValues> = {}
): NoiseProfile {
  const profile: NoiseProfile = { ...base, ...overrides, id: 'custom' }
  validateProfile(profile)
  return profile
}

/**
 * Throw unless every field is physical. Exported because the custom-profile
 * panel wants the answer before it recomputes anything, and because the
 * presets above are checked by it in the tests — a preset with a typo would
 * otherwise be the one profile nothing validates.
 *
 * THE TWO GATE ERRORS ARE BOUNDED MORE TIGHTLY THAN THE READOUT ONES, and the
 * asymmetry is the physics rather than caution. A readout error is a classifier
 * being wrong and every value in [0, 1] describes one. A benchmarked *gate*
 * error is converted to a depolarising parameter downstream, and the conversion
 * saturates well before 1 — see `MAX_ONE_QUBIT_GATE_ERROR` and
 * `MAX_TWO_QUBIT_GATE_ERROR`. Checking it here rather than only inside the
 * conversions is what lets the panel mark the offending input in the frame the
 * reader types it, instead of the worker throwing mid-run.
 */
export function validateProfile(profile: NoiseProfile): void {
  checkCoherenceTime('t1Ns', profile.t1Ns)
  checkCoherenceTime('t2Ns', profile.t2Ns)
  checkGateDuration('oneQubitGateNs', profile.oneQubitGateNs)
  checkGateDuration('twoQubitGateNs', profile.twoQubitGateNs)
  checkRate('oneQubitGateError', profile.oneQubitGateError)
  checkRate('twoQubitGateError', profile.twoQubitGateError)
  checkGateErrorCeiling(
    'oneQubitGateError',
    profile.oneQubitGateError,
    MAX_ONE_QUBIT_GATE_ERROR,
    `a one-qubit error rate above ${MAX_ONE_QUBIT_GATE_ERROR} cannot be ` +
      `produced by a depolarising channel: r = p/2, so the worst case is the ` +
      `fully depolarising p = 1 and its average infidelity is one half.`
  )
  checkGateErrorCeiling(
    'twoQubitGateError',
    profile.twoQubitGateError,
    MAX_TWO_QUBIT_GATE_ERROR,
    `a two-qubit error rate above ${MAX_TWO_QUBIT_GATE_ERROR} cannot be ` +
      `produced by one-qubit depolarising on both wires; the pair would be ` +
      `more than fully mixed.`
  )
  checkRate('readoutP0to1', profile.readoutP0to1)
  checkRate('readoutP1to0', profile.readoutP1to0)
  if (profile.t2Ns > 2 * profile.t1Ns) {
    throw new NoiseProfileError(
      't2Ns',
      profile.t2Ns,
      `T2 cannot exceed 2·T1 (${2 * profile.t1Ns} ns here). 1/T2 = 1/(2·T1) ` +
        `+ 1/Tφ with Tφ ≥ 0, so relaxation alone caps the coherence time; a ` +
        `larger T2 usually means the two were entered in different units.`
    )
  }
}

/* ───────────────────── datasheet numbers → channel parameters ───────────── */

/** What a stretch of idling or a gate duration costs a qubit. */
export interface RelaxationParameters {
  /** γ for `amplitudeDampingChannel` — the T1 part. */
  readonly gamma: number
  /** λ for `phaseDampingChannel` — the pure-dephasing part of T2. */
  readonly lambda: number
}

/**
 * T1, T2 and a duration → the amplitude- and phase-damping parameters.
 *
 * THE CONVERSION, DERIVED. Solving the Lindblad equation for a single qubit
 * with relaxation and pure dephasing gives an exponential decay of the
 * population and of the coherence:
 *
 *     ρ₁₁(t) = e^{−t/T₁}·ρ₁₁(0)          ρ₀₁(t) = e^{−t/T₂}·ρ₀₁(0)
 *
 * Amplitude damping alone reproduces the first line with
 *
 *     1 − γ = e^{−t/T₁}   ⟹   γ = 1 − e^{−t/T₁}
 *
 * and, as a side effect, carries the coherence down by √(1−γ) = e^{−t/(2T₁)}.
 * That is the relation behind the T2 ≤ 2·T1 bound: relaxation *alone* already
 * decoheres at half the rate it depopulates. Whatever is left over is pure
 * dephasing, and phase damping has to supply exactly it:
 *
 *     √(1−λ) = e^{−t/T₂} / e^{−t/(2T₁)} = e^{−t·(1/T₂ − 1/(2T₁))} = e^{−t/Tφ}
 *     ⟹  λ = 1 − e^{−2t/Tφ},   with  1/Tφ = 1/T₂ − 1/(2T₁)
 *
 * Applying the two channels in that order composes the two decays, and the
 * coherence ends at e^{−t/(2T₁)}·e^{−t/Tφ} = e^{−t/T₂} as required. The
 * relation 1/T2 = 1/(2·T1) + 1/Tφ is the standard decomposition — see, e.g.,
 * Nielsen & Chuang §8.3 for the two channels, and Krantz et al., *A Quantum
 * Engineer's Guide to Superconducting Qubits*, Appl. Phys. Rev. 6, 021318
 * (2019), §III for the T1/T2/Tφ relation as hardware reports it.
 *
 * THE DEPHASING RATE IS COMPUTED AS A RATE, never as a Tφ. `1/T₂ − 1/(2T₁)` is
 * exactly zero when T2 = 2·T1, and inverting that to get Tφ = ∞ and then
 * dividing by it again would put an Infinity and a division by zero in the
 * path of the most common well-behaved case in the file.
 */
export function relaxationFor(
  t1Ns: number,
  t2Ns: number,
  durationNs: number
): RelaxationParameters {
  checkCoherenceTime('t1Ns', t1Ns)
  checkCoherenceTime('t2Ns', t2Ns)
  if (!Number.isFinite(durationNs) || durationNs < 0) {
    throw new RangeError(
      `A duration must be finite and ≥ 0, got ${durationNs}.`
    )
  }
  if (t2Ns > 2 * t1Ns) {
    throw new NoiseProfileError(
      't2Ns',
      t2Ns,
      `T2 cannot exceed 2·T1 (${2 * t1Ns} ns here).`
    )
  }

  const gamma = clampUnit(1 - Math.exp(-durationNs / t1Ns))
  const dephasingRate = 1 / t2Ns - 1 / (2 * t1Ns)
  const lambda = clampUnit(1 - Math.exp(-2 * durationNs * dephasingRate))
  return { gamma, lambda }
}

/**
 * The average gate infidelity a relaxation pair costs on its own — the number
 * that has to be *subtracted* from a benchmarked error rate before the rest
 * can be blamed on control.
 *
 * For a one-qubit map whose Bloch action is r → M·r + c,
 *
 *     F_avg = ½ + (M_xx + M_yy + M_zz) / 6
 *
 * (the affine shift c does not enter, which is why an amplitude-damping
 * channel and a depolarising one can share an infidelity while doing visibly
 * different things). Amplitude damping contributes M_xx = M_yy = √(1−γ),
 * M_zz = 1−γ; phase damping contributes √(1−λ), √(1−λ), 1. Composed:
 *
 *     r = 1 − F_avg = ½ − ( 2·√((1−γ)(1−λ)) + (1−γ) ) / 6
 *
 * which is (2γ + λ)/6 to first order, and is used exactly rather than to first
 * order because the teaching profile is not in the first-order regime.
 */
export function relaxationInfidelity(gamma: number, lambda: number): number {
  const surviving = Math.sqrt((1 - gamma) * (1 - lambda))
  return 0.5 - (2 * surviving + (1 - gamma)) / 6
}

/**
 * The largest one-qubit benchmarked error rate a depolarising channel can
 * reproduce: r = p/2 at p = 1, so r = 1/2.
 *
 * This is where the *model* runs out, not where the arithmetic does. Past it
 * `2r` is still a finite number and still clamps to a valid probability — see
 * the guard below for why that clamp was the bug.
 */
export const MAX_ONE_QUBIT_GATE_ERROR = 0.5

/**
 * The largest two-qubit benchmarked error rate D_p ⊗ D_p can reproduce.
 *
 * p ≤ 1 ⟺ 4(1 − √(1 − 5r/4))/3 ≤ 1 ⟺ √(1 − 5r/4) ≥ 1/4 ⟺ r ≤ 3/4, and 3/4 is
 * exactly the average infidelity of the maximally mixing pair channel. The
 * square root stays real up to 4/5, which is a different and larger number —
 * confusing the two is the bug the guard below is written against.
 */
export const MAX_TWO_QUBIT_GATE_ERROR = 0.75

/**
 * A benchmarked one-qubit error rate → the depolarising p that reproduces it.
 *
 * For a depolarising channel in dimension d the average gate infidelity is
 * r = (d−1)/d · p — the standard relation between the randomised-benchmarking
 * number a device reports and the depolarising parameter a simulator wants
 * (Nielsen, *A simple formula for the average gate fidelity*, Phys. Lett. A
 * 303, 249 (2002)). At d = 2 that is r = p/2, so p = 2r.
 *
 * THE DOMAIN IS [0, 1/2], NOT [0, 1], AND THE DIFFERENCE WAS A WRONG NUMBER.
 * `checkRate` admits every probability, because a *probability* is what the
 * field holds; but r = p/2 wants p = 2r, and a p above 1 is not a probability.
 * `clampUnit` used to absorb that silently, so a caller reporting r = 0.55 got
 * p = 1 — a channel whose average infidelity is 0.5 — and r = 0.6, 0.8 and 1.0
 * all collapsed onto the same channel modelling 0.5. Nothing threw, nothing
 * reached the UI, and the histogram that came out was normalised, plausible and
 * understating the reported error by up to a factor of two: precisely the
 * failure mode this module's header is written against.
 *
 * So the ceiling is refused rather than clamped, with the same typed error
 * `localDepolarizingFromPairError` has always raised for its own out-of-range
 * rate — `NoiseProfileError` carries the field, so the custom-profile panel can
 * mark the input that produced it (D2). `validateProfile` checks the same bound
 * up front, so a profile never reaches here to fail.
 */
export function depolarizingFromGateError(errorRate: number): number {
  checkRate('oneQubitGateError', errorRate)
  checkGateErrorCeiling(
    'oneQubitGateError',
    errorRate,
    MAX_ONE_QUBIT_GATE_ERROR,
    `a one-qubit error rate above ${MAX_ONE_QUBIT_GATE_ERROR} cannot be ` +
      `produced by a depolarising channel: r = p/2, so the worst case is the ` +
      `fully depolarising p = 1 and its average infidelity is one half.`
  )
  return clampUnit(2 * errorRate)
}

/**
 * A benchmarked *two-qubit* error rate → the depolarising p to apply to **each
 * of the two qubits separately**.
 *
 * WHY NOT A TWO-QUBIT CHANNEL. A genuine two-qubit depolarising channel needs
 * the sixteen two-qubit Paulis and a 4×4 Kraus set. §3.3 asks for one-qubit
 * channels, and the local model — the same one-qubit channel on both wires — is
 * the standard approximation. It is an approximation: D_p ⊗ D_p is not
 * depolarising on the pair, because it damps a weight-2 Pauli by (1−p)² and a
 * weight-1 Pauli by (1−p), where the true channel damps all fifteen equally.
 * The tests hold it to reproducing the reported *infidelity*, which is what it
 * is calibrated to, and nothing more.
 *
 * THE CONVERSION, DERIVED. The Pauli transfer matrix of D_p ⊗ D_p is diagonal
 * with entry (1−p)^w on the two-qubit Pauli of weight w: one of weight 0, six
 * of weight 1, nine of weight 2. With u = 1−p the process fidelity is
 *
 *     F_pro = (1 + 6u + 9u²)/16 = ((1 + 3u)/4)²
 *
 * and F_avg = (d·F_pro + 1)/(d+1) at d = 4 gives r = 1 − F_avg = (4/5)(1 −
 * F_pro). Inverting,
 *
 *     p = 4·(1 − √(1 − 5r/4)) / 3
 *
 * which is 5r/6 to first order — the reading that says "the pair's error, split
 * between two qubits, costs each of them a bit more than half of it", because
 * a Pauli error on either wire is an error on the pair.
 *
 * THE CEILING IS 3/4, NOT 4/5, AND THE DIFFERENCE WAS A WRONG NUMBER. Two
 * thresholds live in that formula and they are not the same one. The square
 * root goes imaginary at r = 4/5; the *model* runs out earlier, at the r where
 * p reaches 1 — √(1 − 5r/4) = 1/4, i.e. r = 3/4, which is exactly the average
 * infidelity of the maximally mixing pair channel D_1 ⊗ D_1. Guarding at 4/5
 * and clamping p at 1 meant every reported rate in (3/4, 4/5] was accepted and
 * silently modelled as 3/4: neither reproduced nor refused. The guard now sits
 * where the model ends, which is also where the guard's own sentence — "the
 * pair would be more than fully mixed" — has been true all along.
 */
export function localDepolarizingFromPairError(errorRate: number): number {
  checkRate('twoQubitGateError', errorRate)
  checkGateErrorCeiling(
    'twoQubitGateError',
    errorRate,
    MAX_TWO_QUBIT_GATE_ERROR,
    `a two-qubit error rate above ${MAX_TWO_QUBIT_GATE_ERROR} cannot be ` +
      `produced by one-qubit depolarising on both wires; the pair would be ` +
      `more than fully mixed.`
  )
  // 1 − 5r/4 at the ceiling r = 3/4 is 1/16 exactly — every term is a power of
  // two, so the boundary case lands on p = 1 with no rounding to absorb.
  const inside = 1 - (5 * errorRate) / 4
  return clampUnit((4 * (1 - Math.sqrt(inside))) / 3)
}

/**
 * The channels to apply to **each qubit a gate touched**, derived from the
 * profile.
 *
 * WHAT IS COMPOSED, AND WHY IN THIS ORDER. A gate of duration t on a device
 * with T1 and T2 costs, unavoidably, the relaxation of that duration; whatever
 * the benchmark reports *beyond* that is miscalibration, crosstalk and control
 * error, which depolarising is the honest stand-in for. So:
 *
 *   1. depolarising with the residual p, then
 *   2. amplitude damping with γ, then
 *   3. phase damping with λ.
 *
 * Relaxation last because it is the part that is happening while the pulse
 * plays, and putting the isotropic term first keeps the composition in the
 * order a Lindblad integration would produce it. The three do not commute in
 * general, but they differ only at second order in the parameters, which is
 * well below the accuracy any of these numbers has.
 *
 * NO DOUBLE COUNTING. The benchmarked error rate already *includes* the
 * relaxation that happened during the gate — that is what benchmarking
 * measures. Applying both channels at face value would count it twice, which
 * for the two-qubit gate of the teaching profile would be a factor of two on
 * the dominant error term. So the relaxation's own average infidelity is
 * converted to a depolarising parameter (`p = 2r`, the same relation as above,
 * run backwards) and subtracted. Where the reported rate is *below* the
 * coherence limit — which happens with an invented profile, and with a real
 * one means the benchmark and the T1 were measured on different days — the
 * residual clamps to zero and the relaxation stands alone. That clamp is why
 * the subtraction cannot make a channel with a negative parameter.
 *
 * ZERO-PARAMETER CHANNELS ARE DROPPED, and that is exact rather than an
 * optimisation: every constructor above yields the identity operator plus
 * zeros at parameter 0, so applying it is a no-op to the last bit (the tests
 * assert bit-for-bit equality, not approximate). Dropping them is what makes
 * `NOISE_PROFILES.ideal` produce an empty list and the noisy path collapse
 * onto the unitary one.
 */
export function channelsForGate(
  profile: NoiseProfile,
  arity: 1 | 2
): readonly KrausChannel[] {
  validateProfile(profile)
  const duration = arity === 1 ? profile.oneQubitGateNs : profile.twoQubitGateNs
  const { gamma, lambda } = relaxationFor(profile.t1Ns, profile.t2Ns, duration)

  const benchmarked =
    arity === 1
      ? depolarizingFromGateError(profile.oneQubitGateError)
      : localDepolarizingFromPairError(profile.twoQubitGateError)
  const fromRelaxation = 2 * relaxationInfidelity(gamma, lambda)
  const residual = clampUnit(Math.max(0, benchmarked - fromRelaxation))

  const channels: KrausChannel[] = []
  if (residual > 0) channels.push(depolarizingChannel(residual))
  if (gamma > 0) channels.push(amplitudeDampingChannel(gamma))
  if (lambda > 0) channels.push(phaseDampingChannel(lambda))
  return channels
}

/**
 * What idling for `durationNs` costs a qubit that no gate touched.
 *
 * Separate from `channelsForGate` because the two answer different questions
 * and only one of them has a benchmark behind it: an idle qubit accrues
 * relaxation and nothing else, since there is no pulse to be miscalibrated.
 * Whether a given column counts as idle is the runner's judgement and not this
 * module's.
 */
export function channelsForIdle(
  profile: NoiseProfile,
  durationNs: number
): readonly KrausChannel[] {
  validateProfile(profile)
  const { gamma, lambda } = relaxationFor(
    profile.t1Ns,
    profile.t2Ns,
    durationNs
  )
  const channels: KrausChannel[] = []
  if (gamma > 0) channels.push(amplitudeDampingChannel(gamma))
  if (lambda > 0) channels.push(phaseDampingChannel(lambda))
  return channels
}

/**
 * The profile's readout error, for every qubit of a register.
 *
 * One entry per qubit with the same pair of probabilities: a profile describes
 * a class of device, not a chip with a calibration per qubit. A caller with
 * per-qubit numbers builds the array itself — `applyReadoutError` never reads
 * a profile, only the array.
 */
export function readoutErrorsFor(
  profile: NoiseProfile,
  qubitCount: number
): readonly ReadoutError[] {
  validateProfile(profile)
  if (!Number.isInteger(qubitCount) || qubitCount < 0) {
    throw new RangeError(
      `A register has a non-negative integer number of qubits, got ` +
        `${qubitCount}.`
    )
  }
  const out: ReadoutError[] = []
  for (let qubit = 0; qubit < qubitCount; qubit++) {
    out.push({
      qubit,
      p0to1: profile.readoutP0to1,
      p1to0: profile.readoutP1to0,
    })
  }
  return out
}

/* ──────────────────────────────── guards ────────────────────────────────── */

/**
 * `factor · matrix`, into a fresh buffer.
 *
 * The multiplication is exact when `factor` is 1 and every entry is 0 or ±1,
 * which is what makes a channel at parameter 0 the exact identity rather than
 * the identity to within an ulp.
 */
function scaledMatrix(matrix: Matrix2, factor: number): Matrix2 {
  const out = new Float64Array(8)
  for (let i = 0; i < 8; i++) out[i] = matrix[i] * factor
  return out
}

function checkProbability(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      `${name} must be a probability in [0, 1], got ${value}.`
    )
  }
}

function checkOperator(matrix: Matrix2): void {
  if (matrix.length !== 8) {
    throw new RangeError(
      `A one-qubit Kraus operator is a 2×2 (8 doubles), got ${matrix.length}. ` +
        `See the layout in gates.ts.`
    )
  }
}

function checkQubit(rho: DensityMatrix, qubit: number): void {
  if (!Number.isInteger(qubit) || qubit < 0 || qubit >= rho.qubits) {
    throw new RangeError(
      `Noise target qubit ${qubit} is outside [0, ${rho.qubits}).`
    )
  }
}

/**
 * A coherence time: strictly positive nanoseconds, or Infinity.
 *
 * Zero is rejected rather than treated as "instantly decohered": `1 − e^{−t/0}`
 * is NaN for t = 0 and 1 otherwise, so the one value a caller might mean by it
 * is the one the arithmetic cannot express. Infinity is allowed and means no
 * relaxation — see `NoiseProfile`.
 */
function checkCoherenceTime(
  field: keyof NoiseProfileValues,
  value: number
): void {
  const positiveFinite = Number.isFinite(value) && value > 0
  if (!(positiveFinite || value === Number.POSITIVE_INFINITY)) {
    throw new NoiseProfileError(
      field,
      value,
      'a coherence time is a strictly positive number of nanoseconds, or ' +
        'Infinity for a profile with no relaxation.'
    )
  }
}

/** A gate duration: finite, ≥ 0. Zero is legal — it is what `ideal` uses. */
function checkGateDuration(
  field: keyof NoiseProfileValues,
  value: number
): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new NoiseProfileError(
      field,
      value,
      'a gate duration is a finite non-negative number of nanoseconds.'
    )
  }
}

function checkRate(field: keyof NoiseProfileValues, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new NoiseProfileError(
      field,
      value,
      'an error probability lies in [0, 1].'
    )
  }
}

/**
 * A benchmarked gate error the depolarising stand-in can actually reproduce.
 *
 * Separate from `checkRate` because the two bounds answer different questions
 * and only one of them is about probability. A *readout* error of 0.9 is a
 * terrible detector and a perfectly expressible one; a *gate* error of 0.9 is a
 * number no depolarising channel has, and the difference is the whole reason
 * this function exists. Clamping instead would return a channel modelling a
 * smaller error than the caller reported, with nothing thrown and nothing to
 * see — which is exactly the quiet wrong number §3.3 cannot afford.
 */
function checkGateErrorCeiling(
  field: keyof NoiseProfileValues,
  value: number,
  ceiling: number,
  why: string
): void {
  if (value > ceiling) throw new NoiseProfileError(field, value, why)
}

/**
 * Pull a parameter back inside [0, 1].
 *
 * Only ever moves a value by rounding error, and every caller is responsible
 * for keeping that true. `1 − exp(−x)` for x ≥ 0 is mathematically in [0, 1),
 * the subtraction of two infidelities is clamped at zero before it gets here,
 * and the two datasheet conversions refuse an out-of-range rate *before*
 * calling this rather than letting it absorb one. That last point is not a
 * style rule: a clamp reached with a genuinely out-of-range parameter is a
 * channel modelling less error than the caller reported, returned in silence.
 *
 * It exists because a parameter of −1e-17 reaches `Math.sqrt` as NaN and a NaN
 * in a Kraus operator poisons 4ⁿ entries with nothing left to say where it came
 * from.
 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Derived a non-finite channel parameter: ${value}.`)
  }
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
