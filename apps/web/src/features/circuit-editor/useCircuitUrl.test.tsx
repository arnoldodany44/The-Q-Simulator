import { emptyCircuit, type Circuit } from '@qsim/schema'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CIRCUIT_URL_PARAM,
  encode,
  readCircuitParam,
} from '../../lib/circuit-url'
import { PRESETS } from './presets'
import { createCircuitStore, type CircuitStore } from './useCircuitStore'
import { useCircuitUrl, type CircuitUrlView } from './useCircuitUrl'

/**
 * The editor's half of decision D4: the address bar is the save file.
 *
 * Two properties matter more than everything else here and both are pinned
 * below. A shared link has to open the circuit it names — otherwise the whole
 * feature is decoration — and editing must never push a history entry, because
 * a Back button that walks backwards through somebody's own keystrokes is a
 * Back button they cannot use to leave.
 */

const DEBOUNCE = 20

function bellCircuit(): Circuit {
  const bell = PRESETS.find((preset) => preset.id === 'bell')
  if (bell === undefined) throw new Error('no Bell preset')
  return bell.circuit
}

/** Puts the page at `/new` with the given query, without adding history. */
function openAt(search: string): void {
  window.history.replaceState(null, '', `/new${search}`)
}

let view: CircuitUrlView | null = null

/**
 * A component that is nothing but the hook, so the hook can be driven the way
 * the editor drives it — real effects, real commit order, real store.
 *
 * The view is published from an effect rather than assigned during render:
 * writing to a module variable while rendering is a side effect in render,
 * and React is entitled to throw that render away. Effects flush inside
 * `act`, so `view` is current by the time any assertion reads it.
 */
function Probe({ store }: { store: CircuitStore }) {
  const current = useCircuitUrl({ store, debounceMs: DEBOUNCE })
  useEffect(() => {
    view = current
  }, [current])
  return null
}

function mount(store: CircuitStore) {
  return render(<Probe store={store} />)
}

beforeEach(() => {
  view = null
  vi.useFakeTimers()
  openAt('')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  openAt('')
})

describe('opening a link', () => {
  it('loads the circuit the payload carries', () => {
    const circuit = bellCircuit()
    openAt(`?${CIRCUIT_URL_PARAM}=${encode(circuit)}`)
    const store = createCircuitStore()

    mount(store)

    expect(store.getState().circuit).toEqual(circuit)
    expect(view?.rejected).toBeNull()
  })

  it('leaves no undo step behind the document it opened', () => {
    openAt(`?${CIRCUIT_URL_PARAM}=${encode(bellCircuit())}`)
    const store = createCircuitStore()

    mount(store)

    // Undoing past the start of a shared circuit would hand the reader a blank
    // canvas they never saw, and no way back to the link.
    expect(store.getState().undo()).toMatchObject({
      ok: false,
      reason: 'nothing-to-undo',
    })
  })

  it('keeps the document and reports the code when the payload is refused', () => {
    openAt(`?${CIRCUIT_URL_PARAM}=not%20base64`)
    const store = createCircuitStore()
    const before = store.getState().circuit

    mount(store)

    expect(store.getState().circuit).toBe(before)
    expect(view?.rejected).toBe('not-base64')
  })

  it('leaves a refused payload in the address bar', () => {
    // The evidence stays: a reload retries the same link, and the reader can
    // still see what they were sent.
    openAt(`?${CIRCUIT_URL_PARAM}=zzzz`)
    mount(createCircuitStore())
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE * 4)
    })
    expect(readCircuitParam(window.location.search)).toBe('zzzz')
  })

  it('says nothing about a page opened with no payload', () => {
    mount(createCircuitStore())
    expect(view?.rejected).toBeNull()
    expect(view?.link).toBeNull()
  })

  it('can be told to stop complaining', () => {
    openAt(`?${CIRCUIT_URL_PARAM}=zzzz`)
    mount(createCircuitStore())
    expect(view?.rejected).toBe('not-deflate')

    act(() => {
      view?.dismiss()
    })
    expect(view?.rejected).toBeNull()
  })
})

describe('writing the circuit back', () => {
  it('puts the edited circuit in the address bar', () => {
    const store = createCircuitStore(emptyCircuit(2, 0))
    mount(store)

    act(() => {
      store.getState().placeGate('h', [0], 0)
    })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE)
    })

    const param = readCircuitParam(window.location.search)
    expect(param).toBe(encode(store.getState().circuit))
  })

  it('replaces rather than pushes, so Back leaves the page', () => {
    const store = createCircuitStore(emptyCircuit(2, 0))
    mount(store)
    const depth = window.history.length

    for (const column of [0, 1, 2, 3]) {
      act(() => {
        store.getState().placeGate('h', [0], column)
      })
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE)
      })
    }

    expect(window.history.length).toBe(depth)
  })

  it('coalesces a burst of edits into one write', () => {
    const store = createCircuitStore(emptyCircuit(2, 0))
    const replace = vi.spyOn(window.history, 'replaceState')
    mount(store)

    for (const column of [0, 1, 2, 3, 4]) {
      act(() => {
        store.getState().placeGate('h', [0], column)
      })
      act(() => {
        // Less than the debounce: every edit restarts the timer.
        vi.advanceTimersByTime(DEBOUNCE / 4)
      })
    }
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE)
    })

    expect(replace).toHaveBeenCalledTimes(1)
    replace.mockRestore()
  })

  it('does not rewrite the payload the page was opened with', () => {
    const param = encode(bellCircuit())
    openAt(`?${CIRCUIT_URL_PARAM}=${param}`)
    const store = createCircuitStore()
    const replace = vi.spyOn(window.history, 'replaceState')

    mount(store)
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE * 4)
    })

    expect(replace).not.toHaveBeenCalled()
    expect(readCircuitParam(window.location.search)).toBe(param)
    replace.mockRestore()
  })

  it('drops the parameter when the last gate is deleted', () => {
    const store = createCircuitStore(emptyCircuit(2, 0))
    mount(store)

    act(() => {
      store.getState().placeGate('h', [0], 0)
    })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE)
    })
    expect(readCircuitParam(window.location.search)).not.toBeNull()

    act(() => {
      const [operation] = store.getState().circuit.operations
      store.getState().removeOperation(operation!.id)
    })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE)
    })

    // `/new` is the address of a blank editor. Encoding emptiness would make a
    // fresh page look like a shared one.
    expect(readCircuitParam(window.location.search)).toBeNull()
  })

  it('keeps the rest of the query string', () => {
    openAt('?ref=classroom')
    const store = createCircuitStore(emptyCircuit(2, 0))
    mount(store)

    act(() => {
      store.getState().placeGate('h', [0], 0)
    })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE)
    })

    expect(new URLSearchParams(window.location.search).get('ref')).toBe(
      'classroom'
    )
  })
})

describe('the shareable link', () => {
  it('is absolute and carries the circuit', () => {
    const store = createCircuitStore(emptyCircuit(2, 0))
    mount(store)

    act(() => {
      store.getState().placeGate('h', [0], 0)
    })

    const link = view?.link
    expect(link).toBeTruthy()
    const url = new URL(link!)
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/new')
    expect(readCircuitParam(url.search)).toBe(encode(store.getState().circuit))
  })

  it('is nothing at all for an empty document', () => {
    mount(createCircuitStore(emptyCircuit(2, 0)))
    expect(view?.link).toBeNull()
    expect(view?.tooLarge).toBe(false)
  })
})
