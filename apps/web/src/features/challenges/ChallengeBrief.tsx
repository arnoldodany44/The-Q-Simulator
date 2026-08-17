/**
 * The rules of one challenge, as a reader needs them — §3.6, Phase 3.
 *
 * Everything on this panel arrived from the API, and what did *not* arrive is
 * the point: there is no target here, because the server never sent one. A
 * learner is given the prompt, the register, the gates they may use, the gate
 * budget and the fidelity they have to reach — which is enough to work with and
 * is not the answer.
 *
 * The line about what kind of target it is earns its place. "State", "operation"
 * and "truth table" are three different questions, and the third is the one
 * that has to be said out loud: a truth table fixes what happens to definite
 * bits and says nothing about superposed inputs, so a reader who assumed
 * otherwise would be debugging a phase the check never looked at.
 */

import { useTranslation } from 'react-i18next'
import type { Challenge } from '@qsim/contract'

import { Notation } from '../../components/Notation'
import { ChallengeProse } from './ChallengeProse'
import { challengeKey } from './catalog'
import { fidelityFormat } from './numbers'

export interface ChallengeBriefProps {
  readonly challenge: Challenge
}

export function ChallengeBrief({ challenge }: ChallengeBriefProps) {
  const { t, i18n } = useTranslation('challenges')
  /*
   * The SAME formatter the verdict uses, and in the reader's language.
   *
   * Two changes, both about a number a learner is asked to compare. This used
   * to be an `Intl` percent formatter, so the fidelity a reader had to reach
   * read "99 %" while the fidelity they achieved read "0.985" — the same
   * quantity under the same definition, in two units, with nothing on screen
   * saying they were commensurable. And it passed `undefined` as the locale,
   * which is the machine's language rather than the one the reader chose.
   */
  const number = fidelityFormat(i18n.language)

  return (
    <div className="challenge-brief">
      <ChallengeProse
        className="challenge-brief__prompt"
        paragraph={t(challengeKey(challenge.slug, 'prompt'))}
      />

      <p className="challenge-brief__kind">
        {t(`brief.targetNote.${challenge.targetType}`)}
      </p>

      <dl className="challenge-brief__rules">
        <div>
          <dt>{t('brief.qubits')}</dt>
          <dd>{challenge.qubitCount}</dd>
        </div>
        <div>
          <dt>{t('brief.allowedGates')}</dt>
          <dd>
            {challenge.allowedGates.length === 0 ? (
              t('brief.anyGate')
            ) : (
              /*
               * Gate ids are invariant notation (D2, §1.1): `cx` is `cx` in
               * every language, and translating it would break the
               * correspondence with Qiskit and with every textbook.
               */
              <ul className="challenge-brief__gates">
                {challenge.allowedGates.map((gate) => (
                  <li key={gate}>
                    <Notation value={gate} />
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('brief.maxGates')}</dt>
          <dd>
            {challenge.maxGates === null
              ? t('brief.noLimit')
              : challenge.maxGates}
          </dd>
        </div>
        <div>
          <dt>{t('brief.threshold')}</dt>
          <dd>{number.format(challenge.fidelityThreshold)}</dd>
        </div>
      </dl>
    </div>
  )
}
