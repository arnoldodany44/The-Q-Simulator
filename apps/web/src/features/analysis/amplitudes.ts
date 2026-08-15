/**
 * The model behind the amplitude table — §3.2: `|state⟩ → a + bi`, magnitude,
 * probability, phase in radians and degrees.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CAP IS THE HISTOGRAM'S CAP, BECAUSE IT IS ONE RULE AND NOT TWO.
 *
 * A twenty-qubit register is 1 048 576 rows, and a table is no better at
 * showing them than a chart is. So the same three rules apply — a floor of
 * 1e-12 on |a|², at most `DEFAULT_BAR_LIMIT` rows chosen by probability, and
 * whatever the cap leaves out reported as one aggregated remainder — and they
 * apply by *calling `buildHistogram`*, not by restating them.
 *
 * That matters beyond saving code. The chart and the table sit one above the
 * other, and a reader compares them: a bar with no row, or a row with no bar,
 * would read as a defect in the physics rather than as two selections that
 * disagree. Sharing the selection makes them incapable of disagreeing, and a
 * change to the cap moves both.
 *
 * What this module adds is the part a histogram bar has no use for: the
 * amplitude itself. `re` and `im` are read back out of the state at the index
 * the selection kept, which is `bars.length` reads — at most thirty-two —
 * rather than a second pass over the register.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SORTING IS A VIEW, NOT A REBUILD.
 *
 * §3.2 asks for the table to be sortable by probability. `sortAmplitudes`
 * therefore takes rows and returns rows: changing the order must not re-read
 * the state, because the state is up to eight megabytes and the order changes
 * on a click.
 *
 * Basis-state order is the default for the reason the histogram gives at
 * length: a row that keeps its address is a row a reader can watch change
 * while a slider moves. Probability order is what answers "what is this
 * circuit most likely to produce", which is a different question and worth a
 * click. Ties break on the index, so equal amplitudes — the common case, a
 * uniform superposition — produce one stable order rather than whatever the
 * sort happened to do.
 */

import type { Statevector } from '@qsim/core'

import {
  DEFAULT_BAR_LIMIT,
  PROBABILITY_FLOOR,
  buildHistogram,
} from './histogram'

/** One basis state, with everything §3.2 prints about it. */
export interface AmplitudeRow {
  /** Statevector index. Qubit `q` of it is `(index >> q) & 1` — D1. */
  readonly index: number
  /** `formatKet`'s label: highest qubit first, no bra-ket brackets. */
  readonly label: string
  /** Real part of the amplitude. */
  readonly re: number
  /** Imaginary part of the amplitude. */
  readonly im: number
  /** `|a|`. Not the probability — that is `|a|²` — and both are shown. */
  readonly magnitude: number
  /** Born-rule probability, straight from the histogram's own pass. */
  readonly probability: number
  /** Argument of the amplitude, folded into `[0, 2π)`. */
  readonly phase: number
}

export interface AmplitudeModel {
  readonly qubits: number
  /** 2ⁿ — every basis state, listed or not. */
  readonly size: number
  /** Basis states carrying any probability at all. */
  readonly occupied: number
  /** The listed rows, in ascending basis-state order. */
  readonly rows: readonly AmplitudeRow[]
  /** Occupied states the cap left out. Zero when everything is listed. */
  readonly hidden: number
  /** Probability those states hold between them. */
  readonly hiddenProbability: number
  /** The cap this model was built with, for the caption to quote. */
  readonly limit: number
}

/** The two orders §3.2 asks the table to offer. */
export type AmplitudeOrder = 'state' | 'probability'

/**
 * Reads the state once — through the histogram's selection — and answers with
 * every row the table can show, in basis-state order.
 */
export function buildAmplitudes(
  state: Statevector,
  limit: number = DEFAULT_BAR_LIMIT,
  floor: number = PROBABILITY_FLOOR
): AmplitudeModel {
  const model = buildHistogram(state, { limit, floor })

  return {
    qubits: model.qubits,
    size: model.size,
    occupied: model.occupied,
    rows: model.bars.map((bar) => {
      const re = state.re[bar.index] ?? 0
      const im = state.im[bar.index] ?? 0
      return {
        index: bar.index,
        label: bar.label,
        re,
        im,
        // `hypot` rather than `sqrt(probability)`: it is the same number
        // without the round trip through a square, and it does not overflow
        // on the way. The probability beside it is the engine's, unaltered.
        magnitude: Math.hypot(re, im),
        probability: bar.probability,
        phase: bar.phase,
      }
    }),
    hidden: model.hidden,
    hiddenProbability: model.hiddenProbability,
    limit: model.limit,
  }
}

/**
 * The rows in the requested order, as a new array. Never in place: the model
 * is memoised on the state and re-ordering it under React would leave two
 * renders disagreeing about what they drew.
 */
export function sortAmplitudes(
  rows: readonly AmplitudeRow[],
  order: AmplitudeOrder
): readonly AmplitudeRow[] {
  if (order === 'state') return [...rows].sort((a, b) => a.index - b.index)
  return [...rows].sort(
    (a, b) => b.probability - a.probability || a.index - b.index
  )
}
