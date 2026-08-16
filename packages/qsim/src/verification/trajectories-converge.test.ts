/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — TRAJECTORIES-CONVERGE LENS.
 *
 * The noise milestone ships two answers to the same question. `runNoisyDensity`
 * carries the whole ensemble in a 4ⁿ matrix and evaluates Σₖ Kₖ ρ Kₖ†;
 * `runNoisy` carries one 2ⁿ statevector per shot and *draws* an operator. They
 * are supposed to agree — the second one only up to the sampling error its shot
 * count implies. This file is the check that they do, and that they agree with
 * a third answer that shares no code with either.
 *
 * NOTHING HERE IS DERIVED FROM THE IMPLEMENTATION. The oracle below is a
 * deliberately slow dense reference written from the definitions:
 *
 *   - a complex matrix is `dim × dim` with an O(dim³) multiply, no strides and
 *     no index pairing anywhere in it;
 *   - a one-qubit operator on wire t is embedded by enumerating basis states
 *     and moving bit t, straight from D1 ("qubit 0 is the least significant
 *     bit") — the engine's flat `Matrix2` layout is never read;
 *   - the Kraus operators are rebuilt from §5.4 as explicit 2×2 matrices;
 *   - a channel is ρ → Σₖ Kₖ ρ Kₖ† by dense multiplication of full 2ⁿ × 2ⁿ
 *     matrices, which is exactly the construction §5.2 forbids the engine from
 *     using and therefore exactly the one that can disagree with it;
 *   - readout error is a brute-force sum over all (prepared, read) pairs with
 *     the per-qubit conditional probabilities multiplied out.
 *
 * The oracle is itself checked before anything rests on it: at zero noise its
 * distribution must equal an ordinary analytic `run()`, which is what pins the
 * gate conventions and the bit ordering of the embedding rather than assuming
 * them.
 *
 * WHAT THIS LENS IS HUNTING FOR
 *
 *  1. **A sampler that ignores the state.** pₖ = ‖Kₖ|ψ⟩‖² is a function of ψ.
 *     A uniform draw over the operators is the single most plausible wrong
 *     implementation: it returns normalised states, a normalised histogram and
 *     a perfectly believable noisy distribution. On amplitude damping at
 *     γ = 0.05 it reports an emission rate of ½ instead of 0.05 — a device ten
 *     times worse than the profile, with nothing thrown. So the weights are
 *     read against a dense ‖K|ψ⟩‖² on states chosen to separate the two
 *     (|0⟩ where p₁ = 0, |1⟩ where p₁ = γ, a superposition where p₁ = γ·sin²,
 *     and a Bell pair where p₁ = γ/2 with no product form at all), and the
 *     *drawn* frequencies are checked too — a correct weight vector that is
 *     then sampled uniformly would pass the first check alone.
 *
 *  2. **A fast path that is not the slow path.** Pauli channels take a
 *     state-independent branch. If those cached weights were wrong the general
 *     reading would still be right and only the draws would move, so the two
 *     are compared directly on random states.
 *
 *  3. **A trajectory average that is not the channel.** The two paths are run
 *     against each other and against the oracle on five channels, several
 *     parameters, three device profiles, entangled circuits, a circuit with a
 *     reset (where the density path uses amplitude damping at γ = 1 and the
 *     trajectory path measures and flips — different arithmetic, same map) and
 *     a pooled multi-seed estimate that would expose a bias too small for one
 *     seed to resolve.
 *
 *  4. **A noiseless limit that is only approximately noiseless.** At the ideal
 *     profile every channel has parameter 0 and is dropped, so the claim is
 *     bit-for-bit equality with a clean run and not closeness. It is checked as
 *     equality, including that the noisy path consumes the RNG stream at
 *     exactly the same points — a stray draw would leave the physics right and
 *     the reproducibility guarantee false.
 *
 *  5. **A seed that does not seed.** Same seed twice must be identical; two
 *     different seeds must actually differ.
 *
 * THE STATISTICAL BOUND, AND WHY IT IS NOT TUNED. A count over N shots of an
 * outcome with exact probability p is Binomial(N, p), so its standard error is
 * √(N·p·(1−p)). Every frequency assertion below allows
 *
 *     |observed − N·p|  ≤  5·√(N·p·(1−p)) + 6
 *
 * The 5σ term is the Gaussian bound (a two-sided excursion has probability
 * 6e-7); the additive 6 covers the small-mean regime where the Gaussian
 * approximation is not available — for a Poisson mean of 1 the bound is 12, and
 * P(X ≥ 12) is about 1e-9. Every seed here is fixed, so these are deterministic
 * assertions: they pass or they report a real disagreement, and they were not
 * widened to make anything pass.
 */

import { describe, expect, it } from 'vitest'

import { formatKet } from '../conventions.js'
import {
  fromStatevector as densityFromStatevector,
  probabilities as densityProbabilities,
} from '../density.js'
import { probabilities as stateProbabilities } from '../measure.js'
import {
  NOISE_PROFILES,
  amplitudeDampingChannel,
  applyChannel,
  applyChannels,
  bitFlipChannel,
  channelFor,
  channelsForGate,
  customProfile,
  depolarizingChannel,
  phaseDampingChannel,
  phaseFlipChannel,
} from '../noise.js'
import type { KrausChannel, NoiseProfile } from '../noise.js'
import { createRng } from '../rng.js'
import type { Rng } from '../rng.js'
import { run, runNoisy, runNoisyDensity, runTrajectory } from '../runner.js'
import type { CircuitLike, OperationLike } from '../runner.js'
import { alloc as stateAlloc } from '../statevector.js'
import type { Statevector } from '../statevector.js'
import {
  applyTrajectoryChannels,
  krausWeights,
  prepareChannel,
  prepareChannels,
  sampleKraus,
} from '../trajectories.js'
import { alloc as densityAllocFor } from '../density.js'
import type { DensityMatrix } from '../density.js'

/* ═══════════════════════ the oracle: dense, slow, mine ═══════════════════ */

/** A complex number as a pair. Nested arrays on purpose — see the header. */
type C = readonly [number, number]

/** A 2×2 complex matrix, written the way §5.4 writes one. */
type M2 = readonly [readonly [C, C], readonly [C, C]]

/** A dense `dim × dim` complex matrix, row-major, real and imaginary apart. */
interface Dense {
  readonly dim: number
  readonly re: Float64Array
  readonly im: Float64Array
}

function denseZero(dim: number): Dense {
  return {
    dim,
    re: new Float64Array(dim * dim),
    im: new Float64Array(dim * dim),
  }
}

/** Textbook O(dim³) multiply. No structure exploited, and that is the point. */
function denseMul(a: Dense, b: Dense): Dense {
  const dim = a.dim
  const out = denseZero(dim)
  for (let i = 0; i < dim; i++) {
    for (let k = 0; k < dim; k++) {
      const ar = a.re[i * dim + k]
      const ai = a.im[i * dim + k]
      for (let j = 0; j < dim; j++) {
        const br = b.re[k * dim + j]
        const bi = b.im[k * dim + j]
        out.re[i * dim + j] += ar * br - ai * bi
        out.im[i * dim + j] += ar * bi + ai * br
      }
    }
  }
  return out
}

function denseDagger(a: Dense): Dense {
  const dim = a.dim
  const out = denseZero(dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      out.re[j * dim + i] = a.re[i * dim + j]
      out.im[j * dim + i] = -a.im[i * dim + j]
    }
  }
  return out
}

function denseAddInto(target: Dense, source: Dense): void {
  for (let i = 0; i < target.re.length; i++) {
    target.re[i] += source.re[i]
    target.im[i] += source.im[i]
  }
}

/**
 * Embed a 2×2 on wire `target` of an `qubits`-wire register.
 *
 * Built column by column from the action on a basis state, which is the
 * statement of D1 rather than a restatement of the engine's stride arithmetic:
 * basis state `col` has bit `b = (col >> target) & 1` on that wire, and the
 * operator sends it to Σ_row m[row][b] · |col with bit target replaced by row⟩.
 */
function embed(qubits: number, m: M2, target: number): Dense {
  const dim = 1 << qubits
  const out = denseZero(dim)
  for (let col = 0; col < dim; col++) {
    const b = (col >> target) & 1
    for (let row = 0; row < 2; row++) {
      const r = (col & ~(1 << target)) | (row << target)
      out.re[r * dim + col] = m[row][b][0]
      out.im[r * dim + col] = m[row][b][1]
    }
  }
  return out
}

interface RefControl {
  readonly qubit: number
  readonly state: 0 | 1
}

/**
 * Embed a controlled 2×2: the identity on every basis state whose controls do
 * not read their required value, and `m` on the target otherwise.
 */
function embedControlled(
  qubits: number,
  m: M2,
  target: number,
  controls: readonly RefControl[]
): Dense {
  const dim = 1 << qubits
  const out = denseZero(dim)
  for (let col = 0; col < dim; col++) {
    const active = controls.every(
      (control) => ((col >> control.qubit) & 1) === control.state
    )
    if (!active) {
      out.re[col * dim + col] = 1
      continue
    }
    const b = (col >> target) & 1
    for (let row = 0; row < 2; row++) {
      const r = (col & ~(1 << target)) | (row << target)
      out.re[r * dim + col] = m[row][b][0]
      out.im[r * dim + col] = m[row][b][1]
    }
  }
  return out
}

/** SWAP as a permutation of basis states: exchange bits q0 and q1. */
function embedSwap(qubits: number, q0: number, q1: number): Dense {
  const dim = 1 << qubits
  const out = denseZero(dim)
  for (let col = 0; col < dim; col++) {
    const b0 = (col >> q0) & 1
    const b1 = (col >> q1) & 1
    let row = col & ~(1 << q0) & ~(1 << q1)
    row |= b1 << q0
    row |= b0 << q1
    out.re[row * dim + col] = 1
  }
  return out
}

/** ρ → U ρ U†, densely. */
function conjugate(rho: Dense, u: Dense): Dense {
  return denseMul(denseMul(u, rho), denseDagger(u))
}

/** ρ → Σₖ Kₖ ρ Kₖ† for one-qubit operators on `target`, densely. */
function refApplyChannel(
  rho: Dense,
  operators: readonly M2[],
  target: number,
  qubits: number
): Dense {
  const out = denseZero(rho.dim)
  for (const operator of operators) {
    const k = embed(qubits, operator, target)
    denseAddInto(out, conjugate(rho, k))
  }
  return out
}

/* ─────────────────── the Kraus operators, from §5.4 ──────────────────── */

const REF_I: M2 = [
  [
    [1, 0],
    [0, 0],
  ],
  [
    [0, 0],
    [1, 0],
  ],
]
const REF_X: M2 = [
  [
    [0, 0],
    [1, 0],
  ],
  [
    [1, 0],
    [0, 0],
  ],
]
const REF_Y: M2 = [
  [
    [0, 0],
    [0, -1],
  ],
  [
    [0, 1],
    [0, 0],
  ],
]
const REF_Z: M2 = [
  [
    [1, 0],
    [0, 0],
  ],
  [
    [0, 0],
    [-1, 0],
  ],
]

function scale2(m: M2, factor: number): M2 {
  return [
    [
      [m[0][0][0] * factor, m[0][0][1] * factor],
      [m[0][1][0] * factor, m[0][1][1] * factor],
    ],
    [
      [m[1][0][0] * factor, m[1][0][1] * factor],
      [m[1][1][0] * factor, m[1][1][1] * factor],
    ],
  ]
}

/** A real 2×2, spelled out. Used for the two damping channels. */
function real2(a: number, b: number, c: number, d: number): M2 {
  return [
    [
      [a, 0],
      [b, 0],
    ],
    [
      [c, 0],
      [d, 0],
    ],
  ]
}

/**
 * The five channels of §3.3, rebuilt from their definitions.
 *
 * Depolarising is §5.4's list verbatim. Amplitude damping is §5.4's pair.
 * Phase damping is the pair that leaves the populations alone and carries the
 * coherence down by √(1−λ); bit and phase flip are the two Pauli mixtures. Each
 * is written here so that a coefficient error in `noise.ts` has something to
 * disagree with — and the closed forms are asserted separately below, so a
 * shared misreading of the definitions would still be caught.
 */
function refOperators(kind: string, parameter: number): readonly M2[] {
  switch (kind) {
    case 'depolarizing': {
      const identity = Math.sqrt(1 - (3 * parameter) / 4)
      const pauli = Math.sqrt(parameter / 4)
      return [
        scale2(REF_I, identity),
        scale2(REF_X, pauli),
        scale2(REF_Y, pauli),
        scale2(REF_Z, pauli),
      ]
    }
    case 'amplitudeDamping':
      return [
        real2(1, 0, 0, Math.sqrt(1 - parameter)),
        real2(0, Math.sqrt(parameter), 0, 0),
      ]
    case 'phaseDamping':
      return [
        real2(1, 0, 0, Math.sqrt(1 - parameter)),
        real2(0, 0, 0, Math.sqrt(parameter)),
      ]
    case 'bitFlip':
      return [
        scale2(REF_I, Math.sqrt(1 - parameter)),
        scale2(REF_X, Math.sqrt(parameter)),
      ]
    case 'phaseFlip':
      return [
        scale2(REF_I, Math.sqrt(1 - parameter)),
        scale2(REF_Z, Math.sqrt(parameter)),
      ]
    default:
      throw new Error(`The oracle has no operators for "${kind}".`)
  }
}

/** The oracle's reading of a channel the engine built: kind and parameter only. */
function refOperatorsOf(channel: KrausChannel): readonly M2[] {
  return refOperators(channel.kind, channel.parameter)
}

/* ────────────────────── the gates, from their definitions ────────────────── */

const SQRT_HALF = Math.SQRT1_2

function refGateMatrix(operation: OperationLike): M2 {
  const angle = (): number => {
    const first = operation.params?.[0]
    if (typeof first !== 'number') {
      throw new Error(`The oracle only takes literal angles, got ${first}.`)
    }
    return first
  }
  switch (operation.gate) {
    case 'x':
      return REF_X
    case 'y':
      return REF_Y
    case 'z':
      return REF_Z
    case 'h':
      return [
        [
          [SQRT_HALF, 0],
          [SQRT_HALF, 0],
        ],
        [
          [SQRT_HALF, 0],
          [-SQRT_HALF, 0],
        ],
      ]
    case 's':
      return [
        [
          [1, 0],
          [0, 0],
        ],
        [
          [0, 0],
          [0, 1],
        ],
      ]
    case 't':
      return [
        [
          [1, 0],
          [0, 0],
        ],
        [
          [0, 0],
          [SQRT_HALF, SQRT_HALF],
        ],
      ]
    case 'ry': {
      // Ry(θ) = exp(−iθY/2) = [[cos, −sin], [sin, cos]] at the half angle.
      const c = Math.cos(angle() / 2)
      const s = Math.sin(angle() / 2)
      return real2(c, -s, s, c)
    }
    default:
      throw new Error(`The oracle has no matrix for "${operation.gate}".`)
  }
}

function refControlsOf(operation: OperationLike): readonly RefControl[] {
  const controls = operation.controls ?? []
  return controls.map((control) =>
    typeof control === 'number'
      ? { qubit: control, state: 1 as const }
      : { qubit: control.qubit, state: control.state }
  )
}

/** The unitary an operation applies, and every wire it touched. */
interface RefStep {
  readonly unitary: Dense
  readonly wires: readonly number[]
}

function refStep(
  qubits: number,
  operation: OperationLike
): RefStep | undefined {
  const controls = refControlsOf(operation)
  const wires = [...operation.targets, ...controls.map((c) => c.qubit)]
  switch (operation.gate) {
    case 'barrier':
    case 'i':
      return undefined
    case 'cx':
    case 'ccx':
      return {
        unitary: embedControlled(qubits, REF_X, operation.targets[0], controls),
        wires,
      }
    case 'cz':
      return {
        unitary: embedControlled(qubits, REF_Z, operation.targets[0], controls),
        wires,
      }
    case 'swap':
      return {
        unitary: embedSwap(qubits, operation.targets[0], operation.targets[1]),
        wires,
      }
    default:
      return {
        unitary: embedControlled(
          qubits,
          refGateMatrix(operation),
          operation.targets[0],
          controls
        ),
        wires,
      }
  }
}

/**
 * The reset channel, {|0⟩⟨0|, |0⟩⟨1|} — the map "throw the state away and hand
 * back |0⟩", written from that sentence rather than from the observation that
 * it coincides with amplitude damping at γ = 1.
 */
const REF_RESET: readonly M2[] = [real2(1, 0, 0, 0), real2(0, 1, 0, 0)]

/**
 * The whole circuit on a dense ρ: gate, then the profile's channels on every
 * wire the gate touched, in the order `channelsForGate` fixes.
 *
 * Only `kind` and `parameter` are taken from the engine's channels — the
 * operators are the oracle's own. Turning a datasheet into a parameter is a
 * different question from turning a parameter into a channel, and this lens is
 * about the second one.
 */
function refDensity(circuit: CircuitLike, profile: NoiseProfile): Dense {
  const qubits = circuit.qubits
  const dim = 1 << qubits
  let rho = denseZero(dim)
  rho.re[0] = 1

  const oneQubit = channelsForGate(profile, 1).map((channel) => ({
    operators: refOperatorsOf(channel),
  }))
  const twoQubit = channelsForGate(profile, 2).map((channel) => ({
    operators: refOperatorsOf(channel),
  }))

  const columns = [...new Set(circuit.operations.map((o) => o.column))].sort(
    (a, b) => a - b
  )
  for (const column of columns) {
    for (const operation of circuit.operations) {
      if (operation.column !== column) continue
      if (operation.gate === 'reset') {
        rho = refApplyChannel(rho, REF_RESET, operation.targets[0], qubits)
        continue
      }
      const step = refStep(qubits, operation)
      if (step === undefined) continue
      rho = conjugate(rho, step.unitary)
      const channels = step.wires.length === 1 ? oneQubit : twoQubit
      for (const wire of step.wires) {
        for (const channel of channels) {
          rho = refApplyChannel(rho, channel.operators, wire, qubits)
        }
      }
    }
  }
  return rho
}

/** The diagonal of a dense ρ — the distribution over basis states. */
function refDiagonal(rho: Dense): Float64Array {
  const out = new Float64Array(rho.dim)
  for (let i = 0; i < rho.dim; i++) out[i] = rho.re[i * rho.dim + i]
  return out
}

/**
 * Readout error by brute force: every (prepared, read) pair, with the per-qubit
 * conditional probabilities multiplied out. O(4ⁿ) and obviously the definition.
 */
function refReadout(
  distribution: Float64Array,
  qubits: number,
  p0to1: number,
  p1to0: number
): Float64Array {
  const out = new Float64Array(distribution.length)
  for (let prepared = 0; prepared < distribution.length; prepared++) {
    const mass = distribution[prepared]
    if (mass === 0) continue
    for (let read = 0; read < distribution.length; read++) {
      let weight = 1
      for (let q = 0; q < qubits; q++) {
        const from = (prepared >> q) & 1
        const to = (read >> q) & 1
        if (from === 0) weight *= to === 0 ? 1 - p0to1 : p0to1
        else weight *= to === 1 ? 1 - p1to0 : p1to0
      }
      out[read] += mass * weight
    }
  }
  return out
}

/** The oracle's full answer for a circuit under a profile, readout included. */
function refDistribution(
  circuit: CircuitLike,
  profile: NoiseProfile,
  readout = true
): Float64Array {
  const diagonal = refDiagonal(refDensity(circuit, profile))
  if (!readout) return diagonal
  if (profile.readoutP0to1 === 0 && profile.readoutP1to0 === 0) return diagonal
  return refReadout(
    diagonal,
    circuit.qubits,
    profile.readoutP0to1,
    profile.readoutP1to0
  )
}

/**
 * The final statevector of a clean analytic run.
 *
 * `run()` returns a union — a trajectories run has counts and no state — so the
 * mode is asserted rather than cast. A circuit here that turned out to measure
 * would otherwise reach a comparison against `undefined`.
 */
function analyticState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') {
    throw new Error(`Expected an analytic run, got "${result.mode}".`)
  }
  return result.state
}

/* ──────────────────────────── statistics ────────────────────────────── */

/**
 * The tolerance on a count of N shots of an outcome with probability p — see
 * the header for where the two terms come from.
 */
function shotTolerance(shots: number, p: number): number {
  return 5 * Math.sqrt(shots * p * (1 - p)) + 6
}

/** Counts keyed by ket, read back as an array indexed by basis state. */
function countsByIndex(
  counts: Readonly<Record<string, number>>,
  qubits: number
): Float64Array {
  const out = new Float64Array(1 << qubits)
  for (let i = 0; i < out.length; i++) {
    out[i] = counts[formatKet(i, qubits)] ?? 0
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  let seen = 0
  for (const value of out) seen += value
  // Every key a run produced must be a ket of this register: a label the loop
  // above cannot address would be silently dropped and the comparison would
  // pass on a distribution nobody checked.
  expect(seen).toBe(total)
  return out
}

/* ────────────────────────────── circuits ────────────────────────────── */

function op(
  id: string,
  gate: string,
  column: number,
  targets: readonly number[],
  controls?: readonly number[],
  params?: readonly number[]
): OperationLike {
  return { id, gate, column, targets, controls, params }
}

/** H then CX: the Bell pair, the smallest circuit with entanglement in it. */
const BELL: CircuitLike = {
  qubits: 2,
  operations: [op('a', 'h', 0, [0]), op('b', 'cx', 1, [1], [0])],
}

/** A GHZ state with a phase on it, so the coherences are complex. */
const GHZ_PHASE: CircuitLike = {
  qubits: 3,
  operations: [
    op('a', 'h', 0, [0]),
    op('b', 'cx', 1, [1], [0]),
    op('c', 'cx', 2, [2], [1]),
    op('d', 't', 3, [0]),
    op('e', 's', 3, [2]),
  ],
}

/** Interference on one wire: two Hadamards around a T. */
const INTERFERE: CircuitLike = {
  qubits: 1,
  operations: [
    op('a', 'h', 0, [0]),
    op('b', 't', 1, [0]),
    op('c', 'h', 2, [0]),
  ],
}

/**
 * A reset in the middle of entanglement. The density path runs it as amplitude
 * damping at γ = 1 and the trajectory path measures the wire and flips it: two
 * completely different pieces of arithmetic that must produce the same
 * ensemble.
 */
const RESET_MID: CircuitLike = {
  qubits: 2,
  operations: [
    op('a', 'h', 0, [0]),
    op('b', 'cx', 1, [1], [0]),
    op('c', 'reset', 2, [0]),
    op('d', 'h', 3, [0]),
  ],
}

/** Three wires, a Toffoli and a swap — controls, arity 3, and a permutation. */
const TOFFOLI_SWAP: CircuitLike = {
  qubits: 3,
  operations: [
    op('a', 'h', 0, [0]),
    op('b', 'h', 0, [1]),
    op('c', 'ccx', 1, [2], [0, 1]),
    op('d', 'swap', 2, [0, 2]),
  ],
}

/** A parametrised rotation and a CZ, so the answer is not all halves. */
const ROTATED: CircuitLike = {
  qubits: 2,
  operations: [
    op('a', 'ry', 0, [0], undefined, [0.7]),
    op('b', 'ry', 0, [1], undefined, [1.9]),
    op('c', 'cz', 1, [1], [0]),
    op('d', 'ry', 2, [0], undefined, [-0.4]),
  ],
}

/**
 * A profile noisy enough that a wrong coefficient has somewhere to show. Built
 * on `teaching` — §3.3's study profile — with readout switched off, so the
 * quantum part of the comparison is not diluted by a classical map that would
 * pull every distribution towards uniform and hide a disagreement underneath
 * it. Readout gets its own case.
 */
const LOUD: NoiseProfile = customProfile(NOISE_PROFILES.teaching, {
  readoutP0to1: 0,
  readoutP1to0: 0,
})

/**
 * A device where the gate takes as long as T1 and the benchmark blames
 * everything it can on control error. Nobody would build this; §3.3 lets a
 * custom profile describe it, and it is the only way to make two facts
 * observable that every plausible profile hides:
 *
 *   - the channels stop being small, so the **order** they are composed in
 *     matters at first order rather than at second (`channelsForGate` yields
 *     depolarising at 0.53 followed by amplitude damping at 0.63 here, and
 *     those two do not commute);
 *   - the "no error" branch stops being overwhelmingly likely, so the sampler's
 *     jump path is taken on most gates instead of on one in a thousand — the
 *     arithmetic that a realistic profile almost never runs.
 */
const ORDER_STRESS: NoiseProfile = customProfile(NOISE_PROFILES.teaching, {
  t1Ns: 20_000,
  // Exactly 2·T1, so the pure-dephasing rate is zero and phase damping drops
  // out. That leaves two channels rather than three, and the two left are the
  // pair that does not commute.
  t2Ns: 40_000,
  oneQubitGateNs: 20_000,
  twoQubitGateNs: 30_000,
  // Both rates sit strictly inside the domain their conversions accept, so
  // nothing here depends on a clamp: 2r = 1 exactly at r = 0.5 for the
  // one-qubit rate, and the two-qubit inversion is real for any r ≤ 0.8.
  oneQubitGateError: 0.5,
  twoQubitGateError: 0.5,
  readoutP0to1: 0,
  readoutP1to0: 0,
})

/* ═══════════════════════ 0. the oracle checks itself ════════════════════ */

describe('the oracle, before anything rests on it', () => {
  const circuits: readonly (readonly [string, CircuitLike])[] = [
    ['bell', BELL],
    ['ghz with a phase', GHZ_PHASE],
    ['interference', INTERFERE],
    ['toffoli and swap', TOFFOLI_SWAP],
    ['rotations', ROTATED],
  ]

  it.each(circuits)(
    'reproduces the analytic run at zero noise: %s',
    (_name, circuit) => {
      const exact = refDistribution(circuit, NOISE_PROFILES.ideal)
      const analytic = stateProbabilities(analyticState(circuit))
      for (let i = 0; i < exact.length; i++) {
        expect(exact[i]).toBeCloseTo(analytic[i], 12)
      }
    }
  )

  it('agrees with the engine about the reset circuit too', () => {
    // `run()` cannot take a reset out of a superposition in analytic mode, so
    // the oracle is pinned here against the density path at zero noise instead
    // — which is the same statement one representation further along.
    const exact = refDistribution(RESET_MID, NOISE_PROFILES.ideal)
    const engine = runNoisyDensity(RESET_MID, {
      profile: NOISE_PROFILES.ideal,
    })
    for (let i = 0; i < exact.length; i++) {
      expect(exact[i]).toBeCloseTo(engine.distribution[i], 12)
    }
  })
})

/* ═══════════ 1. the channels act the way §5.4 says they act ═════════════ */

describe('the channel kernel against a dense Σ K ρ K†', () => {
  const kinds = [
    'depolarizing',
    'amplitudeDamping',
    'phaseDamping',
    'bitFlip',
    'phaseFlip',
  ] as const
  const parameters = [0, 0.05, 0.3, 0.75, 1]

  /** A two-qubit ρ with complex coherences and no symmetry to hide behind. */
  function messyRho(): { engine: DensityMatrix; oracle: Dense } {
    const rng = createRng(20240816)
    const state = stateAlloc(2)
    let norm = 0
    for (let i = 0; i < 4; i++) {
      state.re[i] = rng.next() * 2 - 1
      state.im[i] = rng.next() * 2 - 1
      norm += state.re[i] * state.re[i] + state.im[i] * state.im[i]
    }
    const scale = 1 / Math.sqrt(norm)
    for (let i = 0; i < 4; i++) {
      state.re[i] *= scale
      state.im[i] *= scale
    }
    const engine = densityFromStatevector(state)
    const oracle = denseZero(4)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        oracle.re[r * 4 + c] =
          state.re[r] * state.re[c] + state.im[r] * state.im[c]
        oracle.im[r * 4 + c] =
          state.im[r] * state.re[c] - state.re[r] * state.im[c]
      }
    }
    return { engine, oracle }
  }

  for (const kind of kinds) {
    for (const parameter of parameters) {
      for (const target of [0, 1]) {
        it(`${kind}(${parameter}) on wire ${target}`, () => {
          const { engine, oracle } = messyRho()
          const channel = channelFor(kind, parameter)
          applyChannel(engine, channel, target)
          const expected = refApplyChannel(
            oracle,
            refOperators(kind, parameter),
            target,
            2
          )
          for (let i = 0; i < 16; i++) {
            expect(engine.re[i]).toBeCloseTo(expected.re[i], 12)
            expect(engine.im[i]).toBeCloseTo(expected.im[i], 12)
          }
        })
      }
    }
  }

  it('matches the closed forms the operators are supposed to produce', () => {
    // Representation-independent statements, so a shared misreading of §5.4
    // between the oracle and the engine still has somewhere to fail.
    const gamma = 0.37
    const lambda = 0.41
    const p = 0.23

    // Amplitude damping: ρ₀₀ → ρ₀₀ + γρ₁₁, ρ₁₁ → (1−γ)ρ₁₁, ρ₀₁ → √(1−γ)ρ₀₁.
    const ad = oneQubitRho(0.3, 0.2, -0.35)
    applyChannel(ad, amplitudeDampingChannel(gamma), 0)
    expect(ad.re[0]).toBeCloseTo(0.7 + gamma * 0.3, 12)
    expect(ad.re[3]).toBeCloseTo((1 - gamma) * 0.3, 12)
    expect(ad.re[1]).toBeCloseTo(Math.sqrt(1 - gamma) * 0.2, 12)
    expect(ad.im[1]).toBeCloseTo(Math.sqrt(1 - gamma) * -0.35, 12)

    // Phase damping: the diagonal does not move at all.
    const pd = oneQubitRho(0.3, 0.2, -0.35)
    applyChannel(pd, phaseDampingChannel(lambda), 0)
    expect(pd.re[0]).toBeCloseTo(0.7, 12)
    expect(pd.re[3]).toBeCloseTo(0.3, 12)
    expect(pd.re[1]).toBeCloseTo(Math.sqrt(1 - lambda) * 0.2, 12)

    // Depolarising: ρ → (1−p)ρ + p·I/2, which is the p §5.4 means.
    const dp = oneQubitRho(0.3, 0.2, -0.35)
    applyChannel(dp, depolarizingChannel(p), 0)
    expect(dp.re[0]).toBeCloseTo((1 - p) * 0.7 + p / 2, 12)
    expect(dp.re[3]).toBeCloseTo((1 - p) * 0.3 + p / 2, 12)
    expect(dp.re[1]).toBeCloseTo((1 - p) * 0.2, 12)
    expect(dp.im[1]).toBeCloseTo((1 - p) * -0.35, 12)

    // Bit flip: x fixed, y and z shrink by (1 − 2p).
    const bf = oneQubitRho(0.3, 0.2, -0.35)
    applyChannel(bf, bitFlipChannel(p), 0)
    expect(bf.re[0] - bf.re[3]).toBeCloseTo((1 - 2 * p) * (0.7 - 0.3), 12)
    expect(bf.re[1]).toBeCloseTo(0.2, 12)
    expect(bf.im[1]).toBeCloseTo((1 - 2 * p) * -0.35, 12)

    // Phase flip: z fixed, x and y shrink by (1 − 2p).
    const pf = oneQubitRho(0.3, 0.2, -0.35)
    applyChannel(pf, phaseFlipChannel(p), 0)
    expect(pf.re[0]).toBeCloseTo(0.7, 12)
    expect(pf.re[1]).toBeCloseTo((1 - 2 * p) * 0.2, 12)
    expect(pf.im[1]).toBeCloseTo((1 - 2 * p) * -0.35, 12)
  })
})

/** ρ = [[1−p₁, c], [conj(c), p₁]] as a one-qubit DensityMatrix. */
function oneQubitRho(
  excited: number,
  coherenceRe: number,
  coherenceIm: number
): DensityMatrix {
  const rho = densityAllocFor(1)
  rho.re[0] = 1 - excited
  rho.re[1] = coherenceRe
  rho.im[1] = coherenceIm
  rho.re[2] = coherenceRe
  rho.im[2] = -coherenceIm
  rho.re[3] = excited
  return rho
}

/* ══════════ 2. the unravelling weights are ‖Kψ‖², and are drawn ═════════ */

/** ‖K_full ψ‖² for every operator, by dense multiplication. */
function refWeights(
  state: Statevector,
  operators: readonly M2[],
  target: number
): number[] {
  const qubits = state.qubits
  const dim = 1 << qubits
  return operators.map((operator) => {
    const k = embed(qubits, operator, target)
    let total = 0
    for (let r = 0; r < dim; r++) {
      let re = 0
      let im = 0
      for (let c = 0; c < dim; c++) {
        re += k.re[r * dim + c] * state.re[c] - k.im[r * dim + c] * state.im[c]
        im += k.re[r * dim + c] * state.im[c] + k.im[r * dim + c] * state.re[c]
      }
      total += re * re + im * im
    }
    return total
  })
}

function stateFrom(
  qubits: number,
  amplitudes: readonly (readonly [number, number])[]
): Statevector {
  const state = stateAlloc(qubits)
  for (let i = 0; i < amplitudes.length; i++) {
    state.re[i] = amplitudes[i][0]
    state.im[i] = amplitudes[i][1]
  }
  return state
}

describe('the branch probabilities depend on the state', () => {
  it('reads ‖Kψ‖² for every channel on product and entangled states', () => {
    const states: readonly (readonly [string, Statevector])[] = [
      [
        'ground',
        stateFrom(1, [
          [1, 0],
          [0, 0],
        ]),
      ],
      [
        'excited',
        stateFrom(1, [
          [0, 0],
          [1, 0],
        ]),
      ],
      [
        'superposition with a phase',
        stateFrom(1, [
          [0.6, 0],
          [0.48, 0.64],
        ]),
      ],
      [
        'bell',
        stateFrom(2, [
          [SQRT_HALF, 0],
          [0, 0],
          [0, 0],
          [SQRT_HALF, 0],
        ]),
      ],
    ]
    const cases = [
      ['depolarizing', 0.3],
      ['amplitudeDamping', 0.37],
      ['phaseDamping', 0.52],
      ['bitFlip', 0.21],
      ['phaseFlip', 0.44],
    ] as const

    for (const [, state] of states) {
      for (const [kind, parameter] of cases) {
        for (let target = 0; target < state.qubits; target++) {
          const channel = channelFor(kind, parameter)
          const read = krausWeights(state, channel, target)
          const expected = refWeights(
            state,
            refOperators(kind, parameter),
            target
          )
          for (let k = 0; k < expected.length; k++) {
            expect(read[k]).toBeCloseTo(expected[k], 12)
          }
        }
      }
    }
  })

  it('gives amplitude damping the emission rate the physics says', () => {
    // The three statements a uniform sampler cannot make: no emission from the
    // ground state, exactly γ from the excited state, and γ·|⟨1|ψ⟩|² between.
    const gamma = 0.37
    const channel = amplitudeDampingChannel(gamma)
    const ground = stateFrom(1, [
      [1, 0],
      [0, 0],
    ])
    expect(krausWeights(ground, channel, 0)[1]).toBe(0)

    const excited = stateFrom(1, [
      [0, 0],
      [1, 0],
    ])
    expect(krausWeights(excited, channel, 0)[1]).toBeCloseTo(gamma, 12)

    for (const theta of [0.3, 1.1, 2.4]) {
      const state = stateFrom(1, [
        [Math.cos(theta / 2), 0],
        [Math.sin(theta / 2), 0],
      ])
      const expected = gamma * Math.sin(theta / 2) ** 2
      expect(krausWeights(state, channel, 0)[1]).toBeCloseTo(expected, 12)
      // And it is nowhere near the uniform answer, which is what makes the
      // assertion worth making: p₁ = γ·sin² is bounded above by γ = 0.37, so
      // every value here sits at least 0.13 below the uniform ½.
      expect(Math.abs(expected - 0.5)).toBeGreaterThan(0.1)
    }

    const bell = stateFrom(2, [
      [SQRT_HALF, 0],
      [0, 0],
      [0, 0],
      [SQRT_HALF, 0],
    ])
    expect(krausWeights(bell, channel, 0)[1]).toBeCloseTo(gamma / 2, 12)
    expect(krausWeights(bell, channel, 1)[1]).toBeCloseTo(gamma / 2, 12)
  })

  it('draws the branches at those weights, not uniformly', () => {
    const shots = 200_000
    const rng = createRng(4242)
    const cases = [
      ['amplitudeDamping', 0.37, 0.8],
      ['amplitudeDamping', 0.05, 0.5],
      ['phaseDamping', 0.52, 0.65],
      ['depolarizing', 0.4, 0.3],
      ['bitFlip', 0.17, 0.9],
      ['phaseFlip', 0.44, 0.25],
    ] as const

    for (const [kind, parameter, excited] of cases) {
      const channel = channelFor(kind, parameter)
      const prepared = prepareChannel(channel)
      const amplitudes: readonly (readonly [number, number])[] = [
        [Math.sqrt(1 - excited), 0],
        [Math.sqrt(excited), 0],
      ]
      const reference = refWeights(
        stateFrom(1, amplitudes),
        refOperators(kind, parameter),
        0
      )
      const drawn = new Float64Array(channel.operators.length)
      const state = stateAlloc(1)
      for (let shot = 0; shot < shots; shot++) {
        state.re[0] = amplitudes[0][0]
        state.im[0] = 0
        state.re[1] = amplitudes[1][0]
        state.im[1] = 0
        drawn[sampleKraus(state, prepared, 0, rng)]++
      }
      for (let k = 0; k < drawn.length; k++) {
        const p = reference[k]
        expect(Math.abs(drawn[k] - shots * p)).toBeLessThanOrEqual(
          shotTolerance(shots, p)
        )
      }
      // A uniform sampler would have put shots/count in every bin. Assert the
      // observed histogram is many standard errors away from that, so this test
      // is known to be able to tell the two apart.
      const uniform = shots / drawn.length
      const worst = Math.max(
        ...[...drawn].map((count) => Math.abs(count - uniform))
      )
      expect(worst).toBeGreaterThan(20 * Math.sqrt(shots * 0.25))
    }
  })

  it('agrees between the fast path and the general reading', () => {
    // Pauli channels cache their weights because K†K is a multiple of I. If the
    // cache were wrong the general reading would still be right, so only this
    // comparison — on states the cache never looks at — can see the difference.
    const rng = createRng(99)
    for (const [kind, parameter] of [
      ['depolarizing', 0.31],
      ['bitFlip', 0.62],
      ['phaseFlip', 0.08],
    ] as const) {
      const channel = channelFor(kind, parameter)
      const prepared = prepareChannel(channel)
      expect(prepared.fixedWeights).toBeDefined()
      for (let trial = 0; trial < 20; trial++) {
        const state = stateAlloc(2)
        let norm = 0
        for (let i = 0; i < 4; i++) {
          state.re[i] = rng.next() * 2 - 1
          state.im[i] = rng.next() * 2 - 1
          norm += state.re[i] ** 2 + state.im[i] ** 2
        }
        const scale = 1 / Math.sqrt(norm)
        for (let i = 0; i < 4; i++) {
          state.re[i] *= scale
          state.im[i] *= scale
        }
        const general = krausWeights(state, channel, 1)
        const cached = prepared.fixedWeights
        expect(cached).toBeDefined()
        if (cached === undefined) return
        for (let k = 0; k < cached.length; k++) {
          expect(cached[k]).toBeCloseTo(general[k], 10)
        }
      }
    }
  })

  it('lands on the exact post-jump state after an emission', () => {
    // K₁ = √γ·|0⟩⟨1| on wire 0 of (|00⟩+|11⟩)/√2 leaves √(γ/2)·|q1=1, q0=0⟩,
    // which renormalises to that basis state exactly. A sampler that applied
    // the operator without renormalising, or renormalised by the wrong weight,
    // would leave a vector of the right direction and the wrong length.
    const channel = amplitudeDampingChannel(0.37)
    const prepared = prepareChannel(channel)
    const state = stateFrom(2, [
      [SQRT_HALF, 0],
      [0, 0],
      [0, 0],
      [SQRT_HALF, 0],
    ])
    // A draw that certainly lands in the second branch: p₀ = 1 − γ/2 here.
    const scripted: Rng = { next: () => 0.999999 }
    expect(sampleKraus(state, prepared, 0, scripted)).toBe(1)
    expect(state.re[2]).toBeCloseTo(1, 12)
    expect(state.re[0]).toBeCloseTo(0, 12)
    expect(state.re[1]).toBeCloseTo(0, 12)
    expect(state.re[3]).toBeCloseTo(0, 12)
  })

  it('consumes exactly one draw per application, on both paths', () => {
    // The contract the "same seed, same answer" guarantee rests on: if the
    // identity branch drew a different number of times from a jump, every later
    // collapse in the shot would depend on which operator was chosen.
    for (const [kind, parameter] of [
      ['depolarizing', 0.4],
      ['amplitudeDamping', 0.4],
      ['phaseDamping', 0.4],
      ['bitFlip', 0.4],
      ['phaseFlip', 0.4],
    ] as const) {
      const prepared = prepareChannel(channelFor(kind, parameter))
      const source = createRng(7)
      let draws = 0
      const counting: Rng = {
        next: () => {
          draws++
          return source.next()
        },
      }
      const state = stateAlloc(1)
      for (let shot = 0; shot < 500; shot++) {
        state.re[0] = SQRT_HALF
        state.re[1] = SQRT_HALF
        state.im[0] = 0
        state.im[1] = 0
        sampleKraus(state, prepared, 0, counting)
      }
      expect(draws).toBe(500)
    }
  })
})

/* ═════════ 3. one channel: the ensemble average is the channel ══════════ */

describe('the trajectory ensemble reproduces ε(ρ)', () => {
  const cases = [
    ['depolarizing', 0.3],
    ['amplitudeDamping', 0.45],
    ['phaseDamping', 0.6],
    ['bitFlip', 0.25],
    ['phaseFlip', 0.35],
  ] as const

  it.each(cases)('averages |ψ⟩⟨ψ| onto Σ K ρ K†: %s(%f)', (kind, parameter) => {
    const shots = 120_000
    const rng = createRng(31337)
    const channel = channelFor(kind, parameter)
    const prepared = prepareChannel(channel)

    // A state with weight on both levels and a phase, so every entry of the
    // 2×2 has something to say.
    const a: readonly [number, number] = [0.6, 0]
    const b: readonly [number, number] = [0.48, 0.64]

    const sumRe = new Float64Array(4)
    const sumIm = new Float64Array(4)
    const state = stateAlloc(1)
    for (let shot = 0; shot < shots; shot++) {
      state.re[0] = a[0]
      state.im[0] = a[1]
      state.re[1] = b[0]
      state.im[1] = b[1]
      sampleKraus(state, prepared, 0, rng)
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          sumRe[r * 2 + c] +=
            state.re[r] * state.re[c] + state.im[r] * state.im[c]
          sumIm[r * 2 + c] +=
            state.im[r] * state.re[c] - state.re[r] * state.im[c]
        }
      }
    }

    const rho = denseZero(2)
    for (let r = 0; r < 2; r++) {
      const ar = r === 0 ? a[0] : b[0]
      const ai = r === 0 ? a[1] : b[1]
      for (let c = 0; c < 2; c++) {
        const br = c === 0 ? a[0] : b[0]
        const bi = c === 0 ? a[1] : b[1]
        rho.re[r * 2 + c] = ar * br + ai * bi
        rho.im[r * 2 + c] = ai * br - ar * bi
      }
    }
    const expected = refApplyChannel(rho, refOperators(kind, parameter), 0, 1)

    // Each entry is an average of `shots` values bounded by 1 in modulus, so
    // its standard error is at most 1/(2√N); five of those is the bound.
    const bound = (5 * 0.5) / Math.sqrt(shots)
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(sumRe[i] / shots - expected.re[i])).toBeLessThan(bound)
      expect(Math.abs(sumIm[i] / shots - expected.im[i])).toBeLessThan(bound)
    }
  })
})

/* ═════════ 3b. a list of channels is applied in the order given ═════════ */

describe('several channels on one wire compose in order', () => {
  /**
   * Depolarising and amplitude damping do **not** commute: on |1⟩ the two
   * orders differ in ρ₀₀ by γ·p/2, which is first order in both parameters.
   * The profiles a device would report keep p and γ small enough that the
   * difference is a few parts in a million and no shot count could see it —
   * which is exactly why the contract "both modes get the same list in the same
   * order" needs a case where it is visible, rather than a case where it does
   * not matter.
   *
   * (Amplitude and phase damping, by contrast, commute exactly: one moves the
   * populations and multiplies the coherence, the other only multiplies the
   * coherence, and the two factors multiply either way round. So a test built
   * on that pair would have proved nothing.)
   */
  const first = depolarizingChannel(0.5)
  const second = amplitudeDampingChannel(0.6)

  /** ρ for the state used below, as the oracle's dense 2×2. */
  function startRho(): Dense {
    const rho = denseZero(2)
    rho.re[0] = 0.36
    rho.re[1] = 0.288
    rho.im[1] = -0.384
    rho.re[2] = 0.288
    rho.im[2] = 0.384
    rho.re[3] = 0.64
    return rho
  }

  function compose(order: readonly (readonly [string, number])[]): Dense {
    let rho = startRho()
    for (const [kind, parameter] of order) {
      rho = refApplyChannel(rho, refOperators(kind, parameter), 0, 1)
    }
    return rho
  }

  const forward = compose([
    ['depolarizing', 0.5],
    ['amplitudeDamping', 0.6],
  ])
  const backward = compose([
    ['amplitudeDamping', 0.6],
    ['depolarizing', 0.5],
  ])

  it('has two orders that are genuinely different maps', () => {
    // The guard: without this the two tests below would pass whatever the
    // implementation did with the order.
    let worst = 0
    for (let i = 0; i < 4; i++) {
      worst = Math.max(worst, Math.abs(forward.re[i] - backward.re[i]))
    }
    expect(worst).toBeGreaterThan(0.1)
  })

  it('applies them to ρ in the order the list is written', () => {
    const rho = oneQubitRho(0.64, 0.288, -0.384)
    applyChannels(rho, [first, second], 0)
    for (let i = 0; i < 4; i++) {
      expect(rho.re[i]).toBeCloseTo(forward.re[i], 12)
      expect(rho.im[i]).toBeCloseTo(forward.im[i], 12)
    }
  })

  it('samples them in the same order, so the ensemble is the same map', () => {
    const shots = 120_000
    const prepared = prepareChannels([first, second])
    const rng = createRng(8675309)
    const sumRe = new Float64Array(4)
    const sumIm = new Float64Array(4)
    const state = stateAlloc(1)
    for (let shot = 0; shot < shots; shot++) {
      state.re[0] = 0.6
      state.im[0] = 0
      state.re[1] = 0.48
      state.im[1] = 0.64
      applyTrajectoryChannels(state, prepared, 0, rng)
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          sumRe[r * 2 + c] +=
            state.re[r] * state.re[c] + state.im[r] * state.im[c]
          sumIm[r * 2 + c] +=
            state.im[r] * state.re[c] - state.re[r] * state.im[c]
        }
      }
    }
    const bound = (5 * 0.5) / Math.sqrt(shots)
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(sumRe[i] / shots - forward.re[i])).toBeLessThan(bound)
      expect(Math.abs(sumIm[i] / shots - forward.im[i])).toBeLessThan(bound)
    }
  })
})

/* ══════════ 4. whole circuits: the two modes and the oracle ═════════════ */

interface ConvergenceCase {
  readonly name: string
  readonly circuit: CircuitLike
  readonly profile: NoiseProfile
  readonly shots: number
  readonly seed: number
}

const CONVERGENCE: readonly ConvergenceCase[] = [
  { name: 'bell, loud', circuit: BELL, profile: LOUD, shots: 200_000, seed: 1 },
  {
    name: 'bell, superconducting with readout',
    circuit: BELL,
    profile: NOISE_PROFILES.superconducting,
    shots: 200_000,
    seed: 2,
  },
  {
    name: 'ghz with a phase, loud',
    circuit: GHZ_PHASE,
    profile: LOUD,
    shots: 200_000,
    seed: 3,
  },
  {
    name: 'interference, loud',
    circuit: INTERFERE,
    profile: LOUD,
    shots: 200_000,
    seed: 4,
  },
  {
    name: 'reset in the middle, loud',
    circuit: RESET_MID,
    profile: LOUD,
    shots: 200_000,
    seed: 5,
  },
  {
    name: 'toffoli and swap, teaching with readout',
    circuit: TOFFOLI_SWAP,
    profile: NOISE_PROFILES.teaching,
    shots: 200_000,
    seed: 6,
  },
  {
    name: 'rotations, trapped ion',
    circuit: ROTATED,
    profile: NOISE_PROFILES.trappedIon,
    shots: 200_000,
    seed: 7,
  },
  {
    name: 'bell, order stress',
    circuit: BELL,
    profile: ORDER_STRESS,
    shots: 120_000,
    seed: 8,
  },
  {
    name: 'ghz with a phase, order stress',
    circuit: GHZ_PHASE,
    profile: ORDER_STRESS,
    shots: 120_000,
    seed: 9,
  },
]

describe('the density path is the exact answer', () => {
  it.each(CONVERGENCE.map((c) => [c.name, c] as const))(
    'matches a dense Σ K ρ K† evolution: %s',
    (_name, testCase) => {
      const exact = refDistribution(testCase.circuit, testCase.profile)
      const engine = runNoisyDensity(testCase.circuit, {
        profile: testCase.profile,
      })
      let total = 0
      for (let i = 0; i < exact.length; i++) {
        expect(engine.distribution[i]).toBeCloseTo(exact[i], 11)
        total += exact[i]
      }
      expect(total).toBeCloseTo(1, 11)
    }
  )
})

describe('the trajectory average converges to the exact answer', () => {
  it.each(CONVERGENCE.map((c) => [c.name, c] as const))(
    'stays inside the sampling error the shot count implies: %s',
    (_name, testCase) => {
      const exact = refDistribution(testCase.circuit, testCase.profile)
      const result = runNoisy(testCase.circuit, {
        profile: testCase.profile,
        shots: testCase.shots,
        rng: createRng(testCase.seed),
      })
      expect(result.shots).toBe(testCase.shots)
      const observed = countsByIndex(result.counts, testCase.circuit.qubits)
      for (let i = 0; i < exact.length; i++) {
        expect(Math.abs(observed[i] - testCase.shots * exact[i])).toBeLessThan(
          shotTolerance(testCase.shots, exact[i])
        )
      }
    }
  )

  /*
   * AN EXPLICIT TIMEOUT, AND IT IS NOT A WALL-CLOCK ASSERTION.
   *
   * Nothing here measures anything: the claim is that two modes agree on a
   * distribution, and it would be just as true at any speed. But the run takes a
   * couple of seconds on an idle machine, and `pnpm verify` runs this workspace
   * beside three others — so Vitest's five-second default is measuring the
   * scheduler, which is precisely what `performance.perf.test.ts` says a
   * correctness suite must never do. A suite that goes red at random is a suite
   * everyone learns to ignore. Sixty seconds is the same headroom
   * `numerical-stability.test.ts` gives its own long case.
   */
  it('is unbiased when the seeds are pooled', { timeout: 60_000 }, () => {
    // One seed at 200 000 shots resolves a probability to about 0.001. A
    // systematic error smaller than that — a slightly wrong coefficient, a
    // channel applied to one wire of a pair instead of two — would hide under
    // the per-seed bound and survive. Pooling sixteen independent seeds shrinks
    // the bound by four and gives it nowhere to sit.
    const seeds = 12
    const perSeed = 30_000
    const total = seeds * perSeed
    const exact = refDistribution(GHZ_PHASE, LOUD)
    const pooled = new Float64Array(exact.length)
    for (let seed = 0; seed < seeds; seed++) {
      const result = runNoisy(GHZ_PHASE, {
        profile: LOUD,
        shots: perSeed,
        rng: createRng(1000 + seed),
      })
      const observed = countsByIndex(result.counts, GHZ_PHASE.qubits)
      for (let i = 0; i < pooled.length; i++) pooled[i] += observed[i]
    }
    for (let i = 0; i < exact.length; i++) {
      expect(Math.abs(pooled[i] - total * exact[i])).toBeLessThan(
        shotTolerance(total, exact[i])
      )
    }
  })

  it('passes a χ² goodness-of-fit against the exact distribution', () => {
    // A per-outcome bound can be satisfied by every outcome leaning the same
    // way. χ² adds the leanings up. Four outcomes, three degrees of freedom;
    // the 0.999 critical value for 3 dof is 16.27, so a fixed seed either
    // clears it or reports a real disagreement.
    const shots = 200_000
    const exact = refDistribution(BELL, LOUD)
    const result = runNoisy(BELL, {
      profile: LOUD,
      shots,
      rng: createRng(2718),
    })
    const observed = countsByIndex(result.counts, BELL.qubits)
    let chiSquared = 0
    for (let i = 0; i < exact.length; i++) {
      const expectedCount = shots * exact[i]
      expect(expectedCount).toBeGreaterThan(5)
      chiSquared += (observed[i] - expectedCount) ** 2 / expectedCount
    }
    expect(chiSquared).toBeLessThan(16.27)
  })

  it('would notice a distribution that is merely plausible', () => {
    // The guard on every test above: check that the bound is tight enough to
    // reject a *wrong* answer that is still a normalised distribution. The
    // ideal distribution is one such — noise moves the Bell pair away from it
    // by far more than the sampling error, so if this passed the whole section
    // would be measuring nothing.
    const shots = 200_000
    const noisy = refDistribution(BELL, LOUD)
    const ideal = refDistribution(BELL, NOISE_PROFILES.ideal)
    let worst = 0
    for (let i = 0; i < noisy.length; i++) {
      const gap = Math.abs(shots * noisy[i] - shots * ideal[i])
      worst = Math.max(worst, gap / shotTolerance(shots, noisy[i]))
    }
    expect(worst).toBeGreaterThan(3)
  })
})

/* ═════ 5. the trajectory paths ρ cannot follow, against the oracle ══════ */

/**
 * A projector onto `value` on one wire — the two Kraus operators of a
 * measurement whose result is recorded and then not conditioned on.
 */
const REF_PROJECT: readonly M2[] = [real2(1, 0, 0, 0), real2(0, 0, 0, 1)]

describe('measurement and feed-forward under noise', () => {
  /**
   * `runNoisyDensity` refuses a circuit that measures mid-way, so these two
   * have no density answer to converge to and the oracle is the only check
   * there is. They are worth having precisely for that reason: a measurement
   * and a Kraus jump share one RNG stream and one renormalisation, and a bug in
   * how they interleave would show up nowhere else in this file.
   */

  const MEASURED: CircuitLike = {
    qubits: 2,
    clbits: 1,
    operations: [
      op('a', 'h', 0, [0]),
      op('b', 'cx', 1, [1], [0]),
      { id: 'c', gate: 'measure', column: 2, targets: [0], clbitTargets: [0] },
      op('d', 'h', 3, [1]),
    ],
  }

  const FED_FORWARD: CircuitLike = {
    qubits: 2,
    clbits: 1,
    operations: [
      op('a', 'h', 0, [0]),
      { id: 'b', gate: 'measure', column: 1, targets: [0], clbitTargets: [0] },
      {
        id: 'c',
        gate: 'x',
        column: 2,
        targets: [1],
        condition: { clbit: 0, equals: 1 },
      },
    ],
  }

  /** The profile's one-qubit channels, as the oracle's own operators. */
  function oneQubitOperators(
    profile: NoiseProfile
  ): readonly (readonly M2[])[] {
    return channelsForGate(profile, 1).map(refOperatorsOf)
  }

  function twoQubitOperators(
    profile: NoiseProfile
  ): readonly (readonly M2[])[] {
    return channelsForGate(profile, 2).map(refOperatorsOf)
  }

  function noiseOn(
    rho: Dense,
    groups: readonly (readonly M2[])[],
    wires: readonly number[],
    qubits: number
  ): Dense {
    let out = rho
    for (const wire of wires) {
      for (const operators of groups) {
        out = refApplyChannel(out, operators, wire, qubits)
      }
    }
    return out
  }

  it('reproduces a measured Bell pair, statistically', () => {
    // Measuring a wire and never reading the bit is exactly the channel
    // {P₀, P₁} on that wire, which is why this has an oracle at all.
    const profile = LOUD
    const one = oneQubitOperators(profile)
    const two = twoQubitOperators(profile)

    let rho = denseZero(4)
    rho.re[0] = 1
    rho = conjugate(rho, embed(2, refGateMatrix(op('h', 'h', 0, [0])), 0))
    rho = noiseOn(rho, one, [0], 2)
    rho = conjugate(rho, embedControlled(2, REF_X, 1, [{ qubit: 0, state: 1 }]))
    rho = noiseOn(rho, two, [1, 0], 2)
    rho = refApplyChannel(rho, REF_PROJECT, 0, 2)
    rho = conjugate(rho, embed(2, refGateMatrix(op('h', 'h', 0, [1])), 1))
    rho = noiseOn(rho, one, [1], 2)

    const exact = refDiagonal(rho)
    const shots = 200_000
    const result = runNoisy(MEASURED, {
      profile,
      shots,
      rng: createRng(606),
    })
    const observed = countsByIndex(result.counts, 2)
    for (let i = 0; i < exact.length; i++) {
      expect(Math.abs(observed[i] - shots * exact[i])).toBeLessThan(
        shotTolerance(shots, exact[i])
      )
    }
  })

  it('reproduces a classically conditioned X, statistically', () => {
    // The map is correlated across the two wires and does not factor:
    //   ρ → P₀ρP₀  +  ε₁( X₁P₁ ρ P₁X₁ )
    // with the channel on wire 1 present in the second branch only, because in
    // the first branch no pulse was played. That asymmetry is the thing worth
    // checking — it is the difference between "the gate is there" and "the gate
    // fired", and only the branch that fired should decohere.
    const profile = LOUD
    const one = oneQubitOperators(profile)

    let rho = denseZero(4)
    rho.re[0] = 1
    rho = conjugate(rho, embed(2, refGateMatrix(op('h', 'h', 0, [0])), 0))
    rho = noiseOn(rho, one, [0], 2)

    const p0 = embed(2, real2(1, 0, 0, 0), 0)
    const p1 = embed(2, real2(0, 0, 0, 1), 0)
    const flip = denseMul(embed(2, REF_X, 1), p1)
    const quiet = conjugate(rho, p0)
    const fired = noiseOn(conjugate(rho, flip), one, [1], 2)
    const combined = denseZero(4)
    denseAddInto(combined, quiet)
    denseAddInto(combined, fired)

    const exact = refDiagonal(combined)
    let total = 0
    for (const value of exact) total += value
    expect(total).toBeCloseTo(1, 12)

    const shots = 200_000
    const result = runNoisy(FED_FORWARD, {
      profile,
      shots,
      rng: createRng(707),
    })
    const observed = countsByIndex(result.counts, 2)
    for (let i = 0; i < exact.length; i++) {
      expect(Math.abs(observed[i] - shots * exact[i])).toBeLessThan(
        shotTolerance(shots, exact[i])
      )
    }
  })
})

/* ═══════════ 6. depth, and the rate the error actually falls at ═════════ */

/** Twenty columns of gates, so a per-gate bias has twenty chances to show. */
const DEEP: CircuitLike = {
  qubits: 2,
  operations: Array.from({ length: 20 }, (_, column) =>
    column % 2 === 0
      ? op(`h${column}`, 'h', column, [0])
      : op(`c${column}`, 'cx', column, [1], [0])
  ),
}

describe('depth and convergence rate', () => {
  it('still agrees after twenty columns of channels', () => {
    // Channels compose, and so do coefficient errors: a map that is wrong by a
    // factor (1 + ε) per gate is wrong by (1 + ε)³⁰ after this circuit. Depth is
    // the cheapest amplifier available, and it also exercises the two paths'
    // renormalisation, which they run on different quantities.
    const shots = 60_000
    const exact = refDistribution(DEEP, LOUD)
    const density = runNoisyDensity(DEEP, { profile: LOUD })
    for (let i = 0; i < exact.length; i++) {
      expect(density.distribution[i]).toBeCloseTo(exact[i], 11)
    }
    const result = runNoisy(DEEP, {
      profile: LOUD,
      shots,
      rng: createRng(313),
    })
    const observed = countsByIndex(result.counts, DEEP.qubits)
    for (let i = 0; i < exact.length; i++) {
      expect(Math.abs(observed[i] - shots * exact[i])).toBeLessThan(
        shotTolerance(shots, exact[i])
      )
    }
  })

  it('shrinks its error like 1/√N rather than settling on a floor', () => {
    // "Close enough at this shot count" and "converging" are different claims,
    // and only the second one is what §5.4 promises. A sampler with a bias b
    // has a total-variation distance that falls to b and stops; a correct one
    // falls as 1/√N forever. Sixteen times the shots must therefore buy about
    // four times the accuracy — measured as a mean over eight seeds, because a
    // single TV distance is itself a random variable.
    const exact = refDistribution(BELL, LOUD)
    const meanDistance = (shots: number, base: number): number => {
      let sum = 0
      for (let seed = 0; seed < 8; seed++) {
        const result = runNoisy(BELL, {
          profile: LOUD,
          shots,
          rng: createRng(base + seed),
        })
        const observed = countsByIndex(result.counts, BELL.qubits)
        let distance = 0
        for (let i = 0; i < exact.length; i++) {
          distance += Math.abs(observed[i] / shots - exact[i])
        }
        sum += distance / 2
      }
      return sum / 8
    }

    const coarse = meanDistance(2_000, 8100)
    const fine = meanDistance(32_000, 8200)
    // The expected ratio is √16 = 4. The band is generous — the mean of eight
    // TV distances has a relative spread of roughly 15% — and still nowhere
    // near 1, which is what a biased sampler would produce.
    expect(coarse / fine).toBeGreaterThan(2.5)
    expect(coarse / fine).toBeLessThan(6)
  })

  /*
   * AN EXPLICIT TIMEOUT, AND IT IS NOT A WALL-CLOCK ASSERTION.
   *
   * Nothing here measures anything: the claim is that two modes agree on a
   * distribution, and it would be just as true at any speed. But the run takes a
   * couple of seconds on an idle machine, and `pnpm verify` runs this workspace
   * beside three others — so Vitest's five-second default is measuring the
   * scheduler, which is precisely what `performance.perf.test.ts` says a
   * correctness suite must never do. A suite that goes red at random is a suite
   * everyone learns to ignore. Sixty seconds is the same headroom
   * `numerical-stability.test.ts` gives its own long case.
   */
  it(
    'agrees across the renormalisation boundary the two modes cross apart',
    { timeout: 60_000 },
    () => {
      // D6 has each mode mop up its own drift every 64 gates — but they mop up
      // *different quantities*. The trajectory path rescales a statevector to
      // unit norm; the density path rescales ρ to unit trace. Under 64 gates
      // neither ever runs, so every case above stops short of the one point where
      // the two modes do something to the state that the other does not. This
      // circuit is 80 gates long and crosses it, on a profile whose per-gate error
      // is small enough that 80 gates still leave a distribution with structure in
      // it rather than a flat one.
      const columns = 80
      const circuit: CircuitLike = {
        qubits: 2,
        operations: Array.from({ length: columns }, (_, column) =>
          column % 4 === 3
            ? op(`c${column}`, 'cx', column, [1], [0])
            : op(`h${column}`, 'h', column, [0])
        ),
      }
      const profile = NOISE_PROFILES.superconducting
      const exact = refDistribution(circuit, profile)
      const density = runNoisyDensity(circuit, { profile })
      // The exact comparison is the one that would see a renormalisation applied
      // to the wrong quantity or at the wrong moment: it is good to 1e-11, where
      // the shot comparison below could not resolve anything under a percent.
      for (let i = 0; i < exact.length; i++) {
        expect(density.distribution[i]).toBeCloseTo(exact[i], 11)
      }

      const shots = 40_000
      const result = runNoisy(circuit, {
        profile,
        shots,
        rng: createRng(6464),
      })
      const observed = countsByIndex(result.counts, 2)
      for (let i = 0; i < exact.length; i++) {
        expect(Math.abs(observed[i] - shots * exact[i])).toBeLessThan(
          shotTolerance(shots, exact[i])
        )
      }
    }
  )
})

/* ══════════════ 7. the noiseless limit is exact, not close ══════════════ */

describe('zero noise reproduces the clean run exactly', () => {
  const circuits: readonly (readonly [string, CircuitLike])[] = [
    ['bell', BELL],
    ['ghz with a phase', GHZ_PHASE],
    ['toffoli and swap', TOFFOLI_SWAP],
    ['rotations', ROTATED],
  ]

  it.each(circuits)(
    'leaves the trajectory state bit for bit identical: %s',
    (_name, circuit) => {
      const clean = analyticState(circuit)
      const noisy = runTrajectory(circuit, createRng(11), {
        profile: NOISE_PROFILES.ideal,
      }).state
      for (let i = 0; i < clean.re.length; i++) {
        expect(noisy.re[i]).toBe(clean.re[i])
        expect(noisy.im[i]).toBe(clean.im[i])
      }
    }
  )

  it('touches the RNG not at all when there is no noise to sample', () => {
    // Not decoration: `runNoisy` shares one stream between the channels, the
    // final read and the readout map. A stray draw at the ideal profile would
    // shift everything after it and break the exactness claim below without
    // changing any physics.
    const forbidden: Rng = {
      next: () => {
        throw new Error('a clean run drew from the RNG')
      },
    }
    expect(() =>
      runTrajectory(GHZ_PHASE, forbidden, { profile: NOISE_PROFILES.ideal })
    ).not.toThrow()
  })

  it.each(circuits)(
    'tallies exactly what sampling the clean state would: %s',
    (_name, circuit) => {
      const shots = 5_000
      const seed = 909
      const noisy = runNoisy(circuit, {
        profile: NOISE_PROFILES.ideal,
        shots,
        rng: createRng(seed),
      })

      // The independent expectation: sample the analytic final state with the
      // same generator, drawing once per shot exactly as `runNoisy` does.
      const clean = analyticState(circuit)
      const rng = createRng(seed)
      const tally = new Map<string, number>()
      for (let shot = 0; shot < shots; shot++) {
        const label = formatKet(drawIndex(clean, rng), circuit.qubits)
        tally.set(label, (tally.get(label) ?? 0) + 1)
      }
      const expected: Record<string, number> = {}
      for (const [label, count] of tally) expected[label] = count
      expect(noisy.counts).toEqual(expected)
    }
  )

  it('gives the same ρ as the pure state it should be', () => {
    const clean = analyticState(GHZ_PHASE)
    const pure = densityFromStatevector(clean)
    const engine = runNoisyDensity(GHZ_PHASE, { profile: NOISE_PROFILES.ideal })
    for (let i = 0; i < pure.re.length; i++) {
      expect(engine.rho.re[i]).toBeCloseTo(pure.re[i], 12)
      expect(engine.rho.im[i]).toBeCloseTo(pure.im[i], 12)
    }
    const born = densityProbabilities(engine.rho)
    const analytic = stateProbabilities(clean)
    for (let i = 0; i < born.length; i++) {
      expect(born[i]).toBeCloseTo(analytic[i], 12)
    }
  })
})

/**
 * Draw one basis state from `state`, written here rather than imported.
 *
 * Same rule as the Born rule states it: accumulate the probabilities in index
 * order and take the first index whose running total passes `u`. A drawn index
 * is the only thing this shares with the engine's sampler, and the test above
 * is worthless if it shares more.
 */
function drawIndex(state: Statevector, rng: Rng): number {
  let total = 0
  for (let i = 0; i < state.size; i++) {
    total += state.re[i] * state.re[i] + state.im[i] * state.im[i]
  }
  const target = rng.next() * total
  let cumulative = 0
  let last = 0
  for (let i = 0; i < state.size; i++) {
    const mass = state.re[i] * state.re[i] + state.im[i] * state.im[i]
    cumulative += mass
    if (mass > 0) last = i
    if (target < cumulative) return i
  }
  return last
}

/* ════════════════════ 8. the seed is really a seed ═════════════════════ */

describe('seeding', () => {
  it('gives identical counts from identical seeds', () => {
    const options = { profile: LOUD, shots: 4_000 }
    const first = runNoisy(GHZ_PHASE, { ...options, rng: createRng(5150) })
    const second = runNoisy(GHZ_PHASE, { ...options, rng: createRng(5150) })
    expect(second.counts).toEqual(first.counts)
  })

  it('gives different counts from different seeds', () => {
    const options = { profile: LOUD, shots: 4_000 }
    const first = runNoisy(GHZ_PHASE, { ...options, rng: createRng(5150) })
    const second = runNoisy(GHZ_PHASE, { ...options, rng: createRng(5151) })
    expect(second.counts).not.toEqual(first.counts)
  })

  it('reproduces a single trajectory exactly, and separates two seeds', () => {
    const model = { profile: LOUD }
    const a = runTrajectory(GHZ_PHASE, createRng(77), model)
    const b = runTrajectory(GHZ_PHASE, createRng(77), model)
    for (let i = 0; i < a.state.re.length; i++) {
      expect(b.state.re[i]).toBe(a.state.re[i])
      expect(b.state.im[i]).toBe(a.state.im[i])
    }

    // Two seeds must reach different trajectories at least sometimes. One shot
    // is not enough to say so — the no-error branch is likely — so this walks
    // seeds until it finds a disagreement and fails if it never does.
    let differed = false
    for (let seed = 0; seed < 60 && !differed; seed++) {
      const left = runTrajectory(GHZ_PHASE, createRng(seed), model)
      const right = runTrajectory(GHZ_PHASE, createRng(seed + 1000), model)
      for (let i = 0; i < left.state.re.length; i++) {
        if (left.state.re[i] !== right.state.re[i]) differed = true
      }
    }
    expect(differed).toBe(true)
  })

  it('keeps the density answer independent of any seed at all', () => {
    // `runNoisyDensity` takes no generator. Running it twice must return the
    // same numbers, and they must be the numbers the trajectories converge to.
    const first = runNoisyDensity(GHZ_PHASE, { profile: LOUD })
    const second = runNoisyDensity(GHZ_PHASE, { profile: LOUD })
    for (let i = 0; i < first.distribution.length; i++) {
      expect(second.distribution[i]).toBe(first.distribution[i])
    }
  })
})
