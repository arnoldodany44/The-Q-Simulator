/**
 * The noise panel's own state, and the arithmetic between a datasheet and a
 * channel.
 *
 * The defect this file exists for is a factor of a thousand. `NoiseProfile`
 * puts the unit in every field name because a profile mixing nanoseconds and
 * microseconds "would produce channel parameters wrong by three orders of
 * magnitude while still returning a valid ρ" — a distribution that is
 * normalised, plausible and wrong. The panel shows microseconds and the engine
 * takes nanoseconds, so this module is the one place that conversion happens,
 * and it is asserted in both directions here.
 */

import {
  NOISE_PROFILES,
  relaxationFor,
  validateProfile,
  type NoiseProfileValues,
} from '@qsim/core'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  MAX_CLIENT_QUBITS,
  MAX_DENSITY_CLIENT_QUBITS,
  MAX_SHOTS,
  MIN_TRAJECTORY_SHOTS,
} from '../simulation/protocol'
import {
  INITIAL_NOISE,
  NOISE_FIELDS,
  densityFits,
  fieldFor,
  formOf,
  methodFits,
  noiseErrorOf,
  noiseIsValid,
  profileOf,
  specOf,
  trajectoryShotsFor,
  valuesOf,
  type NoiseSettings,
} from './noiseSettings'

function withForm(patch: Partial<NoiseSettings['form']>): NoiseSettings {
  return {
    ...INITIAL_NOISE,
    enabled: true,
    profileId: 'custom',
    form: { ...INITIAL_NOISE.form, ...patch },
  }
}

describe('units', () => {
  it('shows a transmon’s T1 as 100 µs, not 100 000', () => {
    // The whole point of the conversion, in one assertion: nine digits nobody
    // can read become three, in the unit a calibration page prints.
    const form = formOf(NOISE_PROFILES.superconducting)
    expect(NOISE_PROFILES.superconducting.t1Ns).toBe(100_000)
    expect(form.t1Us).toBe(100)
  })

  it('shows a gate error of 3e-4 as 0.03 %', () => {
    const form = formOf(NOISE_PROFILES.superconducting)
    expect(form.oneQubitGateErrorPercent).toBeCloseTo(0.03, 12)
    expect(form.readoutP1to0Percent).toBeCloseTo(2, 12)
  })

  it('round-trips every preset the form can express', () => {
    /*
     * Closeness rather than equality, and the difference is 3e-20: 3e-4 becomes
     * 0.03 and 0.03/100 is 0.00030000000000000003. That is fifteen orders of
     * magnitude below anything a gate error means, and asserting exact equality
     * here would be asserting a property of Float64 division rather than a
     * property of this module.
     */
    for (const id of [
      'superconducting',
      'trappedIon',
      'teaching',
      'custom',
    ] as const) {
      const original = NOISE_PROFILES[id]
      const back = valuesOf(formOf(original))
      for (const key of Object.keys(back) as (keyof NoiseProfileValues)[]) {
        expect(back[key], `${id}.${key}`).toBeCloseTo(original[key], 12)
      }
    }
  })

  it('round-trips any form a reader could type', () => {
    fc.assert(
      fc.property(
        fc.record({
          t1Us: fc.double({ min: 0.001, max: 1e7, noNaN: true }),
          t2Us: fc.double({ min: 0.001, max: 1e7, noNaN: true }),
          oneQubitGateNs: fc.double({ min: 0, max: 1e6, noNaN: true }),
          twoQubitGateNs: fc.double({ min: 0, max: 1e6, noNaN: true }),
          oneQubitGateErrorPercent: fc.double({
            min: 0,
            max: 100,
            noNaN: true,
          }),
          twoQubitGateErrorPercent: fc.double({
            min: 0,
            max: 100,
            noNaN: true,
          }),
          readoutP0to1Percent: fc.double({ min: 0, max: 100, noNaN: true }),
          readoutP1to0Percent: fc.double({ min: 0, max: 100, noNaN: true }),
        }),
        (form) => {
          const back = formOf(valuesOf(form))
          for (const key of Object.keys(form) as (keyof typeof form)[]) {
            /*
             * A *relative* bound, not `toBeCloseTo`'s absolute one. A trapped
             * ion's T1 is ten million microseconds, and one Float64 ulp there
             * is 2e-9 — larger than the absolute tolerance nine decimal places
             * asks for, so an absolute check would go red on some seeds and
             * green on others. A suite that fails at random is a suite everyone
             * learns to ignore.
             */
            expect(
              Math.abs(back[key] - form[key]),
              `${key}: ${back[key]} vs ${form[key]}`
            ).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(form[key])))
          }
        }
      )
    )
  })

  it('falls back to the custom preset for a coherence time that is not a number', () => {
    // `ideal` writes Infinity, which is a valid profile and not a typeable
    // value. The form opens on the preset the engine wrote for this.
    const form = formOf(NOISE_PROFILES.ideal)
    expect(Number.isFinite(form.t1Us)).toBe(true)
    expect(form.t1Us).toBe(NOISE_PROFILES.custom.t1Ns / 1000)
    // Everything that *is* finite in `ideal` still comes from `ideal`.
    expect(form.oneQubitGateNs).toBe(0)
    expect(form.oneQubitGateErrorPercent).toBe(0)
  })

  it('maps every engine field a validation error can name back to a control', () => {
    // `NoiseProfileError` carries the field so the panel can mark the input.
    // A field the engine can complain about with no control to mark would be a
    // sentence the reader cannot act on.
    for (const key of Object.keys(
      NOISE_PROFILES.custom
    ) as (keyof typeof NOISE_PROFILES.custom)[]) {
      if (key === 'id') continue
      expect(fieldFor(key), key).not.toBeNull()
    }
    expect(NOISE_FIELDS).toHaveLength(8)
  })
})

describe('profileOf', () => {
  it('returns the preset itself when one is chosen', () => {
    expect(profileOf({ ...INITIAL_NOISE, profileId: 'trappedIon' })).toBe(
      NOISE_PROFILES.trappedIon
    )
  })

  it('builds a validated custom profile from the form', () => {
    const profile = profileOf(withForm({ t1Us: 50, t2Us: 40 }))
    expect(profile.id).toBe('custom')
    expect(profile.t1Ns).toBe(50_000)
    expect(profile.t2Ns).toBe(40_000)
    expect(() => {
      validateProfile(profile)
    }).not.toThrow()
  })

  it('produces the channel parameters the engine derives from those numbers', () => {
    // The end-to-end statement of the unit conversion: a T1 of 50 µs and a
    // 35 ns gate have to reach `relaxationFor` as 50 000 ns and 35 ns.
    const profile = profileOf(withForm({ t1Us: 50, t2Us: 40 }))
    const expected = relaxationFor(50_000, 40_000, profile.oneQubitGateNs)
    const actual = relaxationFor(
      profile.t1Ns,
      profile.t2Ns,
      profile.oneQubitGateNs
    )
    expect(actual.gamma).toBe(expected.gamma)
    expect(actual.lambda).toBe(expected.lambda)
  })
})

describe('validation', () => {
  it('marks T2 when it is more than twice T1', () => {
    // The physical bound, and the one a units mistake produces in practice:
    // 1/T2 = 1/(2·T1) + 1/Tφ with Tφ ≥ 0, so relaxation alone caps coherence.
    const settings = withForm({ t1Us: 10, t2Us: 30 })
    expect(noiseIsValid(settings)).toBe(false)
    expect(noiseErrorOf(settings)).toBe('t2Us')
  })

  it('marks an emptied field rather than treating it as zero', () => {
    // A number input that has been cleared reads as NaN, and a coherence time
    // of zero is a physically different device — so it is refused, not coerced.
    const settings = withForm({ t1Us: Number.NaN })
    expect(noiseErrorOf(settings)).toBe('t1Us')
  })

  it('marks an error rate outside [0, 1]', () => {
    expect(noiseErrorOf(withForm({ oneQubitGateErrorPercent: 140 }))).toBe(
      'oneQubitGateErrorPercent'
    )
    expect(noiseErrorOf(withForm({ readoutP1to0Percent: -1 }))).toBe(
      'readoutP1to0Percent'
    )
  })

  it('marks nothing for a profile the engine accepts', () => {
    expect(noiseErrorOf({ ...INITIAL_NOISE, enabled: true })).toBeNull()
  })
})

describe('the ceiling', () => {
  it('admits the whole of §3.3’s range and refuses the first qubit past it', () => {
    expect(densityFits(MAX_DENSITY_CLIENT_QUBITS)).toBe(true)
    expect(densityFits(MAX_DENSITY_CLIENT_QUBITS + 1)).toBe(false)
  })

  it('gives the sampled method a ceiling of its own, made of time', () => {
    /*
     * THIS ASSERTION USED TO SAY THE OPPOSITE, and the opposite was the bug.
     * "Sampled trajectories have no ceiling" is true of *memory* and false of
     * everything else: `runNoisy` restarts every shot from |0…0⟩, so a run
     * costs shots × operations × 2ⁿ in a worker that cannot be pre-empted. The
     * density refusal's own button sends a reader here without touching the
     * shot count, so at twenty qubits and the panel's default two thousand
     * shots the way out of a ceiling was a fifty-minute freeze.
     *
     * The right expectation is the one the density method already has: the
     * method fits where the run is affordable and is refused where it is not.
     */
    const sampled: NoiseSettings = {
      ...INITIAL_NOISE,
      enabled: true,
      method: 'trajectories',
    }
    // A teaching-sized circuit at the first register the density ceiling
    // refuses — the exact case the way out sends a reader to.
    expect(methodFits(sampled, MAX_DENSITY_CLIENT_QUBITS + 1, 25)).toBe(true)
    // …and the widest register the editor offers, where it is not affordable.
    expect(methodFits(sampled, MAX_CLIENT_QUBITS, 39)).toBe(false)
    // It really does reach further than the exact method, which is what makes
    // it an alternative rather than a redirection.
    expect(methodFits(sampled, MAX_DENSITY_CLIENT_QUBITS + 3, 25)).toBe(true)
  })

  it('bounds the shot count by the register, not only by §3.2’s range', () => {
    const sampled: NoiseSettings = {
      ...INITIAL_NOISE,
      enabled: true,
      method: 'trajectories',
      shots: MAX_SHOTS,
    }
    // Small circuit: §3.2's own ceiling is the binding one.
    expect(trajectoryShotsFor(sampled, 3, 4)).toBe(MAX_SHOTS)
    // Wide circuit: the time budget is, and it falls with 2ⁿ.
    const wide = trajectoryShotsFor(sampled, MAX_DENSITY_CLIENT_QUBITS + 1, 25)
    expect(wide).toBeLessThan(MAX_SHOTS)
    expect(wide).toBeGreaterThanOrEqual(MIN_TRAJECTORY_SHOTS)
    // Every doubling of the register quarters what it can afford, because the
    // cost is linear in 2ⁿ and the budget is fixed.
    expect(trajectoryShotsFor(sampled, 14, 25)).toBe(
      Math.floor(trajectoryShotsFor(sampled, 13, 25) / 2)
    )
  })

  it('never rewrites the method it was given', () => {
    // A reader who asked for the exact answer and quietly got a sampled one
    // would read a fidelity of 0.9993 as exact when it carries an error of
    // 1/(2√shots). So this reports, and the panel refuses out loud.
    const exact: NoiseSettings = { ...INITIAL_NOISE, enabled: true }
    expect(methodFits(exact, MAX_DENSITY_CLIENT_QUBITS + 1, 2)).toBe(false)
    expect(exact.method).toBe('density')
  })
})

describe('specOf', () => {
  it('asks for nothing until the reader asks', () => {
    expect(specOf(INITIAL_NOISE, 3, 2)).toBeNull()
  })

  it('asks for nothing on the ideal profile', () => {
    // The noisy run would be the ideal run bit for bit, and §3.3's comparison
    // would be a chart of a distribution against itself.
    expect(
      specOf({ ...INITIAL_NOISE, enabled: true, profileId: 'ideal' }, 3, 2)
    ).toBeNull()
  })

  it('asks for nothing past the ceiling', () => {
    expect(
      specOf(
        { ...INITIAL_NOISE, enabled: true },
        MAX_DENSITY_CLIENT_QUBITS + 1,
        2
      )
    ).toBeNull()
  })

  it('asks for nothing past the sampled method’s ceiling either', () => {
    // The other half of the same rule. A trajectories run at the widest
    // register the editor offers, on a circuit with something in it, is tens of
    // minutes of an un-interruptible worker — so it is refused before it is
    // asked for, exactly as the density one is.
    expect(
      specOf(
        { ...INITIAL_NOISE, enabled: true, method: 'trajectories' },
        MAX_CLIENT_QUBITS,
        39
      )
    ).toBeNull()
  })

  it('asks for nothing while the profile is unphysical', () => {
    // Otherwise every keystroke inside a half-typed number would dispatch a
    // 4ⁿ evolution the worker would immediately refuse.
    expect(specOf(withForm({ t2Us: 1e9 }), 3, 2)).toBeNull()
  })

  it('carries the profile, the method and the seed when it does ask', () => {
    const spec = specOf({ ...INITIAL_NOISE, enabled: true }, 4, 2)
    expect(spec).not.toBeNull()
    expect(spec?.profile).toBe(NOISE_PROFILES.teaching)
    expect(spec?.method).toBe('density')
    expect(spec?.readout).toBe(true)
    expect(spec?.seed).toBe(INITIAL_NOISE.seed)
  })

  it('clamps the shot count the engine would refuse', () => {
    const spec = specOf(
      {
        ...INITIAL_NOISE,
        enabled: true,
        method: 'trajectories',
        shots: 10 ** 9,
      },
      4,
      2
    )
    expect(spec?.shots).toBe(100_000)
  })

  it('clamps the shot count the register cannot afford', () => {
    // The same clamp for the other bound. A settings object whose register grew
    // after the shot count was chosen — which is exactly what the density
    // refusal's button produces — must not dispatch the shot count it is still
    // holding.
    const spec = specOf(
      {
        ...INITIAL_NOISE,
        enabled: true,
        method: 'trajectories',
        shots: 2000,
      },
      MAX_DENSITY_CLIENT_QUBITS + 4,
      25
    )
    expect(spec).not.toBeNull()
    expect(spec?.shots).toBeLessThan(2000)
    expect(spec?.shots).toBeGreaterThanOrEqual(MIN_TRAJECTORY_SHOTS)
  })
})
