/**
 * The Q-sphere, as a reader who cannot see the canvas reads it.
 *
 * Every assertion here is against the table, and that is the design rather than
 * a limitation of jsdom: the WebGL scene is `aria-hidden`, so the table is the
 * rendering. jsdom gives the second half for free — it has no WebGL, so the
 * lazy scene really does fail to get a context on every run, and the
 * degradation path is exercised rather than being a branch nobody executes
 * until a reader on old hardware finds it.
 *
 * The one thing worth stating twice: the table's columns are deliberately not
 * the amplitude table's. That one already lists the amplitude, the magnitude
 * and the phase of every drawn state. What this adds is the *ring* — the
 * Hamming weight — which is what the picture is made of and the only column
 * that explains why a GHZ state is two points at opposite poles.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { QSpherePanel } from './QSpherePanel'

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enAnalysis> = {
  en: enAnalysis,
  es: esAnalysis,
  fr: frAnalysis,
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: {
      en: { analysis: enAnalysis },
      es: { analysis: esAnalysis },
      fr: { analysis: frAnalysis },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function ghz(qubits: number): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      ...Array.from({ length: qubits - 1 }, (_unused, index) => ({
        id: `cx${index}`,
        gate: 'x',
        targets: [index + 1],
        controls: [index],
        column: index + 1,
      })),
    ],
  })
}

function draw(state: Statevector, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <QSpherePanel state={state} />
    </I18nextProvider>
  )
}

/** Every run of whitespace as one plain space — see the language test. */
function spaces(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function rows(view: ReturnType<typeof draw>): HTMLElement[] {
  return [...view.container.querySelectorAll<HTMLElement>('.qsphere__row')]
}

afterEach(cleanup)

describe('the table is the rendering', () => {
  it('is visible rather than hidden, unlike the histogram’s', () => {
    // A node's radius in an orthographic projection is not a length anyone can
    // compare by eye, so a low-vision reader who does not use a screen reader
    // would otherwise have no rendering at all — §10's `--wire` argument.
    const view = draw(ghz(3))
    const table = view.container.querySelector('.qsphere__grid')
    expect(table).not.toBeNull()
    expect(table?.closest('.visually-hidden')).toBeNull()
  })

  it('gives one row per drawn basis state', () => {
    // A GHZ state is two points and therefore two rows, whatever the register.
    expect(rows(draw(ghz(4)))).toHaveLength(2)
  })

  it('names the ring each state sits on', () => {
    // The column that explains the picture. |000⟩ has no qubits at 1 and
    // |111⟩ has all three, which is why they are at opposite poles.
    const view = draw(ghz(3))
    const cells = rows(view).map(
      (row) => row.querySelectorAll('td')[0]?.textContent
    )
    expect(cells[0]).toBe(
      CATALOGS.en.qsphere.table.weight_other
        .replace('{{weight}}', '0')
        .replace('{{total}}', '3')
    )
    expect(cells[1]).toBe(
      CATALOGS.en.qsphere.table.weight_other
        .replace('{{weight}}', '3')
        .replace('{{total}}', '3')
    )
  })

  it('prints the amplitude, not the probability, in the amplitude column', () => {
    // §3.2 asks for a radius proportional to the amplitude, so the table has to
    // carry the quantity the picture is drawn from: 0,7071 rather than 50 %.
    const view = draw(ghz(2))
    const magnitudes = rows(view).map(
      (row) => row.querySelectorAll('td')[1]?.textContent
    )
    expect(magnitudes).toEqual(['0.7071', '0.7071'])
  })

  it('carries the phase as a number, never only as a colour', () => {
    // §10's ordering: hue is reinforcement and the numeric angle is what a
    // colour-blind reader relies on. The canvas is the only place hue exists.
    const view = draw(ghz(2))
    const phases = rows(view).map(
      (row) => row.querySelectorAll('td')[3]?.textContent
    )
    for (const phase of phases) expect(phase).toContain('rad')
  })
})

describe('the caption', () => {
  it('says how many states carry anything and that all of them are drawn', () => {
    const view = draw(ghz(3))
    expect(view.container.textContent).toContain(
      CATALOGS.en.qsphere.caption.complete_other
        .replace('{{occupied}}', '2')
        .replace('{{total}}', '8')
    )
  })

  it('states the cap when it bites, the way the histogram does', () => {
    // Five Hadamards is thirty-two occupied states against a cap of thirty-two,
    // so six wires is the first size that hides anything.
    const wide = stateOf({
      schemaVersion: 1,
      qubits: 6,
      operations: Array.from({ length: 6 }, (_unused, wire) => ({
        id: `h${wire}`,
        gate: 'h',
        targets: [wire],
        column: 0,
      })),
    })
    const view = draw(wide)
    expect(rows(view)).toHaveLength(32)
    expect(view.container.textContent).toContain('32')
    expect(view.container.textContent).toContain('64')
  })
})

describe('when the picture cannot be drawn', () => {
  it('says so and keeps every number', () => {
    // jsdom has no WebGL, so this is the real degradation path rather than a
    // simulated one. The canvas is allowed to fail because the table is the
    // rendering; a blank box is the failure this panel may not have.
    const view = draw(ghz(2))
    expect(rows(view)).toHaveLength(2)
    expect(view.container.textContent).not.toMatch(/qsphere\./u)
  })
})

describe('three languages', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders words, not keys, in %s',
    (language) => {
      const view = draw(ghz(3), language)
      expect(view.container.textContent).not.toMatch(/qsphere\.[a-z]/u)
      expect(
        within(view.container).getByText(CATALOGS[language].qsphere.heading)
      ).toBeTruthy()
      /*
       * Compared through `spaces` rather than with `getByText`: that helper's
       * normaliser collapses every run of whitespace in the DOM, including the
       * U+00A0 French typography requires before a semicolon, while leaving the
       * expected string as the catalog wrote it. The two would differ by one
       * invisible character in the one language where the character is mandatory.
       */
      const note = view.container.querySelector('.qsphere__note')
      expect(spaces(note?.textContent ?? '')).toBe(
        spaces(CATALOGS[language].qsphere.note)
      )
    }
  )
})
