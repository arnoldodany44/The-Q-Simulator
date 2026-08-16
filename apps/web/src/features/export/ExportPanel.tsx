/**
 * "Take this circuit somewhere else" — milestone M1.7, specification §3.5.
 *
 * Five buttons over one document. The panel's whole job is to turn a click
 * into a file the browser really saves, and to say what happened when it
 * cannot — `saveFile` is deliberately silent about the outcome (the page has
 * no way to learn whether the user kept the file), so the status line below
 * reports what was *offered*, never what was stored.
 *
 * ── WHY THE FORMAT NAMES ARE NOT IN THE CATALOGS ─────────────────────────
 *
 * `OpenQASM 3`, `Qiskit`, `JSON`, `SVG` and `PNG` are proper nouns and format
 * names: decision D2 keeps those identical in all three languages, alongside
 * the gate symbols, so they travel through `Notation` — which also marks them
 * `translate="no"` so Chrome's page translator cannot turn `PNG` into
 * something else. What *is* translated is everything around them: the action
 * ("Download as"), and the sentence under each button saying what the format
 * is good for, which is the part a reader who does not already know Qiskit
 * needs.
 *
 * The button shows the format and is *named* "Download as OpenQASM 3", through
 * an `aria-label` that interpolates the format into a translated sentence. The
 * visible label is contained in the accessible name, which is what WCAG 2.5.3
 * asks; the alternative — a visually hidden verb beside the label — computes
 * the name by concatenating two inline spans, and the accessible name
 * algorithm drops the whitespace between them (the defect `CircuitCanvas`
 * documents at `PIECE_STYLE`). A row of five buttons does not need five
 * sentences of visible chrome, and a name that depends on a CSS rule having
 * loaded is a name that is sometimes "Download asOpenQASM 3".
 *
 * ── ONE BUTTON AT A TIME ─────────────────────────────────────────────────
 *
 * A PNG has to load the server renderer, rasterise through an image and encode
 * a bitmap, which is the only export slow enough to notice. While one is in
 * flight the others are disabled and the status line says which format is
 * being prepared: two overlapping exports would race for the same status and
 * report each other's outcome.
 */

import { depth, gateCount } from '@qsim/schema'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { pluralCount } from '../analysis/format'
import type { CircuitStore } from '../circuit-editor/useCircuitStore'
import { saveFile } from './download'
import { EXPORT_FORMATS, buildExport, type ExportFormat } from './formats'
import { RasterError } from './raster'

/**
 * The visible label of each button. Invariant across locales (D2), which is
 * why it is here and not in a catalog.
 */
const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  qasm3: 'OpenQASM 3',
  qiskit: 'Qiskit',
  json: 'JSON',
  svg: 'SVG',
  png: 'PNG',
}

/** What the panel is currently saying about itself. */
type Attempt =
  | { readonly phase: 'working'; readonly format: ExportFormat }
  | {
      readonly phase: 'offered'
      readonly format: ExportFormat
      readonly filename: string
    }
  | {
      readonly phase: 'failed'
      readonly format: ExportFormat
      /** A catalog key under `failure`, chosen from the cause. */
      readonly reason: 'too-large' | 'unknown'
    }

export interface ExportPanelProps {
  readonly store: CircuitStore
  /** The saved document's title, when it has one. Names the file. */
  readonly title?: string
}

export function ExportPanel({ store, title = '' }: ExportPanelProps) {
  const { t, i18n } = useTranslation('export')
  const headingId = useId()
  const circuit = store((state) => state.circuit)
  const [attempt, setAttempt] = useState<Attempt | null>(null)

  const busy = attempt?.phase === 'working'
  const numbers = new Intl.NumberFormat(i18n.language)

  /** `3 qubits` — the form chosen by one number, the figure written by another. */
  const countedPhrase = (key: string, value: number): string =>
    t(key, { count: pluralCount(value), value: numbers.format(value) })

  const download = (format: ExportFormat): void => {
    setAttempt({ phase: 'working', format })
    void (async () => {
      try {
        const file = await buildExport(format, circuit, {
          title,
          diagramTitle:
            title === ''
              ? t('diagram.untitled')
              : t('diagram.title', { title }),
          /*
           * Composed from three counted phrases rather than written as one
           * sentence with three numbers in it: i18next resolves a plural
           * against a single `count`, so "1 qubits, 1 gates" is what a single
           * key would produce — in the one string that has to stand on its own
           * inside a file, read by someone who cannot see the picture.
           *
           * And each figure is formatted before it is interpolated, separately
           * from the number that selects the plural form — the rule `format.ts`
           * states and the whole analysis panel follows. These three used to
           * pass `count` and let i18next print it, which made them the only
           * figures in the product not written the way the language writes
           * numbers: "1234 portes" in a French file where every number on
           * screen reads "1 234". They are also the figures most likely to be
           * read outside any correcting context, because this string is the one
           * place a catalog value leaves the page it was rendered on.
           */
          diagramDescription: t('diagram.description', {
            qubits: countedPhrase('diagram.qubits', circuit.qubits),
            gates: countedPhrase('diagram.gates', gateCount(circuit)),
            depth: countedPhrase('diagram.depth', depth(circuit)),
          }),
          render: loadRenderer,
        })
        saveFile(file.filename, file.blob)
        setAttempt({ phase: 'offered', format, filename: file.filename })
      } catch (cause) {
        // Logged rather than shown: the causes are a browser refusing a canvas
        // and a circuit the exporter cannot express, and neither message is
        // something this app has translated. The reader gets a sentence from
        // the catalog; whoever is debugging gets the object.
        console.error('export failed', cause)
        setAttempt({
          phase: 'failed',
          format,
          reason:
            cause instanceof RasterError && cause.code === 'too-large'
              ? 'too-large'
              : 'unknown',
        })
      }
    })()
  }

  return (
    <section className="export-panel" aria-labelledby={headingId}>
      <h3 id={headingId} className="export-panel__heading">
        {t('heading')}
      </h3>
      <p className="export-panel__hint">{t('hint')}</p>

      <ul className="export-panel__formats">
        {EXPORT_FORMATS.map((format) => (
          <li key={format} className="export-panel__format">
            <button
              type="button"
              className="export-panel__button"
              aria-label={t('action', { format: FORMAT_LABELS[format] })}
              disabled={busy}
              onClick={() => {
                download(format)
              }}
            >
              <Notation value={FORMAT_LABELS[format]} />
            </button>
            <p className="export-panel__description">
              {t(`formats.${format}`)}
            </p>
          </li>
        ))}
      </ul>

      {/*
       * One live region for every outcome, so a reader hears the result of the
       * button they just pressed and nothing else. `role="status"` rather than
       * an alert even for a failure: nothing was lost, the circuit is still on
       * screen, and interrupting is for news the reader must act on.
       */}
      <p className="export-panel__status" role="status">
        {attempt === null
          ? null
          : attempt.phase === 'working'
            ? t('status.working', { format: FORMAT_LABELS[attempt.format] })
            : attempt.phase === 'offered'
              ? t('status.offered', { filename: attempt.filename })
              : t(`failure.${attempt.reason}`)}
      </p>
    </section>
  )
}

/**
 * Loads React's static renderer, which only the SVG and PNG exports need.
 *
 * Split out so the import is a chunk of its own: it is some 150 kB, the editor
 * does not need it to paint, and a reader downloading OpenQASM never fetches
 * it at all.
 */
async function loadRenderer() {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup
}
