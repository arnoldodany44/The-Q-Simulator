/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — THE TWO OTHER CAPS OF §3.3's PANEL.
 *
 * Lens: limits and refusals. The density-matrix ceiling is a *refusal* — the
 * run does not happen. The heat map's block and the Q-sphere's node count are
 * the softer kind of limit: the run happens, and what is drawn is a *slice* of
 * it. That is the more dangerous shape, because a refusal that goes missing is
 * a crash and a disclosure that goes missing is a picture that looks complete.
 * §3.2 says it in as many words about the histogram: a chart that keeps half
 * the distribution to itself is a lie drawn in colour.
 *
 * So the numbers here are derived from the state rather than read from the
 * model. An n-qubit Hadamard wall puts exactly 2ⁿ basis states at exactly 2⁻ⁿ
 * each, which makes every quantity the disclosure quotes an integer arithmetic
 * problem with one answer:
 *
 *   drawn        = min(2ⁿ, cap)
 *   hidden       = 2ⁿ − drawn
 *   hidden share = hidden / 2ⁿ
 *
 * and drawn + hidden must be the whole support, or the sentence beside the
 * picture is wrong in the one direction nobody checks. The `ideal` profile is
 * used for the density block on purpose: with no channels ρ is exactly |ψ⟩⟨ψ|,
 * so the populations are the amplitudes' own and the arithmetic above is exact
 * rather than approximate.
 *
 * The rendering is then checked in all three languages, because a disclosure
 * that exists in the model and not on screen is the same omission one layer
 * down (D2).
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { DensityHeatmap } from '../../features/analysis/DensityHeatmap'
import { QSpherePanel } from '../../features/analysis/QSpherePanel'
import { DEFAULT_BAR_LIMIT } from '../../features/analysis/histogram'
import { buildQSphere } from '../../features/analysis/qsphere'
import {
  DENSITY_BLOCK_LIMIT,
  runNoiseJob,
} from '../../features/simulation/noiseJob'
import type { DensityBlock } from '../../features/simulation/protocol'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'

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

/** A Hadamard on every wire: 2ⁿ basis states, 2⁻ⁿ of the probability each. */
function wall(qubits: number): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_, q) => ({
      id: `h${q}`,
      gate: 'h',
      targets: [q],
      column: 0,
    })),
  })
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/**
 * The block the heat map would draw for an n-qubit wall.
 *
 * Through `runNoiseJob` rather than by reaching for the private builder, so
 * what is measured is the block that really crosses the thread boundary. The
 * `ideal` profile applies no channels at all, which is what makes ρ exactly
 * |ψ⟩⟨ψ| and the populations exactly 2⁻ⁿ.
 */
function blockFor(qubits: number): DensityBlock {
  const circuit = wall(qubits)
  const payload = runNoiseJob(circuit, stateOf(circuit), {
    profile: {
      id: 'ideal',
      t1Ns: Number.POSITIVE_INFINITY,
      t2Ns: Number.POSITIVE_INFINITY,
      oneQubitGateNs: 0,
      twoQubitGateNs: 0,
      oneQubitGateError: 0,
      twoQubitGateError: 0,
      readoutP0to1: 0,
      readoutP1to0: 0,
    },
    readout: false,
    method: 'density',
    shots: 1,
    seed: 1,
  })
  if (!payload.ok) throw new Error(`refused: ${payload.refusal.code}`)
  const block = payload.reading.density
  if (block === null) throw new Error('the density method drew no block')
  return block
}

afterEach(() => {
  cleanup()
})

describe('the heat map draws a slice and says how big a slice', () => {
  it.each([2, 3, 4])('draws the whole matrix at %i qubits', (qubits) => {
    // 4, 8 and 16 basis states: at or under the cap, so nothing is hidden and
    // the picture is the matrix. §3.2's rule — a limit only ever bites where
    // drawing the whole thing was never possible.
    const block = blockFor(qubits)
    expect(block.indices.length).toBe(2 ** qubits)
    expect(block.hidden).toBe(0)
    expect(block.hiddenPopulation).toBeCloseTo(0, 12)
    expect(block.limit).toBe(DENSITY_BLOCK_LIMIT)
  })

  it.each([5, 6, 7])(
    'states exactly what it left out at %i qubits',
    (qubits) => {
      const total = 2 ** qubits
      const drawn = Math.min(total, DENSITY_BLOCK_LIMIT)
      const block = blockFor(qubits)

      expect(block.indices.length).toBe(drawn)
      expect(block.labels.length).toBe(drawn)
      // Row-major over the kept states, so the payload is exactly k² entries —
      // and at the cap that is 256 cells however wide the register was.
      expect(block.re.length).toBe(drawn * drawn)
      expect(block.im.length).toBe(drawn * drawn)

      // The disclosure, derived rather than read.
      expect(block.hidden).toBe(total - drawn)
      expect(block.hiddenPopulation).toBeCloseTo((total - drawn) / total, 12)
      // Nothing vanishes between the two: drawn share + hidden share is all of it.
      expect(block.hiddenPopulation + drawn / total).toBeCloseTo(1, 12)
    }
  )

  it('never sends more than the cap squared, whatever the register', () => {
    // The reason the cap is 16 and not the histogram's 32: a chart of k states
    // is k marks and a matrix of k states is k². At the ceiling ρ is 256 MB and
    // what crosses the boundary must not grow with it.
    for (const qubits of [5, 8, 10]) {
      const block = blockFor(qubits)
      expect(block.re.length, `n=${qubits}`).toBeLessThanOrEqual(
        DENSITY_BLOCK_LIMIT ** 2
      )
    }
  })

  it.each(['en', 'es', 'fr'] as const)(
    'prints the disclosure on screen in %s',
    (language: Language) => {
      const block = blockFor(6)
      const { container } = render(
        <I18nextProvider i18n={i18nFor(language)}>
          <DensityHeatmap block={block} />
        </I18nextProvider>
      )

      const disclosure =
        container.querySelector('.density__disclosure')?.textContent ?? ''
      expect(disclosure.length, language).toBeGreaterThan(10)
      // The two numbers the sentence exists to carry: how many are drawn, and
      // how many are not. A picture that says neither is a picture that lies.
      expect(disclosure, language).toContain(String(DENSITY_BLOCK_LIMIT))
      expect(disclosure, language).toContain(String(64 - DENSITY_BLOCK_LIMIT))
      // And it is not a raw catalog key.
      expect(disclosure, language).not.toContain('density.caption')
      expect(CATALOGS[language].density.caption.capped_other).toBeTruthy()
    }
  )
})

describe('the Q-sphere caps at the chart and says so', () => {
  it('shares the histogram cap rather than inventing one', () => {
    // Deliberate: a bar with no point beside it would read as physics.
    const model = buildQSphere(stateOf(wall(10)))
    expect(model.limit).toBe(DEFAULT_BAR_LIMIT)
    expect(model.nodes.length).toBe(DEFAULT_BAR_LIMIT)
  })

  it.each([3, 5, 10, 14])(
    'accounts for every occupied state at %i qubits',
    (qubits) => {
      const total = 2 ** qubits
      const drawn = Math.min(total, DEFAULT_BAR_LIMIT)
      const model = buildQSphere(stateOf(wall(qubits)))

      expect(model.size).toBe(total)
      expect(model.occupied).toBe(total)
      expect(model.nodes.length).toBe(drawn)
      expect(model.hidden).toBe(total - drawn)
      expect(model.hiddenProbability).toBeCloseTo((total - drawn) / total, 12)
      // Every drawn node's own probability is 2⁻ⁿ, so the drawn mass and the
      // stated hidden mass have to add to one.
      const drawnMass = model.nodes.reduce(
        (sum, node) => sum + node.probability,
        0
      )
      expect(drawnMass + model.hiddenProbability).toBeCloseTo(1, 12)
    }
  )

  it.each(['en', 'es', 'fr'] as const)(
    'prints its own disclosure in %s',
    (language: Language) => {
      const { container } = render(
        <I18nextProvider i18n={i18nFor(language)}>
          <QSpherePanel state={stateOf(wall(10))} />
        </I18nextProvider>
      )
      const disclosure =
        container.querySelector('.qsphere__disclosure')?.textContent ?? ''
      expect(disclosure, language).toContain(String(DEFAULT_BAR_LIMIT))
      expect(disclosure, language).not.toContain('qsphere.caption')
      // 1024 occupied, 32 drawn, 992 hidden — the numbers, not just a hedge.
      expect(disclosure.replace(/\D+/gu, ' '), language).toMatch(/\b992\b/u)
    }
  )
})
