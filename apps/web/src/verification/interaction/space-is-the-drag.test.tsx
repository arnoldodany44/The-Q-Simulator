/**
 * Adversarial verification — Space picks a gate up and does nothing else.
 *
 * Space was bound twice: dnd-kit's keyboard sensor starts a drag with it, and
 * the grid's own handler ran `activate()` on it as well. One press therefore
 * did both, and the second half was invisible to whoever pressed it:
 *
 *  - picking up an armed gate also attempted a placement on the cell it was
 *    standing on, which the occupied cell refused — so a screen reader
 *    announced "Another gate already occupies that cell." for a placement
 *    nobody attempted, straight after dnd-kit's "Gate picked up.";
 *  - on an empty cell the phantom placement *succeeded*, so Space placed
 *    gates, contradicting the shortcuts panel the editor ships in all three
 *    languages ("Enter — place", "Space — pick up");
 *  - with a multi-qubit gate armed it opened a pending placement, prompting
 *    for a control wire the user had not asked to choose.
 *
 * The editor cannot tell the two apart at the keystroke either: dnd-kit
 * reports a drag through React state, which lands after the keydown that
 * started it. So Space simply is not the grid's key.
 *
 * jsdom cannot run the drag itself — dnd-kit resolves everything from
 * measured rectangles and jsdom reports every rectangle as zero — so what is
 * asserted here is the half that broke: the document does not change and the
 * live region stays quiet. That the pick-up still happens is asserted in
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

function open() {
  const store = createCircuitStore(emptyCircuit(2, 2))
  const view = render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitEditor store={store} />
    </I18nextProvider>
  )
  return { store, view }
}

function press(key: string): void {
  fireEvent.keyDown(screen.getByRole('grid'), { key })
}

/** The editor's own live region; the simulation panel has one of its own. */
function status(container: HTMLElement): string {
  return container.querySelector('.circuit-editor__status')?.textContent ?? ''
}

describe('Space is the drag key and nothing else', () => {
  it('does not refuse a placement while an armed gate is picked up', () => {
    const { store, view } = open()

    // Arming survives a placement by design, so the gate is still armed when
    // the user reaches for the drag — the exact state that produced a
    // refusal about a cell nobody was placing on.
    press('h')
    press('Enter')
    expect(status(view.container)).toBe('H placed on q0, column 0.')
    const placed = store.getState().circuit

    press(' ')

    // Untouched, not merely "not a refusal": the pick-up has nothing to say,
    // and what was already on screen is still the last thing that happened.
    expect(status(view.container)).toBe('H placed on q0, column 0.')
    expect(status(view.container)).not.toBe(
      enEditor.rejection['column-conflict']
    )
    expect(store.getState().circuit).toBe(placed)
  })

  it('places nothing on an empty cell', () => {
    const { store, view } = open()

    press('h')
    press(' ')

    expect(store.getState().circuit.operations).toEqual([])
    expect(status(view.container)).toBe('')

    // …and Enter, which the shortcuts panel says is the placing key, still
    // is. A fix that made Space inert by disarming the gate would fail here.
    press('Enter')
    expect(store.getState().circuit.operations).toHaveLength(1)
  })

  it('does not open a half-finished multi-qubit placement', () => {
    const { store, view } = open()

    press('c')
    press(' ')

    expect(store.getState().circuit.operations).toEqual([])
    expect(status(view.container)).toBe('')
    expect(
      view.container.querySelectorAll('.circuit-canvas__cell--claimed')
    ).toHaveLength(0)
  })

  it('leaves the shortcuts panel telling the truth', () => {
    open()

    // The two lines the user reads. They are the specification this file
    // enforces, and they are what the double binding contradicted.
    expect(enEditor.shortcuts.place).toContain('Place the chosen gate')
    expect(enEditor.shortcuts.pickUp).toContain('Pick a gate up')
  })
})
