/**
 * The entanglement metrics — §3.2: "entropía de von Neumann de cada subsistema
 * y concurrencia para pares de qubits".
 *
 * ────────────────────────────────────────────────────────────────────────
 * A BARE NUMBER TEACHES NOBODY ANYTHING
 *
 * "Entropy 1" is not a fact anyone can use. "Entropy 1: this qubit alone has no
 * state of its own" is, and it is the same fact — so every row here carries a
 * sentence beside its number, and the two are generated from one reading so
 * they cannot disagree. That is the same ruling the Bloch table already makes
 * about its own `Reading` column, and the threshold is deliberately tied to the
 * printed precision for the same reason: a row saying `1,0000` next to "partly
 * entangled" is a contradiction on screen whatever the seventh decimal says.
 *
 * Two tables rather than one, because they answer two questions. The entropy
 * says whether a qubit has a state of its own; the concurrence says whether two
 * of them share it *with each other* — and the pair that makes the distinction
 * unmissable is GHZ₃ against W₃, where every qubit reads about the same entropy
 * and every pair reads 0 in one and 2/3 in the other. The panel's own summary
 * line is what points at that.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PAIR TABLE STOPS, AND SAYS SO
 *
 * Concurrence is a partial trace per pair and there are n(n−1)/2 pairs, so the
 * cost grows as n²·2ⁿ and leaves the frame budget somewhere past twelve qubits
 * (`entanglement.ts` has the measurements). Past that the pairs are not
 * computed — and the panel says which limit it hit and why, in words, the way
 * the histogram states its bar cap. A table that silently thinned itself, or a
 * panel that quietly took a quarter of a second on every keystroke, are the two
 * failures this avoids.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Statevector } from '@qsim/core'

import { Notation } from '../../components/Notation'
import {
  MAX_CONCURRENCE_QUBITS,
  buildEntanglement,
  type EntropyReading,
  type PairReading,
} from './entanglement'
import { formatCoordinate, formatCount, pluralCount } from './format'

export interface EntanglementPanelProps {
  /** The final state of an analytic run. */
  readonly state: Statevector
}

export function EntanglementPanel({ state }: EntanglementPanelProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language

  /*
   * Memoised on the state: this is the second-largest piece of arithmetic in
   * the panel — n passes over the amplitudes for the entropies and one partial
   * trace per pair — and doing it once per answer rather than once per render
   * is the whole of what keeps it affordable. Same discipline as the Bloch
   * vectors next door.
   */
  const model = useMemo(() => buildEntanglement(state), [state])

  const summary =
    model.entangledQubits === 0
      ? t('entanglement.summary.product', {
          count: pluralCount(model.qubits),
          total: formatCount(model.qubits, language),
        })
      : t('entanglement.summary.entangled', {
          count: pluralCount(model.entangledQubits),
          entangled: formatCount(model.entangledQubits, language),
          total: formatCount(model.qubits, language),
        })

  return (
    <section className="entanglement">
      <h4 className="entanglement__heading">{t('entanglement.heading')}</h4>
      <p className="entanglement__summary">{summary}</p>

      <figure className="entanglement__block">
        <figcaption className="entanglement__legend">
          {t('entanglement.entropy.legend')}
        </figcaption>
        <div className="entanglement__viewport">
          <table className="entanglement__grid">
            <caption className="visually-hidden">
              {t('entanglement.entropy.caption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('entanglement.table.qubit')}</th>
                {/*
                 * `S` is notation, not a word: §5.5 and every textbook write the
                 * von Neumann entropy that way, and §1.1 keeps notation out of
                 * the three catalogs. The unit is bits, which the caption above
                 * names in words.
                 */}
                <th scope="col">
                  <Notation value="S" />
                </th>
                <th scope="col">{t('entanglement.table.reading')}</th>
              </tr>
            </thead>
            <tbody>
              {model.entropies.map((row) => (
                <tr className="entanglement__row" key={row.qubit}>
                  <th scope="row" className="entanglement__name">
                    <Notation value={row.name} />
                  </th>
                  <td className="entanglement__number">
                    {formatCoordinate(row.entropy, language)}
                  </td>
                  <td className="entanglement__reading">
                    {t(entropyKey(row.reading))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>

      <figure className="entanglement__block">
        <figcaption className="entanglement__legend">
          {t('entanglement.pairs.legend')}
        </figcaption>

        {!model.pairsComputed ? (
          <p className="entanglement__note">
            {model.qubits < 2
              ? t('entanglement.pairs.single')
              : t('entanglement.pairs.tooWide', {
                  qubits: formatCount(model.qubits, language),
                  limit: formatCount(MAX_CONCURRENCE_QUBITS, language),
                })}
          </p>
        ) : (
          <div className="entanglement__viewport">
            <table className="entanglement__grid">
              <caption className="visually-hidden">
                {t('entanglement.pairs.caption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('entanglement.table.pair')}</th>
                  {/* Wootters writes the concurrence `C`; see the note above. */}
                  <th scope="col">
                    <Notation value="C" />
                  </th>
                  <th scope="col">{t('entanglement.table.reading')}</th>
                </tr>
              </thead>
              <tbody>
                {model.pairs.map((pair) => (
                  <tr
                    className="entanglement__row"
                    key={`${pair.first}:${pair.second}`}
                  >
                    <th scope="row" className="entanglement__name">
                      <Notation value={pair.name} />
                    </th>
                    <td className="entanglement__number">
                      {formatCoordinate(pair.concurrence, language)}
                    </td>
                    <td className="entanglement__reading">
                      {t(pairKey(pair.reading))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </figure>

      {/*
       * The sentence that turns two tables into one lesson. It is printed only
       * when the pairs exist *and* none of them shares anything while qubits
       * are nevertheless entangled — which is exactly the GHZ shape, and the
       * one case where the two tables look like they contradict each other.
       */}
      {model.pairsComputed &&
      model.entangledQubits > 0 &&
      model.strongestPair === null ? (
        <p className="entanglement__note">{t('entanglement.shared.none')}</p>
      ) : null}
    </section>
  )
}

/**
 * The sentence for a reading, as a lookup rather than an interpolated key.
 *
 * A template literal would put three catalog keys beyond the reach of every
 * grep and of `locale-parity.test.ts`'s reviewer, which is how a key survives a
 * rename in one language only. Same shape as `readingKey` in the Bloch panel
 * and `stateKey` in the simulation panel.
 */
function entropyKey(reading: EntropyReading): string {
  switch (reading) {
    case 'own':
      return 'entanglement.entropy.reading.own'
    case 'none':
      return 'entanglement.entropy.reading.none'
    default:
      return 'entanglement.entropy.reading.partial'
  }
}

function pairKey(reading: PairReading): string {
  switch (reading) {
    case 'separable':
      return 'entanglement.pairs.reading.separable'
    case 'maximal':
      return 'entanglement.pairs.reading.maximal'
    default:
      return 'entanglement.pairs.reading.partial'
  }
}
