/**
 * The Q-sphere — specification §3.2, milestone M2.2.
 *
 * The whole state on one sphere: a point per basis state, placed by Hamming
 * weight, sized by the magnitude of its amplitude and coloured by its phase.
 * `qsphere.ts` argues the geometry at length; this file is the two renderings
 * of it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT SHOWS THAT THE HISTOGRAM CANNOT
 *
 * A histogram gives every basis state a row and no *position*. Which states
 * carry probability is then a list, and a list has no shape. On the sphere the
 * arrangement is the reading: a Hadamard wall is an even shell, a GHZ state is
 * two points at the two poles with an empty ball between them, a W state is one
 * ring, and interference is a ring whose colours are opposite. None of those is
 * available from a chart of the same numbers.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TABLE IS THE RENDERING, AND IT IS VISIBLE
 *
 * The same decision the Bloch panel took, for the same two reasons. A WebGL
 * scene is unreadable to a screen reader and unusable without a pointer, so the
 * canvas is `aria-hidden` and the numbers beside it carry the meaning. And the
 * table is *visible* rather than `visually-hidden` like the histogram's,
 * because a node's radius in an orthographic projection is not a quantity
 * anyone can compare by eye — a reader with low vision who does not use a
 * screen reader would otherwise have no rendering at all.
 *
 * From which the rest follows: because the numbers are the rendering, the
 * picture is allowed to fail. No WebGL, a refused context, a GPU reset
 * mid-session — the panel says so in one sentence and keeps every fact.
 *
 * The table's columns are deliberately *not* the amplitude table's. That one
 * already lists the amplitude, the magnitude and the phase of every drawn
 * state, and repeating it here would be a second copy that could drift. What
 * this table adds is what the picture is made of and the other cannot show:
 * which ring each state is on, which is its Hamming weight.
 */

import { Suspense, lazy, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Statevector } from '@qsim/core'

import { Notation } from '../../components/Notation'
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import { SceneBoundary } from './SceneBoundary'
import {
  formatCoordinate,
  formatCount,
  formatPhaseReading,
  formatProbability,
  pluralCount,
} from './format'
import { DEFAULT_BAR_LIMIT, ket } from './histogram'
import { buildQSphere } from './qsphere'

/**
 * three.js, in the chunk it already shares with the Bloch scene. §9 asks for
 * the split and `BlochScene.tsx` gives the number: some six hundred kilobytes
 * for a panel a reader may never scroll to.
 */
const QSphereScene = lazy(async () => {
  const module = await import('./QSphereScene')
  return { default: module.QSphereScene }
})

export interface QSpherePanelProps {
  /** The final state of an analytic run. */
  readonly state: Statevector
  /** How many basis states are drawn. The chart's cap, shared deliberately. */
  readonly nodeLimit?: number
}

export function QSpherePanel({
  state,
  nodeLimit = DEFAULT_BAR_LIMIT,
}: QSpherePanelProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const frozen = usePrefersReducedMotion()
  /*
   * Once the picture is gone it stays gone for this mount — retrying on the
   * next result would ask for a context every time the reader typed, and a
   * browser that refused once refuses faster the second time.
   */
  const [drawable, setDrawable] = useState(true)
  const giveUpDrawing = useCallback(() => {
    setDrawable(false)
  }, [])

  const model = useMemo(
    () => buildQSphere(state, nodeLimit),
    [state, nodeLimit]
  )

  const caption =
    model.hidden > 0
      ? t('qsphere.caption.capped', {
          count: pluralCount(model.hidden),
          shown: formatCount(model.nodes.length, language),
          occupied: formatCount(model.occupied, language),
          total: formatCount(model.size, language),
          hidden: formatCount(model.hidden, language),
          share: formatProbability(model.hiddenProbability, language),
        })
      : t('qsphere.caption.complete', {
          count: pluralCount(model.occupied),
          occupied: formatCount(model.occupied, language),
          total: formatCount(model.size, language),
        })

  return (
    <figure className="qsphere">
      <figcaption className="qsphere__caption">
        <span className="qsphere__title">{t('qsphere.heading')}</span>
        <span className="qsphere__disclosure">{caption}</span>
      </figcaption>

      {drawable ? (
        <Suspense
          fallback={<p className="qsphere__pending">{t('qsphere.loading')}</p>}
        >
          <SceneBoundary onFailure={giveUpDrawing} scene="Q-sphere scene">
            <QSphereScene
              nodes={model.nodes}
              qubits={model.qubits}
              capacity={model.limit}
              frozen={frozen}
              onUnavailable={giveUpDrawing}
            />
          </SceneBoundary>
        </Suspense>
      ) : (
        <p className="qsphere__unavailable">{t('qsphere.unavailable')}</p>
      )}

      <p className="qsphere__note">{t('qsphere.note')}</p>

      {/*
       * Its own scroller, never the page's: five columns of data cannot shrink
       * to fit 320 CSS px without becoming unreadable, and WCAG 2.2 SC 1.4.10
       * asks that the page not scroll sideways. Same arrangement as the
       * amplitude table and the Bloch grid.
       */}
      <div className="qsphere__viewport">
        <table className="qsphere__grid">
          <caption className="visually-hidden">
            {t('qsphere.table.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('qsphere.table.state')}</th>
              <th scope="col">{t('qsphere.table.ring')}</th>
              <th scope="col">{t('qsphere.table.magnitude')}</th>
              <th scope="col">{t('qsphere.table.probability')}</th>
              <th scope="col">{t('qsphere.table.phase')}</th>
            </tr>
          </thead>
          <tbody>
            {model.nodes.map((node) => (
              <tr className="qsphere__row" key={node.index}>
                <th scope="row" className="qsphere__state">
                  <Notation value={ket(node.label)} />
                </th>
                <td className="qsphere__number">
                  {/*
                   * `count` selects the plural form, and the form matters in
                   * exactly one of the three languages. English and Spanish
                   * attach the noun to the *total* — "1 of 4 qubits at 1" — so
                   * both forms read the same; French attaches it to the count,
                   * "{{weight}} qubit(s) sur {{total}}", where it has to agree,
                   * and French takes the singular after 0 as well as after 1.
                   * Every register has a |0…0⟩ at weight 0 and one Hadamard
                   * produces a state at weight 1, so this is the first row a
                   * French reader ever sees rather than a corner case. The
                   * catalogs carry `weight_one` and `weight_other`; the
                   * selector was already being passed and had nothing to select.
                   */}
                  {t('qsphere.table.weight', {
                    count: pluralCount(node.weight),
                    weight: formatCount(node.weight, language),
                    total: formatCount(model.qubits, language),
                  })}
                </td>
                <td className="qsphere__number">
                  {formatCoordinate(node.magnitude, language)}
                </td>
                <td className="qsphere__number">
                  {formatProbability(node.probability, language)}
                </td>
                <td className="qsphere__number">
                  <Notation value={formatPhaseReading(node.phase, language)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}
