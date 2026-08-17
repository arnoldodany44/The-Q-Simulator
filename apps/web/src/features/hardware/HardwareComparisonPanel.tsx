/**
 * §3.7's three columns — ideal, modelled, real — as one chart.
 *
 * ════════════════════════════════════════════════════════════════════════
 * IT IS ONE CHART, NOT THREE
 *
 * "Vista comparativa de tres columnas" is what §3.7 asks for, and three charts
 * drawn side by side is not how to give it. Three renderings invite the reader
 * to compare the *drawings* — this one is taller, that one has more bars — when
 * the question is which outcomes gained probability and which lost it, and by
 * how much. That is a quantity no set of charts states: it is a bar here minus
 * a bar over there, held in the reader's head across two gaps.
 *
 * So this is the phasor histogram of §3.2, reused with two overlays. The bar is
 * the ideal probability, with its phasor and its hue; the upper band carries
 * the noise model's reading and the lower one the device's, each with a tick
 * where it landed and a coloured sliver showing the move. The same "one track,
 * several marks" ruling §3.3 made for the noisy column, extended by exactly one
 * reading — `HistogramOverlay` in `histogram.ts` argues the lanes at length.
 *
 * ════════════════════════════════════════════════════════════════════════
 * FIVE NUMBERS, AND THE FIFTH IS THE ONE THAT ONLY EXISTS HERE
 *
 * Four of them are §3.3's pair of figures applied twice: fidelity and total
 * variation, for the model against the ideal and for the device against it.
 * `noiseComparison.ts` argues why a fidelity alone would flatter the noise, and
 * the argument is unchanged.
 *
 * The fifth is **model against device**, and it is the reason all three
 * readings are worth putting on one page. It says whether the noise profile
 * predicted the machine. A profile that did is one worth trusting on a circuit
 * nobody has run, which is the entire practical value of a noise model; one
 * that did not is the most interesting result on the screen, and it is invisible
 * from the other four numbers — two distributions can each sit the same distance
 * from the ideal one and be nowhere near each other.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SAMPLING ERROR IS PRINTED, ALWAYS
 *
 * The third column is a finite number of shots off a real machine — a thousand,
 * usually, because the Open Plan's allowance is ten minutes per twenty-eight
 * days. At a thousand shots the standard error on a probability is around 1.6 %,
 * which is the same size as the effects this panel exists to show. A fidelity
 * read to four digits off that is four digits of shot noise, so the panel prints
 * the size of the noise beside the figures rather than leaving the reader to
 * assume there is none — the same ruling §3.3's panel makes about its own
 * sampled method.
 */

import type { Statevector } from '@qsim/core'
import { Fragment, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { ProbabilityHistogram } from '../analysis/ProbabilityHistogram'
import {
  formatCoordinate,
  formatCount,
  formatProbability,
} from '../analysis/format'
import { DEFAULT_BAR_LIMIT, ket } from '../analysis/histogram'
import { standardError } from '../analysis/sampling'
import {
  overlaysOf,
  type HardwareComparison,
  type HardwareRow,
} from './comparison'

export interface HardwareComparisonPanelProps {
  /** The ideal state, from the same worker response the noisy reading came in. */
  readonly state: Statevector
  readonly comparison: HardwareComparison
  /** The device's name. It is a column header, so it is the chip and not "real". */
  readonly backend: string
  /** How many basis states are drawn. The chart's cap, shared deliberately. */
  readonly barLimit?: number
  /**
   * The name of the noise profile that produced the middle column, translated
   * by whoever owns the control that chose it.
   *
   * Passed in rather than assumed. The note under these figures used to state a
   * transmon profile unconditionally, while the same page offers a select with
   * `ideal`, `superconducting`, `trappedIon`, `teaching` and `custom` on it —
   * so the sentence became false the moment the feature was used the way its
   * own header invites ("turn the coherence and the gate errors until the
   * middle column lands on the right-hand one"). A trapped-ion model beside a
   * superconducting Heron is a perfectly good thing to look at; describing it
   * as transmon-like is not.
   *
   * Null when the caller does not know, and then the note says only what is
   * true of every profile: the model ran the circuit as drawn and the device
   * ran the transpiled program.
   */
  readonly noiseProfileName?: string | null
}

export function HardwareComparisonPanel({
  state,
  comparison,
  backend,
  barLimit = DEFAULT_BAR_LIMIT,
  noiseProfileName = null,
}: HardwareComparisonPanelProps) {
  const { t, i18n } = useTranslation('hardware')
  const language = i18n.language

  /*
   * The device's column is headed with the chip's name rather than with the
   * word "real", and that is not decoration: two runs of one circuit on two
   * devices are two different measurements, and a reader who saved both wants
   * to know which machine each column came off.
   */
  const labels = useMemo(
    () => ({
      noisy: t('comparison.column.noisy'),
      noisyDelta: t('comparison.column.noisyDelta'),
      real: t('comparison.column.real', { backend }),
      realDelta: t('comparison.column.realDelta'),
    }),
    [t, backend]
  )
  const overlays = useMemo(
    () => overlaysOf(comparison, labels),
    [comparison, labels]
  )

  return (
    <section className="hardware-comparison">
      <h3 className="hardware-comparison__heading">
        {t('comparison.heading')}
      </h3>
      <p className="hardware-comparison__lead">{t('comparison.lead')}</p>

      <p className="hardware-comparison__note">
        {t('comparison.shotNote', {
          shots: formatCount(comparison.shots, language),
          typical: formatProbability(standardError(comparison.shots), language),
        })}
      </p>

      <dl className="hardware-comparison__figures">
        <Figure
          term={t('comparison.figure.deviceFidelity')}
          value={formatCoordinate(comparison.deviceVsIdeal.fidelity, language)}
        />
        <Figure
          term={t('comparison.figure.deviceMoved')}
          value={formatProbability(
            comparison.deviceVsIdeal.totalVariation,
            language
          )}
        />
        {comparison.noiseVsIdeal === null ? null : (
          <>
            <Figure
              term={t('comparison.figure.modelFidelity')}
              value={formatCoordinate(
                comparison.noiseVsIdeal.fidelity,
                language
              )}
            />
            <Figure
              term={t('comparison.figure.modelMoved')}
              value={formatProbability(
                comparison.noiseVsIdeal.totalVariation,
                language
              )}
            />
          </>
        )}
        {comparison.modelVsReal === null ? null : (
          <>
            <Figure
              term={t('comparison.figure.modelVsDevice')}
              value={formatCoordinate(
                comparison.modelVsReal.fidelity,
                language
              )}
            />
            {/*
             * The total variation for the pair this panel calls the most
             * important one. It was computed and discarded, against the
             * panel's own rule: a fidelity alone flatters because it
             * saturates, which is why the other two pairs each print both.
             * On the worked example above, "0.9853" reads as very close while
             * six per cent of the probability is in the wrong place.
             */}
            <Figure
              term={t('comparison.figure.modelVsDeviceMoved')}
              value={formatProbability(
                comparison.modelVsReal.totalVariation,
                language
              )}
            />
          </>
        )}
      </dl>

      {comparison.modelVsReal !== null ? (
        <>
          <p className="hardware-comparison__note">
            {t('comparison.modelVsDeviceLead')}
          </p>
          {/*
           * The one caveat that keeps that number honest: the model simulates
           * the circuit as drawn, and the device ran the transpiled program.
           * Without this sentence a reader would take the gap as the model
           * being wrong about the physics, when most of it is the eight extra
           * gates the section below counts.
           *
           * The profile is named when the caller knows which one is selected,
           * and the sentence says nothing about the physics when it does not.
           */}
          <p className="hardware-comparison__note">
            {noiseProfileName === null
              ? t('comparison.modelScopeNote')
              : t('comparison.modelScopeNoteNamed', {
                  profile: noiseProfileName,
                })}
          </p>
        </>
      ) : comparison.noiseVsIdeal === null ? (
        <p className="hardware-comparison__note">
          {t('comparison.modelMissing')}
        </p>
      ) : (
        /* A noisy run happened, but a sampled one — see `comparison.ts`. */
        <p className="hardware-comparison__note">
          {t('comparison.modelVsDeviceMissing')}
        </p>
      )}

      <Movement comparison={comparison} language={language} />

      <ProbabilityHistogram
        state={state}
        barLimit={barLimit}
        overlays={overlays}
        heading={t('comparison.chart.heading')}
        summary={t('comparison.chart.summary')}
        tableCaption={t('comparison.chart.tableCaption')}
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
    <div className="hardware-comparison__figure">
      <dt>{term}</dt>
      <dd className="tabular-numbers">{value}</dd>
    </div>
  )
}

/**
 * The fence around an interpolated notation argument.
 *
 * The same device `NoiseComparisonPanel` uses, and for the reason its header
 * gives: D2 names `components/Notation.tsx` as the only sanctioned route for
 * notation, because `translate="no"` is what stops a browser-level page
 * translator from rewriting `|011⟩` into words. Interpolating a ket into a
 * translated sentence as bare text would be the one ket on the page that
 * escaped that. U+0000 because no catalog and no ket can contain one, and
 * because every occurrence is consumed by the split below.
 */
const NOTATION_FENCE = '\u0000'

function fenced(value: string): string {
  return `${NOTATION_FENCE}${value}${NOTATION_FENCE}`
}

/**
 * The sentence naming the outcome the device gained most on and the one it lost
 * most on.
 *
 * It is the difference read out loud. The chart shows every row's move, and a
 * reader arriving at a page of thirty-two bars needs to be told which one to
 * look at first. Both are named when both exist: probability is conserved, so a
 * distribution that lost some somewhere gained it somewhere else, and naming
 * only the loss would make a device look like a leak.
 *
 * The remainder has no ket, so it is named in words — it stands for states that
 * share no label, and an ellipsis mid-sentence would be a riddle. It is also
 * where the most characteristic hardware effect shows up: the rows are chosen
 * by *ideal* probability, so every outcome the circuit never reaches and the
 * device found anyway is in that one row.
 */
function Movement({
  comparison,
  language,
}: {
  readonly comparison: HardwareComparison
  readonly language: string
}) {
  const { t } = useTranslation('hardware')
  const { largestGain, largestLoss } = comparison

  const name = (row: HardwareRow): string =>
    row.index === null
      ? t('comparison.movement.others')
      : fenced(ket(row.label))

  let sentence: string
  if (largestGain !== null && largestLoss !== null) {
    sentence = t('comparison.movement.both', {
      lost: name(largestLoss),
      loss: formatProbability(-largestLoss.realDelta, language),
      gained: name(largestGain),
      gain: formatProbability(largestGain.realDelta, language),
    })
  } else if (largestGain !== null) {
    sentence = t('comparison.movement.gainOnly', {
      state: name(largestGain),
      gain: formatProbability(largestGain.realDelta, language),
    })
  } else if (largestLoss !== null) {
    sentence = t('comparison.movement.lossOnly', {
      state: name(largestLoss),
      loss: formatProbability(-largestLoss.realDelta, language),
    })
  } else {
    sentence = t('comparison.movement.none')
  }

  const pieces = sentence.split(NOTATION_FENCE)
  return (
    <p className="hardware-comparison__summary">
      {pieces.map((piece, index) => (
        // The index is part of the key because the same ket can legitimately
        // appear twice in one sentence, and the position is what tells them
        // apart. The array is rebuilt from scratch on every render anyway.
        <Fragment key={`${String(index)}:${piece}`}>
          {index % 2 === 1 ? <Notation value={piece} /> : piece}
        </Fragment>
      ))}
    </p>
  )
}
