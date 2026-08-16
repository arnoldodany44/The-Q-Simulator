/**
 * Independent verification (lens: ui-truth-a11y) — does the French text agree
 * with the numbers it is interpolating?
 *
 * D2 does not stop at "the key exists in fr.json". A sentence that is
 * grammatically wrong in one of the three languages is a sentence that reads as
 * a machine translation, in the panel whose whole job is to be trusted about
 * numbers.
 *
 * `QSpherePanel.tsx` passes `count: pluralCount(node.weight)` into
 * `qsphere.table.weight` — the i18next plural *selector* — which says plainly
 * that plural forms were intended. None of the three catalogs has them: the key
 * is a single form in each language. English and Spanish survive that, because
 * both attach the noun to the *total* ("1 of 4 qubits at 1", "1 de 4 qubits en
 * 1"); French attaches it to the count ("{{weight}} qubits sur {{total}} à 1"),
 * where it must agree, and French makes both 0 and 1 singular.
 *
 * Every register has a |0…0⟩ at weight 0, and a single Hadamard produces a
 * state at weight 1, so this is not a corner: it is what a French reader sees
 * on the first circuit anyone builds.
 *
 * FIXED, AND KEPT AS A REGRESSION TEST. The catalogs carry `weight_one` and
 * `weight_other` in all three languages; the `count` argument this panel was
 * already passing now has something to select. Kept because the failure it
 * caught is invisible to every other guard in the tree: locale parity compares
 * the three catalogs against each other and they agreed perfectly while all
 * three were equally missing the forms, and no rendering test reads the French
 * noun.
 */

import type { Statevector } from '@qsim/core'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { QSpherePanel } from '../../features/analysis/QSpherePanel'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'fr',
    fallbackLng: false,
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: { fr: { analysis: frAnalysis } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** |0⟩ and |1⟩ on one qubit: weight 0 and weight 1, the two singular cases. */
function oneHadamard(): Statevector {
  const value = Math.SQRT1_2
  return {
    qubits: 1,
    size: 2,
    re: Float64Array.from([value, value]),
    im: new Float64Array(2),
  }
}

/** The "Anneau" cell of every row, in order. */
function ringCells(): string[] {
  const table = screen.getByRole('table')
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '')
}

afterEach(cleanup)

describe('the French sentences agree with their numbers', () => {
  it('writes a singular noun after 0 and after 1', () => {
    render(
      <I18nextProvider i18n={i18nFor()}>
        <QSpherePanel state={oneHadamard()} />
      </I18nextProvider>
    )

    const cells = ringCells()
    expect(cells).toHaveLength(2)
    // French: "0 qubit sur 1 à 1" and "1 qubit sur 1 à 1". Both counts take the
    // singular; only 2 and above take "qubits".
    for (const cell of cells) {
      const count = Number(
        (cell.match(/^(\d+)/u)?.[1] ?? '2').replace(/\s/gu, '')
      )
      if (count <= 1) {
        expect(cell, `count ${count}`).not.toMatch(/^\d+\s+qubits\b/u)
      }
    }
  })

  it('agrees the remainder row with the verb the sentence conjugates', () => {
    /*
     * The second half of the same rule, found by driving the panel by hand.
     *
     * `noise.comparison.movement` has four sentences and every one of them is
     * built around a *singular* subject, because the subject is normally a ket:
     * "{{lost}} a le plus perdu … et {{gained}} a le plus gagné". The remainder
     * row goes into the same slot, and while it was a plural noun phrase — "les
     * résultats non dessinés" — the sentence read "les résultats non dessinés A
     * le plus gagné", which is wrong in French and was wrong in Spanish the same
     * way ("los resultados no dibujados FUE el que más perdió"). English has no
     * agreement in a past tense, which is why it never showed there.
     *
     * The fix is on the noun rather than on the verb: a singular collective goes
     * into all four sentences, where pluralising the verb would need four more
     * forms in two languages and would still be wrong for the ket. Both
     * languages mark the plural with a final "s", so the property is checkable:
     * the filler carries no plural word.
     */
    for (const [language, phrase] of [
      ['fr', frAnalysis.noise.comparison.movement.others],
      ['es', esAnalysis.noise.comparison.movement.others],
    ] as const) {
      expect(phrase.trim().length, language).toBeGreaterThan(3)
      for (const word of phrase.split(/\s+/u)) {
        expect(word, `${language}: "${word}" is plural`).not.toMatch(/s$/u)
      }
    }
  })
})
