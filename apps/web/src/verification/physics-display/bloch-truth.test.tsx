/**
 * Independent verification — do the Bloch spheres tell the truth?
 *
 * The engine's own suite proves that `blochVectors` computes §5.5. This one
 * asks a different question, and the one a reader actually depends on: does
 * the number **on screen** match the mathematics? Between the two sits a
 * component, a locale-aware formatter that rounds, a classifier that turns a
 * length into a sentence, and a table that could put the right value in the
 * wrong column or the wrong wire's row.
 *
 * So every expectation is derived from `reference.ts` — the dense
 * 2ⁿ × 2ⁿ simulator that shares no code with `@qsim/core` — and traced out by
 * a partial trace written here from the definition. Neither the engine nor
 * its tests are consulted.
 *
 * What is checked, over a Bell pair, GHZ-3, a product state, a partly
 * entangled pair and a state with a genuine y component:
 *
 *   - each printed component is the reference's, to the precision printed
 *   - the length printed is |r| of that same vector
 *   - the row belongs to the wire it names, little-endian (D1), and not to
 *     its neighbour
 *   - the sentence in the last column agrees with the digits beside it
 *   - all of the above in French, where the decimal separator is a comma
 */

import type { Statevector } from '@qsim/core'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { BlochSpheres } from '../../features/analysis/BlochSpheres'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import {
  GATE_H,
  GATE_S,
  GATE_X,
  gateRy,
  referenceState,
  type Cx,
  type RefStep,
} from './reference'

afterEach(cleanup)

/* ── the reference partial trace, written from the definition ───────────── */

/** D1, restated once more so this file depends on nothing for it. */
function bitOf(index: number, qubit: number): number {
  return (index >> qubit) & 1
}

/**
 * ρ_q = Σ over every basis index whose *other* bits agree.
 *
 * Written as a double loop over all 2ⁿ × 2ⁿ pairs of indices, keeping the
 * ones that agree everywhere except on `qubit`. That is the definition of a
 * partial trace transcribed literally — quadratic, unusable in production,
 * and sharing no stride, pairing or accumulator with the engine's version.
 */
function referenceReduced(
  vector: readonly Cx[],
  qubits: number,
  qubit: number
): readonly [number, number, number] {
  const size = 1 << qubits
  let rho00 = 0
  let rho11 = 0
  let re01 = 0
  let im01 = 0

  for (let a = 0; a < size; a++) {
    for (let b = 0; b < size; b++) {
      // The rest of the register must be in the same configuration on both
      // sides; only the traced qubit is free to differ.
      if ((a & ~(1 << qubit)) !== (b & ~(1 << qubit))) continue

      const left = vector[a]!
      const right = vector[b]!
      // ψ_a · conj(ψ_b)
      const re = left.re * right.re + left.im * right.im
      const im = left.im * right.re - left.re * right.im

      const aBit = bitOf(a, qubit)
      const bBit = bitOf(b, qubit)
      if (aBit === 0 && bBit === 0) rho00 += re
      else if (aBit === 1 && bBit === 1) rho11 += re
      else if (aBit === 0 && bBit === 1) {
        re01 += re
        im01 += im
      }
    }
  }

  // §5.5, with y written as 2·Im(ρ₁₀) = −2·Im(ρ₀₁).
  return [2 * re01, -2 * im01, rho00 - rho11]
}

/* ── the states, each written twice ─────────────────────────────────────── */

interface Case {
  readonly name: string
  readonly qubits: number
  readonly steps: readonly RefStep[]
}

const CASES: readonly Case[] = [
  {
    name: 'a Bell pair',
    qubits: 2,
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
    ],
  },
  {
    name: 'GHZ-3',
    qubits: 3,
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
      { gate: GATE_X, target: 2, controls: [1] },
    ],
  },
  {
    name: 'a product state with three different vectors',
    qubits: 3,
    steps: [
      // |+⟩ on q0, |1⟩ on q1, |+i⟩ on q2 — one axis each, so a column swap
      // or a row swap shows up as a wrong number rather than as a tie.
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1 },
      { gate: GATE_H, target: 2 },
      { gate: GATE_S, target: 2 },
    ],
  },
  {
    name: 'a partly entangled pair',
    qubits: 2,
    steps: [
      { gate: gateRy(Math.PI / 3), target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
    ],
  },
  {
    name: 'an entangled pair beside a spectator on +y',
    qubits: 3,
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
      { gate: GATE_H, target: 2 },
      { gate: GATE_S, target: 2 },
    ],
  },
]

/* ── rendering ──────────────────────────────────────────────────────────── */

type Language = 'en' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: { en: { analysis: enAnalysis }, fr: { analysis: frAnalysis } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/**
 * The reference vector as a `Statevector`, built by hand.
 *
 * Deliberately not `run()`: the component must be fed the *reference's* own
 * amplitudes, so that what the table prints is checked against the dense
 * simulator end to end rather than against the engine it is meant to audit.
 */
function stateFrom(vector: readonly Cx[], qubits: number): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let index = 0; index < size; index++) {
    re[index] = vector[index]!.re
    im[index] = vector[index]!.im
  }
  return { qubits, size, re, im }
}

function draw(state: Statevector, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <BlochSpheres state={state} />
    </I18nextProvider>
  )
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1)
}

function cells(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '')
}

/**
 * The four decimals the table prints, in a given language — derived here from
 * `Intl` directly rather than from the app's formatter, so a change of rule in
 * `format.ts` has to be a deliberate one rather than a silently agreed one.
 */
function printed(value: number, language: Language): string {
  const rounded = Math.round(value * 1e4) / 1e4
  return new Intl.NumberFormat(language, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(rounded === 0 ? 0 : rounded)
}

/** The sentence that must sit beside a length, chosen from the length alone. */
function readingFor(length: number, language: Language): string {
  const catalog = language === 'fr' ? frAnalysis : enAnalysis
  if (length >= 1 - 5e-5) return catalog.bloch.reading.pure
  if (length <= 5e-5) return catalog.bloch.reading.centre
  return catalog.bloch.reading.shortened
}

/* ── the checks ─────────────────────────────────────────────────────────── */

describe.each(CASES)('$name', ({ qubits, steps }) => {
  const vector = referenceState(qubits, steps)

  it('prints the vector the mathematics gives each wire', () => {
    draw(stateFrom(vector, qubits))
    const printedRows = rows()
    expect(printedRows).toHaveLength(qubits)

    for (let qubit = 0; qubit < qubits; qubit++) {
      const [x, y, z] = referenceReduced(vector, qubits, qubit)
      const length = Math.hypot(x, y, z)
      const row = printedRows[qubit]!

      // The row is addressed by the wire it names, not by its position, so a
      // table that rendered its rows in the wrong order fails here rather
      // than passing by symmetry.
      expect(within(row).getByRole('rowheader').textContent).toBe(`q${qubit}`)

      const printedCells = cells(row)
      expect(printedCells[0]).toBe(printed(x, 'en'))
      expect(printedCells[1]).toBe(printed(y, 'en'))
      expect(printedCells[2]).toBe(printed(z, 'en'))
      expect(printedCells[3]).toBe(printed(length, 'en'))
    }
  })

  it('says something about each wire that its own digits agree with', () => {
    draw(stateFrom(vector, qubits))
    const printedRows = rows()

    for (let qubit = 0; qubit < qubits; qubit++) {
      const [x, y, z] = referenceReduced(vector, qubits, qubit)
      const length = Math.hypot(x, y, z)
      expect(cells(printedRows[qubit]!).at(-1)).toBe(readingFor(length, 'en'))
    }
  })

  it('prints the same numbers in French, with a decimal comma', () => {
    draw(stateFrom(vector, qubits), 'fr')
    const printedRows = rows()

    for (let qubit = 0; qubit < qubits; qubit++) {
      const [x, y, z] = referenceReduced(vector, qubits, qubit)
      const length = Math.hypot(x, y, z)
      const printedCells = cells(printedRows[qubit]!)

      expect(printedCells[0]).toBe(printed(x, 'fr'))
      expect(printedCells[1]).toBe(printed(y, 'fr'))
      expect(printedCells[2]).toBe(printed(z, 'fr'))
      expect(printedCells[3]).toBe(printed(length, 'fr'))
      expect(printedCells.at(-1)).toBe(readingFor(length, 'fr'))
    }
  })
})

describe('the reading a reader is here for', () => {
  it('is zero on both halves of a Bell pair and one on a spectator', () => {
    /*
     * Stated once, plainly, against the reference: this is §3.2's whole
     * claim. Everything above proves the table agrees with the mathematics;
     * this proves the mathematics is the mathematics anyone was promised.
     */
    const qubits = 3
    const vector = referenceState(qubits, [
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
      { gate: GATE_H, target: 2 },
    ])

    const lengths = [0, 1, 2].map((qubit) =>
      Math.hypot(...referenceReduced(vector, qubits, qubit))
    )
    expect(lengths[0]!).toBeCloseTo(0, 12)
    expect(lengths[1]!).toBeCloseTo(0, 12)
    expect(lengths[2]!).toBeCloseTo(1, 12)

    draw(stateFrom(vector, qubits))
    expect(cells(rows()[0]!)[3]).toBe('0.0000')
    expect(cells(rows()[1]!)[3]).toBe('0.0000')
    expect(cells(rows()[2]!)[3]).toBe('1.0000')
  })
})
