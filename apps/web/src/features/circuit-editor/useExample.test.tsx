import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encode, readCircuitParam } from '../../lib/circuit-url'
import { PRESETS } from './presets'
import { createCircuitStore, type CircuitStore } from './useCircuitStore'
import { EXAMPLE_URL_PARAM, readExampleParam, useExample } from './useExample'

/**
 * The landing page's route into the examples strip (M0.9b).
 *
 * Two rules carry everything here. A shared `?c=` circuit is somebody's work
 * and always wins; `?example=` is a starting point and quietly does nothing
 * when it names something this build has never heard of — a stale link should
 * open the editor, not an error page.
 */

function presetCircuit(id: string) {
  const preset = PRESETS.find((candidate) => candidate.id === id)
  if (preset === undefined) throw new Error(`no ${id} preset`)
  return preset.circuit
}

/** Puts the page at `/new` with the given query, without adding history. */
function openAt(search: string): void {
  window.history.replaceState(null, '', `/new${search}`)
}

function Probe({ store }: { store: CircuitStore }) {
  useExample({ store })
  return null
}

let store: CircuitStore

beforeEach(() => {
  store = createCircuitStore()
})

afterEach(() => {
  cleanup()
  openAt('')
})

describe('reading the example parameter', () => {
  it('finds it and ignores everything else', () => {
    expect(readExampleParam('?example=ghz')).toBe('ghz')
    expect(readExampleParam('?c=abc')).toBeNull()
    expect(readExampleParam('')).toBeNull()
  })
})

describe('opening the editor on an example', () => {
  it('loads the circuit the parameter names', () => {
    openAt('?example=bell')

    render(<Probe store={store} />)

    expect(store.getState().circuit.operations).toEqual(
      presetCircuit('bell').operations
    )
  })

  /*
   * The parameter has done its job once the circuit is on screen, and leaving
   * it would put two answers to one question in the same URL as soon as
   * `useCircuitUrl` writes the real `?c=` payload.
   */
  it('takes the spent parameter out of the address bar', () => {
    openAt('?example=ghz')

    render(<Probe store={store} />)

    expect(window.location.search).not.toContain(EXAMPLE_URL_PARAM)
    expect(store.getState().circuit.qubits).toBe(presetCircuit('ghz').qubits)
  })

  it('leaves a shared circuit alone', () => {
    // `useCircuitUrl` is what loads this one; the point of the case is that
    // the example does not then overwrite it.
    const shared = encode(presetCircuit('interference'))
    openAt(`?c=${shared}&example=bell`)
    store.getState().loadCircuit(presetCircuit('interference'))

    render(<Probe store={store} />)

    expect(store.getState().circuit.operations).toEqual(
      presetCircuit('interference').operations
    )
    // The shared payload survives — it is the answer on screen…
    expect(readCircuitParam(window.location.search)).toBe(shared)
    // …and the example name does not, because it lost. Leaving it is the
    // accumulation this module exists to prevent: `?c=…&example=bell` is two
    // answers to one question, and every share link built from that address
    // would carry the loser along with the winner.
    expect(window.location.search).not.toContain(EXAMPLE_URL_PARAM)
  })

  it('does nothing at all for a name it does not know', () => {
    openAt('?example=grover')
    const before = store.getState().circuit

    render(<Probe store={store} />)

    expect(store.getState().circuit).toBe(before)
    /*
     * And the spent name goes too. It was kept once, so that a reader who
     * mistyped could see what they had asked for — but nothing on screen says
     * anything about it either way, and the parameter is not transient: the
     * first edit makes `useCircuitUrl` write `?c=` *beside* it, and from then
     * on every link the reader copies carries a preset name that means nothing
     * and outranks nothing. A name is spent the moment it is read, whether or
     * not it named anything.
     */
    expect(window.location.search).not.toContain('grover')
  })

  it('does nothing when there is no parameter', () => {
    openAt('')
    const before = store.getState().circuit

    render(<Probe store={store} />)

    expect(store.getState().circuit).toBe(before)
  })

  /*
   * Strict mode double-invokes effects, and this one writes to the document.
   * Loading twice would be harmless; the guard exists so that a second run
   * cannot land after the reader's first edit.
   */
  it('loads once however many times the effect runs', () => {
    openAt('?example=bell')
    const { rerender } = render(<Probe store={store} />)

    const loaded = store.getState().circuit
    rerender(<Probe store={store} />)

    expect(store.getState().circuit).toBe(loaded)
  })
})
