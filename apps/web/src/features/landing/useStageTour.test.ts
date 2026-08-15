import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REDUCED_MOTION_QUERY } from '../../lib/usePrefersReducedMotion'
import { DEMO_STAGES } from './stages'
import { STAGE_DWELL_MS, useStageTour } from './useStageTour'

/**
 * The demonstration moves on its own, which is the one thing on this page that
 * has to be right twice: right for the reader who wants to watch, and right
 * for the reader who has asked their operating system for no motion at all.
 *
 * `prefers-reduced-motion` is driven through a `matchMedia` stub rather than
 * through a prop, because the hook that reads the query is part of what is
 * being asserted — the same call `ProbabilityHistogram.test.tsx` makes.
 */

const DWELL = 100
const LAST = DEMO_STAGES.length - 1

/** A `matchMedia` jsdom does not ship. Only the motion query answers true. */
function stubMotionPreference(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query === REDUCED_MOTION_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

function tick(times: number): void {
  act(() => {
    vi.advanceTimersByTime(DWELL * times)
  })
}

beforeEach(() => {
  stubMotionPreference(false)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('the stage tour', () => {
  it('starts at the first stage and plays by itself', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))

    expect(result.current.index).toBe(0)
    expect(result.current.playing).toBe(true)

    tick(1)
    expect(result.current.index).toBe(1)
  })

  /*
   * It stops rather than looping: the entangled pair is the conclusion, and it
   * is what the reader should be looking at when the motion ends.
   */
  it('stops at the last stage instead of looping', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))

    tick(LAST + 4)

    expect(result.current.index).toBe(LAST)
    expect(result.current.playing).toBe(false)
    expect(result.current.stage.id).toBe('entangled')
  })

  it('stops playing when a stage is chosen by hand', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))

    act(() => {
      result.current.goTo(1)
    })
    expect(result.current.index).toBe(1)
    expect(result.current.playing).toBe(false)

    // And stays where it was put, however long nobody touches it.
    tick(5)
    expect(result.current.index).toBe(1)
  })

  it('rewinds when play is pressed at the end', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))
    act(() => {
      result.current.goTo(LAST)
    })

    act(() => {
      result.current.toggle()
    })

    expect(result.current.index).toBe(0)
    expect(result.current.playing).toBe(true)
  })

  it('pauses on a second press', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))

    act(() => {
      result.current.toggle()
    })
    expect(result.current.playing).toBe(false)

    tick(3)
    expect(result.current.index).toBe(0)
  })

  /*
   * The accommodation, and the shape of it: nothing starts by itself, and
   * everything still works when asked. Taking the feature away from a reader
   * who pressed play would read the setting as a punishment.
   */
  describe('under prefers-reduced-motion', () => {
    beforeEach(() => {
      stubMotionPreference(true)
    })

    it('never starts on its own', () => {
      const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))

      expect(result.current.playing).toBe(false)
      expect(result.current.reducedMotion).toBe(true)

      tick(6)
      expect(result.current.index).toBe(0)
    })

    it('still plays when the reader presses play', () => {
      const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))

      act(() => {
        result.current.toggle()
      })
      tick(1)

      expect(result.current.index).toBe(1)
    })
  })
})

/**
 * The tour used to begin on a mount timer and finish 10,5 s later whether or
 * not the demonstration had ever been on screen. On a 390×844 phone the chart
 * is entirely below the fold, so a reader who spent an ordinary ten seconds on
 * the hero arrived at the conclusion with the premises already gone — and the
 * plan's Phase 0 criterion is precisely a stranger opening the link on a phone.
 */
describe('waiting until the reader can see it', () => {
  /** A stand-in for the API jsdom does not ship, driven by hand. */
  class FakeObserver {
    static instances: FakeObserver[] = []
    readonly callback: IntersectionObserverCallback
    disconnected = false

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
      FakeObserver.instances.push(this)
    }

    observe(): void {
      /* nothing to do: `arrive()` is what drives this */
    }

    disconnect(): void {
      this.disconnected = true
    }

    unobserve(): void {
      /* unused */
    }

    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }

  function arrive(): void {
    act(() => {
      for (const observer of FakeObserver.instances) {
        observer.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          observer as unknown as IntersectionObserver
        )
      }
    })
  }

  beforeEach(() => {
    FakeObserver.instances = []
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value: FakeObserver,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'IntersectionObserver')
  })

  it('does not start until the demonstration is on screen', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))
    act(() => {
      result.current.section(document.createElement('section'))
    })

    expect(result.current.playing).toBe(false)
    tick(6)
    // Still on the first stage: the argument has not begun without a reader.
    expect(result.current.index).toBe(0)

    arrive()

    expect(result.current.playing).toBe(true)
    tick(1)
    expect(result.current.index).toBe(1)
  })

  it('starts from the beginning, however late the reader arrives', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))
    act(() => {
      result.current.section(document.createElement('section'))
    })
    tick(20)

    arrive()

    expect(result.current.index).toBe(0)
  })

  it('does not restart under a reader who has taken over', () => {
    const { result } = renderHook(() => useStageTour({ dwellMs: DWELL }))
    act(() => {
      result.current.section(document.createElement('section'))
    })
    act(() => {
      result.current.goTo(2)
    })

    arrive()

    // They chose a stage before scrolling to it; autoplay must not pull the
    // page out from under them a moment later.
    expect(result.current.index).toBe(2)
    expect(result.current.playing).toBe(false)
  })
})

describe('the pace', () => {
  it('gives each stage long enough for its own prose', () => {
    /*
     * It was 3 500 ms, about a quarter of what a stage's paragraph takes to
     * read: at 238 wpm the superposition stage needs 14,6 s in English and
     * 16,6 s in French, and "That is superposition." was on screen for three
     * and a half seconds and then gone. Four stages at this pace is 27 s,
     * inside the minute §2 allows.
     */
    expect(STAGE_DWELL_MS).toBeGreaterThanOrEqual(8000)
    expect(STAGE_DWELL_MS * DEMO_STAGES.length).toBeLessThanOrEqual(60_000)
  })
})
