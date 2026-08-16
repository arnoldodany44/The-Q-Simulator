/**
 * "Open somebody else's circuit here" — specification §3.5, the other half of
 * the export panel.
 *
 * ── TWO WAYS IN, ONE PATH THROUGH ────────────────────────────────────────
 *
 * A file and a paste box. They are two affordances for one reason: a QASM
 * program arrives as a download from a hardware console or as three lines copied
 * out of a notebook, and asking somebody to save a clipboard to disk in order to
 * open it is a step nobody should have to take. Both end in the same call, so
 * there is exactly one place where an import can succeed or fail and exactly one
 * status line that says which.
 *
 * ── WHY THE VERSION IS NOT A CONTROL ─────────────────────────────────────
 *
 * There is no "OpenQASM 2 / OpenQASM 3" selector, on purpose. The reader
 * pasting a fragment out of a notebook does not necessarily know which dialect
 * they have, and the importer can tell — from the header if there is one, from
 * the syntax if there is not. What the panel does instead is *say* which it
 * read, because that is the one thing a reader might want to overrule, and the
 * way to overrule it is to add the header line their file was missing.
 *
 * ── WHAT A FAILURE SAYS ──────────────────────────────────────────────────
 *
 * A line, a column, and — where the file used a real OpenQASM feature this
 * format has no shape for — the feature's own name. "Line 12, column 3: this
 * file uses `def`" sends the reader to one line; "could not import" sends them
 * nowhere. The sentence is assembled in `failure.ts` from the error's code and
 * position so that it can be translated (D2); the importer's own English
 * message goes to the console for whoever is debugging.
 *
 * ── IT REPLACES THE DOCUMENT, AND SAYS SO BEFORE IT DOES ─────────────────
 *
 * `loadCircuit` is the store's door for a whole document and it clears the undo
 * history, which is the right behaviour — being able to undo past the beginning
 * of the document you just opened is how you lose it — and is also
 * irreversible. So the hint above the controls says the circuit on screen is
 * replaced, in the same three languages as everything else, rather than a
 * confirmation dialog that a reader importing ten files would learn to dismiss.
 */

import { safeImportOpenQasm } from '@qsim/qasm'
import { depth, gateCount } from '@qsim/schema'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { pluralCount } from '../analysis/format'
import type { CircuitStore } from '../circuit-editor/useCircuitStore'
import {
  asImportFailure,
  importFailureKey,
  importFailureValues,
  type ImportFailure,
} from './failure'
import { QASM_FILE_ACCEPT, readQasmFile } from './readSource'

/** Dialect names, invariant across locales (D2). */
const DIALECT_LABELS: Readonly<Record<2 | 3, string>> = {
  2: 'OpenQASM 2',
  3: 'OpenQASM 3',
}

type Attempt =
  | { readonly phase: 'working' }
  | {
      readonly phase: 'imported'
      readonly format: string
      readonly qubits: number
      readonly gates: number
      readonly depth: number
    }
  | { readonly phase: 'failed'; readonly failure: ImportFailure }

export interface ImportPanelProps {
  readonly store: CircuitStore
}

export function ImportPanel({ store }: ImportPanelProps) {
  const { t, i18n } = useTranslation('import')
  const textId = useId()
  const fileId = useId()
  const statusId = useId()
  const [source, setSource] = useState('')
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  /**
   * How many times the button has been pressed.
   *
   * The sentence is keyed on this, so pressing "Read this circuit" twice on the
   * same bad program announces twice. React sees an identical string, leaves
   * the text node untouched, and a polite live region that did not change says
   * nothing — which is indistinguishable from a dead button for anyone not
   * reading the screen. `CustomGatePanel` and `PresetPicker` both solve it this
   * way and cite this exact reason.
   */
  const [attempts, setAttempts] = useState(0)

  const numbers = new Intl.NumberFormat(i18n.language)
  const countedPhrase = (key: string, value: number): string =>
    t(key, { count: pluralCount(value), value: numbers.format(value) })

  /** The one path both affordances end in. */
  const load = (text: string): void => {
    setAttempts((count) => count + 1)
    if (text.trim() === '') {
      setAttempt({ phase: 'failed', failure: { code: 'empty' } })
      return
    }
    setAttempt({ phase: 'working' })

    const read = safeImportOpenQasm(text)
    if (!read.ok) {
      console.error('import: the file was refused', read.error)
      setAttempt({ phase: 'failed', failure: asImportFailure(read.error) })
      return
    }

    /*
     * Through `loadCircuit` rather than straight into state, even though the
     * importer already ran `parseCircuit`. It is the store's single door for a
     * whole document — it clears history, ends any open gesture and closes a
     * definition being edited — and checking the contract a second time costs
     * nothing next to a document that skipped any of those.
     */
    const result = store.getState().loadCircuit(read.circuit)
    if (!result.ok) {
      console.error('import: the store refused the circuit', result.issues)
      setAttempt({
        phase: 'failed',
        failure: { code: 'contract' },
      })
      return
    }

    setAttempt({
      phase: 'imported',
      format: DIALECT_LABELS[read.version],
      qubits: read.circuit.qubits,
      gates: gateCount(read.circuit),
      depth: depth(read.circuit),
    })
  }

  const chooseFile = (file: File | undefined): void => {
    if (file === undefined) return
    setAttempts((count) => count + 1)
    setAttempt({ phase: 'working' })
    void (async () => {
      const read = await readQasmFile(file)
      if (!read.ok) {
        setAttempt({ phase: 'failed', failure: { code: read.reason } })
        return
      }
      // The text lands in the box as well as being imported, so a file that
      // fails at line 12 can be looked at — and fixed — without leaving the
      // page for an editor.
      setSource(read.text)
      load(read.text)
    })()
  }

  return (
    <details className="import-panel">
      <summary className="import-panel__summary">{t('heading')}</summary>
      <p className="import-panel__hint">{t('hint')}</p>

      <label className="import-panel__field" htmlFor={fileId}>
        {t('file.label')}
      </label>
      <input
        id={fileId}
        className="import-panel__file"
        type="file"
        accept={QASM_FILE_ACCEPT}
        aria-describedby={attempt === null ? undefined : statusId}
        aria-invalid={attempt?.phase === 'failed' ? true : undefined}
        onChange={(event) => {
          chooseFile(event.target.files?.[0])
          // Cleared so that choosing the same file twice fires again: after a
          // failed import the obvious next move is to fix the file and pick it
          // again, and a picker that ignores an unchanged name does nothing.
          event.target.value = ''
        }}
      />

      <label className="import-panel__field" htmlFor={textId}>
        {t('text.label')}
      </label>
      <textarea
        id={textId}
        className="import-panel__text"
        value={source}
        rows={6}
        spellCheck={false}
        placeholder={t('text.placeholder')}
        /*
         * Tied to the sentence the last attempt produced, and marked invalid
         * while that attempt failed. The live region says it once; this is what
         * says it again when focus arrives — which is the moment that matters,
         * because the obvious next move after "line 12, column 1" is to go back
         * into the box and fix line 12. Every other field in this app that can
         * be wrong does both (`AuthField`, `SaveCircuitPanel`, `NoisePanel`).
         */
        aria-describedby={attempt === null ? undefined : statusId}
        aria-invalid={attempt?.phase === 'failed' ? true : undefined}
        onChange={(event) => {
          setSource(event.target.value)
        }}
      />

      <button
        type="button"
        className="import-panel__button"
        disabled={attempt?.phase === 'working'}
        onClick={() => {
          load(source)
        }}
      >
        {t('action')}
      </button>

      {/*
       * One live region for every outcome, so a reader hears the result of the
       * button they just pressed and nothing else. `role="status"` rather than
       * an alert even for a failure: nothing was lost — a refused import leaves
       * the circuit on screen exactly as it was — and interrupting is for news
       * the reader has to act on.
       */}
      <p className="import-panel__status" role="status" id={statusId}>
        <span key={attempts}>
          {attempt === null
            ? null
            : attempt.phase === 'working'
              ? t('status.working')
              : attempt.phase === 'failed'
                ? t(
                    importFailureKey(attempt.failure),
                    importFailureValues(attempt.failure)
                  )
                : /*
                   * Three counted phrases composed into one sentence rather than
                   * one key with three numbers in it: i18next resolves a plural
                   * against a single `count`, so a single key would produce
                   * "1 qubits, 1 gates". Each figure is also formatted before it
                   * is interpolated, separately from the number that selects the
                   * plural form — the rule `format.ts` states and the whole
                   * analysis panel follows.
                   */
                  t('status.imported', {
                    format: attempt.format,
                    qubits: countedPhrase('counts.qubits', attempt.qubits),
                    gates: countedPhrase('counts.gates', attempt.gates),
                    depth: countedPhrase('counts.depth', attempt.depth),
                  })}
        </span>
      </p>
    </details>
  )
}
