/**
 * The model behind §3.3's comparison: the ideal distribution and the noisy one
 * on the same rows, and the signed difference between them.
 *
 * No physics is computed here and none may be. Both distributions arrive
 * already finished — the ideal one from `buildHistogram` over the statevector
 * the worker returned, the noisy one from `runNoisyDensity` or `runNoisy` in
 * the same message — and so do all four headline numbers (`noiseJob.ts`). What
 * this module does is line the two up, which is arithmetic on numbers that both
 * already exist. It is the same division `sampling.ts` makes for the shots
 * control, and the same one for the same reason.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE SELECTION IS THE HISTOGRAM'S, AND THAT IS LOAD-BEARING.
 *
 * `buildHistogram` chooses which basis states are drawn (§3.2's three rules),
 * and this module takes that choice rather than making its own. Three renderings
 * of one distribution — the chart, the amplitude table, this comparison — that
 * each picked their own states would let a bar exist with no row beside it, and
 * a reader comparing them would read that as a defect in the physics rather
 * than as two selections that failed to agree. `amplitudes.ts` states the same
 * rule and cites the same reason.
 *
 * A consequence worth naming: the selection is by *ideal* probability. An
 * outcome that the noise created out of nothing — probability zero ideally,
 * two percent noisily — is therefore not a row of its own. It is not lost,
 * because it lands in the remainder along with everything else the cap left
 * out, and the remainder's own difference is what makes it visible: a positive
 * delta on the remainder row is precisely "the noise put probability where the
 * circuit put none". Choosing rows by the noisy distribution instead would
 * reorder the chart every time a slider moved, which is the defect §3.2's own
 * ordering rule exists to prevent.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TWO PAYLOADS, ONE READING.
 *
 * The density method answers with a distribution over basis states; the
 * trajectories method answers with a tally keyed by ket label. Both are joined
 * on the histogram's rows without any index arithmetic beyond the one D1 already
 * fixed — `formatKet`'s label is what `buildHistogram` puts on a bar and what
 * `runNoisy` keys its counts by, so the join is a lookup either way.
 */

import type { Statevector } from '@qsim/core'

import type { NoiseMethod, NoiseReading } from '../simulation/protocol'
import {
  DEFAULT_BAR_LIMIT,
  buildHistogram,
  type HistogramOverlay,
} from './histogram'

/**
 * Below this a difference is not a movement.
 *
 * Half of the last digit `formatProbabilityDelta` prints — it shows two
 * decimals of a percent, so 5e-5 is the point where a delta stops being a
 * number on screen and starts being `0 %`. The same ruling `READING_TOLERANCE`
 * makes in `bloch.ts`, and it is not cosmetic: the summary sentence names the
 * biggest gain and the biggest loss, and an ideal probability of
 * 0.5000000000000001 against a noisy 0.5 would otherwise produce
 * "|00⟩ lost the most, 0 %" — a headline about Float64 residue, printed over a
 * chart where nothing moved.
 */
export const MOVEMENT_FLOOR = 5e-5

/** One basis state, ideal against noisy. */
export interface NoiseRow {
  /** Statevector index, or null for the aggregated remainder row. */
  readonly index: number | null
  /** `formatKet`'s label; empty for the remainder row. */
  readonly label: string
  /** Born-rule probability of the ideal run. */
  readonly ideal: number
  /** The same outcome under the noise model, readout error included. */
  readonly noisy: number
  /** `noisy − ideal`: signed, so the direction of the move shows. */
  readonly delta: number
}

export interface NoiseComparison {
  /** Register size, so the drawing can reserve a column for the labels. */
  readonly qubits: number
  /** Which method produced the noisy half. Never inferred from the payload. */
  readonly method: NoiseMethod
  /** The listed states, in ascending basis-state order. */
  readonly rows: readonly NoiseRow[]
  /** Everything the cap left out, as one row. Null when it left nothing out. */
  readonly remainder: NoiseRow | null
  /** How many basis states that remainder stands for. */
  readonly hiddenStates: number
  /** The row that gained the most probability. Null when nothing gained any. */
  readonly largestGain: NoiseRow | null
  /** The row that lost the most. Null when nothing lost any. */
  readonly largestLoss: NoiseRow | null
  /** F(p_ideal, p_noisy), over the whole distribution rather than the rows. */
  readonly distributionFidelity: number
  /** ½ Σ|Δ|, likewise over the whole distribution. See `noiseJob.ts`. */
  readonly totalVariation: number
  /** ⟨ψ|ρ|ψ⟩, or null when no ρ was formed. */
  readonly stateFidelity: number | null
  /** Tr(ρ²), or null as above. */
  readonly purity: number | null
  /** Shots drawn, or null for the exact method. */
  readonly shots: number | null
}

/**
 * Line the noisy reading up against the ideal state it was measured beside.
 *
 * `state` and `reading` must come from the same response, and the protocol is
 * what guarantees it: the noisy run travels in the same message as the state it
 * is compared against, precisely so that no edit can land between them
 * (`protocol.ts`). A comparison assembled from two round trips would show a
 * difference that looks exactly like noise and is not.
 */
export function buildNoiseComparison(
  state: Statevector,
  reading: NoiseReading,
  limit: number = DEFAULT_BAR_LIMIT
): NoiseComparison {
  const model = buildHistogram(state, { limit })
  const noisy = readerFor(reading)

  let listedNoisy = 0
  const rows = model.bars.map((bar): NoiseRow => {
    const value = noisy.at(bar.index, bar.label)
    listedNoisy += value
    return {
      index: bar.index,
      label: bar.label,
      ideal: bar.probability,
      noisy: value,
      delta: value - bar.probability,
    }
  })

  /*
   * The remainder's noisy share is the total minus what is listed, and the
   * total is summed from the payload rather than assumed to be 1 — the same
   * ruling `buildHistogram` makes about its own remainder, for the same reason:
   * a distribution half way through a renormalisation interval does not sum to
   * exactly one, and a row that inherited that error would report probability
   * where there is none. Clamped for the same reason.
   */
  const hiddenNoisy = Math.max(0, noisy.total - listedNoisy)
  const remainder: NoiseRow | null =
    model.hidden === 0 && hiddenNoisy <= 0
      ? null
      : {
          index: null,
          label: '',
          ideal: model.hiddenProbability,
          noisy: hiddenNoisy,
          delta: hiddenNoisy - model.hiddenProbability,
        }

  const everyRow = remainder === null ? rows : [...rows, remainder]
  return {
    qubits: model.qubits,
    method: reading.method,
    rows,
    remainder,
    hiddenStates: model.hidden,
    largestGain: extreme(everyRow, 1),
    largestLoss: extreme(everyRow, -1),
    distributionFidelity: reading.distributionFidelity,
    totalVariation: reading.totalVariation,
    stateFidelity: reading.stateFidelity,
    purity: reading.purity,
    shots: reading.shots,
  }
}

/**
 * The comparison as the chart consumes it — see `HistogramOverlay`.
 *
 * The two labels are passed in already translated because neither this module
 * nor `histogram.ts` has an i18next instance, and neither should: they are
 * arithmetic over a distribution, testable without a DOM and reasonable about
 * without a renderer.
 */
export function overlayOf(
  comparison: NoiseComparison,
  label: string,
  deltaLabel: string
): HistogramOverlay {
  return {
    probabilities: new Map(
      comparison.rows.flatMap((row) =>
        row.index === null ? [] : [[row.index, row.noisy] as const]
      )
    ),
    remainder: comparison.remainder?.noisy ?? 0,
    label,
    deltaLabel,
  }
}

/* ──────────────────────────────── internals ─────────────────────────── */

/** One noisy probability per basis state, whichever payload carried it. */
interface NoisyReader {
  readonly at: (index: number, label: string) => number
  /** Everything the noisy run put anywhere — the denominator of a remainder. */
  readonly total: number
}

function readerFor(reading: NoiseReading): NoisyReader {
  const { distribution, counts, shots } = reading
  if (distribution !== null) {
    let total = 0
    for (let index = 0; index < distribution.length; index++) {
      total += distribution[index] ?? 0
    }
    return { at: (index) => distribution[index] ?? 0, total }
  }

  // The sampled method. A share of zero shots is zero rather than NaN: a run
  // that drew nothing is a legitimate answer to `shots = 0`, and one NaN in a
  // width attribute takes the whole chart down.
  const drawn = shots ?? 0
  const tally = counts ?? {}
  let total = 0
  for (const count of Object.values(tally)) total += count
  return {
    at: (_index, label) => (drawn === 0 ? 0 : (tally[label] ?? 0) / drawn),
    total: drawn === 0 ? 0 : total / drawn,
  }
}

/**
 * The row whose delta is furthest in `direction`, or null when none moved that
 * way by more than `MOVEMENT_FLOOR`.
 *
 * Ties go to the first row in basis-state order, so a distribution where two
 * outcomes lost exactly as much names the same one on every run rather than one
 * that depends on iteration order — the same tie-break rule `buildHistogram`
 * applies to its bars, and for the same reason.
 */
function extreme(
  rows: readonly NoiseRow[],
  direction: 1 | -1
): NoiseRow | null {
  let best: NoiseRow | null = null
  for (const row of rows) {
    const signed = row.delta * direction
    if (signed <= MOVEMENT_FLOOR) continue
    if (best === null || signed > best.delta * direction) best = row
  }
  return best
}
