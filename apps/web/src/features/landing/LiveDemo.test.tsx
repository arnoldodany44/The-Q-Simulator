import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import enLanding from '../../i18n/locales/en/landing.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import esLanding from '../../i18n/locales/es/landing.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import frLanding from '../../i18n/locales/fr/landing.json'
import { REDUCED_MOTION_QUERY } from '../../lib/usePrefersReducedMotion'
import { LiveDemo } from './LiveDemo'

/**
 * The two words §2 makes the page's acceptance criterion, in each language.
 * Lower-cased, because they appear mid-sentence and at the head of one.
 */
const IDEAS: Record<Language, readonly string[]> = {
  en: ['superposition', 'entanglement'],
  es: ['superposición', 'entrelazamiento'],
  fr: ['superposition', 'intrication'],
}

/**
 * §2's acceptance criterion is that a stranger understands two ideas in under
 * a minute, and the only part of that a test can hold is the part that would
 * silently stop being true: the demonstration has to really simulate.
 *
 * So the assertions below read the chart's own described table — the same
 * table a screen reader gets — and count the bars each stage produces: one,
 * two, four, two. A page that had quietly become a set of drawings would fail
 * here and nowhere else, because four static pictures look exactly like four
 * live ones in a screenshot.
 *
 * Autoplay is off throughout. `useStageTour.test.ts` owns the timer; a
 * component test racing it as well would be testing two things and flaking on
 * one of them.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS = {
  en: { analysis: enAnalysis, landing: enLanding },
  es: { analysis: esAnalysis, landing: esLanding },
  fr: { analysis: frAnalysis, landing: frLanding },
} as const

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis', 'landing'],
    defaultNS: 'landing',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function show(language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <LiveDemo autoPlay={false} />
    </I18nextProvider>
  )
}

/**
 * The chart's rows, minus its header.
 *
 * Always four: the landing draws a fixed basis so that the stage 3 → 4
 * transition is two bars shrinking to nothing rather than a re-layout in which
 * every row moves (`LiveDemo`'s header argues it). What changes between stages
 * is therefore how many of them carry any probability, which is `occupied`.
 */
function bars(): HTMLElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1)
}

/** The rows whose probability is not zero — the bars a reader actually sees. */
function occupied(): HTMLElement[] {
  return bars().filter((row) => {
    const probability = within(row).getAllByRole('cell')[0]?.textContent ?? ''
    return !/^0\s*%$/u.test(probability.trim())
  })
}

/** A reading's current value, without the "was …" comparison beside it. */
function figure(node: Element | null): string {
  if (node === null) return ''
  const value = node.querySelector('dd')
  if (value === null) return ''
  const before = value.querySelector('.demo__reading-before')?.textContent ?? ''
  return (value.textContent ?? '').replace(before, '').trim()
}

/** The reading that carries the punchline: how often the two wires match. */
function agreement(container: HTMLElement): string {
  return figure(container.querySelector('.demo__reading--pair'))
}

/** The two per-qubit readings, in wire order, as rendered. */
function marginals(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.demo__reading')]
    .slice(1, 3)
    .map((node) => figure(node))
}

function goToStage(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }))
}

function stageButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(name) })
}

afterEach(cleanup)

describe('the live demonstration', () => {
  it('opens on a single certain outcome', () => {
    const { container } = show()

    expect(occupied()).toHaveLength(1)
    /*
     * And says nothing about agreement yet. "The two agree" reads 100 % here
     * for the boring reason that there is only one outcome, and it reads 100 %
     * again at the entangled stage — a V across the four, so a reader who took
     * it for the signature of entanglement had it falsified by the first
     * picture on the page. It starts where the comparison it belongs to does.
     */
    expect(container.querySelector('.demo__reading--pair')).toBeNull()
  })

  it('keeps every reading of the pair on the chart at every stage', () => {
    // The fixed basis. Two of these rows go to zero length between stage 3 and
    // stage 4; none of them leaves, so nothing else in the picture moves.
    show()

    for (const name of ['Nothing yet', 'One gate', 'Two coins', 'One pair']) {
      goToStage(name)
      expect(bars()).toHaveLength(4)
      expect(
        bars().map((row) => within(row).getByRole('rowheader').textContent)
      ).toEqual(['|00⟩', '|01⟩', '|10⟩', '|11⟩'])
    }
  })

  /*
   * The whole argument, walked in order. Each number here is the one the
   * sentence beside it names, so a stage whose physics drifted would leave the
   * page telling a reader something the chart under it contradicts.
   */
  it('simulates every stage as it is shown', () => {
    const { container } = show()

    goToStage('One gate')
    expect(occupied()).toHaveLength(2)

    goToStage('Two coins')
    expect(occupied()).toHaveLength(4)
    // Two fair coins land the same way half the time.
    expect(agreement(container)).toContain('50')

    goToStage('One pair')
    expect(occupied()).toHaveLength(2)
    expect(agreement(container)).toContain('100')
  })

  /*
   * Entanglement, as the page states it: the marginals do not move and the
   * joint distribution does. Read off the rendered figures rather than
   * recomputed, because what is being checked is that the reader sees it.
   */
  it('shows both qubits unchanged while the pair changes', () => {
    const { container } = show()

    goToStage('Two coins')
    const asCoins = marginals(container)
    expect(asCoins).toHaveLength(2)

    goToStage('One pair')
    expect(marginals(container)).toEqual(asCoins)
    expect(agreement(container)).not.toContain('50')

    // And the previous stage's figures are still on screen beside them, so
    // "the two figures below have not moved" is a claim the reader can check
    // rather than one they have to remember across a transition.
    const before = [...container.querySelectorAll('.demo__reading-before')].map(
      (node) => node.textContent ?? ''
    )
    expect(before).toHaveLength(4)
    expect(before[1]).toContain(asCoins[0]!)
    expect(before[3]).toContain('50')
  })

  it('marks the current stage without relying on its colour', () => {
    show()

    expect(stageButton('Nothing yet').getAttribute('aria-pressed')).toBe('true')

    goToStage('One pair')

    expect(stageButton('One pair').getAttribute('aria-pressed')).toBe('true')
    expect(stageButton('Nothing yet').getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('offers a way to stop the sequence', () => {
    show()
    // WCAG 2.2.2: content that starts moving on its own owes a pause control,
    // and the label says which way the control will act.
    expect(screen.getByRole('button', { name: 'Play' })).toBeDefined()
  })

  /*
   * D2 and §1.1. Every figure on this page is locale-formatted, and the tell
   * is the space French puts before a percent sign — a hardcoded `%` would
   * produce identical strings in all three languages.
   */
  it('formats its percentages for the active language', () => {
    const english = show('en')
    goToStage('Two coins')
    const inEnglish = agreement(english.container)
    cleanup()

    const french = show('fr')
    goToStage('Deux pièces')
    const inFrench = agreement(french.container)

    const expected = new Intl.NumberFormat('fr', {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(0.5)
    expect(inFrench).toBe(expected)
    expect(inFrench).not.toBe(inEnglish)
  })

  it.each(['en', 'es', 'fr'] as const)(
    'renders every stage in "%s" with no missing string',
    (language) => {
      const { container } = show(language)
      const steps = within(
        screen.getByRole('group', {
          name: CATALOGS[language].landing.demo.steps,
        })
      ).getAllByRole('button')

      expect(steps).toHaveLength(4)

      for (const step of steps) {
        fireEvent.click(step)
        const text = container.textContent ?? ''
        // A missing key renders as the key itself; catching that here is what
        // makes the parity test's guarantee visible on screen.
        expect(text).not.toContain('demo.stages')
        /*
         * And an interpolation nobody supplied renders as `{{q0}}`, which the
         * parity test cannot see at all — it compares keys, not the arguments
         * a component passes with them. This caught exactly that: the caption
         * was given the wire names and the narration beside it was not.
         */
        expect(text).not.toContain('{{')
        expect(text.length).toBeGreaterThan(200)
      }
    }
  )
})

/**
 * The reader who asked their operating system for no motion.
 *
 * The tour does not start for them — that is the right accommodation and it is
 * not negotiable — but it used to be the whole of it, which left the page
 * resting on stage 1 for ever: one bar at 100 %, an ordinary pair of bits, and
 * neither of the two ideas §2 names anywhere on the page in any language. The
 * argument is now delivered as four panels at once, which moves nothing.
 */
describe('under prefers-reduced-motion', () => {
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

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('shows all four stages at once, with nothing to press', () => {
    stubMotionPreference(true)
    const { container } = show()

    expect(container.querySelectorAll('.demo__stack-item')).toHaveLength(4)
    // Four charts, four stories, four sets of readings: the whole argument.
    expect(screen.getAllByRole('table')).toHaveLength(4)
    expect(container.querySelectorAll('.demo__story')).toHaveLength(4)
    // And no timer to stop, so no control that would imply one.
    expect(container.querySelector('.demo__play')).toBeNull()
  })

  it.each(['en', 'es', 'fr'] as const)(
    'names both ideas on the page in %s',
    (language) => {
      stubMotionPreference(true)
      const { container } = show(language)
      const text = (container.textContent ?? '').toLowerCase()

      // The two words §2 makes the acceptance criterion. Under the old
      // behaviour neither of them was anywhere on this page for this reader.
      for (const idea of IDEAS[language]) {
        expect(text).toContain(idea)
      }
    }
  )

  it('reaches the entangled pair, which the tour never did', () => {
    stubMotionPreference(true)
    show()

    const panels = screen.getAllByRole('table')
    const last = panels.at(-1)
    expect(last).toBeDefined()
    const probabilities = within(last!)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent)
    // |00⟩ and |11⟩ at a half, |01⟩ and |10⟩ at nothing: the Bell pair.
    expect(probabilities).toEqual(['50%', '0%', '0%', '50%'])
  })
})
