/**
 * Adversarial verification — the four keystrokes and one gutter button that
 * used to produce a circuit the engine has no answer for.
 *
 * The shortest reported path was: measure q1, remove q0, measure q1 again.
 * The measurement rides down onto q0 keeping the bit it always wrote, and the
 * next placement on the vacated index claimed the same bit — two writers in
 * one column, accepted by the contract, and answered by whichever of them the
 * operations array happened to list last.
 *
 * Driven through the rendered editor rather than the store, because the claim
 * is about gestures: the keyboard path and the gutter button are what the
 * user has, and asserting the rule one layer below them would leave the wiring
 * between the two untested.
 */

import { emptyCircuit } from '@qsim/schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { CircuitEditor } from '../../features/circuit-editor/CircuitEditor'
import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'
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

function open(qubits: number, clbits: number) {
  const store = createCircuitStore(emptyCircuit(qubits, clbits))
  const view = render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitEditor store={store} />
    </I18nextProvider>
  )
  return { store, view }
}

/** The editor's own live region; the simulation panel has one of its own. */
function status(container: HTMLElement): string {
  return container.querySelector('.circuit-editor__status')?.textContent ?? ''
}

function press(key: string): void {
  fireEvent.keyDown(screen.getByRole('grid'), { key })
}

/** Every classical bit written in `column`, in order, duplicates included. */
function writesIn(store: CircuitStore, column: number): number[] {
  return store
    .getState()
    .circuit.operations.filter((operation) => operation.column === column)
    .flatMap((operation) => operation.clbitTargets ?? [])
    .sort((first, second) => first - second)
}

describe('measuring a wire whose index a register edit moved', () => {
  it('never writes a bit that column already writes', () => {
    const { store } = open(3, 3)

    // (q1, column 0): the cursor starts at the origin, one row down.
    press('ArrowDown')
    press('m')
    press('Enter')
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [1],
      clbitTargets: [1],
    })

    // The gutter's own control. jsdom does not implement a button's default
    // activation, so the click is what runs its handler here; that the same
    // button answers Enter and Space in a browser is `keyboard-reach.spec`.
    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit q0' }))
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [0],
      clbitTargets: [1],
    })

    // Back onto the wire that now carries index 1, and measure it.
    press('m')
    press('Enter')

    expect(writesIn(store, 0)).toEqual([0, 1])
    expect(store.getState().circuit.operations).toHaveLength(2)
  })

  it('says so rather than guessing when the column has no bit left', () => {
    const { store, view } = open(3, 3)

    // A column whose every classical bit is written, reached with the
    // controls the gutter offers: measure q1, push it up to q2 with an
    // insertion, shrink the classical register to two bits, then fill both.
    press('ArrowDown')
    press('m')
    press('Enter')
    fireEvent.click(
      screen.getByRole('button', { name: 'Insert a qubit below q0' })
    )
    const shrink = screen.getByRole('button', {
      name: 'Remove the last classical bit',
    })
    fireEvent.click(shrink)
    fireEvent.click(shrink)
    expect(store.getState().circuit).toMatchObject({ qubits: 4, clbits: 2 })

    press('ArrowUp')
    press('m')
    press('Enter')
    const filled = store.getState().circuit
    expect(writesIn(store, 0)).toEqual([0, 1])

    // q1 is free, both bits are not. There is nothing to fall back on, so
    // the editor refuses and names the two things that would let it happen.
    press('ArrowDown')
    press('m')
    press('Enter')

    expect(store.getState().circuit).toBe(filled)
    expect(status(view.container)).toBe(enEditor.placement['no-free-clbit'])
  })
})
