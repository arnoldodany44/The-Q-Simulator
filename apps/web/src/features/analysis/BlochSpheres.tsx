/**
 * The Bloch spheres — specification §3.2 and §5.5, milestone M1.6.
 *
 * One sphere per qubit, each showing that qubit's Bloch vector at its true
 * length, and a table of the same numbers underneath.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE LENGTH IS THE WHOLE POINT
 *
 * A qubit entangled with the rest of the register has no state of its own.
 * The partial trace answers with a mixed state, and its vector is shorter
 * than the sphere; for either half of a Bell pair it is the zero vector, and
 * the arrow is simply gone. So this panel is not a decoration on top of the
 * histogram — it is a detector. Drop a CNOT after a Hadamard and two arrows
 * collapse to the centre while nothing else on screen says a word about
 * entanglement.
 *
 * That is also why nothing here normalises anything. An arrow drawn at unit
 * length whatever the reading would be a confident direction for a qubit that
 * has none, which is worse than drawing nothing.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TABLE IS NOT A FOOTNOTE, IT IS THE RENDERING
 *
 * A WebGL scene is unreadable to a screen reader and unusable without a
 * pointer, so the canvas is `aria-hidden` and the numbers beside it carry the
 * meaning — the same division the circuit canvas makes between its SVG and
 * its ARIA grid. Two consequences follow, and both are deliberate:
 *
 *  - The table is **visible**, not `visually-hidden` like the histogram's.
 *    The histogram's bars are already a quantity a sighted reader can compare;
 *    an arrow in a projection is not, and 0,7071 against 1,0000 is a
 *    comparison nobody can make by eye off a 3D scene. A low-vision reader
 *    who does not use a screen reader would otherwise have no rendering at
 *    all — the same argument §10 makes about the `--wire` token.
 *  - Because the numbers are the rendering, the picture is allowed to fail.
 *    No WebGL, a refused context, a GPU reset mid-session: the scene says so
 *    in one sentence and every fact stays on screen. A blank box would be the
 *    failure this panel is specifically not allowed to have.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE COST, STATED
 *
 * `blochVectors` is one pass over the amplitudes per qubit, so a 20-qubit
 * register is ten million iterations on the main thread per result — an order
 * of magnitude more than the histogram's single pass, and the largest thing
 * this panel does. It is memoised on the state, so it happens once per answer
 * rather than once per render, and at the sizes anyone actually teaches with
 * (six qubits is four hundred iterations) it is free. If it ever bites, the
 * fix is already available and is the reason the maths lives in `@qsim/core`
 * rather than in this file: the worker holds the same state and could return
 * the vectors with it, exactly as it already returns sampled counts.
 */

import { blochVectors, type Statevector } from '@qsim/core'
import { Suspense, lazy, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import { SceneBoundary } from './SceneBoundary'
import {
  qubitName,
  readingOf,
  shortenedCount,
  sphereGrid,
  type BlochReading,
} from './bloch'
import { formatCoordinate, formatCount, pluralCount } from './format'

/**
 * three.js, in its own chunk, fetched the first time a reader opens a circuit
 * — never as part of the editor's chunk (§9). See `BlochScene.tsx` for what
 * it costs and why the split is clean.
 */
const BlochScene = lazy(async () => {
  const module = await import('./BlochScene')
  return { default: module.BlochScene }
})

export interface BlochSpheresProps {
  /** The final state of an analytic run. */
  readonly state: Statevector
}

export function BlochSpheres({ state }: BlochSpheresProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const frozen = usePrefersReducedMotion()
  /*
   * Once the picture is gone it stays gone for this mount. Retrying on the
   * next result would ask for a context every time the reader typed, and a
   * browser that refused once refuses faster the second time.
   */
  const [drawable, setDrawable] = useState(true)
  const giveUpDrawing = useCallback(() => {
    setDrawable(false)
  }, [])

  const vectors = useMemo(() => blochVectors(state), [state])
  const grid = useMemo(() => sphereGrid(state.qubits), [state.qubits])
  const shortened = shortenedCount(vectors)

  const caption =
    shortened === 0
      ? t('bloch.caption.product', {
          count: pluralCount(vectors.length),
          total: formatCount(vectors.length, language),
        })
      : t('bloch.caption.entangled', {
          count: pluralCount(shortened),
          shortened: formatCount(shortened, language),
          total: formatCount(vectors.length, language),
        })

  return (
    <figure className="bloch">
      <figcaption className="bloch__caption">
        <span className="bloch__title">{t('bloch.heading')}</span>
        <span className="bloch__disclosure">{caption}</span>
      </figcaption>

      {drawable ? (
        /*
         * The fallback is a translated line rather than `null`, for the reason
         * `App.tsx` gives about its own route chunks: a blank frame during a
         * fetch is indistinguishable from something broken, and D2 does not
         * stop at the strings inside a component.
         */
        <Suspense
          fallback={<p className="bloch__pending">{t('bloch.loading')}</p>}
        >
          <SceneBoundary onFailure={giveUpDrawing} scene="Bloch scene">
            <BlochScene
              vectors={vectors}
              grid={grid}
              frozen={frozen}
              onUnavailable={giveUpDrawing}
            />
          </SceneBoundary>
        </Suspense>
      ) : (
        <p className="bloch__unavailable">{t('bloch.unavailable')}</p>
      )}

      <p className="bloch__note">{t('bloch.note')}</p>

      {/*
       * Its own scroller, never the page's: six columns of data cannot shrink
       * to fit 320 CSS px without becoming unreadable, and WCAG 2.2 SC 1.4.10
       * asks that the page not scroll sideways. Same arrangement as the
       * amplitude table.
       */}
      <div className="bloch__viewport">
        <table className="bloch__grid">
          <caption className="visually-hidden">
            {t('bloch.table.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('bloch.table.qubit')}</th>
              {/*
               * The three components and the length are notation, not words:
               * §5.5 writes them rx, ry, rz, and §1.1 keeps notation out of
               * the catalogs in all three languages. The sentence naming what
               * each column holds is the table's own caption above, which is
               * what a screen reader reads before the first cell.
               */}
              <th scope="col">
                <Notation value="rx" />
              </th>
              <th scope="col">
                <Notation value="ry" />
              </th>
              <th scope="col">
                <Notation value="rz" />
              </th>
              <th scope="col">
                <Notation value="|r|" />
              </th>
              <th scope="col">{t('bloch.table.reading')}</th>
            </tr>
          </thead>
          <tbody>
            {vectors.map((vector) => (
              <tr className="bloch__row" key={vector.qubit}>
                <th scope="row" className="bloch__wire-name">
                  <Notation value={qubitName(vector.qubit)} />
                </th>
                <td className="bloch__number">
                  {formatCoordinate(vector.x, language)}
                </td>
                <td className="bloch__number">
                  {formatCoordinate(vector.y, language)}
                </td>
                <td className="bloch__number">
                  {formatCoordinate(vector.z, language)}
                </td>
                <td className="bloch__number bloch__number--length">
                  {formatCoordinate(vector.length, language)}
                </td>
                <td className="bloch__reading">
                  {t(readingKey(readingOf(vector.length)))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  )
}

/**
 * The sentence for a reading, as a lookup rather than an interpolated key.
 *
 * A template literal would put three catalog keys beyond the reach of every
 * grep and of `locale-parity.test.ts`'s reviewer, which is how a key survives
 * a rename in one language only. Same shape as `stateKey` in the simulation
 * panel.
 */
function readingKey(reading: BlochReading): string {
  switch (reading) {
    case 'pure':
      return 'bloch.reading.pure'
    case 'centre':
      return 'bloch.reading.centre'
    default:
      return 'bloch.reading.shortened'
  }
}
