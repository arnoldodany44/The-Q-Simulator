/**
 * Adversarial verification — a half-finished multi-qubit placement, checked
 * by wire identity while the register moves under it.
 *
 * The question is never "which index did the gate land on" but "is it on the
 * wire the user anchored". Wires are therefore named, and every assertion is
 * phrased against `qubitLabels`: index arithmetic is the thing under test, so
 * it cannot also be the thing the test trusts.
 *
 * Everything is driven through the rendered editor — the gutter's own
 * buttons, the grid's own keys — because the defect being verified was a
 * wiring one: the rules existed somewhere, and the controls the user presses
 * reached past them.
 */

import { type Circuit } from '@qsim/schema'
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

const NAMES = ['alice', 'bob', 'carol', 'dave'] as const

function named(names: readonly string[] = NAMES): Circuit {
  return {
    schemaVersion: 1,
    qubits: names.length,
    clbits: names.length,
    qubitLabels: [...names],
    operations: [],
  }
}

function open(circuit: Circuit) {
  const store = createCircuitStore(circuit)
  const view = render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitEditor store={store} />
    </I18nextProvider>
  )
  return { store, view }
}

function press(key: string, modifiers: Record<string, boolean> = {}): void {
  fireEvent.keyDown(screen.getByRole('grid'), { key, ...modifiers })
}

function status(): string {
  return document.querySelector('.circuit-editor__status')?.textContent ?? ''
}

/** The wires the one placed operation sits on, named rather than indexed. */
function roles(store: CircuitStore): {
  targets: string[]
  controls: string[]
} {
  const circuit = store.getState().circuit
  const labels = circuit.qubitLabels ?? []
  const name = (qubit: number): string => labels[qubit] ?? `#${qubit}`
  const operation = circuit.operations[0]
  if (operation === undefined) return { targets: [], controls: [] }
  return {
    targets: operation.targets.map(name),
    controls: (operation.controls ?? []).map((control) =>
      name(typeof control === 'number' ? control : control.qubit)
    ),
  }
}

/** Rows of the grid that carry the "claimed by a pending placement" mark. */
function claimedRows(): number[] {
  const rows = screen.getAllByRole('row')
  const marked: number[] = []
  rows.forEach((row, index) => {
    if (row.querySelector('.circuit-canvas__cell--claimed') !== null) {
      // Row 0 is the hidden column-header row, so wire n is row n + 1.
      marked.push(index - 1)
    }
  })
  return marked
}

function anchorCnotOn(qubit: number): void {
  press('c')
  for (let step = 0; step < qubit; step += 1) press('ArrowDown')
  press('Enter')
}

describe('a pending placement while the register moves', () => {
  it('lands on the anchored wire after a wire is inserted above it', () => {
    const { store } = open(named())

    anchorCnotOn(1) // target anchored on bob
    expect(claimedRows()).toEqual([1])

    // The gutter's own control, which is the path the user takes.
    fireEvent.click(
      screen.getByRole('button', { name: 'Insert a qubit below alice' })
    )

    // bob is now wire 2, and the highlight has to say so.
    expect(store.getState().circuit.qubits).toBe(5)
    expect(claimedRows()).toEqual([2])

    // Complete on the freshly inserted wire, where the cursor already is.
    press('Enter')

    expect(roles(store)).toEqual({ targets: ['bob'], controls: ['q4'] })
  })

  it('cancels, and says so, when the anchored wire is deleted', () => {
    const { store } = open(named())

    anchorCnotOn(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit bob' }))

    expect(claimedRows()).toEqual([])
    expect(status()).toContain('The half-placed gate was cancelled')
    expect(store.getState().circuit.operations).toEqual([])

    // `armed` survives, so one Enter re-anchors instead of two.
    press('Enter')
    expect(claimedRows()).toHaveLength(1)
  })

  it('follows its wire when a wire below the anchor is deleted', () => {
    const { store } = open(named())

    anchorCnotOn(2) // carol
    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit alice' }))

    expect(store.getState().circuit.qubitLabels).toEqual([
      'bob',
      'carol',
      'dave',
    ])
    expect(claimedRows()).toEqual([1])

    // The cursor is on dave, one row below where it started; two steps up is
    // bob, the only free wire left in the column.
    press('ArrowUp')
    press('ArrowUp')
    press('Enter')

    expect(roles(store)).toEqual({ targets: ['carol'], controls: ['bob'] })
  })

  it('is cancelled by an undo that actually moved the document', () => {
    const { store } = open(named())

    press('h')
    press('Enter') // something to undo
    anchorCnotOn(1)

    press('z', { ctrlKey: true })

    expect(claimedRows()).toEqual([])
    expect(status()).toContain('The half-placed gate was cancelled')
    expect(store.getState().circuit.operations).toEqual([])
  })

  it('survives an undo that found an empty history', () => {
    open(named())

    anchorCnotOn(1)
    press('z', { ctrlKey: true })

    expect(claimedRows()).toEqual([1])
  })

  it('survives a classical-register edit, which renumbers no wire', () => {
    open(named())

    anchorCnotOn(1)
    fireEvent.click(screen.getByRole('button', { name: 'Add a classical bit' }))

    expect(claimedRows()).toEqual([1])
  })

  it('never completes onto a wire that has been renumbered away', () => {
    const { store } = open(named(['alice', 'bob']))

    anchorCnotOn(1) // bob, the last wire
    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit bob' }))

    // One wire left, so a CNOT cannot even start; the prompt must be gone
    // rather than waiting for a partner that cannot exist.
    expect(claimedRows()).toEqual([])
    // The wire the cursor stood on is gone, so it clamps onto the register
    // row; alice is one step up.
    press('ArrowUp')
    press('Enter')
    expect(status()).toContain('needs more wires')
    expect(store.getState().circuit.operations).toEqual([])
  })
})
