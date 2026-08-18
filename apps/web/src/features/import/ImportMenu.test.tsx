import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import enImport from '../../i18n/locales/en/import.json'
import esCommon from '../../i18n/locales/es/common.json'
import esEditor from '../../i18n/locales/es/editor.json'
import esImport from '../../i18n/locales/es/import.json'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { ImportMenu } from './ImportMenu'

/**
 * The route from "I have a QASM file" to "it is on the canvas", through the
 * two presses the toolbar now asks for.
 *
 * `ImportPanel.test.tsx` proves the form: what each broken program says, in
 * three languages. This file proves the only thing moving it into a dialog
 * could have broken — that the form is still *reachable*, and that the store it
 * writes to is the one it was handed. That distinction is the reason this file
 * exists at all: the panel's own suite passed unchanged while the panel was
 * behind a menu nobody had wired up, and would have gone on passing.
 */

type Language = 'en' | 'es'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['editor', 'import', 'common'],
    defaultNS: 'editor',
    resources: {
      en: { editor: enEditor, import: enImport, common: enCommon },
      es: { editor: esEditor, import: esImport, common: esCommon },
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
      <ImportMenu store={store} />
    </I18nextProvider>
  )
  return store
}

/** The two presses: open the overflow, then choose the import. */
function openDialog(language: Language = 'en') {
  const store = draw(language)
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  fireEvent.click(screen.getByRole('menuitem'))
  return store
}

const BELL = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
h q[0];
cx q[0], q[1];
`

afterEach(cleanup)

describe('the toolbar overflow', () => {
  it('offers nothing until it is opened', () => {
    draw()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
  })

  it('names itself in the reader’s language rather than by its glyph', () => {
    // Three dots are the same three dots everywhere, so the *name* is the part
    // that has to be translated. A button whose accessible name is "⋯" tells a
    // screen reader nothing at all.
    draw('es')
    expect(
      screen.getByRole('button', { name: esEditor.toolbar.more })
    ).toBeTruthy()
  })

  it('opens a dialog that holds the import form', () => {
    openDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    // The form itself: the paste box and the file input, both inside the dialog
    // rather than merely somewhere on the page.
    expect(dialog.querySelector('textarea')).toBeTruthy()
    expect(dialog.querySelector('input[type="file"]')).toBeTruthy()
  })

  it('closes the menu when the dialog opens, so neither covers the other', () => {
    openDialog()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('the dialog is wired to the document it was given', () => {
  it('loads a pasted program into the store the menu was handed', () => {
    // The assertion that would have caught a dialog rendering its own store, or
    // a menu that opened a form connected to nothing.
    const store = openDialog()
    expect(store.getState().circuit.operations).toHaveLength(0)

    const dialog = screen.getByRole('dialog')
    const box = dialog.querySelector('textarea')
    expect(box).not.toBeNull()
    fireEvent.change(box as HTMLTextAreaElement, { target: { value: BELL } })
    fireEvent.click(screen.getByRole('button', { name: enImport.action }))

    const circuit = store.getState().circuit
    expect(circuit.qubits).toBe(2)
    expect(circuit.operations.map((operation) => operation.gate)).toEqual([
      'h',
      'cx',
    ])
  })
})
