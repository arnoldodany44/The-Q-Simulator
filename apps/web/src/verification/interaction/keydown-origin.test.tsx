/**
 * Adversarial verification — which keystrokes the editor is allowed to claim.
 *
 * The handler is bound to the whole editor, so every key pressed anywhere in
 * it arrives there. What separates a working editor from one with no working
 * buttons is the origin test, and the only honest way to check it is from
 * *outside* the grid: press the grid's own keys on a toolbar button, on a
 * palette chip and on the shortcuts disclosure, and assert twice over — that
 * the editor did nothing, and that it did not call `preventDefault`, which is
 * what would stop the browser activating the control the user is standing on.
 *
 * `preventDefault` is the load-bearing assertion. jsdom does not activate a
 * button on Enter by itself, so "the button still works" cannot be observed
 * here at all; what can be observed is whether the editor swallowed the
 * keystroke before the browser would have. The real activation is covered in
 * `e2e/keyboard-reach.spec.ts`.
 */

import { emptyCircuit } from '@qsim/schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { CircuitEditor } from '../../features/circuit-editor/CircuitEditor'
import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore'
import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import enGates from '../../i18n/locales/en/gates.json'
import enSimulation from '../../i18n/locales/en/simulation.json'

afterEach(cleanup)

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common', 'editor', 'gates', 'simulation'],
    defaultNS: 'common',
    resources: {
      en: {
        common: enCommon,
        editor: enEditor,
        gates: enGates,
        simulation: enSimulation,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function open(qubits = 2) {
  const store = createCircuitStore(emptyCircuit(qubits, 0))
  render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitEditor store={store} />
    </I18nextProvider>
  )
  return store
}

const grid = (): HTMLElement => screen.getByRole('grid')
const toolbarButton = (name: string): HTMLElement =>
  screen.getByRole('button', { name })
const chip = (gate: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-gate="${gate}"]`)!
const disclosure = (): HTMLElement =>
  document.querySelector<HTMLElement>('.shortcuts__summary')!

/** True when the editor let the keystroke through to the browser. */
function survives(target: HTMLElement, key: string): boolean {
  return fireEvent.keyDown(target, { key })
}

describe('the grid keys act only on the grid', () => {
  it('leaves Enter and Space alone on a toolbar button', () => {
    const store = open()
    fireEvent.keyDown(grid(), { key: 'h' }) // a gate is armed and waiting

    expect(survives(toolbarButton('Undo'), 'Enter')).toBe(true)
    expect(survives(toolbarButton('Undo'), ' ')).toBe(true)

    // And nothing was placed by the Enter the button was meant to receive.
    expect(store.getState().circuit.operations).toEqual([])
  })

  it('leaves Space alone on the shortcuts disclosure', () => {
    open()
    expect(survives(disclosure(), ' ')).toBe(true)
    expect(survives(disclosure(), 'Enter')).toBe(true)
  })

  it('leaves Enter and Space alone on a palette chip', () => {
    const store = open()
    fireEvent.keyDown(grid(), { key: 'h' })

    expect(survives(chip('x'), 'Enter')).toBe(true)
    expect(survives(chip('x'), ' ')).toBe(true)
    expect(store.getState().circuit.operations).toEqual([])
  })

  it('does not delete anything when Delete is pressed on the toolbar', () => {
    const store = open()
    fireEvent.keyDown(grid(), { key: 'h' })
    fireEvent.keyDown(grid(), { key: 'Enter' })
    expect(store.getState().circuit.operations).toHaveLength(1)

    expect(survives(toolbarButton('Undo'), 'Delete')).toBe(true)
    expect(survives(toolbarButton('Undo'), 'Backspace')).toBe(true)

    expect(store.getState().circuit.operations).toHaveLength(1)
  })

  it('does not move the grid cursor from a wire-gutter button', () => {
    open(3)
    fireEvent.keyDown(grid(), { key: 'ArrowDown' })
    const before = document.querySelector('.circuit-canvas__cell--cursor')

    const insert = toolbarButton('Insert a qubit below q0')
    expect(survives(insert, 'ArrowDown')).toBe(true)
    expect(survives(insert, 'ArrowRight')).toBe(true)
    expect(survives(insert, 'Home')).toBe(true)

    expect(document.querySelector('.circuit-canvas__cell--cursor')).toBe(before)
  })

  it('still answers the grid keys inside the grid', () => {
    const store = open()

    expect(survives(grid(), 'h')).toBe(false)
    expect(survives(grid(), 'Enter')).toBe(false)
    expect(store.getState().circuit.operations).toHaveLength(1)
    expect(survives(grid(), 'Delete')).toBe(false)
    expect(store.getState().circuit.operations).toEqual([])
  })
})

describe('the gate keys act on the grid and the palette, and nowhere else', () => {
  it('arms from a palette chip', () => {
    open()
    fireEvent.keyDown(chip('h'), { key: 'x' })
    expect(chip('x').getAttribute('aria-pressed')).toBe('true')
  })

  it('does not arm from a toolbar button', () => {
    open()
    fireEvent.keyDown(toolbarButton('Undo'), { key: 'x' })
    expect(chip('x').getAttribute('aria-pressed')).toBe('false')
  })

  it('does not arm from a wire-gutter button', () => {
    open()
    fireEvent.keyDown(toolbarButton('Remove qubit q0'), { key: 'x' })
    expect(chip('x').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the document commands stay live anywhere in the editor', () => {
  it('undoes from a toolbar button', () => {
    const store = open()
    fireEvent.keyDown(grid(), { key: 'h' })
    fireEvent.keyDown(grid(), { key: 'Enter' })

    fireEvent.keyDown(toolbarButton('Redo'), { key: 'z', ctrlKey: true })

    expect(store.getState().circuit.operations).toEqual([])
  })

  it('cancels a pending placement from a palette chip', () => {
    open(3)
    fireEvent.keyDown(grid(), { key: 'c' })
    fireEvent.keyDown(grid(), { key: 'Enter' })
    expect(document.querySelector('.circuit-canvas__cell--claimed')).not.toBe(
      null
    )

    fireEvent.keyDown(chip('h'), { key: 'Escape' })

    expect(document.querySelector('.circuit-canvas__cell--claimed')).toBe(null)
  })
})
