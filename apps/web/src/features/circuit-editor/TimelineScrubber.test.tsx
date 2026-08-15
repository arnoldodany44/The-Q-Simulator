import { parseCircuit, type Circuit } from '@qsim/schema'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import esEditor from '../../i18n/locales/es/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { REDUCED_MOTION_QUERY } from '../../lib/usePrefersReducedMotion'
import { TimelineScrubber } from './TimelineScrubber'
import { PLAYBACK_MS, useTimeline } from './useTimeline'

/**
 * The scrubber, driven the way a reader drives it.
 *
 * WHAT JSDOM CAN AND CANNOT SAY ABOUT THE KEYBOARD. The bar is an
 * `<input type="range">` precisely so the platform answers the arrows, Home
 * and End — and jsdom does not implement that behaviour, so a `keyDown` here
 * would prove nothing about a browser and would quietly pass whatever the
 * component did. What is asserted instead is the half that is ours: the
 * range's bounds and value, which are what those keys move, and the `change`
 * event a real browser raises once they have. Space is a different matter —
 * a range has no native meaning for it, the handler is our own code, and it
 * is exercised here as a keystroke. `e2e/timeline.spec.ts` closes the gap in
 * a real browser, which is the same split `CircuitEditor.test.tsx` already
 * makes for the grid's own keys.
 *
 * `prefers-reduced-motion` is driven through a `matchMedia` stub rather than
 * a test-only prop, for the reason `ProbabilityHistogram.test.tsx` gives: the
 * hook that reads the query is part of what is being tested.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enEditor> = {
  en: enEditor,
  es: esEditor,
  fr: frEditor,
}

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

/**
 * The scrubber plus the number it is a view of. `useTimeline` lives in the
 * editor in production because the canvas and the analysis panel read it too;
 * here the harness stands in for that owner and prints the position, which is
 * the value the rest of the app acts on.
 */
function Harness({
  circuit,
  autoPlay = false,
}: {
  circuit: Circuit
  autoPlay?: boolean
}) {
  const timeline = useTimeline({ circuit, autoPlay })
  return (
    <>
      <TimelineScrubber timeline={timeline} />
      <span data-testid="position">
        {timeline.position === null ? 'end' : String(timeline.position)}
      </span>
    </>
  )
}

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

/** A circuit occupying columns `0 … columns - 1`. */
function ofLength(columns: number): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 1,
    operations: Array.from({ length: columns }, (_, column) => ({
      id: `g${column}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

function mount(circuit: Circuit, language: Language = 'en', autoPlay = false) {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <Harness circuit={circuit} autoPlay={autoPlay} />
    </I18nextProvider>
  )
}

function bar(): HTMLInputElement {
  return screen.getByRole('slider')
}

function position(): string {
  return screen.getByTestId('position').textContent ?? ''
}

/** Moves the bar the way a browser reports an arrow key or a drag. */
function moveBarTo(stop: number): void {
  fireEvent.change(bar(), { target: { value: String(stop) } })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  stubMotionPreference(false)
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the bar', () => {
  it('starts at the end of the circuit', () => {
    // The resting state of the editor: nothing is held back, the panel runs
    // the whole circuit, and this feature costs the reader who never touches
    // it exactly nothing.
    mount(ofLength(4))

    expect(bar().value).toBe('4')
    expect(bar().getAttribute('aria-valuetext')).toBe(enEditor.timeline.at.end)
    expect(position()).toBe('end')
  })

  it('offers one stop per column plus the end', () => {
    mount(ofLength(4))

    expect(bar().min).toBe('0')
    expect(bar().max).toBe('4')
    expect(bar().step).toBe('1')
  })

  it('names the position in words rather than by stop number', () => {
    // The slider's own value is a stop index, a number the reader has never
    // been shown. Without `aria-valuetext` a screen reader announces "1 of 5".
    mount(ofLength(4))

    moveBarTo(0)
    expect(bar().getAttribute('aria-valuetext')).toBe(
      enEditor.timeline.at.start
    )

    moveBarTo(3)
    expect(bar().getAttribute('aria-valuetext')).toBe(
      enEditor.timeline.at.column.replace('{{column}}', '2')
    )
  })

  it('reports the cut, not the stop, to whoever owns the timeline', () => {
    mount(ofLength(4))

    moveBarTo(0)
    expect(position()).toBe('-1')
    moveBarTo(1)
    expect(position()).toBe('0')
    moveBarTo(4)
    expect(position()).toBe('end')
  })
})

describe('playback', () => {
  it('does not start on its own', () => {
    mount(ofLength(4))

    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.play)
    advance(PLAYBACK_MS.normal * 10)
    expect(position()).toBe('end')
  })

  it('walks the circuit column by column once it is asked to', () => {
    mount(ofLength(4))
    moveBarTo(0)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.pause)

    advance(PLAYBACK_MS.normal)
    expect(position()).toBe('0')
    advance(PLAYBACK_MS.normal)
    expect(position()).toBe('1')
  })

  it('stops at the end rather than looping', () => {
    // A loop is a timer that runs for as long as the tab is open, and the end
    // of a circuit is a result rather than a lap marker.
    mount(ofLength(2))
    moveBarTo(0)
    fireEvent.click(screen.getByRole('button'))

    advance(PLAYBACK_MS.normal * 4)

    expect(position()).toBe('end')
    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.play)
  })

  it('rewinds when play is pressed at the end', () => {
    // A play button that does nothing is a play button that looks broken.
    mount(ofLength(4))

    fireEvent.click(screen.getByRole('button'))

    expect(position()).toBe('-1')
  })

  it('runs at the speed the reader chose', () => {
    mount(ofLength(6))
    moveBarTo(0)
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'slow' },
    })
    fireEvent.click(screen.getByRole('button'))

    advance(PLAYBACK_MS.normal)
    expect(position(), 'still on the first stop at the normal interval').toBe(
      '-1'
    )
    advance(PLAYBACK_MS.slow - PLAYBACK_MS.normal)
    expect(position()).toBe('0')
  })

  it('stops when the reader moves the bar by hand', () => {
    // Two hands on the same wheel. The bar keeps moving under playback, and a
    // reader who grabs it has plainly stopped watching and started looking.
    mount(ofLength(6))
    moveBarTo(0)
    fireEvent.click(screen.getByRole('button'))

    moveBarTo(3)

    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.play)
    advance(PLAYBACK_MS.normal * 3)
    expect(position()).toBe('2')
  })

  it('toggles on Space, which the grid three inches above cannot see', () => {
    /*
     * Space already means "pick this gate up" inside the circuit grid — it is
     * dnd-kit's keyboard drag. Binding it here is safe because it is bound to
     * the bar alone, and because the editor's own key handler ignores
     * everything originating inside an `input` (`originOf` in
     * `useKeyboardGrid.ts`). What is asserted here is the half this component
     * owns: the keystroke plays, and it plays without the event escaping.
     */
    mount(ofLength(4))
    moveBarTo(0)

    const event = fireEvent.keyDown(bar(), { key: ' ' })

    expect(event, 'the keystroke is consumed, never left to bubble').toBe(false)
    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.pause)
    advance(PLAYBACK_MS.normal)
    expect(position()).toBe('0')

    fireEvent.keyDown(bar(), { key: ' ' })
    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.play)
    advance(PLAYBACK_MS.normal * 3)
    expect(position(), 'paused stays paused').toBe('0')
  })

  it('leaves every other key to the platform', () => {
    // The arrows and Home/End belong to the range input, which is why it is a
    // range input. A handler that swallowed them would be re-implementing the
    // platform, badly.
    mount(ofLength(4))

    expect(fireEvent.keyDown(bar(), { key: 'ArrowRight' })).toBe(true)
    expect(fireEvent.keyDown(bar(), { key: 'End' })).toBe(true)
  })
})

describe('prefers-reduced-motion', () => {
  it('refuses to start playing on its own', () => {
    // The whole of the accommodation on this control: nothing moves that the
    // reader did not ask to move. A lesson or a preset may ask for autoplay;
    // a reader who asked for less motion outranks it.
    stubMotionPreference(true)
    mount(ofLength(4), 'en', true)

    expect(screen.getByRole('button').textContent).toBe(enEditor.timeline.play)
    advance(PLAYBACK_MS.normal * 4)
    expect(position()).toBe('end')
  })

  it('still plays when the reader presses play', () => {
    // An explicit start is explicit. Taking the feature away from somebody who
    // reached for it would be reading the setting as a punishment.
    stubMotionPreference(true)
    mount(ofLength(4))
    moveBarTo(0)

    fireEvent.click(screen.getByRole('button'))
    advance(PLAYBACK_MS.normal)

    expect(position()).toBe('0')
  })

  it('plays on its own only when nobody asked it not to', () => {
    stubMotionPreference(false)
    mount(ofLength(4), 'en', true)

    advance(PLAYBACK_MS.normal)

    expect(position()).toBe('0')
  })
})

describe('the three languages (D2)', () => {
  it.each(['en', 'es', 'fr'] as const)('labels every control in %s', (lng) => {
    mount(ofLength(4), lng)
    const catalog = CATALOGS[lng]

    expect(screen.getByRole('button').textContent).toBe(catalog.timeline.play)
    expect(bar().getAttribute('aria-valuetext')).toBe(catalog.timeline.at.end)
    expect(
      screen.getByRole('heading', { name: catalog.timeline.heading })
    ).toBeDefined()
    // The one place a number reaches the reader from this control, and it is
    // formatted by the active locale like every other figure in the app.
    moveBarTo(3)
    expect(bar().getAttribute('aria-valuetext')).toBe(
      catalog.timeline.at.column.replace('{{column}}', '2')
    )
  })
})
