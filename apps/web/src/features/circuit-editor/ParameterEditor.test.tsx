import { parseCircuit, type Operation } from '@qsim/schema'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import esEditor from '../../i18n/locales/es/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { ParameterEditor } from './ParameterEditor'

/**
 * The parameter editor exists to show one number in the two forms that mean
 * something — radians, and the multiple of π they amount to — and to show
 * the first of those in the reader's own convention.
 *
 * The locale assertions are the reason this file is separate from the rest.
 * A French user reading `1.5708` sees a number in the thousands, and no
 * amount of correct physics upstream survives that.
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

function rotation(theta: number | string): Operation {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 1,
    parameters: typeof theta === 'string' ? [{ name: theta, value: 0 }] : [],
    operations: [
      { id: 'op_1', gate: 'rz', targets: [0], params: [theta], column: 0 },
    ],
  }).operations[0]!
}

function show(operation: Operation | null, language: Language = 'en') {
  const onChange = vi.fn()
  const onGestureStart = vi.fn()
  const onGestureEnd = vi.fn()
  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ParameterEditor
        operation={operation}
        onChange={onChange}
        onGestureStart={onGestureStart}
        onGestureEnd={onGestureEnd}
      />
    </I18nextProvider>
  )
  return { onChange, onGestureStart, onGestureEnd, view }
}

const HALF_PI = Math.PI / 2

const LABELS: Record<Language, { slider: string; field: string }> = {
  en: { slider: 'Angle slider', field: 'Angle in radians' },
  es: { slider: 'Deslizador de ángulo', field: 'Ángulo en radianes' },
  fr: { slider: 'Curseur d’angle', field: 'Angle en radians' },
}

describe('the two controls', () => {
  it('offers a slider and a field for the same angle', () => {
    show(rotation(HALF_PI))
    expect(screen.getByRole('slider', { name: LABELS.en.slider })).toBeDefined()
    expect(screen.getByRole('textbox', { name: LABELS.en.field })).toBeDefined()
  })

  it('says nothing to change when the gate takes no parameters', () => {
    show(null)
    expect(
      screen.getByText('Select a parametrised gate to change its angles.')
    ).toBeDefined()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('reports the angle a slider stop stands for, not the stop', () => {
    const { onChange } = show(rotation(0))
    fireEvent.change(screen.getByRole('slider', { name: LABELS.en.slider }), {
      target: { value: '8' },
    })
    expect(onChange).toHaveBeenCalledWith(0, HALF_PI)
  })

  it('shows a symbolic parameter without offering to edit it', () => {
    show(rotation('theta'))
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText(/Driven by the circuit parameter/)).toBeDefined()
  })
})

describe('the number, in each locale', () => {
  const cases: readonly [Language, string][] = [
    ['en', '1.5708'],
    ['es', '1,5708'],
    ['fr', '1,5708'],
  ]

  it.each(cases)('writes the field the way %s does', (language, written) => {
    show(rotation(HALF_PI), language)
    const field = screen.getByRole('textbox', {
      name: LABELS[language].field,
    })
    expect((field as HTMLInputElement).value).toBe(written)
  })

  it.each(cases)('writes the readout the way %s does', (language, written) => {
    const { view } = show(rotation(HALF_PI), language)
    const reading = view.container.querySelector('.parameter-editor__reading')
    expect(reading?.textContent).toContain(`${written} rad`)
    // The π form is notation and is identical in all three.
    expect(reading?.textContent).toContain('π/2')
  })

  it.each(cases)(
    'announces the slider as an angle rather than a step count in %s',
    (language) => {
      show(rotation(HALF_PI), language)
      expect(
        screen
          .getByRole('slider', { name: LABELS[language].slider })
          .getAttribute('aria-valuetext')
      ).toBe('π/2')
    }
  )

  it('accepts a comma from a user whose keypad types one', () => {
    const { onChange } = show(rotation(0), 'fr')
    fireEvent.change(screen.getByRole('textbox', { name: LABELS.fr.field }), {
      target: { value: '1,5' },
    })
    expect(onChange).toHaveBeenCalledWith(0, 1.5)
  })

  it('accepts a point from that same user, because keypads lie', () => {
    const { onChange } = show(rotation(0), 'fr')
    fireEvent.change(screen.getByRole('textbox', { name: LABELS.fr.field }), {
      target: { value: '1.5' },
    })
    expect(onChange).toHaveBeenCalledWith(0, 1.5)
  })

  it('keeps a half-typed value on screen instead of rewriting it', () => {
    const { onChange } = show(rotation(0), 'es')
    const field = screen.getByRole('textbox', { name: LABELS.es.field })
    fireEvent.change(field, { target: { value: '-' } })
    expect((field as HTMLInputElement).value).toBe('-')
    expect(onChange).not.toHaveBeenCalled()
  })
})

/*
 * Where one gesture starts and stops. The store turns each pair into exactly
 * one history step (see `useCircuitStore`), so a boundary in the wrong place
 * is either a drag that costs fifty undo presses or two separate edits the
 * user can only undo together.
 */
describe('the boundaries of a continuous edit', () => {
  function slider(): HTMLElement {
    return screen.getByRole('slider', { name: LABELS.en.slider })
  }

  it('wraps a whole pointer drag in a single gesture', () => {
    const { onChange, onGestureStart, onGestureEnd } = show(rotation(0))
    const control = slider()

    fireEvent.pointerDown(control)
    for (const step of ['1', '2', '3', '4', '5']) {
      fireEvent.change(control, { target: { value: step } })
    }
    fireEvent.pointerUp(control)

    expect(onChange).toHaveBeenCalledTimes(5)
    expect(onGestureStart).toHaveBeenCalledTimes(1)
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })

  it('ends the drag even when the pointer is released off the thumb', () => {
    const { onGestureEnd } = show(rotation(0))
    fireEvent.pointerDown(slider())
    fireEvent.lostPointerCapture(slider())
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })

  it('gives every discrete arrow press its own gesture', () => {
    const { onGestureStart, onGestureEnd } = show(rotation(0))
    const control = slider()

    for (let press = 0; press < 3; press++) {
      fireEvent.keyDown(control, { key: 'ArrowRight' })
      fireEvent.change(control, { target: { value: String(press + 1) } })
      fireEvent.keyUp(control, { key: 'ArrowRight' })
    }

    expect(onGestureStart).toHaveBeenCalledTimes(3)
    expect(onGestureEnd).toHaveBeenCalledTimes(3)
  })

  it('keeps a held key inside the gesture its first press opened', () => {
    const { onGestureStart, onGestureEnd } = show(rotation(0))
    const control = slider()

    fireEvent.keyDown(control, { key: 'ArrowRight' })
    for (let repeat = 0; repeat < 8; repeat++) {
      fireEvent.keyDown(control, { key: 'ArrowRight', repeat: true })
    }
    fireEvent.keyUp(control, { key: 'ArrowRight' })

    expect(onGestureStart).toHaveBeenCalledTimes(1)
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })

  it('treats a typing session in the field as one gesture', () => {
    const { onChange, onGestureStart, onGestureEnd } = show(rotation(0))
    const field = screen.getByRole('textbox', { name: LABELS.en.field })

    for (const text of ['1', '1.', '1.5', '1.57']) {
      fireEvent.change(field, { target: { value: text } })
    }
    expect(onGestureEnd).not.toHaveBeenCalled()
    fireEvent.blur(field)

    // Every keystroke that parses is applied, `1.` included — the store is
    // what notices it means the same number as `1`.
    expect(onChange).toHaveBeenCalledTimes(4)
    expect(onGestureStart).toHaveBeenCalledTimes(1)
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })

  it('opens nothing for a keystroke that is not yet a number', () => {
    const { onGestureStart } = show(rotation(0))
    fireEvent.change(screen.getByRole('textbox', { name: LABELS.en.field }), {
      target: { value: '-' },
    })
    expect(onGestureStart).not.toHaveBeenCalled()
  })

  it('closes the gesture when the row is unmounted mid-drag', () => {
    const { onGestureEnd, view } = show(rotation(0))
    fireEvent.pointerDown(slider())
    expect(onGestureEnd).not.toHaveBeenCalled()

    // What selecting another gate, or deleting this one, does to the row.
    view.unmount()
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })

  it('does not close a gesture twice, whichever events arrive', () => {
    const { onGestureStart, onGestureEnd } = show(rotation(0))
    const control = slider()

    // A real drag fires several of these, and a second `endTransaction`
    // would resume a history that is already running — or close the gesture
    // the next press has just opened.
    fireEvent.pointerDown(control)
    fireEvent.pointerUp(control)
    fireEvent.lostPointerCapture(control)
    fireEvent.blur(control)

    expect(onGestureStart).toHaveBeenCalledTimes(1)
    expect(onGestureEnd).toHaveBeenCalledTimes(1)
  })
})
