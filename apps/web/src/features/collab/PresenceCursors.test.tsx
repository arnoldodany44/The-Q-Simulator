import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PresenceState } from '@qsim/contract'

import enCollab from '../../i18n/locales/en/collab.json'
import enEditor from '../../i18n/locales/en/editor.json'
import { collaboratorHue } from '../../lib/collab-colour'
import { CircuitCanvas } from '../circuit-editor/CircuitCanvas'
import { DEFAULT_METRICS, cellBounds } from '../circuit-editor/geometry'
import { PresenceCursors } from './PresenceCursors'
import { createPresenceStore, type PresenceStore } from './presence'

/**
 * The visual half of presence, and the two claims about it that are not visual.
 *
 * FIRST, IT IS HIDDEN FROM ASSISTIVE TECHNOLOGY. The plot is `aria-hidden` and
 * paired with a described ARIA grid; a layer of carets over it is more of the same
 * pixels, and announcing a coordinate every time somebody moved would be worse than
 * silence. The sentences live in `PresenceRoster`.
 *
 * SECOND, IT DOES NOT RE-RENDER THE GRID. A cursor moves eight times a second and
 * the grid is up to two thousand droppables; a presence that re-rendered its parent
 * would make the editor slower for the person who is trying to type. The layer
 * subscribes to the store itself, so the test below counts renders of the component
 * that *owns* the canvas and asserts the count does not move.
 */

const circuit: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-h', gate: 'h', targets: [0], column: 0 },
    { id: 'op-cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

function i18nInstance(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['collab', 'editor'],
    defaultNS: 'collab',
    resources: { en: { collab: enCollab, editor: enEditor } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function state(overrides: Partial<PresenceState> = {}): PresenceState {
  return {
    name: 'Ada',
    access: 'write',
    cursor: { qubit: 1, column: 3 },
    selection: [],
    edits: 0,
    ...overrides,
  }
}

/**
 * How many times the component that owns the canvas has been committed.
 *
 * Counted in an effect and held at module scope, which is not squeamishness: a
 * `useRef` bumped during render is what `react-hooks/refs` forbids and a mutated
 * prop is what `react-hooks/immutability` forbids, and both are forbidding the
 * right thing. An effect with no dependency array runs after every commit of
 * *this* component and after none of anybody else's, which is precisely the
 * question being asked.
 */
let ownerCommits = 0

function Harness({ store }: { store: PresenceStore }) {
  useEffect(() => {
    ownerCommits += 1
  })
  return (
    <CircuitCanvas
      circuit={circuit}
      readOnly
      readOnlyNotice={null}
      overlay={<PresenceCursors store={store} circuit={circuit} />}
    />
  )
}

function mount(store: PresenceStore) {
  return render(
    <I18nextProvider i18n={i18nInstance()}>
      <Harness store={store} />
    </I18nextProvider>
  )
}

function layer(): HTMLElement | null {
  return document.querySelector('.presence-layer')
}

afterEach(cleanup)

describe('a solo session', () => {
  it('draws no layer at all', () => {
    const store = createPresenceStore()
    mount(store)
    expect(layer()).toBeNull()
  })
})

describe('somebody else’s caret', () => {
  it('is drawn on their cell, in their colour, with their name', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })

    const mark = document.querySelector('.presence-mark--cursor')
    expect(mark).not.toBeNull()
    const bounds = cellBounds({ qubit: 1, column: 3 }, DEFAULT_METRICS)
    const style = (mark as HTMLElement).style
    expect(style.left).toBe(`${bounds.x}px`)
    expect(style.top).toBe(`${bounds.y}px`)
    expect(style.getPropertyValue('--collab-hue')).toBe(
      String(collaboratorHue('p1'))
    )
    expect(mark?.textContent).toBe('Ada')
  })

  it('is hidden from assistive technology, layer and all', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })

    expect(layer()?.getAttribute('aria-hidden')).toBe('true')
    // And the name inside it is therefore not part of any accessible name: the
    // roster is where a listener learns that Ada is here.
    expect(
      screen.queryByText('Ada', { ignore: '[aria-hidden="true"] *' })
    ).toBeNull()
  })

  it('marks a watcher differently from an editor', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ access: 'read' }), 1_000)
    })
    expect(document.querySelector('.presence-mark--reader')).not.toBeNull()
  })

  it('outlines both wires of a gate they are holding', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ selection: ['op-cx'] }), 1_000)
    })
    expect(document.querySelectorAll('.presence-mark--selection')).toHaveLength(
      2
    )
  })

  it('says nothing about a cell this tab cannot draw', () => {
    // The peer has already added a wire this document has not got yet.
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ cursor: { qubit: 7, column: 0 } }), 1_000)
    })
    expect(document.querySelector('.presence-mark--cursor')).toBeNull()
  })

  it('is gone the moment the peer is', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })
    act(() => {
      store.receive('p1', null, 1_100)
    })
    expect(layer()).toBeNull()
  })
})

describe('what a moving cursor costs', () => {
  it('does not re-render the component that owns the canvas', () => {
    const store = createPresenceStore()
    mount(store)
    const before = ownerCommits

    act(() => {
      for (let step = 0; step < 24; step += 1) {
        // Round the eight columns this grid draws, three times over: what is
        // being counted is renders, not distinct cells.
        const column = step % 8
        store.receive(
          'p1',
          state({ cursor: { qubit: 0, column } }),
          1_000 + step
        )
      }
    })

    // Twenty-four movements, and the canvas's owner has not rendered once more —
    // so neither has the ARIA grid, which is where the two thousand cells are.
    expect(ownerCommits).toBe(before)
    expect(document.querySelector('.presence-mark--cursor')).not.toBeNull()
  })

  it('leaves the grid’s own markup untouched', () => {
    const store = createPresenceStore()
    mount(store)
    const grid = document.querySelector('.circuit-canvas__grid')
    const markup = grid?.innerHTML

    act(() => {
      store.receive('p1', state(), 1_000)
    })

    expect(document.querySelector('.circuit-canvas__grid')?.innerHTML).toBe(
      markup
    )
  })
})
