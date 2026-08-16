/**
 * The model behind the Q-sphere — §3.2: "representación de todo el estado en
 * una sola esfera, con radio proporcional a la amplitud y color por fase".
 *
 * No React, no three.js, no i18next: the same split `bloch.ts` makes, and for
 * the same reason. The physics is upstream — the amplitudes are the engine's
 * and the selection is `buildHistogram`'s — and what is left here is where each
 * basis state lands on a sphere, which is presentation geometry and belongs
 * somewhere two renderers can agree on it exactly.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY A SPHERE AT ALL, AND WHAT ITS COORDINATES MEAN
 *
 * A Bloch sphere holds one qubit. This holds the whole register, and it is not
 * the same picture scaled up: there is no point of this sphere that "is" the
 * state. Every basis state gets a point of its own, and the arrangement is what
 * carries the meaning:
 *
 *   **Latitude is Hamming weight.** |0…0⟩ sits at the north pole, |1…1⟩ at the
 *   south, and everything else on the ring for its number of ones. That single
 *   choice is what makes the picture readable at a glance: an equal
 *   superposition of a Hadamard wall is a sphere covered evenly, a GHZ state is
 *   two points at the two poles and nothing in between, and a W state is one
 *   ring. None of those shapes is available from a histogram, where a ket is a
 *   label rather than a position.
 *
 *   **Longitude is the state's rank among the states of its weight**, in
 *   ascending index order, spread evenly around the ring. It carries no physics
 *   — nothing about a register makes |0011⟩ "east of" |0101⟩ — and it is not
 *   pretending to: what it has to be is *stable*, so that a point keeps its
 *   place while a slider moves and the reader watches a radius change instead
 *   of a constellation rearranging itself. The same argument §3.2 makes about
 *   drawing histogram bars in basis-state order rather than in rank order.
 *
 *   **The node's radius is the amplitude's magnitude** — |a|, not |a|² — which
 *   is what §3.2 asks for in as many words. It is the honest choice for a
 *   *radius* on top of that: a disc's area then goes as |a|², so the ink on
 *   screen is proportional to the probability while the length the reader
 *   measures is proportional to the amplitude.
 *
 *   **The colour is the phase**, through the one mapping this app has
 *   (`lib/phase-colour.ts`, §10). Two points of opposite colour are two paths
 *   that would cancel if they met, which is the same sentence the phasors
 *   teach one row at a time.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CAP IS THE HISTOGRAM'S, DELIBERATELY
 *
 * A register has 2ⁿ basis states and a scene cannot draw a million of them, so
 * this is capped exactly as the chart is — and by *calling* `buildHistogram`
 * rather than by re-deriving the rule, which is the ruling `amplitudes.ts`
 * already made: three renderings of one distribution that each chose their own
 * states would let a bar exist with no point beside it, and a reader comparing
 * them would read that as physics.
 *
 * What the cap does *not* touch is the geometry. A state's ring and its place
 * on that ring are computed from the whole register — `weightRank` counts every
 * state of the same weight, drawn or not — so hiding points never moves the
 * ones that remain. A cap that changed the picture would be a cap that lied
 * about it.
 */

import type { Statevector } from '@qsim/core'

import { DEFAULT_BAR_LIMIT, buildHistogram } from './histogram'

/** A point of the sphere's world, in sphere radii. */
export interface Point3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** One basis state, placed. */
export interface QSphereNode {
  /** Statevector index. Qubit `q` of it is `(index >> q) & 1` — D1. */
  readonly index: number
  /** `formatKet`'s label: highest qubit first, no bra-ket brackets. */
  readonly label: string
  /** How many of the register's qubits are 1 here. The node's latitude. */
  readonly weight: number
  /** Born-rule probability, |a|². */
  readonly probability: number
  /** |a| — the node's drawn radius, before scaling. */
  readonly magnitude: number
  /** Argument of the amplitude, folded into `[0, 2π)`. */
  readonly phase: number
  /** Where the node sits on the unit sphere. */
  readonly position: Point3
  /** The node's own radius, in sphere radii. See `NODE_RADIUS`. */
  readonly radius: number
}

export interface QSphereModel {
  readonly qubits: number
  /** 2ⁿ — every basis state, drawn or not. */
  readonly size: number
  /** Basis states carrying any probability at all. */
  readonly occupied: number
  /** The drawn nodes, in ascending basis-state order. */
  readonly nodes: readonly QSphereNode[]
  /** Occupied states the cap left out. Zero when everything is drawn. */
  readonly hidden: number
  /** Probability those states hold between them. */
  readonly hiddenProbability: number
  /** The cap this model was built with, for the caption to quote. */
  readonly limit: number
}

/**
 * The radius of a node carrying the whole state, in sphere radii.
 *
 * A node at |a| = 1 is drawn at this size and everything else in proportion, so
 * a two-state superposition draws two nodes at 0.707 of it. Small enough that
 * sixteen nodes on one ring do not merge into a band, large enough that a
 * single node reads as a marker rather than as a speck.
 */
export const NODE_RADIUS = 0.11

/** The model for a state, capped as the chart is. */
export function buildQSphere(
  state: Statevector,
  limit: number = DEFAULT_BAR_LIMIT
): QSphereModel {
  const model = buildHistogram(state, { limit })
  const qubits = model.qubits

  const nodes = model.bars.map((bar): QSphereNode => {
    const weight = popcount(bar.index)
    const magnitude = Math.sqrt(bar.probability)
    return {
      index: bar.index,
      label: bar.label,
      weight,
      probability: bar.probability,
      magnitude,
      phase: bar.phase,
      position: placeOn(bar.index, qubits),
      /*
       * Exactly proportional, with no minimum — the histogram's ruling about
       * its bars, and it applies here for the same reason and one more. The
       * same one: inflating a node to "visible" would draw an amplitude the
       * state does not have. The extra one: the radius is the *only* quantity
       * this picture carries per node, so a floor under it would not be a small
       * distortion of a secondary encoding, it would be the encoding. A node
       * too small to see still has its line to the centre, which is what says
       * the state is there at all, and the table beside the sphere is what
       * carries values the eye cannot resolve.
       */
      radius: NODE_RADIUS * magnitude,
    }
  })

  return {
    qubits,
    size: model.size,
    occupied: model.occupied,
    nodes,
    hidden: model.hidden,
    hiddenProbability: model.hiddenProbability,
    limit: model.limit,
  }
}

/**
 * Where basis state `index` of an n-qubit register sits on the unit sphere.
 *
 * Latitude from the Hamming weight, longitude from the rank within that weight.
 * A zero-qubit register has one state and it goes to the north pole, which is
 * the only place it can go and keeps the caller free of a special case.
 */
export function placeOn(index: number, qubits: number): Point3 {
  if (qubits <= 0) return { x: 0, y: 0, z: 1 }
  const weight = popcount(index)
  // Weight 0 at the top, weight n at the bottom, evenly spaced in z. Even
  // spacing in *latitude* would crowd the poles, where the two states that
  // matter most on a GHZ state live.
  const z = 1 - (2 * weight) / qubits
  const ring = Math.sqrt(Math.max(0, 1 - z * z))
  const total = binomial(qubits, weight)
  // A ring of one is a pole, and its longitude is undefined rather than zero —
  // `ring` is already 0 there, so any angle gives the same point.
  const angle =
    total <= 1 ? 0 : (2 * Math.PI * weightRank(index, qubits)) / total
  return { x: ring * Math.cos(angle), y: ring * Math.sin(angle), z }
}

/** How many bits of `index` are set. */
export function popcount(index: number): number {
  let bits = index
  let count = 0
  while (bits !== 0) {
    bits &= bits - 1
    count += 1
  }
  return count
}

/**
 * The position of `index` among all `qubits`-bit values with the same Hamming
 * weight, counting from zero in ascending numeric order.
 *
 * THE COMBINATORIAL NUMBER SYSTEM, and it is used rather than an enumeration
 * because enumerating is 2ⁿ. Writing the set bits as positions p₁ > p₂ > … > p_k,
 * the colexicographic rank is C(p₁,k) + C(p₂,k−1) + … + C(p_k,1) — and colex
 * order on k-subsets is exactly ascending order on the bitmasks they encode, so
 * that sum *is* the position wanted here. O(n) per state, no table of 2ⁿ, and
 * the ring of a twenty-qubit state is placed as cheaply as the ring of a
 * two-qubit one.
 *
 * Bit *positions* are what this counts, so D1's little-endian convention
 * decides which qubit is p₁. Nothing physical rests on that — longitude carries
 * no meaning (see the header) — but it does decide the picture, so it is fixed
 * here rather than left to whichever loop happened to run first.
 */
export function weightRank(index: number, qubits: number): number {
  let rank = 0
  let remaining = popcount(index)
  for (let position = qubits - 1; position >= 0 && remaining > 0; position--) {
    if (((index >> position) & 1) === 0) continue
    rank += binomial(position, remaining)
    remaining -= 1
  }
  return rank
}

/**
 * C(n, k), by the multiplicative formula.
 *
 * Exact in Float64 across the whole range this app can reach: the largest value
 * a twenty-qubit register produces is C(20, 10) = 184 756, and the running
 * product is kept small by dividing at each step — `value` is always an integer
 * binomial coefficient, never a partial factorial, so nothing overflows and
 * nothing rounds.
 */
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  const upper = Math.min(k, n - k)
  let value = 1
  for (let i = 0; i < upper; i++) {
    value = (value * (n - i)) / (i + 1)
  }
  return Math.round(value)
}

/* ─────────────────────────────── the stage ──────────────────────────── */

/**
 * How the scene is framed, in CSS pixels before the browser scales it.
 *
 * One sphere rather than a grid, so this is a size rather than a layout — and
 * unlike the Bloch grid there is nothing here that grows with the register: a
 * twenty-qubit Q-sphere is the same sphere with more points on it.
 */
export const STAGE_PIXELS = 320

/** How far from the centre a pole's label sits, in sphere radii. */
export const LABEL_RADIUS = 1.24

/**
 * The sphere is drawn slightly inside the frame so a node on the silhouette,
 * whose own radius sticks out past the surface, is not clipped by the canvas.
 */
export const STAGE_UNITS = 2 * (LABEL_RADIUS + NODE_RADIUS)

/** Pixels per sphere radius. */
export const STAGE_RADIUS = STAGE_PIXELS / STAGE_UNITS
