/**
 * §3.7's three-column comparison, as arithmetic: the ideal distribution, the
 * one a noise model predicts, and the one a device actually produced, on the
 * same rows — with the difference between each pair stated rather than left for
 * the reader to subtract.
 *
 * No React, no i18next, no colour, and no physics. Every distribution arrives
 * already finished: the ideal one from the statevector the worker returned, the
 * noisy one from the same response (`noiseComparison.ts` lines those two up and
 * this module takes its answer whole), and the real one from a stored
 * `HardwareJob.result` folded onto basis states by `alignment.ts`. What happens
 * here is a join and four subtractions — the same division `noiseComparison.ts`
 * makes, for the same reason.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY THE NOISY HALF IS NOT RECOMPUTED
 *
 * `buildNoiseComparison` already produced it, from a reading whose fidelity and
 * total variation were computed **on the worker, where both distributions
 * existed whole**. Recomputing either here would give a second answer to a
 * question already answered — differing in the last digits at best, and at
 * worst differing because this module only ever sees the thirty-two rows the
 * chart drew while the worker saw all 2ⁿ. Two numbers labelled "fidelity" on
 * one screen, disagreeing, is worse than either.
 *
 * So the noisy column is *taken*, and what this module adds is the third one.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THREE PAIRS, AND THE THIRD IS THE ONE §3.7 IS ABOUT
 *
 *   ideal ↔ noisy   what the model says the device should have done.
 *   ideal ↔ real    what the device did to the circuit. The headline.
 *   noisy ↔ real    **how good the model was**, which is the question a reader
 *                   only gets to ask because all three are on one chart. A
 *                   noise profile that predicted the device is a profile worth
 *                   trusting on a circuit nobody has run; one that did not is
 *                   the most interesting result on the page, and neither fact
 *                   is visible from the first two numbers.
 *
 * The third needs a *full* noisy distribution, which only the density method
 * produces — a trajectories run answers with a tally over the states it
 * happened to visit. Rather than reconstruct one from that tally and label it
 * the same thing, `modelVsReal` is null there and the panel says why. A number
 * that silently changes meaning with a method the reader chose in a different
 * panel is a number nobody can use.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE ROWS ARE THE HISTOGRAM'S, AND THAT IS LOAD-BEARING
 *
 * `buildHistogram` chooses which basis states are drawn (§3.2's three rules),
 * and this module takes that choice rather than making its own — the same
 * ruling `noiseComparison.ts` and `amplitudes.ts` make, for the same reason:
 * three renderings of one distribution that each picked their own states would
 * let a bar exist with no row beside it.
 *
 * The selection is by *ideal* probability, so an outcome the **device** created
 * out of nothing — probability zero ideally, four percent on hardware — is not
 * a row of its own. It is not lost: it lands in the remainder, and the
 * remainder's own difference is precisely "the device put probability where the
 * circuit put none", which on a real Heron is where a surprising amount of it
 * goes. Choosing rows by the device's distribution instead would reorder the
 * chart depending on which job was loaded, which is the defect §3.2's ordering
 * rule exists to prevent.
 */

import { distributionFidelity, type Statevector } from '@qsim/core'

import {
  DEFAULT_BAR_LIMIT,
  buildHistogram,
  type HistogramOverlay,
} from '../analysis/histogram'
import {
  MOVEMENT_FLOOR,
  type NoiseComparison,
} from '../analysis/noiseComparison'

/** How two distributions differ, in the two numbers §3.3 argued for. */
export interface PairReading {
  /** F(p, q) = (Σ √(pᵢqᵢ))². Saturates: 0.98 and 0.99 both read as "close". */
  readonly fidelity: number
  /** ½ Σ|pᵢ − qᵢ|: how much probability changed hands. What the slivers sum to. */
  readonly totalVariation: number
}

/** One basis state, across all three readings. */
export interface HardwareRow {
  /** Statevector index, or null for the aggregated remainder row. */
  readonly index: number | null
  /** `formatKet`'s label; empty for the remainder row. */
  readonly label: string
  /** Born-rule probability of the ideal run. */
  readonly ideal: number
  /** The same outcome under the noise model, or null when none was run. */
  readonly noisy: number | null
  /** The device's share of its shots for this outcome. */
  readonly real: number
  /** `noisy − ideal`, or null when there is no noisy run. */
  readonly noisyDelta: number | null
  /** `real − ideal`: signed, so the direction of the move shows. */
  readonly realDelta: number
}

export interface HardwareComparison {
  /** Register size, so the drawing can reserve a column for the labels. */
  readonly qubits: number
  /** The listed states, in ascending basis-state order. */
  readonly rows: readonly HardwareRow[]
  /** Everything the cap left out, as one row. Null when it left nothing out. */
  readonly remainder: HardwareRow | null
  /** How many basis states that remainder stands for. */
  readonly hiddenStates: number
  /** Shots the device actually returned. The resolution of the third column. */
  readonly shots: number
  /** ideal ↔ real. Always present: it is what the job measured. */
  readonly deviceVsIdeal: PairReading
  /** ideal ↔ noisy, taken from the worker's own reading. Null with no noise run. */
  readonly noiseVsIdeal: PairReading | null
  /** noisy ↔ real — how good the model was. See the header for when it is null. */
  readonly modelVsReal: PairReading | null
  /** The row the device gained the most probability on. Null when none did. */
  readonly largestGain: HardwareRow | null
  /** The row it lost the most on. Null when none did. */
  readonly largestLoss: HardwareRow | null
}

/**
 * Line a device's answer up against the ideal state and, when there is one, the
 * noisy prediction.
 *
 * `real` is a distribution over **all** 2ⁿ basis states — `distributionFromCounts`
 * in `alignment.ts` produces exactly that — rather than the counts themselves,
 * because the fidelity needs the whole thing and the remainder row needs the
 * part of it the chart is not drawing.
 *
 * `noise` must have been built from the *same* state, which the caller
 * guarantees by building both from one worker response. A comparison assembled
 * from two runs would show a difference that looks exactly like hardware error
 * and is not.
 */
export function buildHardwareComparison(
  state: Statevector,
  real: ArrayLike<number>,
  shots: number,
  noise: NoiseComparison | null,
  noisyDistribution: ArrayLike<number> | null,
  limit: number = DEFAULT_BAR_LIMIT
): HardwareComparison {
  const model = buildHistogram(state, { limit })
  const noisyByIndex = new Map(
    (noise?.rows ?? []).flatMap((row) =>
      row.index === null ? [] : [[row.index, row.noisy] as const]
    )
  )

  let listedReal = 0
  let realTotal = 0
  for (let index = 0; index < real.length; index++)
    realTotal += real[index] ?? 0

  const rows = model.bars.map((bar): HardwareRow => {
    const value = real[bar.index] ?? 0
    listedReal += value
    const noisy = noisyByIndex.get(bar.index) ?? null
    return {
      index: bar.index,
      label: bar.label,
      ideal: bar.probability,
      noisy,
      real: value,
      noisyDelta: noisy === null ? null : noisy - bar.probability,
      realDelta: value - bar.probability,
    }
  })

  /*
   * Summed from the payload rather than assumed to be 1, and clamped — the same
   * ruling `buildHistogram` and `buildNoiseComparison` make about their own
   * remainders, and it matters more here: a device's counts are integers over a
   * finite number of shots, so the total is exact, but the *ideal* half is a
   * state half way through a renormalisation interval and a remainder that
   * inherited its drift would report probability where there is none.
   */
  const hiddenReal = Math.max(0, realTotal - listedReal)
  const hiddenNoisy = noise === null ? null : (noise.remainder?.noisy ?? 0)
  const remainder: HardwareRow | null =
    model.hidden === 0 && hiddenReal <= 0 && (hiddenNoisy ?? 0) <= 0
      ? null
      : {
          index: null,
          label: '',
          ideal: model.hiddenProbability,
          noisy: hiddenNoisy,
          real: hiddenReal,
          noisyDelta:
            hiddenNoisy === null ? null : hiddenNoisy - model.hiddenProbability,
          realDelta: hiddenReal - model.hiddenProbability,
        }

  const everyRow = remainder === null ? rows : [...rows, remainder]
  const ideal = probabilitiesOf(state)

  return {
    qubits: model.qubits,
    rows,
    remainder,
    hiddenStates: model.hidden,
    shots,
    deviceVsIdeal: pairReading(ideal, real),
    noiseVsIdeal:
      noise === null
        ? null
        : {
            fidelity: noise.distributionFidelity,
            totalVariation: noise.totalVariation,
          },
    modelVsReal:
      noisyDistribution === null ? null : pairReading(noisyDistribution, real),
    largestGain: extreme(everyRow, 1),
    largestLoss: extreme(everyRow, -1),
  }
}

/**
 * The comparison as the chart consumes it — one overlay per further reading,
 * in the order they are drawn.
 *
 * The labels are passed in already translated because this module has no
 * i18next instance and should not: it is arithmetic over distributions,
 * testable without a DOM. The noisy overlay is omitted entirely when there is
 * no noisy run, rather than passed as a lane of zeros — a band of "lost
 * everything" on every row would be a claim about a model nobody ran.
 */
export function overlaysOf(
  comparison: HardwareComparison,
  labels: {
    readonly noisy: string
    readonly noisyDelta: string
    readonly real: string
    readonly realDelta: string
  }
): readonly HistogramOverlay[] {
  const overlays: HistogramOverlay[] = []

  if (comparison.noiseVsIdeal !== null) {
    overlays.push({
      probabilities: new Map(
        comparison.rows.flatMap((row) =>
          row.index === null || row.noisy === null
            ? []
            : [[row.index, row.noisy] as const]
        )
      ),
      remainder: comparison.remainder?.noisy ?? 0,
      label: labels.noisy,
      deltaLabel: labels.noisyDelta,
    })
  }

  overlays.push({
    probabilities: new Map(
      comparison.rows.flatMap((row) =>
        row.index === null ? [] : [[row.index, row.real] as const]
      )
    ),
    remainder: comparison.remainder?.real ?? 0,
    label: labels.real,
    deltaLabel: labels.realDelta,
  })

  return overlays
}

/* ──────────────────────────────── internals ─────────────────────────── */

/**
 * F and TV between two distributions.
 *
 * `distributionFidelity` refuses anything that does not sum to one, which is a
 * check worth keeping rather than working around — it is the difference between
 * "these are two distributions" and "somebody passed counts". A device's
 * distribution is normalised by construction (`distributionFromCounts` divides
 * by the counts' own sum) and a statevector's is normalised by the engine, so
 * reaching the throw means one of those two invariants broke, which is a defect
 * and not a display case.
 */
function pairReading(p: ArrayLike<number>, q: ArrayLike<number>): PairReading {
  let variation = 0
  for (let index = 0; index < p.length; index++) {
    variation += Math.abs((p[index] ?? 0) - (q[index] ?? 0))
  }
  return {
    fidelity: distributionFidelity(p, q),
    totalVariation: variation / 2,
  }
}

/** |a|² for every basis state, as one pass over the state. */
function probabilitiesOf(state: Statevector): Float64Array {
  const out = new Float64Array(state.size)
  for (let index = 0; index < state.size; index++) {
    const re = state.re[index] ?? 0
    const im = state.im[index] ?? 0
    out[index] = re * re + im * im
  }
  return out
}

/**
 * The row whose *device* difference is furthest in `direction`, or null when
 * none moved that way by more than `MOVEMENT_FLOOR`.
 *
 * The device's difference and not the model's, because the sentence this feeds
 * is about what the hardware did. Ties go to the first row in basis-state
 * order — the same tie-break `buildHistogram` and `buildNoiseComparison` apply,
 * so a distribution where two outcomes lost exactly as much names the same one
 * on every render rather than one that depends on iteration order.
 */
function extreme(
  rows: readonly HardwareRow[],
  direction: 1 | -1
): HardwareRow | null {
  let best: HardwareRow | null = null
  for (const row of rows) {
    const signed = row.realDelta * direction
    if (signed <= MOVEMENT_FLOOR) continue
    if (best === null || signed > best.realDelta * direction) best = row
  }
  return best
}
