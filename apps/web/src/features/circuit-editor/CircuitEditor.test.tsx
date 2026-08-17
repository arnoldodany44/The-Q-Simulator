import { emptyCircuit, type Circuit } from '@qsim/schema'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import enGates from '../../i18n/locales/en/gates.json'
import enSimulation from '../../i18n/locales/en/simulation.json'
import esEditor from '../../i18n/locales/es/editor.json'
import esGates from '../../i18n/locales/es/gates.json'
import esSimulation from '../../i18n/locales/es/simulation.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import frGates from '../../i18n/locales/fr/gates.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'
import { CircuitEditor } from './CircuitEditor'
import type { Cell } from './geometry'
import { createCircuitStore, type CircuitStore } from './useCircuitStore'

/**
 * The editor, driven by the keyboard alone.
 *
 * No test that *builds a circuit* here touches a pointer, and that is the
 * requirement rather than a convenience of jsdom: §10 asks for an editor a
 * user can operate with no pointer at all, and the only honest way to check
 * that is to build a real circuit without one and compare the result against
 * the circuit JSON the contract would have produced.
 *
 * The one exception is the last block, which asserts that the register
 * controls in the gutter are wired to the store at all. jsdom does not
 * implement a button's default activation, so an Enter dispatched at one of
 * them proves nothing about whether it fires; `click` is what runs its
 * handler here, and that those buttons answer the keyboard in a real browser
 * is asserted in `keyboard-reach.spec.ts` — the same split the block on
 * grid keys below already relies on.
 *
 * The drag path is proven separately in `placement.test.ts`, which tests the
 * functions dnd-kit's handlers call. Driving dnd-kit itself here would prove
 * nothing: it resolves drops from measured rectangles, and jsdom reports
 * every rectangle as zero.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
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
      es: { editor: esEditor, gates: esGates, simulation: esSimulation },
      fr: { editor: frEditor, gates: frGates, simulation: frSimulation },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** A whole other document: two wires, H then CNOT. */
function bell(): Circuit {
  return {
    schemaVersion: 1,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  }
}

function open(circuit: Circuit, language: Language = 'en') {
  const store = createCircuitStore(circuit)
  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <CircuitEditor store={store} />
    </I18nextProvider>
  )
  return { store, view }
}

/** Everything the editor listens for arrives at the grid and bubbles up. */
function press(key: string, modifiers: Record<string, boolean> = {}): void {
  fireEvent.keyDown(screen.getByRole('grid'), { key, ...modifiers })
}

function type(keys: readonly string[]): void {
  for (const key of keys) press(key)
}

function cellAt(qubit: number, column: number): HTMLElement {
  // Row 0 is the hidden header row of column names.
  const row = screen.getAllByRole('row')[qubit + 1]
  return within(row!).getAllByRole('gridcell')[column]!
}

function status(container: HTMLElement): string {
  return container.querySelector('.circuit-editor__status')?.textContent ?? ''
}

function historyDepth(store: CircuitStore): number {
  return store.temporal.getState().pastStates.length
}

/**
 * The space French sets before ':', ';', '!' and '?' so the mark cannot
 * begin a line. Named rather than typed: U+00A0 is invisible in a diff, and
 * an assertion that silently used an ordinary space would pass only until
 * somebody fixed the catalog. `locale-parity.test.ts` guards the other side.
 */
const NBSP = ' '

describe('building a circuit with the keyboard only', () => {
  it('places a gate where the cursor is', () => {
    const { store } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')

    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    ])
  })

  /*
   * The milestone's own definition of done, done without a pointer: H on q0,
   * CNOT from q0 to q1, and the store holding exactly the Bell JSON.
   */
  it('builds the Bell circuit and produces the expected JSON', () => {
    const { store } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')

    press('c')
    type(['ArrowRight', 'ArrowDown'])
    press('Enter') // the CNOT's target lands on q1, column 1
    press('ArrowUp')
    press('Enter') // and its control on q0

    expect(store.getState().circuit).toEqual({
      schemaVersion: 1,
      qubits: 2,
      clbits: 0,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'cx', targets: [1], column: 1, controls: [0] },
      ],
    })
  })

  it('moves the cursor to the ends of a wire and across the whole grid', () => {
    const { store } = open(emptyCircuit(3, 0))

    press('End')
    press('x')
    press('Enter')
    expect(store.getState().circuit.operations[0]?.column).toBe(7)

    press('ArrowDown')
    press('Home')
    press('Enter')
    expect(store.getState().circuit.operations[1]).toMatchObject({
      targets: [1],
      column: 0,
    })
  })

  it('undoes and redoes through the same keys the panel advertises', () => {
    const { store } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    expect(store.getState().circuit.operations).toHaveLength(1)

    press('z', { ctrlKey: true })
    expect(store.getState().circuit.operations).toHaveLength(0)

    press('z', { ctrlKey: true, shiftKey: true })
    expect(store.getState().circuit.operations).toHaveLength(1)
  })

  it('copies a gate and pastes it under the cursor', () => {
    const { store } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    press('c', { ctrlKey: true })
    type(['ArrowDown', 'ArrowRight'])
    press('v', { ctrlKey: true })

    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'h', targets: [1], column: 1 },
    ])
  })

  it('deletes the gate under the cursor', () => {
    const { store } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    press('Delete')

    expect(store.getState().circuit.operations).toEqual([])
  })

  it('keeps the focused cell in the tab order and takes focus with it', () => {
    open(emptyCircuit(2, 0))

    press('ArrowDown')
    const focused = cellAt(1, 0)
    expect(focused.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(focused)
    expect(cellAt(0, 0).getAttribute('tabindex')).toBe('-1')
  })
})

/*
 * The editor's key handler is bound to the whole editor, because Escape and
 * the Ctrl chords are document-level commands. Every keystroke aimed at a
 * button therefore reaches it as well, and the grid must decline all of
 * them: a `preventDefault` here suppresses the native activation of the
 * control the user is standing on, which is how an editor ends up with a
 * toolbar, a palette and a disclosure that no key can operate (WCAG 2.1.1).
 *
 * jsdom does not implement a button's default activation, so what is checked
 * here is that the editor leaves the event alone and touches nothing. That
 * the button then actually fires is a browser fact, and `keyboard-reach`
 * in the e2e suite is where it is asserted.
 */
describe('keys aimed at a control are left to that control', () => {
  const GRID_KEYS = [
    'Enter',
    ' ',
    'Delete',
    'Backspace',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
  ] as const

  function toolbarButton(name: string): HTMLElement {
    return within(screen.getByRole('toolbar')).getByRole('button', { name })
  }

  it('neither consumes the key, nor moves the cursor, nor edits', () => {
    const { store } = open(emptyCircuit(2, 0))
    press('h')
    press('Enter')
    const before = store.getState().circuit

    const undo = toolbarButton('Undo')
    undo.focus()

    for (const key of GRID_KEYS) {
      const uncancelled = fireEvent.keyDown(undo, { key })
      expect(uncancelled, `${key} was cancelled on a button`).toBe(true)
      expect(document.activeElement, `${key} stole focus`).toBe(undo)
    }

    // The gate under the cursor survived every Delete, and the cursor never
    // left the cell it was on.
    expect(store.getState().circuit).toBe(before)
    expect(cellAt(0, 0).getAttribute('tabindex')).toBe('0')
  })

  it('does not arm a gate from a key pressed on the toolbar', () => {
    open(emptyCircuit(2, 0))
    // Placing a gate selects it, which is what makes Copy enabled and so
    // focusable in the first place.
    press('h')
    press('Enter')

    const copy = toolbarButton('Copy')
    copy.focus()
    expect(document.activeElement).toBe(copy)

    // `c` is CNOT's key and the initial of the button being aimed at — the
    // exact collision WCAG 2.1.4 is about.
    fireEvent.keyDown(copy, { key: 'c' })

    expect(
      screen.getByRole('button', { name: 'CNOT' }).getAttribute('aria-pressed')
    ).toBe('false')
  })

  it('keeps the Ctrl chords working from anywhere in the editor', () => {
    const { store } = open(emptyCircuit(2, 0))
    press('h')
    press('Enter')
    expect(store.getState().circuit.operations).toHaveLength(1)

    const redo = toolbarButton('Redo')
    redo.focus()
    fireEvent.keyDown(redo, { key: 'z', ctrlKey: true })

    expect(store.getState().circuit.operations).toHaveLength(0)
  })

  it('still answers the same keys when they come from the grid', () => {
    const { store } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    press('ArrowDown')
    press('Enter')
    press('Delete')

    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    ])
  })
})

describe('a refused placement', () => {
  it('leaves the circuit and the history exactly as they were', () => {
    const { store, view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')

    const before = store.getState().circuit
    const depth = historyDepth(store)

    press('x')
    press('Enter') // the cursor has not moved: q0, column 0 is taken

    expect(store.getState().circuit).toBe(before)
    expect(historyDepth(store)).toBe(depth)
    expect(status(view.container)).toBe(
      'Another gate already occupies that cell.'
    )
  })

  it('says so when a partner would land in another column', () => {
    const { store, view } = open(emptyCircuit(3, 0))

    press('c')
    press('Enter') // CNOT target on q0, column 0 — now pending
    type(['ArrowDown', 'ArrowRight'])
    press('Enter')

    expect(store.getState().circuit.operations).toEqual([])
    expect(status(view.container)).toBe(
      'The rest of the gate has to go in the same column.'
    )
  })

  it('writes nothing at all until a multi-qubit shape is complete', () => {
    const { store } = open(emptyCircuit(3, 0))

    press('c')
    press('Enter')

    // The gate is half-placed: the store has not heard of it, so there is
    // nothing for undo to undo.
    expect(store.getState().circuit.operations).toEqual([])
    expect(historyDepth(store)).toBe(0)
  })

  it('costs no undo step when the placement is cancelled', () => {
    const { store } = open(emptyCircuit(3, 0))

    press('c')
    press('Enter')
    press('Escape')
    press('ArrowDown')
    press('Enter')

    // Escape disarmed the pending placement, so this Enter placed nothing.
    expect(store.getState().circuit.operations).toEqual([])
    expect(historyDepth(store)).toBe(0)
  })

  it('refuses a gate that would need a classical bit the circuit lacks', () => {
    const { store, view } = open(emptyCircuit(2, 0))

    press('m')
    press('Enter')

    expect(store.getState().circuit.operations).toEqual([])
    // The second sentence is load-bearing: it names the gutter control that
    // now exists. A refusal that prescribes a fix the UI does not offer is
    // worse than one that says nothing.
    expect(status(view.container)).toBe(
      'That classical bit is outside the circuit. Add one to the classical register.'
    )
  })

  it('asks for a gate before it asks for a cell', () => {
    const { view } = open(emptyCircuit(2, 0))
    press('Enter')
    expect(status(view.container)).toBe(
      'Choose a gate first, then press Enter on a cell.'
    )
  })
})

describe('the palette', () => {
  it('marks the armed gate, and only that one', () => {
    open(emptyCircuit(2, 0))
    press('h')

    expect(
      screen.getByRole('button', { name: 'H' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'X' }).getAttribute('aria-pressed')
    ).toBe('false')
  })

  /*
   * Twenty-six chips, one tab stop. Arming a gate has to move that stop onto
   * it, or Tab lands on a chip the user has no reason to expect.
   */
  it('keeps one tab stop and moves it to the gate that was armed', () => {
    open(emptyCircuit(2, 0))
    const chips = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('data-gate'))
    expect(chips.filter((chip) => chip.tabIndex === 0)).toHaveLength(1)

    press('c')
    const tabbable = chips.filter((chip) => chip.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.getAttribute('data-gate')).toBe('cx')
  })

  it('publishes each gate’s key so it is not a secret', () => {
    open(emptyCircuit(2, 0))
    expect(
      screen
        .getByRole('button', { name: 'CNOT' })
        .getAttribute('aria-keyshortcuts')
    ).toBe('c')
  })

  it('groups the gates by arity, in all three languages', () => {
    const { view } = open(emptyCircuit(2, 0), 'fr')
    expect(within(view.container).getByText('Deux qubits')).toBeDefined()
    cleanup()

    const spanish = open(emptyCircuit(2, 0), 'es')
    expect(within(spanish.view.container).getByText('Dos qubits')).toBeDefined()
  })
})

/*
 * The editor is the only thing that mounts the simulation. Deleting the panel
 * would not fail a single test in `features/simulation` — every one of them
 * drives the hook or the scheduler directly — and the app would go back to
 * building circuits it never simulates. So the join is asserted here, where
 * the mounting actually happens.
 */
describe('the simulation is reachable from the editor', () => {
  it('renders the simulation panel beside the circuit', () => {
    open(emptyCircuit(2, 0))

    expect(
      screen.getByRole('heading', { name: enSimulation.panel.heading })
    ).toBeDefined()
  })

  it('reports a browser that cannot start a worker instead of pretending', () => {
    const { view } = open(emptyCircuit(2, 0))

    // jsdom has no `Worker`, which is the same situation as a browser that
    // refuses one: the failure stays on screen rather than being replaced by
    // a `running` that no thread will ever answer.
    expect(
      view.container.querySelector('.simulation-panel__failure')?.textContent
    ).toBe(enSimulation.errors['worker-unavailable'])
    expect(
      within(view.container).getByText(enSimulation.panel.state.error)
    ).toBeDefined()
  })
})

/**
 * The join M0.8 adds. The scrubber's own behaviour is tested against the hook
 * in `TimelineScrubber.test.tsx`; what is asserted here is the wiring, because
 * the position it holds is read by three components that are siblings and a
 * timeline nobody was listening to would look exactly like a working one.
 */
describe('the timeline is wired to the canvas', () => {
  function bar(): HTMLInputElement {
    return screen.getByRole('slider', { name: enEditor.timeline.position })
  }

  it('appears once there is a column to walk', () => {
    const { view } = open(emptyCircuit(2, 0))

    // An empty circuit has no time in it, and a bar with one stop is a
    // control that cannot do anything.
    expect(
      screen.queryByRole('slider', { name: enEditor.timeline.position })
    ).toBeNull()

    press('h')
    press('Enter')

    expect(bar().max).toBe('1')
    expect(view.container.querySelector('.circuit-canvas__cut')).toBeNull()
  })

  /** H in every column from 0 to `columns - 1`, on the top wire. */
  function fill(columns: number): void {
    press('h')
    for (let column = 0; column < columns; column++) {
      if (column > 0) press('ArrowRight')
      press('Enter')
    }
  }

  it('moves the playhead on the canvas with the bar', () => {
    const { view } = open(emptyCircuit(2, 0))
    fill(2)

    fireEvent.change(bar(), { target: { value: '1' } })

    // Two columns, three stops, and the bar on the middle one: the state
    // after column 0. The canvas has to agree, because the reader is looking
    // at both at once.
    expect(bar().max).toBe('2')
    expect(bar().getAttribute('aria-valuetext')).toBe(
      enEditor.timeline.at.column.replace('{{column}}', '0')
    )
    expect(
      view.container.querySelector('.circuit-canvas__moment')
    ).not.toBeNull()
  })

  it('is clamped, not reset, by an edit that shortens the circuit', () => {
    const { view } = open(emptyCircuit(2, 0))
    fill(3)
    fireEvent.change(bar(), { target: { value: '1' } })

    // Deleting the gate in the last column — the cursor is standing on it —
    // leaves the parked position reachable, so it stays exactly where the
    // reader left it. That is the whole point of parking there: to watch one
    // column's state change as the circuit around it is edited. A reset would
    // throw the reader back to the end after every keystroke.
    press('Delete')

    expect(bar().max).toBe('2')
    expect(bar().getAttribute('aria-valuetext')).toBe(
      enEditor.timeline.at.column.replace('{{column}}', '0')
    )
    expect(
      view.container.querySelector('.circuit-canvas__moment')
    ).not.toBeNull()
  })

  it('goes back to the end when a whole new document is opened', () => {
    /*
     * The other half of the rule above, and the one that was missing. An
     * *edit* keeps the position because undo brings the circuit and the
     * position back together. Opening a document — a preset chip, and later
     * `/c/:slug` — has no such pairing: `loadCircuit` clears the history on
     * purpose. A retained position meant clicking "Bell" while parked after
     * column 0 drew |00⟩ and |01⟩ at half each, the un-entangled picture that
     * example exists to be contrasted with, beside a live region announcing
     * that the two qubits are entangled.
     */
    const { store, view } = open(emptyCircuit(2, 0))
    fill(3)
    fireEvent.change(bar(), { target: { value: '1' } })
    expect(
      view.container.querySelector('.circuit-canvas__moment')
    ).not.toBeNull()

    act(() => {
      store.getState().loadCircuit(bell())
    })

    // At the end of the new circuit: nothing held back, no playhead drawn.
    expect(bar().value).toBe(bar().max)
    expect(bar().getAttribute('aria-valuetext')).toBe(enEditor.timeline.at.end)
    expect(view.container.querySelector('.circuit-canvas__moment')).toBeNull()
    expect(view.container.querySelector('.circuit-canvas__cut')).toBeNull()
  })

  it('keeps the position when the same document is merely edited', () => {
    // The guard on the fix above: a document counter that ticked on every
    // edit would undo §3.1's frozen decision 2 entirely.
    const { view } = open(emptyCircuit(2, 0))
    fill(3)
    fireEvent.change(bar(), { target: { value: '1' } })

    press('ArrowDown')
    press('h')
    press('Enter')

    expect(bar().getAttribute('aria-valuetext')).toBe(
      enEditor.timeline.at.column.replace('{{column}}', '0')
    )
    expect(
      view.container.querySelector('.circuit-canvas__moment')
    ).not.toBeNull()
  })
})

/*
 * The defect this block exists for: the editor could grow the quantum
 * register and offered no way to grow the classical one, so every wire added
 * past the register was permanently unmeasurable — and the refusal named a
 * fix that did not exist anywhere in the UI.
 */
describe('the classical register is reachable from the gutter', () => {
  function register(): HTMLElement {
    return screen.getByRole('rowheader', { name: /classical register/ })
  }

  it('lets a wire added past the register still be measured', () => {
    const { store, view } = open(emptyCircuit(3, 3))

    fireEvent.click(
      screen.getByRole('button', { name: 'Insert a qubit below q2' })
    )
    expect(register().textContent).toContain('4 bits')

    type(['ArrowDown', 'ArrowDown', 'ArrowDown'])
    press('m')
    press('Enter')

    expect(store.getState().circuit.operations).toEqual([
      {
        id: 'op_1',
        gate: 'measure',
        targets: [3],
        clbitTargets: [3],
        column: 0,
      },
    ])
    // The placement reports itself: see the live-region block below for why
    // an empty status line here was a defect rather than a nicety.
    expect(status(view.container)).toBe('M placed on q3, column 0.')
  })

  it('adds and removes a classical bit on demand', () => {
    const { store } = open(emptyCircuit(2, 1))

    fireEvent.click(screen.getByRole('button', { name: 'Add a classical bit' }))
    expect(store.getState().circuit.clbits).toBe(2)
    expect(register().textContent).toContain('2 bits')

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove the last classical bit' })
    )
    expect(store.getState().circuit.clbits).toBe(1)
    // The floor: the row that carries the add control is drawn only while
    // the register has width, so the remove control retires at one bit.
    expect(
      screen.queryByRole('button', { name: 'Remove the last classical bit' })
    ).toBeNull()
  })

  it('removing a bit takes the measurement written into it, and nothing else', () => {
    const { store } = open(emptyCircuit(2, 2))

    press('m')
    press('Enter')
    type(['ArrowDown'])
    press('m')
    press('Enter')
    expect(store.getState().circuit.operations).toHaveLength(2)

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove the last classical bit' })
    )

    // The same cascade `removeQubit` performs on a wire, from the end of the
    // register so its effect is predictable from the canvas.
    expect(store.getState().circuit.operations).toEqual([
      {
        id: 'op_1',
        gate: 'measure',
        targets: [0],
        clbitTargets: [0],
        column: 0,
      },
    ])
  })

  it('names the register controls in Spanish', () => {
    open(emptyCircuit(2, 2), 'es')
    expect(
      screen.getByRole('button', { name: 'Añadir un bit clásico' })
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Eliminar el último bit clásico' })
    ).toBeDefined()
  })
})

/*
 * The register can be edited while a multi-qubit gate is half-placed, and the
 * picks it is holding are wire indices. Left alone they mean a different wire
 * after every insertion or deletion, so the gate landed somewhere the user
 * never pointed at and the claimed-wire highlight lied while it waited.
 *
 * Either the placement follows its wire or it ends and says so. Landing
 * silently on another qubit is the one outcome that is not allowed.
 */
describe('a half-finished placement when the register changes', () => {
  const CANCELLED =
    'The half-placed gate was cancelled: the wire it was on has changed.'

  function claimedRows(): number[] {
    return screen
      .getAllByRole('row')
      .slice(1)
      .flatMap((row, qubit) =>
        within(row)
          .getAllByRole('gridcell')[0]
          ?.classList.contains('circuit-canvas__cell--claimed')
          ? [qubit]
          : []
      )
  }

  it('follows its wire down when a qubit is inserted above it', () => {
    const { store } = open(emptyCircuit(3, 0))

    press('c')
    press('ArrowDown')
    press('Enter') // the CNOT's target is anchored on q1, column 0
    expect(claimedRows()).toEqual([1])

    fireEvent.click(
      screen.getByRole('button', { name: 'Insert a qubit below q0' })
    )
    // The wire the user anchored to is q2 now, and the highlight says so.
    expect(claimedRows()).toEqual([2])

    press('ArrowUp')
    press('Enter') // the control, on q0

    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'cx', targets: [2], controls: [0], column: 0 },
    ])
  })

  it('follows its wire up when a qubit below it is removed', () => {
    const { store, view } = open(emptyCircuit(3, 0))

    press('c')
    type(['ArrowDown', 'ArrowDown'])
    press('Enter') // anchored on q2

    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit q0' }))
    expect(claimedRows()).toEqual([1])
    // Nothing surprising happened: the gate is still on the wire it was put
    // on, so the live region is left for the prompt.
    expect(status(view.container)).not.toBe(CANCELLED)

    press('ArrowUp')
    press('Enter')

    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'cx', targets: [1], controls: [0], column: 0 },
    ])
  })

  it('is cancelled, and says so, when its own wire is deleted', () => {
    const { store, view } = open(emptyCircuit(3, 0))

    press('c')
    press('ArrowDown')
    press('Enter') // anchored on q1

    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit q1' }))

    expect(status(view.container)).toBe(CANCELLED)
    expect(claimedRows()).toEqual([])

    // The gate is still armed, so re-anchoring costs one Enter — and the
    // Enter that re-anchors must not complete the placement that is gone.
    expect(
      screen.getByRole('button', { name: 'CNOT' }).getAttribute('aria-pressed')
    ).toBe('true')
    press('Enter')
    expect(store.getState().circuit.operations).toEqual([])
    // Re-anchored where the cursor stands, which is the wire that took the
    // deleted one's place — a fresh first pick, not the old one resurrected.
    expect(claimedRows()).toEqual([1])
  })

  it('is cancelled by an undo, which has no wire to follow', () => {
    const { store, view } = open(emptyCircuit(3, 0))

    press('h')
    press('Enter')
    press('c')
    press('ArrowDown')
    press('Enter') // anchored on q1, with a gate in the history

    press('z', { ctrlKey: true })

    expect(store.getState().circuit.operations).toEqual([])
    expect(status(view.container)).toBe(CANCELLED)
    expect(claimedRows()).toEqual([])
  })

  it('is cancelled by the toolbar’s undo as well as by the chord', () => {
    const { view } = open(emptyCircuit(3, 0))

    press('h')
    press('Enter')
    press('c')
    press('ArrowDown')
    press('Enter')

    fireEvent.click(
      within(screen.getByRole('toolbar')).getByRole('button', { name: 'Undo' })
    )

    expect(status(view.container)).toBe(CANCELLED)
    expect(claimedRows()).toEqual([])
  })

  it('survives an undo that had nothing to undo', () => {
    const { store, view } = open(emptyCircuit(3, 0))

    press('c')
    press('ArrowDown')
    press('Enter')

    press('z', { ctrlKey: true }) // empty history: the document is untouched

    expect(status(view.container)).not.toBe(CANCELLED)
    expect(claimedRows()).toEqual([1])
    press('ArrowUp')
    press('Enter')
    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'cx', targets: [1], controls: [0], column: 0 },
    ])
  })

  it('reports the cancellation in the active language', () => {
    const { view } = open(emptyCircuit(3, 0), 'fr')

    press('c')
    press('ArrowDown')
    press('Enter')
    fireEvent.click(
      screen.getByRole('button', { name: 'Supprimer le qubit q1' })
    )

    expect(status(view.container)).toBe(
      `La porte en cours de placement a été annulée${NBSP}: le qubit sur lequel elle se trouvait a changé.`
    )
  })
})

/*
 * The other half of "one gesture, one undo step": the store groups it, but
 * only if the editor tells it where the gesture starts and stops. Untreated,
 * a single drag of the angle slider cost dozens of undo presses and a few of
 * them pushed every real edit out of the hundred-step history.
 */
describe('turning an angle is one step of history', () => {
  function angleSlider(): HTMLElement {
    return screen.getByRole('slider', { name: 'Angle slider' })
  }

  it('spends one step on a drag, whatever it passed through', () => {
    const { store } = open(emptyCircuit(2, 0))
    press('6') // Rz, which is the palette's parametrised rotation
    press('Enter')
    const depth = historyDepth(store)

    const slider = angleSlider()
    fireEvent.pointerDown(slider)
    for (let stop = 1; stop <= 12; stop++) {
      fireEvent.change(slider, { target: { value: String(stop) } })
    }
    fireEvent.pointerUp(slider)

    expect(historyDepth(store)).toBe(depth + 1)
    // The intermediate values were applied all along — the panel followed
    // the drag — but none of them is a place undo can land.
    press('z', { ctrlKey: true })
    expect(store.getState().circuit.operations[0]?.params).toEqual([0])
  })

  it('spends one step on each arrow press, so the keyboard still steps', () => {
    const { store } = open(emptyCircuit(2, 0))
    press('6')
    press('Enter')
    const depth = historyDepth(store)

    const slider = angleSlider()
    for (let stop = 1; stop <= 3; stop++) {
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      fireEvent.change(slider, { target: { value: String(stop) } })
      fireEvent.keyUp(slider, { key: 'ArrowRight' })
    }

    expect(historyDepth(store)).toBe(depth + 3)
  })

  it('spends one step on a number typed into the field', () => {
    const { store } = open(emptyCircuit(2, 0))
    press('6')
    press('Enter')
    const depth = historyDepth(store)

    const field = screen.getByRole('textbox', { name: 'Angle in radians' })
    for (const text of ['1', '1.5', '1.57']) {
      fireEvent.change(field, { target: { value: text } })
    }
    fireEvent.blur(field)

    expect(historyDepth(store)).toBe(depth + 1)
    press('z', { ctrlKey: true })
    expect(store.getState().circuit.operations[0]?.params).toEqual([0])
  })
})

/*
 * The live region used to speak only when it was saying no. Placing a gate,
 * deleting one, undoing and redoing were all silent, so a user who cannot see
 * the canvas had no confirmation that anything had happened — and undo was
 * the worst of them, because "that was undone" and "there was nothing left to
 * undo" leave exactly the same canvas behind.
 *
 * What is asserted here is the sentence, in the terms of the circuit: which
 * gate, which wires, which column. What is asserted just as deliberately is
 * the silence: an arrow key changes nothing and must say nothing, or the
 * region turns into a stream of coordinates nobody can listen through.
 */
describe('the live region says what happened', () => {
  function toolbarButton(name: string): HTMLElement {
    return within(screen.getByRole('toolbar')).getByRole('button', { name })
  }

  it('names the gate, the wire and the column of a placement', () => {
    const { view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')

    expect(status(view.container)).toBe('H placed on q0, column 0.')
  })

  it('names every wire a multi-qubit gate landed on', () => {
    const { view } = open(emptyCircuit(3, 0))

    press('c')
    type(['ArrowDown', 'ArrowRight'])
    press('Enter')
    press('ArrowUp')
    press('Enter')

    // Both wires, in canvas order rather than in the order they were picked,
    // and joined the way English joins a list.
    expect(status(view.container)).toBe('CNOT placed on q0 and q1, column 1.')
  })

  it('says nothing at all when the cursor merely moves', () => {
    const { view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    expect(status(view.container)).not.toBe('')

    press('ArrowRight')

    expect(status(view.container)).toBe('')
  })

  it('reports a deletion, naming what was removed', () => {
    const { view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    press('Delete')

    expect(status(view.container)).toBe('H removed from q0, column 0.')
  })

  it('tells an undo that consumed a step from one that did not', () => {
    const { view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')

    press('z', { ctrlKey: true })
    expect(status(view.container)).toBe('Undone.')

    // The same canvas either way, so the sentence is the only difference the
    // user has to go on.
    press('z', { ctrlKey: true })
    expect(status(view.container)).toBe('There is nothing left to undo.')

    press('y', { ctrlKey: true })
    expect(status(view.container)).toBe('Redone.')
  })

  /*
   * Repeating a message verbatim is silence: React leaves a text node it
   * would rewrite with the same string alone, no mutation record reaches the
   * screen reader, and the second undo announces nothing. The sentence is
   * therefore rendered inside a node keyed by a sequence number, and this is
   * the test that the node really is replaced.
   */
  it('announces a second identical report as a change of its own', () => {
    const { view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter')
    press('ArrowRight')
    press('x')
    press('Enter')

    const region = view.container.querySelector('.circuit-editor__status')
    expect(region).not.toBeNull()
    const observer = new MutationObserver(() => undefined)
    observer.observe(region!, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    press('z', { ctrlKey: true })
    expect(status(view.container)).toBe('Undone.')
    expect(observer.takeRecords().length).toBeGreaterThan(0)

    press('z', { ctrlKey: true })
    expect(status(view.container)).toBe('Undone.')
    expect(
      observer.takeRecords().length,
      'the second undo rendered the same sentence and must still mutate'
    ).toBeGreaterThan(0)

    observer.disconnect()
  })

  it('answers the toolbar with the same sentences as the chords', () => {
    const { view } = open(emptyCircuit(2, 0))

    press('h')
    press('Enter') // placing selects nothing; Enter again selects the gate
    press('Enter')

    fireEvent.click(toolbarButton('Copy'))
    expect(status(view.container)).toBe('1 gate copied.')

    fireEvent.click(toolbarButton('Undo'))
    expect(status(view.container)).toBe('Undone.')

    // Closing gaps that are not there is not a refusal, and it is not
    // nothing either: a button that answers with silence reads as broken.
    fireEvent.click(toolbarButton('Close gaps'))
    expect(status(view.container)).toBe('There were no gaps to close.')
  })

  it('reports the register edits made from the gutter', () => {
    const { view } = open(emptyCircuit(3, 3))

    fireEvent.click(
      screen.getByRole('button', { name: 'Insert a qubit below q2' })
    )
    expect(status(view.container)).toBe('Qubit q3 added.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit q0' }))
    expect(status(view.container)).toBe('Wire q0 removed.')

    fireEvent.click(screen.getByRole('button', { name: 'Add a classical bit' }))
    expect(status(view.container)).toBe('Classical bit c4 added.')
  })
})

describe('decision D2 reaches the editor’s own messages', () => {
  it('reports a refusal in the active language', () => {
    const { view } = open(emptyCircuit(2, 0), 'fr')
    press('h')
    press('Enter')
    press('x')
    press('Enter')
    expect(status(view.container)).toBe(
      'Une autre porte occupe déjà cette case.'
    )
  })

  it('asks for the missing wire in the active language, keeping the symbol', () => {
    const { view } = open(emptyCircuit(3, 0), 'es')
    press('c')
    press('Enter')
    expect(status(view.container)).toContain('CNOT')
    expect(status(view.container)).toContain(
      'necesita su qubit de control en esta columna'
    )
  })

  it('reports what happened in the active language, keeping the symbol', () => {
    const { view } = open(emptyCircuit(3, 0), 'fr')

    press('h')
    press('Enter')

    // `H` is notation and reads the same everywhere; the sentence around it
    // is French, down to the list conjunction.
    expect(status(view.container)).toBe('H placée sur q0, colonne 0.')

    press('c')
    press('ArrowRight')
    press('Enter')
    press('ArrowDown')
    press('Enter')
    expect(status(view.container)).toBe('CNOT placée sur q0 et q1, colonne 1.')

    press('z', { ctrlKey: true })
    expect(status(view.container)).toBe('Action annulée.')
    press('z', { ctrlKey: true })
    press('z', { ctrlKey: true })
    expect(status(view.container)).toBe('Il n’y a plus rien à annuler.')
  })

  it('counts in the language’s own plural, singular included', () => {
    const spanish = open(emptyCircuit(2, 0), 'es')

    press('h')
    press('Enter')
    press('Enter') // selects the gate under the cursor
    press('c', { ctrlKey: true })

    expect(status(spanish.view.container)).toBe('1 compuerta copiada.')
  })
})

/*
 * The classical register is a row of the ARIA grid, and the grid pattern
 * navigates every row. It used to be the one row the cursor could not reach:
 * `stepCell` clamped to the qubits, so a sighted keyboard user could never
 * put the cursor on the row that records where a measurement landed, and a
 * screen-reader user arrowing the grid heard the row header and then nothing.
 */
describe('the classical register row of the grid', () => {
  function registerCells(): HTMLElement[] {
    const rows = screen.getAllByRole('row')
    return within(rows[rows.length - 1]!).getAllByRole('gridcell')
  }

  it('takes the cursor, and refuses to be edited out loud', () => {
    const { store, view } = open(emptyCircuit(2, 2))

    press('m')
    press('Enter')
    expect(store.getState().circuit.operations).toHaveLength(1)

    type(['ArrowDown', 'ArrowDown']) // q0 → q1 → the register
    const cells = registerCells()
    expect(cells[0]!.getAttribute('tabindex')).toBe('0')
    expect(cells[0]!.className).toContain('circuit-canvas__cell--cursor')

    // Answering is the point: a key that is silent on one row of a grid and
    // active on every other reads as a fault rather than as a rule.
    press('Enter')
    expect(status(view.container)).toBe(enEditor.placement['classical-row'])

    // And Delete must not fall through to emptying the selection, which is
    // where the measurement placed above would have gone.
    press('Delete')
    expect(status(view.container)).toBe(enEditor.placement['classical-row'])
    expect(store.getState().circuit.operations).toHaveLength(1)
  })

  it('names an empty slot and lets a recorded one speak for itself', () => {
    open(emptyCircuit(2, 2))

    press('m')
    press('Enter')

    const cells = registerCells()
    // The cell that records the measurement is described by its contents; an
    // `aria-label` beside them would silence exactly that description.
    expect(cells[0]!.getAttribute('aria-label')).toBeNull()
    expect(cells[0]!.textContent).toContain('c0')
    expect(cells[1]!.getAttribute('aria-label')).toBe(
      enEditor.canvas.cell.empty
    )
  })

  it('counts its bits with the plural each language uses', () => {
    open(emptyCircuit(2, 1))
    expect(
      screen.getByRole('rowheader', { name: /classical register, 1 bit$/ })
    ).toBeDefined()

    cleanup()
    open(emptyCircuit(2, 3))
    expect(
      screen.getByRole('rowheader', { name: /classical register, 3 bits$/ })
    ).toBeDefined()
  })
})

/*
 * Two ways the gutter used to leave a user stranded: a wire removed without a
 * word about the gates that went with it, and a row control that destroyed
 * the element holding focus, dropping it to `<body>` — outside the element
 * the key handler is bound to, so every shortcut went dead (WCAG 2.4.3).
 */
describe('removing a wire', () => {
  it('reports the gates the cascade took with it', () => {
    const { view } = open(emptyCircuit(3, 0))

    press('c')
    press('ArrowDown')
    press('Enter')
    press('ArrowUp')
    press('Enter') // a CNOT across q0 and q1

    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit q0' }))
    // The CNOT mostly lived on q1, a row the user was not looking at.
    expect(status(view.container)).toBe('Wire q0 removed, along with 1 gate.')
  })

  it('says only what happened when the wire was empty', () => {
    const { view } = open(emptyCircuit(3, 0))

    fireEvent.click(screen.getByRole('button', { name: 'Remove qubit q2' }))
    expect(status(view.container)).toBe('Wire q2 removed.')
  })

  it('hands focus to the row that took its place', () => {
    open(emptyCircuit(3, 0))

    const bottom = screen.getByRole('button', { name: 'Remove qubit q2' })
    bottom.focus()
    fireEvent.click(bottom)

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Remove qubit q1' })
    )
  })

  it('does the same for a wire removed from the middle', () => {
    open(emptyCircuit(3, 0))

    const middle = screen.getByRole('button', { name: 'Remove qubit q1' })
    middle.focus()
    fireEvent.click(middle)

    // The wires renumber, so index 1 is now the wire that was q2.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Remove qubit q1' })
    )
  })
})

/*
 * Two things a cell description got wrong at once in Spanish: "objetivo
 * controlada" mismatched the gender of the noun it follows, and every
 * language enumerated its control wires with a hard-coded comma where prose
 * uses a conjunction.
 */
describe('what a controlled cell is called', () => {
  function targetCell(): HTMLElement {
    return cellAt(0, 0)
  }

  function buildToffoli(): void {
    press('o') // CCX
    press('Enter') // target on q0
    press('ArrowDown')
    press('Enter') // first control on q1
    press('ArrowDown')
    press('Enter') // second control on q2
  }

  it('agrees in gender and joins the wires the way Spanish does', () => {
    open(emptyCircuit(3, 0), 'es')
    buildToffoli()
    expect(targetCell().textContent).toContain('controlado por q1 y q2')
  })

  it('joins them the way English and French do', () => {
    open(emptyCircuit(3, 0))
    buildToffoli()
    expect(targetCell().textContent).toContain('controlled by q1 and q2')

    cleanup()
    open(emptyCircuit(3, 0), 'fr')
    buildToffoli()
    expect(targetCell().textContent).toContain('contrôlée par q1 et q2')
  })
})

/**
 * The two props a shared session drives (M5.6).
 *
 * The editor knows nothing about sessions and must not: `.dependency-cruiser.cjs`
 * keeps that arrow pointing one way, so what it exposes is a boolean and a
 * callback about a cell. Both are asserted here because the page that passes them
 * cannot: `routes/editor.test.tsx` proves the wiring end to end, and this proves
 * the two contracts it depends on — that read-only really disables the controls
 * that write, and that a cursor is reported once per movement rather than once per
 * render.
 */
describe('the editor answers a shared session', () => {
  function openWith(props: {
    readOnly?: boolean
    onCursorMove?: (cell: Cell) => void
  }) {
    const store = createCircuitStore(emptyCircuit(2, 0))
    const view = render(
      <I18nextProvider i18n={i18nFor('en')}>
        <CircuitEditor store={store} {...props} />
      </I18nextProvider>
    )
    return { store, view }
  }

  it('disables every control that writes when told it may only watch', () => {
    openWith({ readOnly: true })

    for (const label of [
      enEditor.toolbar.undo,
      enEditor.toolbar.redo,
      enEditor.toolbar.compact,
    ]) {
      expect(screen.getByRole('button', { name: label })).toHaveProperty(
        'disabled',
        true
      )
    }
    // The packaging panel is hidden rather than disabled, exactly as it is on a
    // compact viewport — the other reason this flag can be true.
    expect(screen.queryByText(enEditor.customGates.title)).toBe(null)
  })

  it('leaves them alone by default, which is the editor that shipped', () => {
    openWith({})

    expect(
      screen.getByRole('button', { name: enEditor.toolbar.undo })
    ).toHaveProperty('disabled', false)
  })

  it('reports the cursor once when it moves, and not on every render', () => {
    const seen: Cell[] = []
    const { store } = openWith({
      onCursorMove: (cell) => {
        seen.push(cell)
      },
    })

    // Once on mount: a peer that waited for its first movement would be drawn
    // nowhere on everybody else's screen until its next heartbeat.
    expect(seen).toEqual([{ qubit: 0, column: 0 }])

    press('ArrowRight')
    expect(seen.at(-1)).toEqual({ qubit: 0, column: 1 })
    const afterMove = seen.length

    /*
     * A commit that does not move the cursor produces no report. This is the
     * property the ref in `CircuitEditor` exists for: the store change re-renders
     * this component, and a naive effect would have sent a frame for it.
     */
    act(() => {
      store.getState().addClbit()
    })
    expect(seen.length).toBe(afterMove)
  })
})
