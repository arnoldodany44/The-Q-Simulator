/**
 * Independent verification (lens: ui-truth-a11y) — is the fidelity on screen
 * the number the definition gives, in the convention the package claims?
 *
 * The literature carries two fidelities that differ by exactly a square, and
 * both are called "fidelity". `metrics.ts` states, at length, that this package
 * uses the squared one everywhere. That claim is only worth something if the
 * number a reader sees is that one — so nothing here calls `distributionFidelity`,
 * `densityStateFidelity` or `densityPurity`. Each expected value is written out
 * from its definition, in this file, over ρ and ψ obtained from the engine:
 *
 *     F(p, q)     = (Σᵢ √(pᵢ qᵢ))²          the squared Bhattacharyya coefficient
 *     F(ρ, ψ)     = ⟨ψ|ρ|ψ⟩                 the expectation value, written out
 *     Tr(ρ²)      = Σᵢⱼ |ρᵢⱼ|²              because ρ is Hermitian
 *     TV(p, q)    = ½ Σᵢ |pᵢ − qᵢ|
 *
 * The discriminating assertion is the last one in each block: the printed value
 * must also be *distinguishable from the other convention*. A fidelity of 0.999
 * and its square root 0.9995 agree to three digits, so the circuit below is
 * chosen to lose enough probability that √F and F differ by far more than the
 * fourth decimal the panel prints. Without that, "consistent convention" is a
 * claim no test can fail.
 */

import {
  NOISE_PROFILES,
  run,
  runNoisyDensity,
  type DensityMatrix,
  type Statevector,
} from '@qsim/core'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { NoiseComparisonPanel } from '../../features/analysis/NoiseComparisonPanel'
import { INITIAL_NOISE, specOf } from '../../features/analysis/noiseSettings'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import type { NoiseReading } from '../../features/simulation/protocol'
import enAnalysis from '../../i18n/locales/en/analysis.json'

/**
 * A circuit whose ideal distribution is asymmetric, so a join that reversed a
 * ket would show, and whose amplitudes carry phase, so a channel that only
 * touches coherences has somewhere to bite.
 */
const CIRCUIT: CircuitInput = {
  schemaVersion: 1,
  qubits: 3,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'ry', targets: [1], params: [0.9], column: 0 },
    { id: 'c', gate: 'cx', targets: [2], controls: [0], column: 1 },
    { id: 'd', gate: 't', targets: [0], column: 2 },
    { id: 'e', gate: 'h', targets: [1], column: 3 },
  ],
}

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

function idealState(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/* ───────────── the reference arithmetic, written from the definitions ───── */

/** |aᵢ|², straight off the amplitudes. The Born rule and nothing else. */
function bornProbabilities(state: Statevector): number[] {
  const out: number[] = []
  for (let i = 0; i < state.size; i++) {
    const re = state.re[i] ?? 0
    const im = state.im[i] ?? 0
    out.push(re * re + im * im)
  }
  return out
}

/** F(p, q) = (Σ √(pq))² — the squared convention, spelled out. */
function squaredBhattacharyya(p: readonly number[], q: readonly number[]) {
  let sum = 0
  for (let i = 0; i < p.length; i++) {
    sum += Math.sqrt(Math.max(0, p[i] ?? 0) * Math.max(0, q[i] ?? 0))
  }
  return sum * sum
}

/** ½ Σ |p − q|. */
function totalVariation(p: readonly number[], q: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < p.length; i++) sum += Math.abs((p[i] ?? 0) - (q[i] ?? 0))
  return sum / 2
}

/**
 * ⟨ψ|ρ|ψ⟩ by dense multiplication: the slow, obviously-correct route.
 *
 * Written as the full complex sum rather than as "the real part of", so an
 * imaginary residue would show up here instead of being discarded silently.
 */
function expectationValue(
  rho: DensityMatrix,
  state: Statevector
): { re: number; im: number } {
  const n = rho.dim
  let re = 0
  let im = 0
  for (let r = 0; r < n; r++) {
    // conj(ψ_r)
    const ar = state.re[r] ?? 0
    const ai = -(state.im[r] ?? 0)
    for (let c = 0; c < n; c++) {
      const pr = rho.re[r * n + c] ?? 0
      const pi = rho.im[r * n + c] ?? 0
      const br = state.re[c] ?? 0
      const bi = state.im[c] ?? 0
      // (ar + i·ai)(pr + i·pi)(br + i·bi)
      const xr = pr * br - pi * bi
      const xi = pr * bi + pi * br
      re += ar * xr - ai * xi
      im += ar * xi + ai * xr
    }
  }
  return { re, im }
}

/** Tr(ρ²) = Σᵢⱼ ρᵢⱼ ρⱼᵢ, and ρⱼᵢ = conj(ρᵢⱼ), so this is Σ |ρᵢⱼ|². */
function tracePurity(rho: DensityMatrix): number {
  let sum = 0
  for (let i = 0; i < rho.re.length; i++) {
    const re = rho.re[i] ?? 0
    const im = rho.im[i] ?? 0
    sum += re * re + im * im
  }
  return sum
}

/* ──────────────────────────── reading the panel ─────────────────────────── */

function figures(container: HTMLElement): Map<string, string> {
  const out = new Map<string, string>()
  for (const figure of container.querySelectorAll(
    '.noise-comparison__figure'
  )) {
    const term = figure.querySelector('dt')?.textContent ?? ''
    const value = figure.querySelector('dd')?.textContent ?? ''
    out.set(term, value)
  }
  return out
}

/**
 * An English-locale figure back to a number. `1,234.5` → 1234.5.
 *
 * Everything that is not a digit, a point or a sign goes, which covers the
 * grouping comma and whichever space ICU chose to put before a percent sign —
 * spelling those out as literal characters is exactly what `format.ts` warns
 * against, and an invisible U+202F in a regex is unreadable besides.
 */
function printed(text: string): number {
  return Number(text.replace(/[^\d.+-]/gu, ''))
}

/** A printed percentage back to a share. */
function printedShare(text: string): number {
  return Number(text.replace(/[^\d.+-]/gu, '')) / 100
}

/** The default noise settings, run — which is what a reader gets on tick one. */
function defaultReading(circuit: Circuit, state: Statevector): NoiseReading {
  const spec = specOf(
    { ...INITIAL_NOISE, enabled: true },
    circuit.qubits,
    circuit.operations.length
  )
  if (spec === null) throw new Error('the default settings ask for no run')
  const payload = runNoiseJob(circuit, state, spec)
  if (!payload.ok) throw new Error('the engine refused the default run')
  return payload.reading
}

afterEach(cleanup)

describe('the fidelity a reader sees', () => {
  const circuit = parseCircuit(CIRCUIT)
  const state = idealState(circuit)
  const reading = defaultReading(circuit, state)

  /*
   * The reference run, made here rather than taken from the reading: the point
   * is to have a ρ and a distribution this file obtained itself.
   */
  const reference = runNoisyDensity(circuit, {
    profile: NOISE_PROFILES[INITIAL_NOISE.profileId],
    readout: INITIAL_NOISE.readout,
  })
  const ideal = bornProbabilities(state)
  const noisy = [...reference.distribution]

  function draw() {
    return render(
      <I18nextProvider i18n={i18nFor()}>
        <NoiseComparisonPanel state={state} reading={reading} />
      </I18nextProvider>
    )
  }

  it('is far enough from 1 for the two conventions to be told apart', () => {
    // Guards every assertion below: on a near-perfect run F and √F agree to
    // four decimals and no test here could fail.
    const f = squaredBhattacharyya(ideal, noisy)
    expect(f).toBeLessThan(0.99)
    expect(Math.abs(Math.sqrt(f) - f)).toBeGreaterThan(1e-3)
  })

  it('prints (Σ√(pq))² — the squared convention, not its root', () => {
    const view = draw()
    const shown = figures(view.container).get(
      enAnalysis.noise.comparison.fidelity
    )
    expect(shown).toBeDefined()

    const expected = squaredBhattacharyya(ideal, noisy)
    expect(printed(shown ?? '')).toBeCloseTo(expected, 4)
    // And is not the unsquared one wearing the same label.
    expect(printed(shown ?? '')).not.toBeCloseTo(Math.sqrt(expected), 3)
  })

  it('prints ⟨ψ|ρ|ψ⟩ for the state fidelity, in the same convention', () => {
    const view = draw()
    const shown = figures(view.container).get(
      enAnalysis.noise.comparison.stateFidelity
    )
    expect(shown).toBeDefined()

    const value = expectationValue(reference.rho, state)
    // ρ is Hermitian, so this is real; if it is not, the number on screen is
    // half of a complex quantity and the label is wrong whatever it says.
    expect(Math.abs(value.im)).toBeLessThan(1e-10)
    expect(printed(shown ?? '')).toBeCloseTo(value.re, 4)
    expect(printed(shown ?? '')).not.toBeCloseTo(Math.sqrt(value.re), 3)
  })

  it('prints Tr(ρ²) for the purity', () => {
    const view = draw()
    const shown = figures(view.container).get(
      enAnalysis.noise.comparison.purity
    )
    expect(shown).toBeDefined()
    expect(printed(shown ?? '')).toBeCloseTo(tracePurity(reference.rho), 4)
  })

  it('prints ½Σ|Δ| for the probability that moved', () => {
    const view = draw()
    const shown = figures(view.container).get(enAnalysis.noise.comparison.moved)
    expect(shown).toBeDefined()
    expect(printedShare(shown ?? '')).toBeCloseTo(
      totalVariation(ideal, noisy),
      4
    )
  })

  it('never shows a state fidelity or a purity for a sampled run', () => {
    // Both are questions about a ρ the trajectories method deliberately never
    // forms, and a blank cell would be read as "zero" rather than as "not
    // asked". The panel must omit the term, not print an empty one.
    const spec = specOf(
      { ...INITIAL_NOISE, enabled: true, method: 'trajectories' },
      circuit.qubits,
      circuit.operations.length
    )
    if (spec === null) throw new Error('no spec for the sampled method')
    const payload = runNoiseJob(circuit, state, spec)
    if (!payload.ok) throw new Error('the engine refused the sampled run')

    const view = render(
      <I18nextProvider i18n={i18nFor()}>
        <NoiseComparisonPanel state={state} reading={payload.reading} />
      </I18nextProvider>
    )
    const shown = figures(view.container)
    expect(shown.has(enAnalysis.noise.comparison.fidelity)).toBe(true)
    expect(shown.has(enAnalysis.noise.comparison.stateFidelity)).toBe(false)
    expect(shown.has(enAnalysis.noise.comparison.purity)).toBe(false)
  })

  it('states which method produced the digits it prints', () => {
    const view = draw()
    const method = view.container.querySelector('.noise-comparison__method')
    expect(method?.textContent).toBe(enAnalysis.noise.comparison.ranDensity)
  })
})
