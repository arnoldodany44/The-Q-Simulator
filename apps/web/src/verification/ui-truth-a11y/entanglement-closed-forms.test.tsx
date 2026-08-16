/**
 * Independent verification (lens: ui-truth-a11y) — do the entropy and the
 * concurrence on screen agree with the closed forms?
 *
 * Nothing here calls `qubitEntropy`, `concurrenceOf`, `partialTrace` or
 * `binaryEntropy`. Every expected value is a number derived from the definition
 * for a state written out by hand, and every actual value is read out of the
 * DOM the panel rendered. The states are chosen so that the answers are known
 * without a computation at all:
 *
 *   product         every S = 0, every C = 0
 *   Bell            every S = 1, C = 1
 *   GHZ₃            every S = 1, every pair C = 0   ← the interesting one
 *   W₃              every S = H₂(⅓) = 0.9183, every pair C = ⅔
 *   cosθ|00⟩+sinθ|11⟩   S = H₂(cos²θ), C = sin 2θ
 *
 * GHZ₃ against W₃ is the pair that catches a concurrence computed from ρ's own
 * spectrum instead of from the spin flip: that mistake still returns something
 * in [0, 1] and still returns 0 for a product state, and it is wrong on exactly
 * these two.
 *
 * The states are built as literal statevectors rather than run out of circuits,
 * which is deliberate: a W state has no two-gate circuit, and building the
 * amplitudes by hand removes the engine from the reference entirely. The panel
 * takes a `Statevector`, which is four plain fields.
 */

import type { Statevector } from '@qsim/core'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { EntanglementPanel } from '../../features/analysis/EntanglementPanel'
import enAnalysis from '../../i18n/locales/en/analysis.json'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: { en: { analysis: enAnalysis } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/**
 * A statevector from a sparse list of amplitudes, normalised here.
 *
 * Indices are little-endian per D1: bit q of the index is qubit q.
 */
function stateOf(
  qubits: number,
  amplitudes: readonly (readonly [number, number, number])[]
): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let norm = 0
  for (const [index, real, imaginary] of amplitudes) {
    re[index] = real
    im[index] = imaginary
    norm += real * real + imaginary * imaginary
  }
  const scale = 1 / Math.sqrt(norm)
  for (let i = 0; i < size; i++) {
    re[i] = (re[i] ?? 0) * scale
    im[i] = (im[i] ?? 0) * scale
  }
  return { qubits, size, re, im }
}

/** H₂(p) = −p log₂ p − (1−p) log₂(1−p), from the definition. */
function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0
  return -p * Math.log2(p) - (1 - p) * Math.log2(1 - p)
}

/** An English figure back to a number. The panel prints four decimals. */
function value(text: string): number {
  return Number(text.replace(/,/gu, ''))
}

function tables(): HTMLElement[] {
  return screen.getAllByRole('table')
}

/** `{ name → [figure, sentence] }` for one of the two tables. */
type Reading = Map<string, [number, string]>

function readTable(table: HTMLElement): Reading {
  const out: Reading = new Map()
  for (const row of within(table).getAllByRole('row').slice(1)) {
    const name = within(row).getByRole('rowheader').textContent ?? ''
    const cells = within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '')
    out.set(name, [value(cells[0] ?? ''), cells[1] ?? ''])
  }
  return out
}

function draw(state: Statevector): {
  entropies: Reading
  pairs: Reading
} {
  render(
    <I18nextProvider i18n={i18nFor()}>
      <EntanglementPanel state={state} />
    </I18nextProvider>
  )
  const [entropy, pairs] = tables()
  const empty: Reading = new Map()
  return {
    entropies: entropy === undefined ? empty : readTable(entropy),
    pairs: pairs === undefined ? empty : readTable(pairs),
  }
}

/** Half of the last digit the panel prints. */
const PRINTED = 5e-5

afterEach(cleanup)

describe('the entanglement panel prints the closed forms', () => {
  it('a product state: every entropy 0 and every concurrence 0', () => {
    // (|0⟩+|1⟩)/√2 ⊗ |0⟩ ⊗ (|0⟩+|1⟩)/√2 — separable by construction.
    const shown = draw(
      stateOf(3, [
        [0b000, 1, 0],
        [0b001, 1, 0],
        [0b100, 1, 0],
        [0b101, 1, 0],
      ])
    )

    for (const [name, [figure, reading]] of shown.entropies) {
      expect(figure, name).toBeCloseTo(0, 4)
      expect(reading, name).toBe(enAnalysis.entanglement.entropy.reading.own)
    }
    expect(shown.pairs.size).toBe(3)
    for (const [name, [figure, reading]] of shown.pairs) {
      expect(figure, name).toBeCloseTo(0, 4)
      expect(reading, name).toBe(
        enAnalysis.entanglement.pairs.reading.separable
      )
    }
  })

  it('a Bell pair: S = 1 on both halves and C = 1', () => {
    const shown = draw(
      stateOf(2, [
        [0b00, 1, 0],
        [0b11, 1, 0],
      ])
    )

    expect(shown.entropies.size).toBe(2)
    for (const [name, [figure, reading]] of shown.entropies) {
      expect(figure, name).toBeCloseTo(1, 4)
      expect(reading, name).toBe(enAnalysis.entanglement.entropy.reading.none)
    }
    expect(shown.pairs.get('q0 · q1')?.[0]).toBeCloseTo(1, 4)
    expect(shown.pairs.get('q0 · q1')?.[1]).toBe(
      enAnalysis.entanglement.pairs.reading.maximal
    )
  })

  it('GHZ₃: every qubit has no state of its own and no pair shares any of it', () => {
    const shown = draw(
      stateOf(3, [
        [0b000, 1, 0],
        [0b111, 1, 0],
      ])
    )

    for (const [name, [figure]] of shown.entropies) {
      expect(figure, name).toBeCloseTo(1, 4)
    }
    expect(shown.pairs.size).toBe(3)
    for (const [name, [figure, reading]] of shown.pairs) {
      expect(figure, name).toBeCloseTo(0, 4)
      expect(reading, name).toBe(
        enAnalysis.entanglement.pairs.reading.separable
      )
    }
    // The sentence that stops the two tables reading as a contradiction.
    expect(screen.getByText(enAnalysis.entanglement.shared.none)).toBeTruthy()
  })

  it('W₃: every entropy H₂(⅓) and every concurrence ⅔', () => {
    const shown = draw(
      stateOf(3, [
        [0b001, 1, 0],
        [0b010, 1, 0],
        [0b100, 1, 0],
      ])
    )

    // Each qubit reads 1 with probability ⅓, so its reduced ρ is
    // diag(⅔, ⅓) — diagonal because the two branches differ in the other
    // qubits — and S is the entropy of that spectrum.
    const expected = binaryEntropy(1 / 3)
    expect(expected).toBeCloseTo(0.9182958340544896, 12)
    for (const [name, [figure, reading]] of shown.entropies) {
      expect(figure, name).toBeCloseTo(expected, 4)
      expect(reading, name).toBe(
        enAnalysis.entanglement.entropy.reading.partial
      )
    }

    expect(shown.pairs.size).toBe(3)
    for (const [name, [figure]] of shown.pairs) {
      expect(figure, name).toBeCloseTo(2 / 3, 4)
    }
  })

  it('cosθ|00⟩ + sinθ|11⟩: S = H₂(cos²θ) and C = sin 2θ', () => {
    const theta = 0.4
    const shown = draw(
      stateOf(2, [
        [0b00, Math.cos(theta), 0],
        [0b11, Math.sin(theta), 0],
      ])
    )

    const expectedEntropy = binaryEntropy(Math.cos(theta) ** 2)
    for (const [name, [figure]] of shown.entropies) {
      expect(figure, name).toBeCloseTo(expectedEntropy, 4)
    }
    expect(shown.pairs.get('q0 · q1')?.[0]).toBeCloseTo(Math.sin(2 * theta), 4)
  })

  it('a relative phase changes neither: C = 1 for (|00⟩ + i|11⟩)/√2', () => {
    // The state is still maximally entangled; a concurrence that took the
    // adjoint instead of the entry-by-entry conjugate would not say so.
    const shown = draw(
      stateOf(2, [
        [0b00, 1, 0],
        [0b11, 0, 1],
      ])
    )
    expect(shown.pairs.get('q0 · q1')?.[0]).toBeCloseTo(1, 4)
    for (const [name, [figure]] of shown.entropies) {
      expect(figure, name).toBeCloseTo(1, 4)
    }
  })

  it('an asymmetric register: the entropy of each qubit, one by one', () => {
    /*
     * |ψ⟩ = (|000⟩ + |011⟩ + |101⟩)/√3, chosen so no two qubits are alike.
     * Marginals, counted off the three branches:
     *   qubit 0 reads 1 in |101⟩ only              → p = ⅓
     *   qubit 1 reads 1 in |011⟩ and |101⟩         → p = ⅔
     *   qubit 2 reads 1 in |011⟩ only              → p = ⅓
     * Each branch differs from the others in at least one *other* qubit, so
     * every reduced ρ is diagonal and its spectrum is that marginal.
     */
    const shown = draw(
      stateOf(3, [
        [0b000, 1, 0],
        [0b011, 1, 0],
        [0b101, 1, 0],
      ])
    )

    expect(shown.entropies.get('q0')?.[0]).toBeCloseTo(binaryEntropy(1 / 3), 4)
    expect(shown.entropies.get('q1')?.[0]).toBeCloseTo(binaryEntropy(2 / 3), 4)
    expect(shown.entropies.get('q2')?.[0]).toBeCloseTo(binaryEntropy(1 / 3), 4)
  })

  it('never prints a figure its own sentence contradicts', () => {
    // The number and the words sit in one row, so a threshold looser than the
    // printed precision would put `1,0000` beside "partly entangled".
    const shown = draw(
      stateOf(2, [
        [0b00, Math.cos(0.6), 0],
        [0b11, Math.sin(0.6), 0],
      ])
    )
    for (const [name, [figure, reading]] of shown.entropies) {
      if (figure <= PRINTED) {
        expect(reading, name).toBe(enAnalysis.entanglement.entropy.reading.own)
      } else if (figure >= 1 - PRINTED) {
        expect(reading, name).toBe(enAnalysis.entanglement.entropy.reading.none)
      } else {
        expect(reading, name).toBe(
          enAnalysis.entanglement.entropy.reading.partial
        )
      }
    }
  })
})
