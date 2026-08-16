/**
 * Turning a distribution over 2ⁿ basis states into something that fits a row.
 *
 * ── Why this cannot be "collect, sort, slice" ─────────────────────────────
 *
 * At the ceiling this worker accepts, the distribution is sixteen million
 * doubles. Building an object per entry to sort them would allocate several
 * gigabytes to answer a question whose answer is two hundred and fifty-six
 * entries long — and it would do it *after* the simulation, which is to say at
 * the exact moment the process is already holding its largest allocation.
 *
 * So the selection is a single streaming pass with a bounded buffer: candidates
 * above a moving threshold are collected, and whenever the buffer reaches twice
 * the cap it is compacted down to the cap and the threshold rises to the
 * smallest survivor. Everything dropped is counted and its weight accumulated,
 * because a truncated list without that account is a lie about the physics
 * rather than about the formatting (see `result.ts` in `@qsim/jobs`).
 *
 * ── Determinism, which the moving threshold could easily break ────────────
 *
 * A maximally mixed state has 2ⁿ entries of exactly equal weight, so "the top
 * 256" is decided entirely by tie-breaks. `boundOutcomes` breaks ties by label
 * ascending; this pass visits indices in ascending order and labels are
 * fixed-width, so the two orders agree — and admitting a later candidate only
 * when it is *strictly* above the threshold keeps them agreeing. An equal-weight
 * candidate arriving later necessarily has a larger label and would have sorted
 * behind the entries already kept, so dropping it is what `boundOutcomes` would
 * have done anyway.
 *
 * Without that, the same circuit and the same seed would store a different
 * result depending on the buffer's compaction history — and a reproducible run
 * would have stopped being one.
 */

import { formatKet } from '@qsim/core'
import type { ShotCounts } from '@qsim/core'
import {
  MAX_RESULT_OUTCOMES,
  RESULT_PROBABILITY_FLOOR,
  boundOutcomes,
} from '@qsim/jobs'
import type { BoundedOutcomes, OutcomeCandidate } from '@qsim/jobs'

/**
 * The heaviest basis states of an exact distribution.
 *
 * `counts` is the tally drawn from the very same state, when one was drawn, so
 * that a stored outcome can carry both the exact probability and the empirical
 * frequency — which is §3.2's whole comparison, and is only honest because both
 * halves come out of one run.
 */
export function selectFromDistribution(
  distribution: Float64Array,
  qubits: number,
  counts: ShotCounts | null = null,
  limit: number = MAX_RESULT_OUTCOMES
): BoundedOutcomes {
  const buffer: OutcomeCandidate[] = []
  let threshold = RESULT_PROBABILITY_FLOOR
  let hiddenOutcomes = 0
  let hiddenWeight = 0

  const compact = (): void => {
    buffer.sort((left, right) => {
      const delta = (right.probability ?? 0) - (left.probability ?? 0)
      if (delta !== 0) return delta
      return left.state < right.state ? -1 : left.state > right.state ? 1 : 0
    })
    for (const dropped of buffer.splice(limit)) {
      hiddenOutcomes++
      hiddenWeight += dropped.probability ?? 0
    }
    const last = buffer[buffer.length - 1]
    if (last !== undefined && buffer.length >= limit) {
      threshold = Math.max(threshold, last.probability ?? 0)
    }
  }

  for (let index = 0; index < distribution.length; index++) {
    const probability = distribution[index] ?? 0
    if (probability <= threshold) {
      // Only weight that could have been shown counts as hidden. Numerical
      // residue below the floor was never an outcome, so it is not "left out".
      if (probability > RESULT_PROBABILITY_FLOOR) {
        hiddenOutcomes++
        hiddenWeight += probability
      }
      continue
    }
    const state = formatKet(index, qubits)
    buffer.push({ state, probability, count: counts?.[state] ?? null })
    if (buffer.length >= limit * 2) compact()
  }

  const bounded = boundOutcomes(buffer, limit)
  return {
    outcomes: bounded.outcomes,
    hiddenOutcomes: hiddenOutcomes + bounded.hiddenOutcomes,
    hiddenWeight: Math.min(1, hiddenWeight + bounded.hiddenWeight),
  }
}

/**
 * The heaviest outcomes of a tally.
 *
 * No streaming needed: a tally has at most `shots` distinct keys, and shots are
 * bounded at a hundred thousand — a hundred thousand small objects is an
 * ordinary allocation, where sixteen million is not.
 */
export function selectFromCounts(
  counts: ShotCounts,
  limit: number = MAX_RESULT_OUTCOMES
): BoundedOutcomes {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const candidates: OutcomeCandidate[] = Object.entries(counts).map(
    ([state, count]) => ({
      state,
      // The empirical frequency, stated as a probability so a client can draw
      // a tally and an exact distribution on the same axis without knowing
      // which mode produced it.
      probability: total > 0 ? count / total : 0,
      count,
    })
  )
  return boundOutcomes(candidates, limit)
}
