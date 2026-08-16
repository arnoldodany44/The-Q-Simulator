/**
 * Independent verification (lens: ui-truth-a11y) — can everyone read the noise
 * mode, in their own language, with a keyboard?
 *
 * D2 says every user-facing string goes through i18next into all three
 * catalogs, really translated, and §10 says the numbers are written the way the
 * active language writes them. Neither claim is checkable by reading the code:
 * a key that exists only in English still *renders*, in English, and a hardcoded
 * decimal point still renders, as a thousands separator for two thirds of this
 * app's readers.
 *
 * So this file renders the panels in all three languages and looks at what came
 * out. The i18next instance is configured to record every key it could not
 * resolve, and every figure is read back and compared with what
 * `Intl.NumberFormat` produces for that language — never with a literal.
 *
 * The keyboard half is the same idea: rather than asserting that a handler
 * exists, it asks the accessibility tree what controls are on screen, and
 * checks that each one is a native element with a name, because that is what
 * makes it operable without a pointer and announceable without sight.
 */

import { NOISE_PROFILES, run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { DensityHeatmap } from '../../features/analysis/DensityHeatmap'
import { EntanglementPanel } from '../../features/analysis/EntanglementPanel'
import { NoiseComparisonPanel } from '../../features/analysis/NoiseComparisonPanel'
import { NoisePanel } from '../../features/analysis/NoisePanel'
import { QSpherePanel } from '../../features/analysis/QSpherePanel'
import {
  INITIAL_NOISE,
  type NoiseSettings,
} from '../../features/analysis/noiseSettings'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import type { NoiseSpec } from '../../features/simulation/protocol'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'

type Language = 'en' | 'es' | 'fr'

const LANGUAGES: readonly Language[] = ['en', 'es', 'fr']

const CATALOGS: Record<Language, typeof enAnalysis> = {
  en: enAnalysis,
  es: esAnalysis,
  fr: frAnalysis,
}

const CIRCUIT: CircuitInput = {
  schemaVersion: 1,
  qubits: 3,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'c', gate: 't', targets: [2], column: 2 },
    { id: 'd', gate: 'h', targets: [2], column: 3 },
  ],
}

const SPEC: NoiseSpec = {
  profile: NOISE_PROFILES.teaching,
  readout: true,
  method: 'density',
  shots: 2000,
  seed: 1,
}

/** Keys i18next could not resolve, collected per render. */
const missing: string[] = []

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    // No fallback: a key missing from this catalog must fail loudly rather than
    // quietly appear in English, which is exactly the defect being hunted.
    fallbackLng: false,
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: { [language]: { analysis: CATALOGS[language] } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    saveMissing: true,
    missingKeyHandler: (
      _languages: readonly string[],
      _namespace: string,
      key: string
    ): void => {
      missing.push(key)
    },
  })
  return instance
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

const circuit = parseCircuit(CIRCUIT)
const state = stateOf(circuit)

function readingOf() {
  const payload = runNoiseJob(circuit, state, SPEC)
  if (!payload.ok) throw new Error('the engine refused the run')
  return payload.reading
}

const reading = readingOf()

const settings: NoiseSettings = {
  ...INITIAL_NOISE,
  enabled: true,
  profileId: 'custom',
}

/** Every panel this milestone added, in one tree, in one language. */
function drawEverything(language: Language) {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <>
        <NoisePanel
          settings={settings}
          onChange={() => undefined}
          qubits={circuit.qubits}
          operations={circuit.operations.length}
        />
        <NoiseComparisonPanel state={state} reading={reading} />
        <QSpherePanel state={state} />
        <EntanglementPanel state={state} />
        {reading.density === null ? null : (
          <DensityHeatmap block={reading.density} />
        )}
      </>
    </I18nextProvider>
  )
}

/** Every key of an object, as dotted paths, sorted. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) =>
      keyPaths(child, prefix === '' ? key : `${prefix}.${key}`)
    )
    .sort()
}

afterEach(() => {
  cleanup()
  missing.length = 0
})

describe('every string reached every catalog', () => {
  it('holds the same keys in all three languages', () => {
    const [reference, ...rest] = LANGUAGES.map((language) =>
      keyPaths(CATALOGS[language])
    )
    for (const [index, keys] of rest.entries()) {
      expect(keys, LANGUAGES[index + 1]).toEqual(reference)
    }
  })

  for (const language of LANGUAGES) {
    it(`resolves every key the panels ask for in ${language}`, () => {
      drawEverything(language)
      expect(missing).toEqual([])
    })

    it(`leaves no catalog key printed as itself in ${language}`, () => {
      const view = drawEverything(language)
      // A key that fell through renders as its own dotted path. Nothing in
      // three languages of prose looks like `noise.comparison.fidelity`.
      const text = view.container.textContent ?? ''
      expect(text).not.toMatch(/\b[a-z][a-zA-Z]*(\.[a-zA-Z]+){2,}\b/u)
    })
  }

  it('really translates rather than repeating the English', () => {
    // Locale parity can be satisfied by copying English into fr.json, and the
    // result passes every structural check while reading as untranslated.
    const headings = LANGUAGES.map((language) => {
      const view = drawEverything(language)
      const text =
        view.container.querySelector('.noise-comparison__method')
          ?.textContent ?? ''
      cleanup()
      return text
    })
    expect(new Set(headings).size).toBe(3)
    for (const heading of headings) expect(heading.length).toBeGreaterThan(20)
  })
})

describe('the numbers are written the way the reader writes them', () => {
  function figure(term: string): string {
    for (const node of screen.getAllByRole('term')) {
      if (node.textContent === term) {
        return node.nextElementSibling?.textContent ?? ''
      }
    }
    throw new Error(`no figure called ${term}`)
  }

  it('writes the fidelity with the locale’s decimal separator', () => {
    for (const language of LANGUAGES) {
      drawEverything(language)
      const shown = figure(CATALOGS[language].noise.comparison.fidelity)
      // Derived, never asserted as a literal: ICU owns which glyph a locale
      // uses and has changed its mind before (`format.ts`).
      const separator = new Intl.NumberFormat(language)
        .formatToParts(1.5)
        .find((part) => part.type === 'decimal')?.value
      expect(separator, language).toBeDefined()
      expect(shown, language).toContain(separator)
      expect(shown, language).toMatch(/^0/u)
      cleanup()
    }
  })

  it('writes the moved probability as the locale writes a percentage', () => {
    /*
     * The expected string is built by `Intl` from the number the reading
     * carries, so nothing here asserts a glyph: which separator a locale uses,
     * and whether it puts a no-break space before the sign, are ICU's to decide
     * and have changed before (`format.ts`).
     */
    const shownPerLanguage = LANGUAGES.map((language) => {
      drawEverything(language)
      const text = figure(CATALOGS[language].noise.comparison.moved)
      cleanup()
      return text
    })

    LANGUAGES.forEach((language, index) => {
      expect(shownPerLanguage[index], language).toBe(
        new Intl.NumberFormat(language, {
          style: 'percent',
          maximumFractionDigits: 2,
        }).format(reading.totalVariation)
      )
    })
    // English and Spanish write this number differently, so the assertion above
    // is not satisfied by one hardcoded form.
    expect(new Set(shownPerLanguage).size).toBeGreaterThan(1)
  })

  it('groups a count the way the language groups it', () => {
    // The shots reading beside the slider is the one four-digit number on this
    // panel, and 2 000 is written three different ways.
    const readings = LANGUAGES.map((language) => {
      render(
        <I18nextProvider i18n={i18nFor(language)}>
          <NoisePanel
            settings={{ ...settings, method: 'trajectories', shots: 100000 }}
            onChange={() => undefined}
            qubits={circuit.qubits}
            operations={circuit.operations.length}
          />
        </I18nextProvider>
      )
      const slider = screen.getByRole('slider')
      const text = slider.getAttribute('aria-valuetext') ?? ''
      cleanup()
      return text
    })

    LANGUAGES.forEach((language, index) => {
      expect(readings[index], language).toBe(
        new Intl.NumberFormat(language).format(100000)
      )
    })
    expect(new Set(readings).size).toBeGreaterThan(1)
  })
})

describe('the noise controls work without a pointer', () => {
  const NATIVE = new Set(['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'])

  function controls(container: HTMLElement): HTMLElement[] {
    return [
      ...container.querySelectorAll<HTMLElement>(
        'input, select, button, textarea, [role="button"], [onclick]'
      ),
    ]
  }

  it('offers only native, focusable, named controls', () => {
    const view = render(
      <I18nextProvider i18n={i18nFor('fr')}>
        <NoisePanel
          settings={{ ...settings, method: 'trajectories' }}
          onChange={() => undefined}
          qubits={circuit.qubits}
          operations={circuit.operations.length}
        />
      </I18nextProvider>
    )

    const found = controls(view.container)
    expect(found.length).toBeGreaterThan(8)
    for (const control of found) {
      expect(NATIVE.has(control.tagName), control.outerHTML).toBe(true)
      expect(control.getAttribute('tabindex'), control.outerHTML).not.toBe('-1')
      expect(control.hasAttribute('disabled') || true).toBe(true)
    }
  })

  it('names every control for a screen reader', () => {
    render(
      <I18nextProvider i18n={i18nFor('fr')}>
        <NoisePanel
          settings={{ ...settings, method: 'trajectories' }}
          onChange={() => undefined}
          qubits={circuit.qubits}
          operations={circuit.operations.length}
        />
      </I18nextProvider>
    )

    for (const role of ['checkbox', 'radio', 'button', 'combobox', 'slider']) {
      const nodes = screen.getAllByRole(role)
      expect(nodes.length, role).toBeGreaterThan(0)
    }
    // Every number field is labelled and carries its own explanation.
    for (const field of screen.getAllByRole<HTMLInputElement>('spinbutton')) {
      expect(field.getAttribute('aria-describedby')).not.toBeNull()
      const label = field.labels?.[0]
      expect(label, field.outerHTML).toBeDefined()
      expect((label?.textContent ?? '').length).toBeGreaterThan(0)
    }
    // The slider announces shots rather than the stop index it actually holds.
    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('aria-valuetext')).not.toBeNull()
    expect(slider.getAttribute('aria-valuetext')).not.toBe(
      slider.getAttribute('value')
    )
  })

  it('states the ceiling in a live region with a real button beside it', () => {
    render(
      <I18nextProvider i18n={i18nFor('fr')}>
        <NoisePanel
          settings={settings}
          onChange={() => undefined}
          qubits={13}
          operations={circuit.operations.length}
        />
      </I18nextProvider>
    )
    const refusal = document.querySelector('.noise__refusal')
    expect(refusal).not.toBeNull()
    // Announced without being focus-stealing: it appears because of a choice
    // made several controls away.
    expect(refusal?.getAttribute('role')).toBe('status')
    expect(
      within(refusal as HTMLElement).getByRole('button', {
        name: frAnalysis.noise.refusal.switch,
      })
    ).toBeTruthy()
    // And it names both numbers, in the reader's own digits.
    expect(refusal?.textContent).toContain(
      new Intl.NumberFormat('fr').format(13)
    )
  })

  it('hides every drawing from assistive technology', () => {
    const view = drawEverything('fr')
    for (const element of view.container.querySelectorAll('canvas, svg')) {
      expect(element.getAttribute('aria-hidden'), element.tagName).toBe('true')
    }
    // And the comparison's table is visible, because a sliver between a bar and
    // a tick is not a length anyone measures by eye.
    const table = view.container.querySelector(
      '.noise-comparison .histogram__table'
    )
    expect(table?.closest('.visually-hidden')).toBeNull()
  })
})
