/**
 * What the noise panel owns, and the arithmetic between a datasheet and a
 * channel — §3.3.
 *
 * No React, no i18next, no three.js: the same split `histogram.ts` and
 * `bloch.ts` make. The physics is upstream of all of it — `@qsim/core`'s
 * `noise.ts` derives every Kraus operator from §5.4, checks each channel is
 * trace-preserving, and turns T1, T2 and a gate duration into γ and λ. What is
 * left here is the panel's own state and the unit conversion around it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CONTROLS ARE IN THE UNITS A PROFILE IS WRITTEN IN.
 *
 * A reader who has looked at a device's calibration page has seen "T1 = 100 µs,
 * two-qubit gate error 0.8 %". Nobody has ever seen "γ = 3.5e-4", and nobody
 * should have to: the depolarising parameter of a gate is a derived quantity
 * three formulas downstream of the number the hardware publishes, and a panel
 * that asked for it directly would be asking the reader to do the derivation
 * `relaxationFor` and `depolarizingFromGateError` already do — and to do it
 * before they have any idea what the answer should look like.
 *
 * So the eight fields here are the eight a datasheet has, in the units a
 * datasheet uses: coherence times in microseconds, gate times in nanoseconds,
 * error rates and readout errors as percentages. The engine's own struct is in
 * nanoseconds and fractions throughout, and the conversion is exactly this
 * module — one place, tested in both directions, so a factor of a thousand
 * cannot hide in a component.
 *
 * WHY MICROSECONDS AND NOT NANOSECONDS FOR T1 AND T2. `NoiseProfile` is
 * emphatic that every duration is nanoseconds and says so in each field name,
 * because a profile mixing units would produce channel parameters wrong by
 * three orders of magnitude while still returning a valid ρ. That rule is about
 * the *struct*, and it is what makes this conversion safe to write once: on
 * screen, a transmon's T1 is 100 and a trapped ion's is 10 000 000, where in
 * nanoseconds they are 100 000 and 10 000 000 000 — nine digits nobody can
 * read, in a field where a missing zero is a tenfold error in the physics.
 *
 * ────────────────────────────────────────────────────────────────────────
 * INFINITY IS A PROFILE, NOT A FORM VALUE.
 *
 * `ideal` writes T1 = T2 = Infinity, which is the honest way to say "this
 * profile has no relaxation" and is what makes it a point in the same space as
 * the others rather than a special case. There is no way to type it into a
 * number field, and there is no need: `ideal` is a *preset*, and the custom
 * form opens on `NOISE_PROFILES.custom`, which the engine put there for exactly
 * this — "the panel opens on something plausible and every slider has somewhere
 * sensible to start". A form seeded from a profile with a non-finite duration
 * falls back to that preset's value for that field alone, so the reader lands
 * on a device rather than on an empty box.
 */

import {
  MAX_ONE_QUBIT_GATE_ERROR,
  MAX_TWO_QUBIT_GATE_ERROR,
  NOISE_PROFILES,
  NoiseProfileError,
  customProfile,
  validateProfile,
  type NoiseProfile,
  type NoiseProfileId,
  type NoiseProfileValues,
} from '@qsim/core'

import {
  MAX_DENSITY_CLIENT_QUBITS,
  clampShots,
  maxTrajectoryShots,
  trajectoriesFit,
  type NoiseMethod,
  type NoiseSpec,
} from '../simulation/protocol'

/** Nanoseconds in a microsecond. Written once, used in both directions. */
const NS_PER_US = 1000

/**
 * The eight datasheet numbers, in datasheet units.
 *
 * Every field name carries its unit for the reason `NoiseProfile`'s do: this
 * struct and that one hold the same eight quantities in different units, and
 * the only thing standing between them is `valuesOf` below.
 */
export interface ProfileForm {
  /** T1, the energy relaxation time, in microseconds. */
  readonly t1Us: number
  /** T2, the total coherence time, in microseconds. Bounded by 2·T1. */
  readonly t2Us: number
  readonly oneQubitGateNs: number
  readonly twoQubitGateNs: number
  /** Average error per one-qubit gate, as a percentage. */
  readonly oneQubitGateErrorPercent: number
  /** Average error per two-qubit gate, as a percentage. */
  readonly twoQubitGateErrorPercent: number
  /** P(read 1 | prepared 0), as a percentage. */
  readonly readoutP0to1Percent: number
  /** P(read 0 | prepared 1), as a percentage. */
  readonly readoutP1to0Percent: number
}

/** One control in the custom-profile form. */
export interface NoiseFieldSpec {
  /** Names the catalog block: `noise.field.<id>.{label,unit,help}`. */
  readonly id: keyof ProfileForm
  /** The engine field this one becomes, and the one an error names. */
  readonly profileField: keyof NoiseProfileValues
  readonly min: number
  readonly max: number
  readonly step: number
}

/**
 * The form, in the order a datasheet prints it: what the qubit can hold, how
 * fast the gates are, how well they work, how well it can be read.
 *
 * The bounds are the widest values that are still a device rather than a typo.
 * T1 tops out at ten seconds because that is a trapped ion's, which is the
 * slowest, most coherent technology `NOISE_PROFILES` models; the two-qubit gate
 * tops out at a millisecond for the same reason. They are `max` attributes on a
 * number input rather than clamps, so a reader who types past one is told by
 * the field instead of having their number silently rewritten — and
 * `validateProfile` is what has the final say either way.
 *
 * THE TWO GATE ERRORS DO NOT TOP OUT AT 100 %, and that bound is the engine's
 * rather than a matter of taste. A benchmarked gate error becomes a depolarising
 * parameter, and the conversion saturates: r = p/2 on one qubit puts the worst
 * case at 50 %, and D_p ⊗ D_p on a pair puts it at 75 %. Above those the model
 * has nothing left to say, so it refuses — and these `max` attributes are the
 * same numbers, taken from the engine so the field and the refusal cannot drift
 * apart. The readout errors keep their 100 %: a classifier that is always wrong
 * is a perfectly expressible detector.
 */
export const NOISE_FIELDS: readonly NoiseFieldSpec[] = [
  { id: 't1Us', profileField: 't1Ns', min: 0.001, max: 1e7, step: 0.1 },
  { id: 't2Us', profileField: 't2Ns', min: 0.001, max: 2e7, step: 0.1 },
  {
    id: 'oneQubitGateNs',
    profileField: 'oneQubitGateNs',
    min: 0,
    max: 1e6,
    step: 1,
  },
  {
    id: 'twoQubitGateNs',
    profileField: 'twoQubitGateNs',
    min: 0,
    max: 1e6,
    step: 1,
  },
  {
    id: 'oneQubitGateErrorPercent',
    profileField: 'oneQubitGateError',
    min: 0,
    max: MAX_ONE_QUBIT_GATE_ERROR * 100,
    step: 0.01,
  },
  {
    id: 'twoQubitGateErrorPercent',
    profileField: 'twoQubitGateError',
    min: 0,
    max: MAX_TWO_QUBIT_GATE_ERROR * 100,
    step: 0.01,
  },
  {
    id: 'readoutP0to1Percent',
    profileField: 'readoutP0to1',
    min: 0,
    max: 100,
    step: 0.01,
  },
  {
    id: 'readoutP1to0Percent',
    profileField: 'readoutP1to0',
    min: 0,
    max: 100,
    step: 0.01,
  },
]

/** The engine field a form field becomes — for marking the input that failed. */
export function fieldFor(
  profileField: keyof NoiseProfileValues
): keyof ProfileForm | null {
  return (
    NOISE_FIELDS.find((field) => field.profileField === profileField)?.id ??
    null
  )
}

/**
 * A profile as the form shows it.
 *
 * Non-finite durations fall back to `NOISE_PROFILES.custom`, per the header:
 * `ideal`'s Infinity is a valid profile and not a typeable number.
 */
export function formOf(values: NoiseProfileValues): ProfileForm {
  const fallback = NOISE_PROFILES.custom
  return {
    t1Us: microseconds(values.t1Ns, fallback.t1Ns),
    t2Us: microseconds(values.t2Ns, fallback.t2Ns),
    oneQubitGateNs: values.oneQubitGateNs,
    twoQubitGateNs: values.twoQubitGateNs,
    oneQubitGateErrorPercent: percent(values.oneQubitGateError),
    twoQubitGateErrorPercent: percent(values.twoQubitGateError),
    readoutP0to1Percent: percent(values.readoutP0to1),
    readoutP1to0Percent: percent(values.readoutP1to0),
  }
}

/**
 * The form as the engine takes it.
 *
 * The round trip through `formOf` is exact to within Float64 rounding and not
 * to the last bit: 3e-4 becomes 0.03 and 0.03/100 is 0.00030000000000000003,
 * a difference of 3e-20 in a channel parameter — some fifteen orders of
 * magnitude below anything a gate error means. The tests assert closeness
 * rather than equality for that reason, and say so.
 */
export function valuesOf(form: ProfileForm): NoiseProfileValues {
  return {
    t1Ns: form.t1Us * NS_PER_US,
    t2Ns: form.t2Us * NS_PER_US,
    oneQubitGateNs: form.oneQubitGateNs,
    twoQubitGateNs: form.twoQubitGateNs,
    oneQubitGateError: fraction(form.oneQubitGateErrorPercent),
    twoQubitGateError: fraction(form.twoQubitGateErrorPercent),
    readoutP0to1: fraction(form.readoutP0to1Percent),
    readoutP1to0: fraction(form.readoutP1to0Percent),
  }
}

/* ─────────────────────────── what the panel holds ───────────────────── */

/** Everything the noise panel owns. Held by the simulation panel, which sends it. */
export interface NoiseSettings {
  /**
   * Nothing is simulated twice until this is true.
   *
   * §3.3 is a second run of the whole circuit — the exact method evolves 4ⁿ
   * numbers — so it is off until asked for, exactly as shot sampling is and for
   * the same reason (§5.3): a simulator has no business spending a reader's
   * battery on a question they did not ask.
   */
  readonly enabled: boolean
  readonly profileId: NoiseProfileId
  /** The custom profile's own numbers, kept while a preset is selected. */
  readonly form: ProfileForm
  readonly readout: boolean
  readonly method: NoiseMethod
  readonly shots: number
  /** Bumped by "draw again": a different sample of the same noise model. */
  readonly seed: number
  /** The density heat map of §3.2 — advanced mode, off until asked for. */
  readonly advanced: boolean
}

/**
 * Where the panel opens: off, on the profile §3.3 wrote for teaching, with the
 * exact method and readout error on.
 *
 * `teaching` rather than `superconducting` because §3.3 is a study mode. On a
 * good device a ten-gate lesson circuit loses about one part in a thousand,
 * which is invisible on a histogram and teaches nobody anything — the preset
 * exists precisely so that a Bell pair visibly stops being a Bell pair inside a
 * lesson, and opening on it means the first thing a reader sees after ticking
 * the box is the effect they came for.
 */
export const INITIAL_NOISE: NoiseSettings = {
  enabled: false,
  profileId: 'teaching',
  form: formOf(NOISE_PROFILES.custom),
  readout: true,
  method: 'density',
  shots: 2000,
  seed: 1,
  advanced: false,
}

/**
 * The profile these settings describe — a preset, or the custom one built from
 * the form.
 *
 * Throws `NoiseProfileError` for a form that is not physical, which is exactly
 * what `noiseErrorOf` below turns into a marked field. It is not caught here
 * because a caller that wanted a profile and got a lie would be worse off than
 * one that got an exception.
 */
export function profileOf(settings: NoiseSettings): NoiseProfile {
  if (settings.profileId !== 'custom') return NOISE_PROFILES[settings.profileId]
  return customProfile(NOISE_PROFILES.custom, valuesOf(settings.form))
}

/** The form field a profile is unphysical in, or null when it is fine. */
export function noiseErrorOf(
  settings: NoiseSettings
): keyof ProfileForm | null {
  try {
    validateProfile(profileOf(settings))
    return null
  } catch (cause) {
    if (cause instanceof NoiseProfileError) return fieldFor(cause.field)
    // Anything else is a bug in this module rather than a number the reader
    // typed, and marking an arbitrary input for it would send them hunting.
    // The panel reports it as "this profile is not physical" without a field.
    return null
  }
}

/** Whether these settings describe a profile the engine will accept at all. */
export function noiseIsValid(settings: NoiseSettings): boolean {
  try {
    validateProfile(profileOf(settings))
    return true
  } catch {
    return false
  }
}

/* ──────────────────────────────── the ceiling ───────────────────────── */

/**
 * Whether a register of this size can have a ρ built for it — §3.3's ceiling,
 * asked *before* anything is requested.
 *
 * Checked here as well as on the worker, and both are wanted for the reason the
 * qubit ceiling is checked twice (`job.ts`): this copy decides what the panel
 * offers a reader, and the worker's is the side that would do the allocating.
 * The difference between them is that this one can answer without a round trip,
 * so a thirteen-qubit circuit gets its refusal and its alternative in the same
 * frame the reader ticks the box — never a tab that thinks for a while and then
 * freezes.
 */
export function densityFits(qubits: number): boolean {
  return qubits <= MAX_DENSITY_CLIENT_QUBITS
}

/**
 * Shots this circuit's sampled run may draw — `settings.shots`, or the most the
 * register and the circuit length can afford, whichever is smaller.
 *
 * THE CAP IS SHOWN, NOT APPLIED IN SILENCE. `NoisePanel` limits the slider to
 * this value and prints the sentence saying why, so the number under the slider
 * is the number that runs. The clamp here is the second line of the same
 * defence — a settings object restored from a URL, or one whose register grew
 * after the shot count was chosen, has never been past this control.
 */
export function trajectoryShotsFor(
  settings: NoiseSettings,
  qubits: number,
  operations: number
): number {
  return Math.min(
    clampShots(settings.shots),
    maxTrajectoryShots(qubits, operations)
  )
}

/**
 * The method these settings would actually run at this size — for the exact
 * method a question about memory, for the sampled one a question about time.
 *
 * BOTH METHODS HAVE A CEILING, and for a while only one of them was checked.
 * The exact method's is 4ⁿ bytes and refuses at twelve. The sampled method's is
 * `shots × operations × 2ⁿ` *seconds*, in a worker that cannot be pre-empted —
 * so a register the density refusal sent a reader away from could arrive here,
 * be accepted at any size up to `MAX_CLIENT_QUBITS`, and stop the whole editor
 * for the better part of an hour. `trajectoriesFit` is that ceiling, asked the
 * same way and in the same place.
 *
 * The requested method is *not* silently rewritten. A reader who asked for the
 * exact answer and got a sampled one without being told would read a fidelity
 * of 0.9993 as exact when it carries an error of 1/(2√shots) — so this reports
 * what would happen and the panel refuses out loud, offering the switch as a
 * control rather than performing it.
 */
export function methodFits(
  settings: NoiseSettings,
  qubits: number,
  operations: number
): boolean {
  return settings.method === 'density'
    ? densityFits(qubits)
    : trajectoriesFit(qubits, operations)
}

/**
 * The request these settings make, or `null` when there is nothing to ask for.
 *
 * Four ways to get nothing, and each of them is a state the panel explains in
 * words rather than a silent no-op: the mode is off, the circuit is past the
 * ceiling for the method chosen, the profile is not physical, or the profile is
 * `ideal` — where the noisy run would be the ideal run, bit for bit, and §3.3's
 * comparison would be a chart of a distribution against itself.
 *
 * `operations` is required rather than defaulted, for the reason `sample` and
 * `noise` are required fields on a request: the sampled method's cost is linear
 * in the circuit's length, and a call site that forgot to say how long the
 * circuit is would be asking the ceiling to judge an empty one.
 */
export function specOf(
  settings: NoiseSettings,
  qubits: number,
  operations: number
): NoiseSpec | null {
  if (!settings.enabled) return null
  if (!methodFits(settings, qubits, operations)) return null
  if (settings.profileId === 'ideal') return null
  if (!noiseIsValid(settings)) return null
  return {
    profile: profileOf(settings),
    readout: settings.readout,
    method: settings.method,
    shots: trajectoryShotsFor(settings, qubits, operations),
    seed: settings.seed,
  }
}

/* ──────────────────────────────── internals ─────────────────────────── */

function microseconds(nanoseconds: number, fallbackNs: number): number {
  const value = Number.isFinite(nanoseconds) ? nanoseconds : fallbackNs
  return value / NS_PER_US
}

function percent(fraction_: number): number {
  return fraction_ * 100
}

function fraction(percent_: number): number {
  return percent_ / 100
}
