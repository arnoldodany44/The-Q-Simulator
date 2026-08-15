/**
 * Adversarial verification — one gesture, one undo step.
 *
 * The claim under test is a pair, and the failure modes pull in opposite
 * directions: history must coalesce a continuous drag into a single step,
 * while the document must keep changing on every intermediate value, because
 * watching the phasors turn is the whole reason the slider exists. A repair
 * that debounced the *edit* would satisfy the first half and destroy the
 * second, so both are asserted from the same gesture.
 *
 * Counts come from `store.temporal`, which is what undo actually walks —
 * counting rendered presses of Ctrl+Z instead would measure the assertion
 * against itself.
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

const CIRCUIT: Circuit = {
  schemaVersion: 1,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'rz', targets: [0], column: 0, params: [0] },
  ],
}

/** Three parameter rows on one gate, for the gestures that cross rows. */
const THREE_ROWS: Circuit = {
  schemaVersion: 1,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'u', targets: [0], column: 0, params: [0, 0, 0] },
  ],
}

function open(circuit: Circuit = CIRCUIT) {
  const store = createCircuitStore(circuit)
  const view = render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitEditor store={store} />
    </I18nextProvider>
  )
  // Selecting the gate is what brings the parameter row on screen. Enter on
  // its cell with nothing armed is the editor's own "select this".
  fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' })
  return { store, view }
}

const depth = (store: CircuitStore): number =>
  store.temporal.getState().pastStates.length

const angle = (store: CircuitStore): number =>
  Number(store.getState().circuit.operations[0]?.params?.[0] ?? Number.NaN)

const slider = (): HTMLElement => screen.getByRole('slider')

const field = (): HTMLElement =>
  screen.getByRole('textbox', { name: 'Angle in radians' })

/** Fires `count` slider stops, the way a drag does. */
function drag(steps: readonly number[]): void {
  const input = slider()
  fireEvent.pointerDown(input)
  for (const step of steps) {
    fireEvent.change(input, { target: { value: String(step) } })
  }
  fireEvent.pointerUp(input)
}

describe('one continuous parameter gesture costs one undo step', () => {
  it('records a single history entry for a twelve-stop drag', () => {
    const { store } = open()
    const before = depth(store)

    drag([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    expect(depth(store)).toBe(before + 1)
  })

  it('keeps applying every intermediate value as the drag happens', () => {
    const { store } = open()
    const seen: number[] = []
    const input = slider()

    fireEvent.pointerDown(input)
    for (const step of [1, 2, 3, 4, 5]) {
      fireEvent.change(input, { target: { value: String(step) } })
      seen.push(angle(store))
    }
    fireEvent.pointerUp(input)

    // Strictly increasing: the document moved on every stop, not once at the
    // end and not on a trailing debounce.
    expect(seen).toHaveLength(5)
    seen.forEach((value, index) => {
      if (index > 0) expect(value).toBeGreaterThan(seen[index - 1]!)
    })
  })

  it('comes back to the pre-drag angle in one undo, and forward in one redo', () => {
    const { store } = open()
    const start = angle(store)

    drag([1, 2, 3, 4, 5, 6, 7, 8])
    const end = angle(store)
    expect(end).not.toBe(start)

    store.getState().undo()
    expect(angle(store)).toBe(start)

    store.getState().redo()
    expect(angle(store)).toBe(end)
  })

  it('costs nothing at all when the drag ends where it began', () => {
    const { store } = open()
    const before = depth(store)
    const start = angle(store)

    drag([1, 2, 3, 2, 1, 0])

    expect(angle(store)).toBe(start)
    expect(depth(store)).toBe(before)
    expect(store.temporal.getState().futureStates).toHaveLength(0)
  })

  it('gives a keyboard user one step per discrete press', () => {
    const { store } = open()
    const before = depth(store)
    const input = slider()

    for (const step of [1, 2, 3, 4]) {
      fireEvent.keyDown(input, { key: 'ArrowRight' })
      fireEvent.change(input, { target: { value: String(step) } })
      fireEvent.keyUp(input, { key: 'ArrowRight' })
    }

    expect(depth(store)).toBe(before + 4)
  })

  it('treats auto-repeat from a held key as one gesture', () => {
    const { store } = open()
    const before = depth(store)
    const input = slider()

    fireEvent.keyDown(input, { key: 'ArrowRight' })
    fireEvent.change(input, { target: { value: '1' } })
    for (const step of [2, 3, 4, 5]) {
      fireEvent.keyDown(input, { key: 'ArrowRight', repeat: true })
      fireEvent.change(input, { target: { value: String(step) } })
    }
    fireEvent.keyUp(input, { key: 'ArrowRight' })

    expect(depth(store)).toBe(before + 1)
  })

  it('records one entry for a whole typing session in the field', () => {
    const { store } = open()
    const before = depth(store)
    const input = field()

    for (const text of ['1', '1.', '1.5', '1.57']) {
      fireEvent.change(input, { target: { value: text } })
    }
    fireEvent.blur(input)

    expect(depth(store)).toBe(before + 1)
    expect(angle(store)).toBeCloseTo(1.57, 5)

    store.getState().undo()
    expect(angle(store)).toBe(0)
  })

  it('closes the session on Enter, so the next edit is its own step', () => {
    const { store } = open()
    const before = depth(store)
    const input = field()

    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.blur(input)

    expect(depth(store)).toBe(before + 2)
  })

  it('leaves history running when the row unmounts mid-drag', () => {
    const { store } = open()
    const input = slider()

    fireEvent.pointerDown(input)
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.change(input, { target: { value: '5' } })
    // The gate is deleted while the pointer is still down: the row vanishes
    // and no `pointerup` will ever reach it.
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Delete' })

    const after = depth(store)
    // A later, unrelated edit must still be recorded — a gesture left open
    // would have paused history for the rest of the session.
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'h' })
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' })

    expect(store.getState().circuit.operations).toHaveLength(1)
    expect(depth(store)).toBe(after + 1)
  })

  it('does not swallow an edit made between two drags', () => {
    const { store } = open()
    const before = depth(store)

    drag([1, 2, 3])
    drag([4, 5, 6])

    expect(depth(store)).toBe(before + 2)
    store.getState().undo()
    store.getState().undo()
    expect(angle(store)).toBe(0)
  })
})

/*
 * The orderings the browser actually produces.
 *
 * Pressing the slider while the numeric field still holds focus fires
 * `slider:pointerdown` BEFORE `field:blur` — measured in Chromium as
 * field:pointerdown, field:mousedown, field:focus, slider:pointerdown,
 * slider:mousedown, field:blur, slider:focus. A single "is a gesture open"
 * flag turns that into the worst of both worlds: the pointerdown is a no-op
 * because the typing session is still open, and the blur then closes the drag
 * that has just started, so every remaining stop records its own undo step
 * and the typed value is swallowed as the drag's first value.
 *
 * The same sequence across two rows of a `u` gate did the same thing, because
 * the store's transactions do not nest either.
 */
describe('a gesture that starts while another is still closing', () => {
  it('leaves the typed value undoable and the drag one step', () => {
    const { store } = open()
    const before = depth(store)
    const input = slider()

    fireEvent.change(field(), { target: { value: '1' } })
    expect(angle(store)).toBe(1)

    // The pointer lands on the slider before the field has blurred.
    fireEvent.pointerDown(input)
    fireEvent.blur(field())
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
      fireEvent.change(input, { target: { value: String(step) } })
    }
    fireEvent.pointerUp(input)

    // Two gestures, two steps: the typing session and the drag.
    expect(depth(store)).toBe(before + 2)
    store.getState().undo()
    expect(angle(store)).toBe(1)
    store.getState().undo()
    expect(angle(store)).toBe(0)
  })

  it('does not let one row of a gate close another row’s gesture', () => {
    const { store } = open(THREE_ROWS)
    const before = depth(store)
    const fields = screen.getAllByRole('textbox', { name: 'Angle in radians' })
    const sliders = screen.getAllByRole('slider')
    expect(fields).toHaveLength(3)

    fireEvent.change(fields[0]!, { target: { value: '1' } })
    fireEvent.pointerDown(sliders[1]!)
    fireEvent.blur(fields[0]!)
    for (const step of [1, 2, 3, 4, 5, 6]) {
      fireEvent.change(sliders[1]!, { target: { value: String(step) } })
    }
    fireEvent.pointerUp(sliders[1]!)

    expect(depth(store)).toBe(before + 2)
    const params = store.getState().circuit.operations[0]?.params ?? []
    expect(params[0]).toBe(1)
    expect(Number(params[1])).toBeGreaterThan(0)

    store.getState().undo()
    expect(store.getState().circuit.operations[0]?.params?.[1]).toBe(0)
    expect(store.getState().circuit.operations[0]?.params?.[0]).toBe(1)
  })
})
