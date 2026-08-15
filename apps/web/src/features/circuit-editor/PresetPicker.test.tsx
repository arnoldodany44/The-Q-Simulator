import { emptyCircuit } from '@qsim/schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import esEditor from '../../i18n/locales/es/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { PresetPicker } from './PresetPicker'
import { PRESETS } from './presets'
import { createCircuitStore, type CircuitStore } from './useCircuitStore'

/**
 * The examples strip. What the physics tests in `presets.test.ts` cannot
 * check is whether a reader can reach any of it, so this file is about the
 * control: six buttons, each one loading its own circuit, each one named the
 * way D2 says it should be, and each press answered out loud.
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

function draw(store: CircuitStore, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <PresetPicker store={store} />
    </I18nextProvider>
  )
}

describe('the examples strip', () => {
  it('offers one button per preset', () => {
    draw(createCircuitStore())
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(PRESETS.length)
  })

  it('names each button after its preset, summary included', () => {
    draw(createCircuitStore())
    // The accessible name is the visible name *plus* the hidden summary, which
    // is the whole reason the summary is in the button: "Bell" alone tells a
    // reader who cannot see the diagram nothing at all.
    const bell = screen.getByRole('button', {
      name: /^Bell Two qubits entangled/,
    })
    expect(bell).toBeDefined()
  })

  it.each(PRESETS)('loads the circuit of $id', (preset) => {
    const store = createCircuitStore(emptyCircuit(1, 0))
    draw(store)

    fireEvent.click(screen.getAllByRole('button')[PRESETS.indexOf(preset)]!)

    expect(store.getState().circuit).toEqual(preset.circuit)
  })

  it('announces what was loaded', () => {
    const store = createCircuitStore()
    draw(store)

    fireEvent.click(screen.getByRole('button', { name: /^GHZ/ }))

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('GHZ')
    expect(status.textContent).toContain('Example loaded:')
    expect(status.textContent).toContain('three qubits')
  })

  it('announces the second press of the same button too', () => {
    // The message is identical both times, so React would leave the text node
    // alone and the live region would stay silent — see `PresetPicker.tsx`.
    const store = createCircuitStore()
    draw(store)
    const bell = screen.getByRole('button', { name: /^Bell/ })

    fireEvent.click(bell)
    const first = screen.getByRole('status').firstElementChild
    fireEvent.click(bell)
    const second = screen.getByRole('status').firstElementChild

    expect(first).not.toBe(second)
  })

  it('clears the undo history, so nothing predates the example', () => {
    const store = createCircuitStore()
    draw(store)
    store.getState().placeGate('h', [0], 0)

    fireEvent.click(screen.getByRole('button', { name: /^Bell/ }))

    expect(store.getState().undo()).toMatchObject({
      ok: false,
      reason: 'nothing-to-undo',
    })
  })
})

describe('names follow D2', () => {
  it('never translates a proper noun, in any language', () => {
    for (const language of ['en', 'es', 'fr'] as const) {
      cleanup()
      draw(createCircuitStore(), language)
      for (const preset of PRESETS) {
        if (preset.properName === null) continue
        expect(
          screen.getByRole('button', {
            name: new RegExp(`^${preset.properName}`),
          })
        ).toBeDefined()
      }
    }
  })

  it('marks a proper noun as untranslatable for the browser too', () => {
    draw(createCircuitStore())
    const bell = screen.getByRole('button', { name: /^Bell/ })
    // `translate="no"` is what stops Chrome's page translator from turning a
    // physicist's surname into a bell.
    expect(bell.querySelector('[translate="no"]')?.textContent).toBe('Bell')
  })

  it('does translate the ordinary words', () => {
    draw(createCircuitStore(), 'fr')
    expect(screen.getByRole('button', { name: /^Téléportation/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^Interférence/ })).toBeDefined()

    cleanup()
    draw(createCircuitStore(), 'es')
    expect(screen.getByRole('button', { name: /^Superposición/ })).toBeDefined()
  })
})
