/**
 * A circuit with an empty classical register can acquire one.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DEAD END THIS EXISTS FOR
 *
 * Adding a classical bit is possible from exactly one control: the `+` in the
 * register's gutter. That gutter was drawn only when `size.clbits > 0`, so a
 * circuit that began with an empty register could never acquire one — and five
 * of the six worked examples begin that way, because a simulator has no use for
 * a measurement that collapses the state you came to look at.
 *
 * Placing a measurement on such a circuit refused with "that classical bit is
 * outside the circuit — add one to the classical register", naming a control
 * that was not on screen. `classicalWrites.ts` even documents that refusal as
 * pointing at "the remedy the gutter offers". The remedy was unreachable in the
 * one state where it was needed.
 *
 * It was found by a person trying to measure a Bell pair so they could run it on
 * real hardware, which is the only thing that could have found it: every unit
 * test in this feature builds a circuit with the register it needs.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import enGates from '../../i18n/locales/en/gates.json'
import { CircuitCanvas } from '../../features/circuit-editor/CircuitCanvas'
import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['editor', 'gates'],
    defaultNS: 'editor',
    resources: { en: { editor: enEditor, gates: enGates } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** A Bell pair: two qubits, no classical register — the reported case. */
function bell() {
  const store = createCircuitStore()
  return store.getState().circuit
}

function draw(options: { readOnly: boolean }) {
  const circuit = { ...bell(), qubits: 2, clbits: 0 }
  const calls: number[] = []
  render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitCanvas
        circuit={circuit}
        readOnly={options.readOnly}
        onAddClbit={() => {
          calls.push(1)
        }}
      />
    </I18nextProvider>
  )
  return calls
}

/*
 * Explicit, because auto-cleanup is off in this project. Without it the
 * second case below reads the first case's DOM and finds the button it is
 * asserting is absent — which is exactly what it did.
 */
afterEach(cleanup)

describe('the classical register gutter', () => {
  it('is offered when the register is empty and could be created', () => {
    draw({ readOnly: false })
    // The control the refusal message names. Absent, that message names nothing.
    expect(
      screen.getByRole('button', { name: enEditor.register.addBit })
    ).toBeTruthy()
  })

  it('is not offered on a canvas that cannot be edited', () => {
    // A read-only canvas is a drawing. Offering a control that writes to the
    // document there would be the opposite defect.
    draw({ readOnly: true })
    expect(
      screen.queryByRole('button', { name: enEditor.register.addBit })
    ).toBeNull()
  })
})
