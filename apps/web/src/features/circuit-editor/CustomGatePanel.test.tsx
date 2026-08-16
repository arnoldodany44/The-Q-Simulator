import { emptyCircuit } from '@qsim/schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import esEditor from '../../i18n/locales/es/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { CustomGatePanel } from './CustomGatePanel'
import { createCircuitStore, type CircuitStore } from './useCircuitStore'

/**
 * The blocks panel. `customGates.test.ts` proves the transitions are right;
 * this file is about whether a reader can reach them, and — the reason the
 * component exists at all — whether the shared-definition decision is visible
 * before it is acted on rather than after.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['editor'],
    defaultNS: 'editor',
    resources: {
      en: { editor: enEditor },
      es: { editor: esEditor },
      fr: { editor: frEditor },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function renderPanel(store: CircuitStore, language: Language = 'en'): void {
  render(
    <I18nextProvider i18n={i18nFor(language)}>
      <CustomGatePanel store={store} />
    </I18nextProvider>
  )
}

/** A store holding a Bell pair, with both gates selected. */
function bellStore(): CircuitStore {
  const store = createCircuitStore(emptyCircuit(4, 2))
  store.getState().placeGate('h', [0], 0)
  store.getState().placeGate('cx', [1], 1, { controls: [0] })
  store.getState().setSelection(['op_1', 'op_2'])
  return store
}

function packagedStore(): CircuitStore {
  const store = bellStore()
  store.getState().packageSelection('bellPair', { symbol: 'B' })
  store.getState().placeCustomGate('bellPair', 2)
  return store
}

describe('packaging from the panel', () => {
  it('will not package until there is a selection and a name', () => {
    const store = createCircuitStore(emptyCircuit(3))
    renderPanel(store)
    const submit = screen.getByRole('button', {
      name: enEditor.customGates.package.submit,
    })
    expect(submit).toHaveProperty('disabled', true)
  })

  it('packages the selection and lists the new block', () => {
    const store = bellStore()
    renderPanel(store)

    fireEvent.change(screen.getByLabelText(enEditor.customGates.package.name), {
      target: { value: 'bellPair' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.package.submit })
    )

    expect(store.getState().circuit.customGates?.bellPair).toBeDefined()
    expect(screen.getByText('bellPair')).toBeDefined()
  })

  it('says why a refused packaging was refused, in the reader’s language', () => {
    const store = createCircuitStore(emptyCircuit(4))
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [2], 1)
    store.getState().placeGate('y', [0], 2)
    // Skips the X in the middle of its own column range.
    store.getState().setSelection(['op_1', 'op_3'])
    renderPanel(store, 'fr')

    fireEvent.change(screen.getByLabelText(frEditor.customGates.package.name), {
      target: { value: 'skipper' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: frEditor.customGates.package.submit })
    )

    expect(
      screen.getByText(frEditor.rejection['fragment-not-rectangular'])
    ).toBeDefined()
  })
})

describe('an entry in the list', () => {
  it('prints the block’s shape and how often this circuit uses it', () => {
    renderPanel(packagedStore())
    // Two qubits, two gates in the body, two uses on the canvas.
    expect(screen.getByText(/2 qubits/)).toBeDefined()
    expect(screen.getByText(/2 gates/)).toBeDefined()
    expect(screen.getByText(/used 2 times here/)).toBeDefined()
  })

  it('places another use', () => {
    const store = packagedStore()
    renderPanel(store)
    const before = store.getState().circuit.operations.length
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.place })
    )
    expect(store.getState().circuit.operations).toHaveLength(before + 1)
  })

  it('expands one use back into its gates', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.inline })
    )
    const gates = store.getState().circuit.operations.map((o) => o.gate)
    expect(gates).toContain('h')
    expect(gates).toContain('cx')
  })

  it('refuses to delete a block the circuit still uses, and says so', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.remove })
    )
    expect(store.getState().circuit.customGates?.bellPair).toBeDefined()
    expect(
      screen.getByText(enEditor.rejection['custom-gate-in-use'])
    ).toBeDefined()
  })

  it('duplicates under a free name without asking for one', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', {
        name: enEditor.customGates.actions.duplicate,
      })
    )
    expect(store.getState().circuit.customGates?.bellPair2).toBeDefined()
  })
})

describe('editing a definition', () => {
  /*
   * The whole reason this component exists: the consequence is on screen for
   * as long as the decision is being made, not in a dialog that was dismissed
   * on the way in.
   */
  it('keeps the count of affected uses on screen the whole time', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )

    expect(screen.getByText(/all 2 uses in this circuit/)).toBeDefined()
    // And the escape hatch is named in the same paragraph.
    expect(screen.getByText(/Duplicate it first/)).toBeDefined()
  })

  it('applies the change to every use', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )
    store.getState().placeGate('z', [1], 2)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.editing.apply })
    )

    expect(store.getState().definitionEdit).toBeNull()
    expect(
      store.getState().circuit.customGates?.bellPair?.operations
    ).toHaveLength(3)
  })

  it('discards the change on cancel', () => {
    const store = packagedStore()
    const before = store.getState().circuit
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )
    store.getState().placeGate('z', [1], 2)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.editing.cancel })
    )
    expect(store.getState().circuit).toBe(before)
  })

  it('says why a reshape was refused instead of rewiring the uses', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )
    store.getState().addQubit()
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.editing.apply })
    )

    expect(
      screen.getByText(enEditor.rejection['custom-gate-reshaped'])
    ).toBeDefined()
    expect(store.getState().definitionEdit?.name).toBe('bellPair')
  })
})

describe('what a command says and where it leaves focus', () => {
  /*
   * The panel's own header says its live region exists "because every command
   * here changes a diagram the reader may not be looking at" — and it wrote a
   * sentence only when a command was *refused*, so every command that worked
   * was silent. Four of them also re-render the panel into a different shape,
   * which left the focused button non-existent and focus on `document.body`.
   */
  function spoken(): string {
    return document.querySelector('.custom-gates__status')?.textContent ?? ''
  }

  it('says the selection was packaged', () => {
    const store = bellStore()
    renderPanel(store)
    fireEvent.change(screen.getByLabelText(enEditor.customGates.package.name), {
      target: { value: 'bellPair' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.package.submit })
    )
    expect(spoken()).toMatch(/Packaged the selection/)
  })

  it('says a definition was opened, and puts focus in the editor', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )
    expect(spoken()).toMatch(/Editing the block bellPair/)
    expect(document.activeElement).toBe(
      screen.getByLabelText(enEditor.customGates.editing.symbol)
    )
  })

  it('says the change was applied, and puts focus on the heading', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.editing.apply })
    )
    expect(spoken()).toMatch(/Applied the changes/)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: enEditor.customGates.title })
    )
  })

  it('says the change was discarded, and puts focus on the heading', () => {
    const store = packagedStore()
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.edit })
    )
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.editing.cancel })
    )
    expect(spoken()).toMatch(/Discarded the changes/)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: enEditor.customGates.title })
    )
  })

  it('says a block was deleted, and does not leave focus on the row that went', () => {
    const store = bellStore()
    store.getState().packageSelection('spare', { symbol: 'S' })
    // Packaging leaves one use; remove it so the definition can be deleted.
    store.getState().removeOperation('op_3')
    renderPanel(store)
    fireEvent.click(
      screen.getByRole('button', { name: enEditor.customGates.actions.remove })
    )
    expect(spoken()).toMatch(/Deleted the block spare/)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: enEditor.customGates.title })
    )
  })
})
