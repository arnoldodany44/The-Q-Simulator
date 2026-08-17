/**
 * The frame's contents — §3.4, §11: a circuit and its analysis, read only.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS NOT HERE, AND WHY EACH ABSENCE IS THE FEATURE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * **No editing.** Not a locked editor — no editor. `CircuitEditor` is a
 * document store, an undo history, dnd-kit, a keyboard grid and a palette,
 * and a read-only mode over it would still ship every byte of that to a blog
 * post. What is drawn is `CircuitPlot`, the same renderer the canvas and the
 * SVG export use, with nothing on top of it to press.
 *
 * **No account.** Nothing in this graph can read a session (see
 * `fetchEmbed.ts`), and there is no control that would want one: no star, no
 * fork, no save. A frame that offered them would be asking a reader to sign in
 * from inside a stranger's page, which is the shape of a phishing screen even
 * when it is honest.
 *
 * **No navigation.** The frame never navigates — not on a link, not on a
 * form, not on a redirect. There is exactly one anchor in the whole document,
 * on the title of a saved circuit, and it carries `target="_blank"` with
 * `rel="noopener noreferrer"`: it opens a NEW top-level tab and leaves the
 * frame showing what it was showing. That is what makes it compatible with
 * "no navigation out" rather than an exception to it — the embed cannot be
 * turned into a way to wander this app inside somebody else's layout, which is
 * the failure mode the rule is about. `e2e/embed.spec.ts` asserts the property
 * rather than trusting this paragraph.
 *
 * The link is there because the alternative is worse. An embed with no way
 * back is not attribution: a reader who wants to try the circuit — which is
 * §2's entire purpose — would have nothing to act on, and the author's credit
 * would be a name in small text. `base-uri 'none'` and `form-action 'none'`
 * in the embed's Content-Security-Policy are the machine-checked half of the
 * same rule.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IT SHOWS, AND WHY THAT AND NOT MORE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The diagram, the three counters, and one chart. The chart is the
 * probability histogram with its phasors — §10 calls them the signature
 * element and §3.2 explains why: the arrow's direction is what makes
 * destructive interference visible as geometry rather than as a number
 * shrinking. For a circuit that measures it is the shot tally instead,
 * because a measuring circuit has no single final state (§5.3).
 *
 * Deliberately NOT here: the Bloch spheres, the Q-sphere and the density heat
 * map. All three are three.js — hundreds of kilobytes of WebGL for a figure
 * the size of a paragraph, in a document whose whole argument is that six of
 * it should be cheap. The amplitude table and the shot slider are absent for
 * a different reason: they are controls, and this document has none. Every one
 * of them is one click away in the editor, which is what the link is for.
 */

import type { Statevector } from '@qsim/core'
import { useTranslation } from 'react-i18next'

import { MeasurementCounts } from '../features/analysis/MeasurementCounts'
import { ProbabilityHistogram } from '../features/analysis/ProbabilityHistogram'
import { circuitPagePath } from '../features/circuit-storage/paths'
import { EmbedDiagram } from './EmbedDiagram'
import type { EmbedDocument } from './document'
import type { EmbedSimulation } from './useEmbedSimulation'

export interface EmbedViewProps {
  readonly document: EmbedDocument
  readonly simulation: EmbedSimulation
  /**
   * Where this app lives, for the one link. Passed in rather than read from
   * `window` so the component is a pure function of its props in a test, and
   * so a preview deployment links to itself rather than to production.
   */
  readonly origin: string
}

export function EmbedView({ document, simulation, origin }: EmbedViewProps) {
  const { t } = useTranslation('embed')
  const title = document.title ?? t('untitled')

  return (
    <main className="embed">
      <header className="embed__header">
        <h1 className="embed__title">
          {document.slug === null ? (
            title
          ) : (
            <a
              className="embed__link"
              href={`${origin}${circuitPagePath(document.slug)}`}
              /*
               * The frame must keep showing the frame. `_blank` opens a new
               * top-level context; `noopener` denies that context a handle
               * back to this one, and `noreferrer` withholds the address —
               * which for an UNLISTED circuit is the credential §11 sized at
               * 126 bits, and which the `Referrer-Policy: no-referrer` header
               * on this route already refuses to send.
               */
              target="_blank"
              rel="noopener noreferrer"
            >
              {title}
            </a>
          )}
        </h1>
        {document.author === null ? null : (
          <p className="embed__byline">
            {t('byline', { author: document.author })}
          </p>
        )}
      </header>

      <EmbedDiagram circuit={document.circuit} />

      {/*
       * The counters as real text beside the drawing. They are the accessible
       * account of the circuit's size — the same role they play on a gallery
       * card — and they are what stays true when the analysis below cannot be
       * computed at all.
       */}
      <dl className="embed__metrics">
        <Metric label={t('metrics.qubits')} value={document.qubitCount} />
        <Metric label={t('metrics.gates')} value={document.gateCount} />
        <Metric label={t('metrics.depth')} value={document.depth} />
      </dl>

      <EmbedAnalysis simulation={simulation} />
    </main>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="embed__metric">
      <dt className="embed__metric-label">{label}</dt>
      <dd className="embed__metric-value">{value}</dd>
    </div>
  )
}

/** The chart, the tally, or an honest sentence about why there is neither. */
function EmbedAnalysis({ simulation }: { simulation: EmbedSimulation }) {
  const { t } = useTranslation('embed')

  if (simulation.status === 'running') {
    /*
     * `role="status"`, not `aria-live="assertive"`: a figure finishing its
     * calculation is not news worth interrupting a reader who is part-way
     * through the surrounding article.
     */
    return (
      <p className="embed__pending" role="status">
        {t('analysis.running')}
      </p>
    )
  }

  if (simulation.status === 'failed') {
    return (
      <p className="embed__failure" role="status">
        {t(`analysis.failed.${simulation.code}`, {
          ...simulation.values,
          defaultValue: t('analysis.failed.unknown'),
        })}
      </p>
    )
  }

  if (simulation.status === 'sampled') {
    return (
      <div className="embed__analysis">
        <MeasurementCounts counts={simulation.counts} />
        {/*
         * A tally is a sample, and a sample that cannot be re-rolled has to
         * say so — the seed is fixed precisely so a teacher can write a
         * caption about this figure (`useEmbedSimulation.ts`).
         */}
        <p className="embed__note">{t('analysis.seeded')}</p>
      </div>
    )
  }

  return <Histogram state={simulation.state} />
}

function Histogram({ state }: { state: Statevector }) {
  const { t } = useTranslation('embed')
  return (
    <div className="embed__analysis">
      <ProbabilityHistogram
        state={state}
        heading={t('analysis.heading')}
        summary={t('analysis.summary')}
      />
    </div>
  )
}
