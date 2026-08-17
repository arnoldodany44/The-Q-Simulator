/**
 * What the server said about a submission — §3.6, Phase 3.
 *
 * ── FEEDBACK THAT TEACHES ─────────────────────────────────────────────────
 *
 * "Fidelity 0.83" is a number. "Your state has the right magnitudes and the
 * wrong relative phase" is a lesson: it says where to look, and it says it
 * without giving the answer away. The server computes the diagnosis — it is the
 * only side holding the target — and sends its *name*; this component turns
 * each name into a sentence from the catalogs, which is what keeps the teaching
 * text translatable (D2).
 *
 * ── COLOUR IS NEVER THE ONLY CARRIER ──────────────────────────────────────
 *
 * §10 requires it and a pass/fail badge is exactly where it gets forgotten. The
 * verdict says "solved" or "not yet" in words, and the panel carries a
 * `data-passed` attribute for styling.
 *
 * ── THE LIVE REGION IS NOT HERE, AND THAT IS THE POINT ────────────────────
 *
 * It used to be, on the `<section>` below — which only exists once there is a
 * result. A region and its contents inserted in one mutation is the pattern
 * this project documents twice as the one assistive technology never
 * announces, so the moment challenge mode exists for was the moment nothing
 * was said. The region now lives in `ChallengePlayer`, empty and permanent,
 * and this component is what goes inside it.
 */

import { useTranslation } from 'react-i18next'
import type {
  ChallengeFeedback,
  ChallengeFeedbackCode,
  ChallengeSubmissionResult,
} from '@qsim/contract'

import { Notation } from '../../components/Notation'
import { fidelityFormat } from './numbers'

/**
 * What kind of number each diagnosis carries, so it can be formatted before it
 * reaches a sentence.
 *
 * i18next's `count` is deliberately not used: it switches on plural category,
 * which is right for "3 rows" and wrong for a fidelity of 0.833 and for a phase
 * in radians — and a catalog where some keys need `_one`/`_other` and others
 * must not is a catalog a translator cannot review. So the value arrives
 * already formatted, as `{{value}}`, and the plural-sensitive sentences are
 * phrased so that they read for any count.
 */
const VALUE_KIND: Record<
  ChallengeFeedbackCode,
  'count' | 'fidelity' | 'angle' | 'none'
> = {
  'wrong-qubit-count': 'count',
  'empty-circuit': 'none',
  'gate-not-allowed': 'none',
  'not-scored': 'none',
  'no-final-state': 'none',
  'gate-budget-exceeded': 'count',
  orthogonal: 'none',
  'relative-phase': 'none',
  'qubit-order-reversed': 'none',
  'entanglement-missing': 'none',
  'entanglement-unwanted': 'none',
  'too-few-outcomes': 'count',
  'too-many-outcomes': 'count',
  'nearly-there': 'fidelity',
  'basis-states-only': 'count',
  'row-not-a-basis-state': 'count',
  'rows-wrong': 'count',
  'global-phase-ignored': 'angle',
  solved: 'fidelity',
}

export interface ChallengeVerdictProps {
  readonly result: ChallengeSubmissionResult
}

export function ChallengeVerdict({ result }: ChallengeVerdictProps) {
  const { t, i18n } = useTranslation('challenges')
  const { submission, feedback } = result

  /*
   * Locale-aware, because `fr` writes 0,83 and D2 does not stop at words
   * (§1.1). Three decimals: the default threshold is 0.99, so two would round
   * a near miss into a pass on screen.
   *
   * `i18n.language` and NOT `undefined`. `undefined` resolves to the runtime's
   * default locale — `navigator.language` in a browser — which is the machine's
   * language rather than the reader's chosen one, so a reader who picked
   * French saw English decimal points while the lesson player two panes away,
   * on the same product, wrote `0,833` correctly. Every other formatter in
   * `apps/web` passes the active language; these four did not.
   */
  const number = fidelityFormat(i18n.language)

  return (
    <section
      className="challenge-verdict"
      data-passed={submission.passed ? 'true' : 'false'}
    >
      <h3 className="challenge-verdict__heading">
        {submission.passed ? t('verdict.passed') : t('verdict.failed')}
      </h3>

      <dl className="challenge-verdict__figures">
        <div>
          <dt>{t('verdict.fidelity')}</dt>
          <dd>{number.format(submission.fidelity)}</dd>
        </div>
        <div>
          <dt>{t('verdict.gateCount')}</dt>
          <dd>{submission.gateCount}</dd>
        </div>
        <div>
          <dt>{t('verdict.depth')}</dt>
          <dd>{submission.depth}</dd>
        </div>
      </dl>

      <ul className="challenge-verdict__feedback">
        {feedback.map((entry, index) => (
          <li key={`${entry.code}-${String(index)}`}>
            {/*
             * The number travels as an interpolation and the gate travels
             * beside the sentence as a `Notation`: a gate id is invariant
             * notation (D2), so it must not be interpolated into a translated
             * string where it would look to a translator like a word.
             */}
            {t(`feedback.${entry.code}`, {
              value: formatValue(entry, number, i18n.language),
            })}
            {entry.gate === null ? null : (
              <>
                {' '}
                <Notation
                  className="challenge-verdict__gate"
                  value={entry.gate}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** One diagnosis's number, formatted for the active locale. */
function formatValue(
  entry: ChallengeFeedback,
  number: Intl.NumberFormat,
  language: string
): string {
  if (entry.value === null) return ''
  switch (VALUE_KIND[entry.code]) {
    case 'count':
      // An integer reads as an integer: `Intl` with three forced decimals
      // would render "3 rows" as "3,000".
      return new Intl.NumberFormat(language).format(entry.value)
    case 'fidelity':
      return number.format(entry.value)
    case 'angle':
      // Radians, to two places. The sign matters — it is which way round the
      // circle the reader's whole state sits — so it is kept.
      return new Intl.NumberFormat(language, {
        maximumFractionDigits: 2,
      }).format(entry.value)
    case 'none':
      return ''
  }
}
