import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enImport from '../../i18n/locales/en/import.json'
import esImport from '../../i18n/locales/es/import.json'
import frImport from '../../i18n/locales/fr/import.json'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { ImportPanel } from './ImportPanel'

/**
 * The panel from the reader's side: paste a program, get a circuit; paste a
 * broken one, get a sentence naming the line.
 *
 * The failure half is the half worth testing here rather than in the package.
 * `@qsim/qasm` already proves which error each file produces; what this file
 * proves is that the *reader* is told, in their own language, with the position
 * the parser knew — which is the promise §3.5 makes and the one a panel is
 * capable of breaking on its own.
 */

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['import'],
    defaultNS: 'import',
    resources: {
      en: { import: enImport },
      es: { import: esImport },
      fr: { import: frImport },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function draw(language: Language = 'en') {
  const store = createCircuitStore()
  render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ImportPanel store={store} />
    </I18nextProvider>
  )
  return store
}

/** Types a program into the box and presses the button. */
function paste(source: string, language: Language = 'en') {
  const store = draw(language)
  const box = screen.getByRole('textbox')
  fireEvent.change(box, { target: { value: source } })
  fireEvent.click(screen.getByRole('button'))
  return store
}

const BELL = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
h q[0];
cx q[0], q[1];
`

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a program that reads', () => {
  it('replaces the circuit in the store', () => {
    const store = paste(BELL)
    expect(store.getState().circuit.qubits).toBe(2)
    expect(
      store.getState().circuit.operations.map((operation) => operation.gate)
    ).toEqual(['h', 'cx'])
  })

  it('says which dialect it read, and how big the circuit is', () => {
    paste(BELL)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('OpenQASM 3')
    expect(status.textContent).toContain('2 qubits')
    expect(status.textContent).toContain('2 gates')
  })

  it('reads OpenQASM 2 and says so', () => {
    paste('OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[1];\nx q[0];')
    expect(screen.getByRole('status').textContent).toContain('OpenQASM 2')
  })

  it('counts one qubit in the singular', () => {
    // The plural is selected by a clamped count and the figure is formatted
    // separately (`format.ts`), so "1 qubits" is the failure this catches.
    paste('qubit[1] q;\nx q[0];')
    expect(screen.getByRole('status').textContent).toContain('1 qubit,')
  })

  it('clears the undo history, because the document was replaced', () => {
    const store = createCircuitStore()
    store.getState().placeGate('h', [0], 0)
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ImportPanel store={store} />
      </I18nextProvider>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: BELL } })
    fireEvent.click(screen.getByRole('button'))
    expect(store.getState().undo().ok).toBe(false)
  })
})

describe('a program that does not read', () => {
  it('names the line and the column of a syntax error', () => {
    paste('qubit[2] q;\nh q[0]\ncx q[0], q[1];')
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toContain('Line 3')
    expect(status).toContain('column 1')
  })

  it('names the unsupported construct rather than failing generically', () => {
    paste('qubit[2] q;\nfor i in [0:2] { x q[0]; }')
    const status = screen.getByRole('status').textContent ?? ''
    expect(status).toContain('"for"')
    expect(status).toContain('Line 2')
  })

  it('names a standard gate the catalog has no entry for', () => {
    paste('qubit[2] q;\nrzz(0.5) q[0], q[1];')
    expect(screen.getByRole('status').textContent).toContain('"rzz"')
  })

  it('says there is nothing to read when the box is empty', () => {
    draw()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('status').textContent).toContain('nothing to read')
  })

  it('leaves the circuit on screen exactly as it was', () => {
    const store = createCircuitStore()
    store.getState().placeGate('h', [0], 0)
    const before = store.getState().circuit
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ImportPanel store={store} />
      </I18nextProvider>
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'qubit[1] q;\nnonsense (' },
    })
    fireEvent.click(screen.getByRole('button'))
    expect(store.getState().circuit).toBe(before)
  })
})

describe('every word of it is translated', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders no raw keys in %s',
    (language) => {
      paste('qubit[2] q;\nfor i in [0:2] { x q[0]; }', language)
      /*
       * The same shape-based property `no-raw-keys.spec.ts` asserts on a whole
       * route, applied to the surface behind a control — and it is the same
       * shape rather than a list of expected strings so that a key added later
       * is caught without being told about it. Leaf elements only, and matched
       * whole, so that the OpenQASM in the paste box (`q[0];`, `stdgates.inc`)
       * cannot be mistaken for a key.
       */
      const shape = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/
      const found = [...document.querySelectorAll('body *')]
        .filter((element) => element.children.length === 0)
        .map((element) => (element.textContent ?? '').trim())
        .filter((text) => text !== '' && shape.test(text))
      expect(found).toEqual([])
      expect((document.body.textContent ?? '').length).toBeGreaterThan(50)
    }
  )

  it.each(['es', 'fr'] as const)(
    'says the line and the column in %s too',
    (language) => {
      paste('qubit[2] q;\nh q[0]\ncx q[0], q[1];', language)
      const status = screen.getByRole('status').textContent ?? ''
      // The position is a number wherever the sentence puts it: what must never
      // happen is a translated sentence that dropped the clause carrying it.
      expect(status).toMatch(/3/)
      expect(status).not.toContain('{{')
    }
  )

  it('has the same keys in all three catalogs', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      typeof value !== 'object' || value === null
        ? [prefix]
        : Object.entries(value).flatMap(([key, child]) =>
            keys(child, prefix ? `${prefix}.${key}` : key)
          )
    expect(keys(esImport).sort()).toEqual(keys(enImport).sort())
    expect(keys(frImport).sort()).toEqual(keys(enImport).sort())
  })
})

describe('a chosen file', () => {
  it('fills the box and imports in one gesture', async () => {
    const store = draw()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()

    // jsdom's File has `text()`; the panel uses nothing else from it.
    const file = new File([BELL], 'bell.qasm', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file] })
    fireEvent.change(input as HTMLInputElement)

    await waitFor(() => {
      expect(store.getState().circuit.qubits).toBe(2)
    })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(BELL)
  })

  it('refuses a file larger than the importer reads, without reading it', async () => {
    const store = draw()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    const read = vi.fn()
    // `size` is known without touching a byte, which is the whole point: a
    // gigabyte picked by accident must not be decoded into the tab first.
    const file = { size: 5_000_000, text: read } as unknown as File
    Object.defineProperty(input, 'files', { value: [file] })
    fireEvent.change(input as HTMLInputElement)

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('too big')
    })
    expect(read).not.toHaveBeenCalled()
    expect(store.getState().circuit.operations).toEqual([])
  })
})
