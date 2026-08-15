/**
 * Turning a trajectories tally into rows — M0.9.
 *
 * A trajectories run answers with `ShotCounts`: one entry per *classical
 * register reading that actually came up*, keyed by the bitstring
 * `formatRegister` produced. That is a different animal from the analytic
 * histogram of `histogram.ts`, and the difference is worth stating because it
 * decides everything below:
 *
 *  - The analytic chart draws basis states of the *quantum* register, all 2ⁿ
 *    of them, and has to choose which ones to show. This draws readings of
 *    the *classical* register, and there are at most `shots` of them however
 *    wide the register is — a thousand runs cannot produce more than a
 *    thousand distinct answers.
 *  - A probability there is exact. A share here is a measurement, and its
 *    error falls as 1/√shots. Nothing in this module pretends otherwise.
 *
 * Two rules are borrowed from §3.2 unchanged, because a reader looking at both
 * panels should not have to learn two conventions:
 *
 *  1. **Selection by weight, drawing by label.** The rows shown are the
 *     commonest readings; the order they are drawn in is the register's own
 *     ascending order. A row that keeps its position is a row you can watch
 *     change.
 *  2. **What is left out is still drawn, aggregated.** The remainder row
 *     carries the runs that fell outside the cap and says how many readings
 *     they were, because a tally that quietly drops a third of its shots is a
 *     lie told in a table.
 */

import { orderedCounts, type ShotCounts } from '@qsim/core'

/** One classical register reading and how often it came up. */
export interface CountRow {
  /** The register as a bitstring, highest clbit first — or null for the
   * remainder row, which stands for several readings at once. */
  readonly label: string | null
  readonly count: number
  /** `count / shots`, the observed share. */
  readonly share: number
}

export interface CountTally {
  readonly rows: readonly CountRow[]
  /** The aggregate of everything past the cap, or null when nothing was. */
  readonly remainder: CountRow | null
  /** How many distinct readings the remainder stands for. */
  readonly hiddenReadings: number
  /** Distinct readings observed in total, remainder included. */
  readonly readings: number
  /** Runs the tally was drawn from — the sum of every count. */
  readonly shots: number
}

/**
 * Rows for a tally, capped at `limit` and never losing a shot.
 *
 * `shots` is summed from the counts rather than taken from the request: the
 * two agree in every run the engine produces, and summing means a share is
 * always a share of what is actually in the table. A caller that passed the
 * requested shot count while the worker had answered a different one would
 * print percentages that do not add to 100.
 */
export function tallyCounts(counts: ShotCounts, limit: number): CountTally {
  const ordered = orderedCounts(counts)
  const shots = ordered.reduce((sum, [, count]) => sum + count, 0)
  const share = (count: number): number => (shots === 0 ? 0 : count / shots)

  // Selection by weight. The sort is on a copy, and ties break on the label so
  // that two readings that came up equally often keep a stable order between
  // runs instead of one determined by object key iteration.
  const byWeight = [...ordered].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  )
  const shown = byWeight.slice(0, Math.max(0, limit))
  const hidden = byWeight.slice(shown.length)

  const kept = new Set(shown.map(([label]) => label))
  const rows: CountRow[] = ordered
    .filter(([label]) => kept.has(label))
    .map(([label, count]) => ({ label, count, share: share(count) }))

  const hiddenCount = hidden.reduce((sum, [, count]) => sum + count, 0)
  const remainder: CountRow | null =
    hidden.length === 0
      ? null
      : { label: null, count: hiddenCount, share: share(hiddenCount) }

  return {
    rows,
    remainder,
    hiddenReadings: hidden.length,
    readings: ordered.length,
    shots,
  }
}
