/**
 * The noise controls — §3.3: predefined profiles that imitate real hardware,
 * plus a custom one.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CONTROLS ARE IN THE UNITS A PROFILE IS WRITTEN IN
 *
 * Every field here is one a device's calibration page has: T1 and T2 in
 * microseconds, gate times in nanoseconds, gate and readout errors as
 * percentages. Not one of them is a channel parameter. A panel asking for the
 * depolarising probability of a gate would be asking the reader to run
 * `depolarizingFromGateError` in their head, before they have any idea what the
 * answer should look like — and it would throw away the one thing a datasheet
 * number has going for it, which is that a reader can compare it with a number
 * they have seen somewhere else. `noiseSettings.ts` owns the conversion, in one
 * place, tested in both directions.
 *
 * Each field carries a sentence saying what it does, and each profile carries
 * one saying what kind of machine it is. That is the difference between a form
 * and a lesson: "T1 = 100" is a number, "T1 is how long a qubit stays excited
 * before it decays back to |0⟩" is something a reader can predict with.
 *
 * ────────────────────────────────────────────────────────────────────────
 * BOTH CEILINGS ARE SENTENCES, NEVER A FROZEN TAB
 *
 * ρ is 4ⁿ complex numbers and §3.3 tops the exact method out at twelve qubits.
 * A thirteen-qubit register asking for it is refused *here*, before a request
 * is built, before the worker allocates anything — and the refusal names the
 * register, names the limit, says why the limit exists, and offers the sampled
 * method as a button rather than as advice. The worker refuses the same case
 * independently (`noiseJob.ts`), because it is the side that would do the
 * allocating and must never be talked into it.
 *
 * The sampled method has a ceiling too, and for a while nothing here knew it.
 * Trajectories escape the 4ⁿ — they keep one statevector — but not the clock:
 * `runNoisy` restarts every shot from |0…0⟩, so a run costs shots × operations
 * × 2ⁿ, and the worker cannot be pre-empted. The way out of one ceiling was
 * therefore a way into a worse one, two clicks away and invisible, because the
 * button switches the method without touching the shot count. So this panel
 * does two things about it: the shots slider stops at what the register can
 * afford, with a sentence saying why, and a circuit that cannot afford enough
 * shots for the sample to mean anything is refused in the same shape the
 * density ceiling is.
 *
 * The method is never silently rewritten. A reader who asked for the exact
 * answer and quietly got a sampled one would read a fidelity of 0.9993 as exact
 * when it carries an error of 1/(2√shots). The same rule governs the shot cap:
 * the slider's own maximum moves, so the number under it is the number that
 * runs — a cap applied downstream of a control still showing 2000 would be the
 * same lie one field over.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE EXACT METHOD'S COST IS STATED BEFORE IT IS PAID
 *
 * At the top of §3.3's promised range the exact method is not slow-ish: eleven
 * qubits is some twelve seconds and twelve is some thirty-seven, and every
 * scrub step pays it again in full, because there is no ρ counterpart to the
 * statevector's checkpoint cache. `noise.perf.test.ts` puts it plainly —
 * "twelve is a wait the UI has to be honest about" — and aria-busy is not
 * honesty. A notice appears from the size the wait becomes seconds.
 *
 * ────────────────────────────────────────────────────────────────────────
 * NOTHING IS SIMULATED TWICE UNTIL SOMEBODY ASKS
 *
 * The noise mode is a second run of the whole circuit, and the exact method
 * evolves 4ⁿ numbers to do it. So it is off until the box is ticked — the same
 * ruling the shots control makes, and §5.3's reason: a simulator has no
 * business spending a reader's battery on a question they did not ask.
 */

import { NOISE_PROFILE_IDS, type NoiseProfileId } from '@qsim/core'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import {
  MAX_DENSITY_CLIENT_QUBITS,
  MAX_SHOTS,
  MIN_TRAJECTORY_SHOTS,
  maxTrajectoryShots,
  trajectoriesFit,
} from '../simulation/protocol'
import { formatCount } from './format'
import {
  NOISE_FIELDS,
  densityFits,
  noiseErrorOf,
  type NoiseFieldSpec,
  type NoiseSettings,
  type ProfileForm,
} from './noiseSettings'
import { SHOT_STOPS, shotsAtStop, stopForShots } from './sampling'

/**
 * The register from which the exact method's own cost is worth a sentence.
 *
 * Measured in `noise.perf.test.ts` on a teaching-sized circuit: ten qubits is
 * about two seconds, eleven about twelve, twelve about thirty-seven. Two
 * seconds is where a live editor stops feeling live, so the notice starts at
 * ten — one qubit below the point where the wait becomes the dominant fact
 * about the panel.
 */
const DENSITY_SLOW_QUBITS = 10

export interface NoisePanelProps {
  readonly settings: NoiseSettings
  readonly onChange: (settings: NoiseSettings) => void
  /** The register the circuit on screen declares — what the ceiling is about. */
  readonly qubits: number
  /**
   * How many operations the circuit on screen has.
   *
   * Required rather than defaulted: a sampled run's cost is linear in it, so a
   * caller that omitted it would be asking the sampled ceiling to judge an
   * empty circuit — the one shape whose cost is easiest to under-estimate.
   */
  readonly operations: number
}

export function NoisePanel({
  settings,
  onChange,
  qubits,
  operations,
}: NoisePanelProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const headingId = useId()
  const profileId = useId()
  const shotsId = useId()

  const invalidField = noiseErrorOf(settings)
  const sampled = settings.method === 'trajectories'
  const refused = settings.method === 'density' && !densityFits(qubits)
  const sampledRefused = sampled && !trajectoriesFit(qubits, operations)
  /*
   * The most shots this circuit can afford, and therefore the largest number
   * the slider may express. Read here rather than clamped in `specOf` alone,
   * because a control that let a reader choose two thousand while the run drew
   * a hundred and forty-seven would be printing a shot count that is not the
   * one the fidelity beside it came from.
   */
  const shotCeiling = maxTrajectoryShots(qubits, operations)
  const maxStop = stopForShots(shotCeiling)
  const shots = Math.min(settings.shots, shotCeiling)
  const slowExact =
    settings.method === 'density' &&
    densityFits(qubits) &&
    qubits >= DENSITY_SLOW_QUBITS

  return (
    <section className="noise" aria-labelledby={headingId}>
      <h4 id={headingId} className="noise__heading">
        {t('noise.heading')}
      </h4>
      <p className="noise__intro">{t('noise.intro')}</p>

      <label className="noise__toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => {
            onChange({ ...settings, enabled: event.target.checked })
          }}
        />
        {t('noise.enable')}
      </label>

      {settings.enabled ? (
        <div className="noise__controls">
          <div className="noise__row">
            <label className="noise__label" htmlFor={profileId}>
              {t('noise.profile.label')}
            </label>
            <select
              id={profileId}
              className="noise__select"
              value={settings.profileId}
              onChange={(event) => {
                onChange({
                  ...settings,
                  profileId: event.target.value as NoiseProfileId,
                })
              }}
            >
              {NOISE_PROFILE_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(profileNameKey(id))}
                </option>
              ))}
            </select>
          </div>
          <p className="noise__help">{t(profileHelpKey(settings.profileId))}</p>

          {settings.profileId === 'custom' ? (
            <fieldset className="noise__fields">
              <legend className="noise__legend">
                {t('noise.custom.legend')}
              </legend>
              {NOISE_FIELDS.map((field) => (
                <ProfileField
                  key={field.id}
                  field={field}
                  form={settings.form}
                  invalid={invalidField === field.id}
                  onChange={(value) => {
                    onChange({
                      ...settings,
                      form: { ...settings.form, [field.id]: value },
                    })
                  }}
                />
              ))}
            </fieldset>
          ) : null}

          {/*
           * A live region, unlike everything else in this panel. The rest
           * changes because the reader moved it and is announced by the control
           * that moved; this appears *because of* what they typed, several
           * fields away from where they typed it — a T2 above 2·T1 is a
           * statement about the pair, and the field it marks may be off screen.
           */}
          <p className="noise__invalid" role="status">
            {invalidField === null ? '' : t('noise.custom.invalid')}
          </p>

          <label className="noise__toggle">
            <input
              type="checkbox"
              checked={settings.readout}
              onChange={(event) => {
                onChange({ ...settings, readout: event.target.checked })
              }}
            />
            {t('noise.readout.label')}
          </label>
          <p className="noise__help">{t('noise.readout.help')}</p>

          <fieldset className="noise__methods">
            <legend className="noise__legend">
              {t('noise.method.legend')}
            </legend>

            <label className="noise__toggle">
              <input
                type="radio"
                name={`${headingId}-method`}
                checked={settings.method === 'density'}
                onChange={() => {
                  onChange({ ...settings, method: 'density' })
                }}
              />
              {t('noise.method.density.label')}
            </label>
            <p className="noise__help">{t('noise.method.density.help')}</p>

            <label className="noise__toggle">
              <input
                type="radio"
                name={`${headingId}-method`}
                checked={settings.method === 'trajectories'}
                onChange={() => {
                  onChange({ ...settings, method: 'trajectories' })
                }}
              />
              {t('noise.method.trajectories.label')}
            </label>
            <p className="noise__help">{t('noise.method.trajectories.help')}</p>
          </fieldset>

          {refused ? (
            /*
             * The ceiling, stated. Not a disabled control with no explanation
             * and not a tab that thinks for a while: the register, the limit,
             * the reason the limit exists, and the way out — as a button,
             * because "use trajectories instead" is an action and a sentence
             * that only describes one leaves the reader to find the radio.
             */
            <div className="noise__refusal" role="status">
              <p className="noise__refusal-text">
                {t('noise.refusal.tooLarge', {
                  qubits: formatCount(qubits, language),
                  limit: formatCount(MAX_DENSITY_CLIENT_QUBITS, language),
                })}
              </p>
              <button
                type="button"
                className="noise__switch"
                onClick={() => {
                  onChange({ ...settings, method: 'trajectories' })
                }}
              >
                {t('noise.refusal.switch')}
              </button>
            </div>
          ) : null}

          {slowExact ? (
            /*
             * Not a refusal — this register is inside §3.3's promised range and
             * the answer it gives is exact. It is a warning, because the cost is
             * invisible until it has already been paid: the exact method walks
             * the whole circuit from a fresh ρ on every request, scrub steps
             * included, while the ideal half beside it resumes from a
             * checkpoint. A reader who parks the scrubber on ten columns of a
             * twelve-qubit circuit pays that ten times over, and nothing else on
             * screen says so.
             */
            <p className="noise__slow" role="status">
              {t('noise.slow.density', {
                qubits: formatCount(qubits, language),
              })}
            </p>
          ) : null}

          {sampledRefused ? (
            /*
             * The sampled method's own ceiling, in the shape the density one
             * already has: the register, the circuit, what it could afford and
             * what it would need. There is no button here because there is no
             * second way out — the exact method has a smaller ceiling still, and
             * offering it would be sending the reader in a circle. What the
             * sentence names instead is the two things a reader can actually
             * change: the length of the circuit and the width of the register.
             */
            <div className="noise__refusal" role="status">
              <p className="noise__refusal-text">
                {t('noise.refusal.tooSlow', {
                  qubits: formatCount(qubits, language),
                  operations: formatCount(operations, language),
                  shots: formatCount(shotCeiling, language),
                  limit: formatCount(MIN_TRAJECTORY_SHOTS, language),
                })}
              </p>
            </div>
          ) : null}

          {sampled && !sampledRefused ? (
            <div className="noise__row">
              <label className="noise__label" htmlFor={shotsId}>
                {t('noise.shots')}
              </label>
              {/*
               * The slider's value is a stop index, which is a number nobody has
               * been shown — hence `aria-valuetext`, exactly as the shots
               * control and the parameter editor do. Without it a screen reader
               * announces "10 of 15" for two thousand shots.
               */}
              <input
                id={shotsId}
                className="noise__slider"
                type="range"
                min={0}
                // Not `SHOT_STOPS.length - 1`. The track stops where the
                // register's time budget does, so the reader cannot ask for a
                // run the panel would then quietly shrink.
                max={Math.min(SHOT_STOPS.length - 1, maxStop)}
                step={1}
                value={Math.min(stopForShots(shots), maxStop)}
                aria-valuetext={formatCount(shots, language)}
                onChange={(event) => {
                  onChange({
                    ...settings,
                    shots: shotsAtStop(
                      Math.min(Number(event.target.value), maxStop)
                    ),
                  })
                }}
              />
              <span
                className="noise__reading tabular-numbers"
                aria-hidden="true"
              >
                {formatCount(shots, language)}
              </span>
              <button
                type="button"
                className="noise__resample"
                onClick={() => {
                  // A new seed and nothing else: the circuit, the profile and
                  // the shot count are untouched, so what changes on screen is
                  // the sample and only the sample.
                  onChange({ ...settings, seed: settings.seed + 1 })
                }}
              >
                {t('noise.resample')}
              </button>
            </div>
          ) : null}

          {sampled && !sampledRefused && shotCeiling < MAX_SHOTS ? (
            /*
             * Why the track stops short of §3.2's hundred thousand. A control
             * whose maximum moved with no explanation is the third failure §3.3
             * names — a disabled control with nothing on screen saying why —
             * and the explanation is the whole cost model in one sentence: a
             * sampled run re-runs the circuit once per shot, so the affordable
             * count falls with the register and with the circuit's length.
             */
            <p className="noise__cap">
              {t('noise.shotsCapped', {
                qubits: formatCount(qubits, language),
                operations: formatCount(operations, language),
                shots: formatCount(shotCeiling, language),
              })}
            </p>
          ) : null}

          <label className="noise__toggle">
            <input
              type="checkbox"
              checked={settings.advanced}
              disabled={settings.method !== 'density'}
              onChange={(event) => {
                onChange({ ...settings, advanced: event.target.checked })
              }}
            />
            {t('noise.advanced.label')}
          </label>
          <p className="noise__help">
            {settings.method === 'density'
              ? t('noise.advanced.help')
              : t('noise.advanced.unavailable')}
          </p>
        </div>
      ) : null}
    </section>
  )
}

interface ProfileFieldProps {
  readonly field: NoiseFieldSpec
  readonly form: ProfileForm
  readonly invalid: boolean
  readonly onChange: (value: number) => void
}

/**
 * One datasheet number.
 *
 * A number input rather than a slider, and that is about the data: T1 runs from
 * tens of microseconds on a transmon to ten million on a trapped ion, seven
 * decades, and a linear slider over that range puts every transmon in the first
 * pixel while a logarithmic one has no position a reader can name. A field
 * takes the number off the datasheet as it is written there.
 *
 * `aria-describedby` ties the sentence to the input rather than leaving it as
 * loose text after it, so a screen reader reads what the field *does* when the
 * reader arrives in it — which is the whole reason the sentence exists.
 */
function ProfileField({ field, form, invalid, onChange }: ProfileFieldProps) {
  const { t } = useTranslation('analysis')
  const inputId = useId()
  const helpId = useId()

  return (
    <div className="noise__field">
      <label className="noise__label" htmlFor={inputId}>
        {t(fieldLabelKey(field.id))}
      </label>
      <input
        id={inputId}
        className="noise__input"
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step}
        value={form[field.id]}
        aria-describedby={helpId}
        aria-invalid={invalid}
        onChange={(event) => {
          // An empty field parses as NaN, and NaN is exactly what
          // `validateProfile` refuses — so an emptied box marks itself and
          // stops the run instead of silently becoming a zero, which would be
          // a coherence time of zero and a physically different device.
          onChange(Number(event.target.value))
        }}
      />
      <span className="noise__unit">{t(fieldUnitKey(field.id))}</span>
      <p id={helpId} className="noise__help">
        {t(fieldHelpKey(field.id))}
      </p>
    </div>
  )
}

/*
 * The catalog keys, built from the ids rather than switched over.
 *
 * Eight fields with three strings each and five profiles with two would be
 * thirty-eight cases in six `switch` statements, which is the point at which a
 * lookup stops being safer than a template. The safety comes back through a
 * test instead: `noiseCatalog.test.ts` asserts that every id in
 * `NOISE_FIELDS` and every id in `NOISE_PROFILE_IDS` has each of its keys in
 * all three catalogs, and that nothing else is in those blocks — the same
 * guard `authCatalog.test.ts` gives the failure codes, and for the same reason
 * (locale parity cannot see a key that is missing from all three at once).
 */
function fieldLabelKey(id: keyof ProfileForm): string {
  return `noise.field.${id}.label`
}

function fieldUnitKey(id: keyof ProfileForm): string {
  return `noise.field.${id}.unit`
}

function fieldHelpKey(id: keyof ProfileForm): string {
  return `noise.field.${id}.help`
}

function profileNameKey(id: NoiseProfileId): string {
  return `noise.profile.${id}.name`
}

function profileHelpKey(id: NoiseProfileId): string {
  return `noise.profile.${id}.help`
}
