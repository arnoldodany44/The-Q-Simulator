/**
 * The noise controls, as a reader meets them.
 *
 * Three properties are the milestone, and each one is a way §3.3 could fail
 * quietly:
 *
 *  1. **The controls are in datasheet units.** A panel that asked for a
 *     depolarising probability would be asking the reader to run
 *     `depolarizingFromGateError` in their head. The assertion is that the T1
 *     field shows 100 where the profile holds 100 000 nanoseconds.
 *  2. **The ceiling is a sentence with a way out.** Thirteen qubits must
 *     produce a refusal naming the register, the limit and the alternative —
 *     and the alternative has to be a control, not advice.
 *  3. **Nothing is simulated twice until somebody asks.** The mode is off, and
 *     turning it off again has to stop the second run rather than hide it.
 */

import { NOISE_PROFILES } from '@qsim/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { MAX_DENSITY_CLIENT_QUBITS } from '../simulation/protocol'
import { NoisePanel } from './NoisePanel'
import { INITIAL_NOISE, type NoiseSettings } from './noiseSettings'

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

/**
 * A teaching-sized circuit's operation count, which is what the sampled
 * method's own ceiling is a function of alongside the register. Two: small
 * enough that the ceiling never bites in the tests that are not about it.
 */
const OPERATIONS = 2

function draw(
  settings: NoiseSettings,
  qubits = 3,
  language: Language = 'en',
  operations = OPERATIONS
): { onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn()
  render(
    <I18nextProvider i18n={i18nFor(language)}>
      <NoisePanel
        settings={settings}
        onChange={onChange}
        qubits={qubits}
        operations={operations}
      />
    </I18nextProvider>
  )
  return { onChange }
}

/** Every run of whitespace as one plain space — see the ceiling test. */
function spaces(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

const ON: NoiseSettings = { ...INITIAL_NOISE, enabled: true }
const CUSTOM: NoiseSettings = { ...ON, profileId: 'custom' }

afterEach(cleanup)

describe('asking for it at all', () => {
  it('shows nothing but the switch until the mode is on', () => {
    // §3.3 is a second run of the whole circuit and the exact method evolves
    // 4ⁿ numbers to do it, so it is off until asked for (§5.3).
    draw(INITIAL_NOISE)
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('reports the switch rather than acting on it', () => {
    const { onChange } = draw(INITIAL_NOISE)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL_NOISE, enabled: true })
  })
})

describe('the device', () => {
  it('offers every profile the engine publishes, with an explanation', () => {
    draw(ON)
    const options = screen
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toContain(CATALOGS.en.noise.profile.teaching.name)
    expect(options).toContain(CATALOGS.en.noise.profile.trappedIon.name)
    // The sentence for the selected one is on screen, not hidden in a tooltip.
    expect(
      screen.getByText(CATALOGS.en.noise.profile.teaching.help)
    ).toBeTruthy()
  })

  it('shows the custom fields only when custom is chosen', () => {
    draw(ON)
    expect(
      screen.queryByLabelText(CATALOGS.en.noise.field.t1Us.label)
    ).toBeNull()
    cleanup()
    draw(CUSTOM)
    expect(
      screen.getByLabelText(CATALOGS.en.noise.field.t1Us.label)
    ).toBeTruthy()
  })
})

describe('the units', () => {
  it('shows a transmon’s T1 as 100 µs and not as 100 000 ns', () => {
    // The one assertion this whole feature turns on. `NOISE_PROFILES.custom` is
    // superconducting-class, so 100 000 ns is what the engine holds.
    expect(NOISE_PROFILES.custom.t1Ns).toBe(100_000)
    draw(CUSTOM)
    const field = screen.getByLabelText<HTMLInputElement>(
      CATALOGS.en.noise.field.t1Us.label
    )
    expect(field.value).toBe('100')
    // And the unit is beside it rather than assumed.
    expect(
      screen.getAllByText(CATALOGS.en.noise.field.t1Us.unit).length
    ).toBeGreaterThan(0)
  })

  it('shows a gate error of 3e-4 as 0.03 %', () => {
    draw(CUSTOM)
    const field = screen.getByLabelText<HTMLInputElement>(
      CATALOGS.en.noise.field.oneQubitGateErrorPercent.label
    )
    expect(Number(field.value)).toBeCloseTo(0.03, 12)
  })

  it('ties each field’s sentence to the field itself', () => {
    // `aria-describedby` rather than loose text after the input: a screen
    // reader has to hear what the control *does* on arriving in it, which is
    // the entire reason the sentence exists.
    draw(CUSTOM)
    const field = screen.getByLabelText(CATALOGS.en.noise.field.t2Us.label)
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      CATALOGS.en.noise.field.t2Us.help
    )
  })

  it('reports a typed value in the unit it was typed in', () => {
    const { onChange } = draw(CUSTOM)
    fireEvent.change(
      screen.getByLabelText(CATALOGS.en.noise.field.t1Us.label),
      {
        target: { value: '250' },
      }
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        form: expect.objectContaining({ t1Us: 250 }),
      })
    )
  })
})

describe('an unphysical profile', () => {
  it('marks the field and says so, without asking for a run', () => {
    // T2 above 2·T1 is the shape a units mistake takes in practice, and the
    // engine names the field precisely so this panel can point at it.
    const broken: NoiseSettings = {
      ...CUSTOM,
      form: { ...CUSTOM.form, t1Us: 10, t2Us: 40 },
    }
    draw(broken)

    const field = screen.getByLabelText(CATALOGS.en.noise.field.t2Us.label)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(CATALOGS.en.noise.custom.invalid)).toBeTruthy()

    // And the field that is fine is not marked.
    expect(
      screen
        .getByLabelText(CATALOGS.en.noise.field.t1Us.label)
        .getAttribute('aria-invalid')
    ).toBe('false')
  })
})

describe('the ceiling', () => {
  const wide = MAX_DENSITY_CLIENT_QUBITS + 1

  it.each(['en', 'es', 'fr'] as const)(
    'refuses a register past the limit in %s, naming both numbers',
    (language) => {
      draw(ON, wide, language)
      const expected = CATALOGS[language].noise.refusal.tooLarge
        .replace('{{qubits}}', String(wide))
        .replace('{{limit}}', String(MAX_DENSITY_CLIENT_QUBITS))
      /*
       * Compared through `spaces` rather than with `getByText`, because
       * `getByText`'s default normaliser collapses every run of whitespace in
       * the DOM — including the U+00A0 French typography requires before a
       * colon — while leaving the expected string as the catalog wrote it. The
       * two would then differ by one invisible character, in the one language
       * where the character is mandatory.
       */
      const rendered = document.querySelector('.noise__refusal-text')
      expect(spaces(rendered?.textContent ?? '')).toBe(spaces(expected))
    }
  )

  it('offers the alternative as a control rather than as advice', () => {
    // "Use trajectories instead" is an action. A sentence that only described
    // one would leave the reader hunting for the radio it refers to.
    const { onChange } = draw(ON, wide)
    fireEvent.click(
      screen.getByRole('button', { name: CATALOGS.en.noise.refusal.switch })
    )
    expect(onChange).toHaveBeenCalledWith({ ...ON, method: 'trajectories' })
  })

  it('says nothing about a ceiling once the sampled method is chosen', () => {
    draw({ ...ON, method: 'trajectories' }, wide)
    expect(
      screen.queryByRole('button', { name: CATALOGS.en.noise.refusal.switch })
    ).toBeNull()
  })

  it('leaves a register inside the limit alone', () => {
    draw(ON, MAX_DENSITY_CLIENT_QUBITS)
    expect(
      screen.queryByRole('button', { name: CATALOGS.en.noise.refusal.switch })
    ).toBeNull()
  })
})

describe('the method', () => {
  it('shows the shots control only for the sampled method', () => {
    draw(ON)
    expect(screen.queryByRole('slider')).toBeNull()
    cleanup()
    draw({ ...ON, method: 'trajectories' })
    expect(screen.getByRole('slider')).toBeTruthy()
  })

  it('announces the shot count rather than the stop index', () => {
    // The slider's value is a position nobody has been shown, so without
    // `aria-valuetext` a screen reader announces "10 of 15" for 2000 shots.
    draw({ ...ON, method: 'trajectories', shots: 2000 })
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe(
      '2,000'
    )
  })

  it('moves only the seed when a new sample is asked for', () => {
    const { onChange } = draw({ ...ON, method: 'trajectories' })
    fireEvent.click(
      screen.getByRole('button', { name: CATALOGS.en.noise.resample })
    )
    expect(onChange).toHaveBeenCalledWith({
      ...ON,
      method: 'trajectories',
      seed: ON.seed + 1,
    })
  })

  it('disables the density heat map when no ρ will be formed, and says why', () => {
    draw({ ...ON, method: 'trajectories' })
    const advanced = screen.getByRole('checkbox', {
      name: CATALOGS.en.noise.advanced.label,
    })
    expect((advanced as HTMLInputElement).disabled).toBe(true)
    expect(
      screen.getByText(CATALOGS.en.noise.advanced.unavailable)
    ).toBeTruthy()
  })
})
