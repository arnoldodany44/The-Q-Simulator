/**
 * §3.3's side-by-side — the ideal distribution and the noisy one, with the
 * fidelity between them.
 *
 * ────────────────────────────────────────────────────────────────────────
 * IT IS ONE CHART, NOT TWO
 *
 * "Side by side" is what §3.3 asks for and two adjacent charts is not how to
 * give it: the reader would be subtracting a bar here from a bar over there,
 * across a gap, from memory. What they want to know is which outcomes gained
 * probability and which lost it, and that is a quantity neither chart states.
 *
 * So the phasor histogram is reused with an overlay (`histogram.ts`): the bar
 * is still the ideal probability with its phasor and its hue, a tick marks
 * where the noise put it, and a coloured sliver between the two is the move —
 * outside the bar for a gain, cut out of it for a loss. The same "one track,
 * two marks" ruling §3.2 made for the shots control, applied to a second
 * question, and one chart rather than two for the same reason: what the reader
 * is looking at is a *gap*.
 *
 * ────────────────────────────────────────────────────────────────────────
 * FOUR NUMBERS, AND WHY IT IS NOT ONE
 *
 * The headline is the fidelity §3.3 names, but a fidelity alone would flatter
 * the noise:
 *
 *  - **Distribution fidelity** compares the two histograms. It is the number
 *    beside the chart because it is the number the chart is *of* — and it is
 *    the weakest of the four: phase damping can leave every bar exactly where
 *    it was and destroy every coherence in the state.
 *  - **Total variation** is how much probability changed hands, which is what
 *    the slivers add up to. A fidelity of 0.98 and one of 0.99 both read as
 *    "close"; a fifth of the probability moving does not.
 *  - **State fidelity** is ⟨ψ|ρ|ψ⟩ — how much of the ideal *state* survived. It
 *    is the one that catches what the histogram cannot, and it exists only for
 *    the exact method, because the sampled one never forms a ρ.
 *  - **Purity** is Tr(ρ²): 1 for a state that is still a state at all, 1/2ⁿ for
 *    one the channel has turned into noise. Same availability.
 *
 * The panel says which method ran, always. A fidelity read to four digits off
 * ten thousand sampled shots would be four digits of shot noise, and the
 * summary line prints the size of that noise beside it rather than leaving the
 * reader to assume there is none.
 */

import type { Statevector } from '@qsim/core'
import { Fragment, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { fenceNotation, splitFencedNotation } from '../../lib/prose'
import type { NoiseReading } from '../simulation/protocol'
import { ProbabilityHistogram } from './ProbabilityHistogram'
import { formatCoordinate, formatCount, formatProbability } from './format'
import { DEFAULT_BAR_LIMIT, ket } from './histogram'
import {
  buildNoiseComparison,
  overlayOf,
  type NoiseComparison as Comparison,
  type NoiseRow,
} from './noiseComparison'
import { standardError } from './sampling'

export interface NoiseComparisonPanelProps {
  /** The ideal state, from the same response the reading came in. */
  readonly state: Statevector
  readonly reading: NoiseReading
  /** How many basis states are drawn. The chart's cap, shared deliberately. */
  readonly barLimit?: number
}

export function NoiseComparisonPanel({
  state,
  reading,
  barLimit = DEFAULT_BAR_LIMIT,
}: NoiseComparisonPanelProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language

  const comparison = useMemo(
    () => buildNoiseComparison(state, reading, barLimit),
    [state, reading, barLimit]
  )
  const noisyLabel = t('noise.comparison.column.noisy')
  const deltaLabel = t('noise.comparison.column.difference')
  // An array of one. This chart draws a single further reading; §3.7's takes
  // the same prop with two, which is the whole of what they have in common.
  const overlays = useMemo(
    () => [overlayOf(comparison, noisyLabel, deltaLabel)],
    [comparison, noisyLabel, deltaLabel]
  )

  return (
    <section className="noise-comparison">
      <h4 className="noise-comparison__heading">
        {t('noise.comparison.heading')}
      </h4>

      <p className="noise-comparison__method">
        {comparison.method === 'density'
          ? t('noise.comparison.ranDensity')
          : t('noise.comparison.ranTrajectories', {
              shots: formatCount(comparison.shots ?? 0, language),
              typical: formatProbability(
                standardError(comparison.shots ?? 0),
                language
              ),
            })}
      </p>

      <dl className="noise-comparison__figures">
        <Figure
          term={t('noise.comparison.fidelity')}
          value={formatCoordinate(comparison.distributionFidelity, language)}
        />
        <Figure
          term={t('noise.comparison.moved')}
          value={formatProbability(comparison.totalVariation, language)}
        />
        {comparison.stateFidelity === null ? null : (
          <Figure
            term={t('noise.comparison.stateFidelity')}
            value={formatCoordinate(comparison.stateFidelity, language)}
          />
        )}
        {comparison.purity === null ? null : (
          <Figure
            term={t('noise.comparison.purity')}
            value={formatCoordinate(comparison.purity, language)}
          />
        )}
      </dl>

      <Movement comparison={comparison} language={language} />

      {/*
       * The chart of §3.2, carrying a second reading. Its own heading and
       * caption are overridden because this caller has its own vocabulary — the
       * same two props the landing demo uses — and its accessible table becomes
       * visible on its own, because a sliver between a bar and a tick is not a
       * length anyone can measure by eye (`ProbabilityHistogram.tsx`).
       */}
      <ProbabilityHistogram
        state={state}
        barLimit={barLimit}
        overlays={overlays}
        heading={t('noise.comparison.chart.heading')}
        summary={t('noise.comparison.chart.summary')}
      />
    </section>
  )
}

function Figure({
  term,
  value,
}: {
  readonly term: string
  readonly value: string
}) {
  return (
    <div className="noise-comparison__figure">
      <dt>{term}</dt>
      <dd className="tabular-numbers">{value}</dd>
    </div>
  )
}

/**
 * The sentence that names the biggest winner and the biggest loser.
 *
 * It is the difference read out loud, and it is here rather than left to the
 * chart because the chart shows *every* row's move and a reader arriving at the
 * panel needs to know which one to look at first. Both are named when both
 * exist: probability is conserved, so a distribution that lost some somewhere
 * gained it somewhere else, and saying only one half would make the noise look
 * like a leak.
 *
 * The remainder row has no ket, so it is named in words — it stands for states
 * that share no label, and an ellipsis in the middle of a sentence would be a
 * riddle. That row is also where an outcome the noise *created* shows up: the
 * chart's rows are chosen by ideal probability, so a state the circuit never
 * reaches has no row of its own (`noiseComparison.ts`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE KET INSIDE THE SENTENCE IS STILL NOTATION
 *
 * This is the one place on the panel where invariant notation is interpolated
 * *into* a translated string rather than rendered on its own, and for a while it
 * was the one ket in the analysis panel that reached the DOM as bare text. D2
 * names `components/Notation.tsx` as the only sanctioned route for notation, and
 * that component's own header gives the reason the marking is not decorative:
 * `translate="no"` is what stops a browser-level page translator from rewriting
 * `|011⟩` into words. Every other ket here — the histogram's labels, the
 * amplitude table, the Q-sphere's rows, the shot sampler, the density map — goes
 * through it.
 *
 * So the notation arguments are interpolated *fenced*, and the finished sentence
 * is split back apart on the fence: the odd pieces are the notation and become
 * `Notation`, the even pieces are the translator's prose and stay text. The
 * alternative — matching a ket-shaped regex against the rendered sentence —
 * would mark notation by recognising it rather than by knowing it, and would
 * quietly stop working the day a locale wrote something ket-shaped of its own.
 * `others` is deliberately *not* fenced: it is translated prose and a page
 * translator should be free to have it.
 */

/*
 * The fence itself lives in `lib/prose.ts` since M5.4: a comment’s anchor
 * sentence — "H on q0, column 3" — interpolates a gate symbol and a wire’s own
 * name into a translated string and owes them the same marking, and one fence
 * character defined in two files is one place for two definitions to drift.
 */

function Movement({
  comparison,
  language,
}: {
  readonly comparison: Comparison
  readonly language: string
}) {
  const { t } = useTranslation('analysis')
  const { largestGain, largestLoss } = comparison

  const name = (row: NoiseRow): string =>
    row.index === null
      ? t('noise.comparison.movement.others')
      : fenceNotation(ket(row.label))

  let sentence: string
  if (largestGain !== null && largestLoss !== null) {
    sentence = t('noise.comparison.movement.both', {
      lost: name(largestLoss),
      loss: formatProbability(-largestLoss.delta, language),
      gained: name(largestGain),
      gain: formatProbability(largestGain.delta, language),
    })
  } else if (largestGain !== null) {
    sentence = t('noise.comparison.movement.gainOnly', {
      state: name(largestGain),
      gain: formatProbability(largestGain.delta, language),
    })
  } else if (largestLoss !== null) {
    sentence = t('noise.comparison.movement.lossOnly', {
      state: name(largestLoss),
      loss: formatProbability(-largestLoss.delta, language),
    })
  } else {
    sentence = t('noise.comparison.movement.none')
  }

  return (
    <p className="noise-comparison__summary">
      {splitFencedNotation(sentence).map((span, index) => (
        // The index is part of the key because the same ket can legitimately
        // appear twice in one sentence, and the position is what tells them
        // apart. The array is rebuilt from scratch on every render anyway.
        <Fragment key={`${String(index)}:${span.text}`}>
          {span.notation ? <Notation value={span.text} /> : span.text}
        </Fragment>
      ))}
    </p>
  )
}
