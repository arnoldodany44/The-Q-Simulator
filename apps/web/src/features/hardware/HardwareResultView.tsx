/**
 * A stored hardware run, rendered whole — §3.7.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE STORED PATH IS THE FIRST-CLASS PATH
 *
 * A queue on a shared device is hours deep and is not something to gamble a
 * demonstration on. So the intended use of this view is: submit a job the day
 * before, open its address the next morning, and present the saved answer —
 * which means **nothing here may need the provider**. One `GET` for one row is
 * the whole of the network, and the row carries everything: the transpiled
 * program that ran, the layout it ran on, the counts that came back, the
 * calibration timestamp and the two ends of the wait.
 *
 * The first two columns are recomputed in this tab, and that is not a hidden
 * round trip: the ideal statevector and a noise model of a two-qubit circuit are
 * milliseconds of arithmetic in a worker that is already running, they are
 * deterministic, and they work with no network at all. What is never recomputed
 * is anything about the *device* — re-transpiling now would place the circuit
 * against today's calibration while the samples came from the qubits chosen
 * yesterday, which is the silent wrongness this whole milestone is arranged to
 * avoid.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT IS SHOWN WHEN THERE IS NO COMPARISON TO SHOW
 *
 * Four states, and none of them is a blank page:
 *
 *   *still running*   the status, and what it means in queue terms. The program
 *                     is already stored, so the "what was drawn, what ran"
 *                     section is on screen before the device has answered —
 *                     which is the half of the lesson that never needed a result.
 *   *failed*          the failure code as a sentence, plus the same section.
 *   *unjoinable*      the circuit's measurements do not make the device's
 *                     register a relabelling of the chart's basis states
 *                     (`alignment.ts`). The counts are shown as themselves,
 *                     with the reason, rather than laid over a chart they do
 *                     not describe.
 *   *no simulation*   the tab could not simulate — the same, without the reason
 *                     being about the circuit.
 *
 * In all four the provenance is rendered, because "which chip, when, under what
 * calibration" is exactly as true of a failed run as of a finished one.
 */

import type { Statevector } from '@qsim/core'
import { HardwareJobStatus, type HardwareJob } from '@qsim/contract'
import type { Circuit } from '@qsim/schema'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { formatCount, formatProbability } from '../analysis/format'
import { DEFAULT_BAR_LIMIT, ket } from '../analysis/histogram'
import type { NoiseComparison } from '../analysis/noiseComparison'
import { DeviceProvenance } from './DeviceProvenance'
import { ExecutedProgram } from './ExecutedProgram'
import { HardwareComparisonPanel } from './HardwareComparisonPanel'
import { driftOf, type VersionDrift } from './drift'
import {
  alignMeasurements,
  distributionFromCounts,
  type AlignmentRefusal,
} from './alignment'
import { buildHardwareComparison } from './comparison'
import type { IdealRefusal } from './ideal'
import { compareProgram } from './program'
import { provenanceOf } from './provenance'

export interface HardwareResultViewProps {
  /** The stored job. Everything about the device comes from here and nowhere else. */
  readonly job: HardwareJob
  /** The circuit the job belongs to, or null when it could not be loaded. */
  readonly circuit: Circuit | null
  /** The ideal state of that circuit, from this tab's worker. */
  readonly state: Statevector | null
  /** §3.3's comparison, when a noise model was run beside it. */
  readonly noise: NoiseComparison | null
  /** The noisy distribution over every basis state, when the exact method ran. */
  readonly noisyDistribution: Float64Array | null
  /**
   * Why this circuit has no single ideal state, when it has none (`ideal.ts`).
   *
   * Decided by the caller rather than here, because the caller is what fed the
   * circuit to a simulator and had to make the same decision to know what to
   * feed it. Two answers to that question would eventually be two different
   * answers.
   */
  readonly idealRefusal?: IdealRefusal | null
  /** Whether the local simulation is still in flight. */
  readonly simulating?: boolean
  readonly barLimit?: number
  /**
   * The id of the circuit version `circuit` is, when the caller knows it.
   *
   * Compared against `job.program.versionId` — the version that was actually
   * transpiled and sent — and a mismatch stops the first two columns being
   * drawn at all. See `driftOf` for why that is a refusal rather than a
   * footnote.
   */
  readonly currentVersionId?: string | null
  /**
   * Which noise profile produced the modelled column, for the sentence that
   * describes it. Named rather than assumed: this page lets the reader change
   * the profile, and a fixed claim about transmon coherence stops being true
   * the moment they do.
   */
  readonly noiseProfileName?: string | null
}

export function HardwareResultView({
  job,
  circuit,
  state,
  noise,
  noisyDistribution,
  idealRefusal = null,
  simulating = false,
  barLimit = DEFAULT_BAR_LIMIT,
  currentVersionId = null,
  noiseProfileName = null,
}: HardwareResultViewProps) {
  const { t } = useTranslation('hardware')
  const provenance = useMemo(() => provenanceOf(job), [job])
  const drift = driftOf(job, currentVersionId)

  return (
    <div className="hardware-result">
      <header className="hardware-result__header">
        <h2 className="hardware-result__title">{t('job.title')}</h2>
        <p className="hardware-result__subtitle">
          {t('job.subtitle', { backend: job.backend })}
        </p>
      </header>

      {drift === 'changed' ? (
        /*
         * At the top, and `role="alert"`, because every number below it would
         * otherwise be read as a statement about the device.
         */
        <p className="notice notice--warning" role="alert">
          {t('job.circuitChanged')}
        </p>
      ) : null}

      <Reading
        job={job}
        circuit={circuit}
        state={state}
        noise={noise}
        noisyDistribution={noisyDistribution}
        idealRefusal={idealRefusal}
        simulating={simulating}
        barLimit={barLimit}
        drift={drift}
        noiseProfileName={noiseProfileName}
      />

      {job.program === null || drift === 'changed' ? null : (
        /*
         * Rendered from the *stored* program whenever there is one, including
         * while the device is still working: what the transpiler did to the
         * circuit is knowable the moment the job is submitted, and it is the
         * half of §3.7's lesson that does not need a result.
         *
         * Not rendered under drift, because this section is a comparison too —
         * "1 drawn gate became 7 on the device" is the current document counted
         * against a program built from a different one, and the reader would
         * take the difference for the transpiler's doing.
         */
        <ProgramSection job={job} circuit={circuit} />
      )}

      <DeviceProvenance provenance={provenance} />
    </div>
  )
}

/* ─────────────────────────── the three columns ──────────────────────── */

/**
 * Why this panel is not drawing three columns, when it is not.
 *
 * `AlignmentRefusal`'s three are facts about the circuit; these two are facts
 * about the run, and they are kept apart because the sentences point somewhere
 * else. "Your measurements do not make a relabelling" sends somebody to the
 * editor; "these counts are not this program's" and "the circuit has changed"
 * send them somewhere else entirely.
 */
type ReadingRefusal = AlignmentRefusal | 'register-mismatch' | 'circuit-changed'

type ReadingAlignment =
  | { readonly ok: true; readonly qubitOfClbit: readonly number[] }
  | { readonly ok: false; readonly code: ReadingRefusal }

function Reading({
  job,
  circuit,
  state,
  noise,
  noisyDistribution,
  idealRefusal,
  simulating,
  barLimit,
  drift,
  noiseProfileName,
}: Required<
  Pick<
    HardwareResultViewProps,
    | 'job'
    | 'circuit'
    | 'state'
    | 'noise'
    | 'noisyDistribution'
    | 'idealRefusal'
    | 'simulating'
    | 'barLimit'
    | 'noiseProfileName'
  >
> & { readonly drift: VersionDrift }) {
  const { t } = useTranslation('hardware')
  const { result } = job

  /*
   * A DONE job whose counts are empty. Rare and not impossible — the schema
   * accepts `{}` — and it needs a branch of its own rather than falling through
   * the alignment, for two reasons. A distribution of all zeros does not sum to
   * one, so `distributionFidelity` throws on it and the throw would land inside
   * a render; and the alignment would refuse an empty register with
   * "unmeasured qubit", which is a sentence about the *circuit* for a problem
   * that is entirely about the answer.
   */
  const shots = result === null ? 0 : shotsOf(result.counts)

  const aligned = useMemo(
    () => resolveAlignment(job, circuit, shots),
    [job, circuit, shots]
  )

  const comparison = useMemo(() => {
    if (drift === 'changed') return null
    if (result === null || state === null || aligned === null || !aligned.ok) {
      return null
    }
    /*
     * The register the counts are keyed by has to be the register the chart
     * draws. The alignment already tied it to the register the *program*
     * declared; this ties it to the *state* the caller handed in, which is the
     * one thing this component cannot check for itself. A mismatch would put a
     * bit past the end of the distribution, where `?? 0` would swallow it and
     * the chart would quietly lose shots.
     */
    if (aligned.qubitOfClbit.length !== state.qubits) return null

    /*
     * `basisIndexOf` refuses a key of the wrong width, and refusing is right —
     * it means the counts belong to a different job. What was wrong was where
     * the refusal landed: a `throw` inside a render-path `useMemo`, in an app
     * whose only error boundary wraps the three.js scene, blanked the whole
     * page. `widthOf` reads the first key only, so a stored result with keys of
     * mixed width — which both validators accept — reached it. Caught here and
     * turned into the same kind of refusal every other branch produces.
     */
    let real: Float64Array
    try {
      real = distributionFromCounts(
        result.counts,
        state.qubits,
        aligned.qubitOfClbit
      )
    } catch {
      return null
    }
    return buildHardwareComparison(
      state,
      real,
      shots,
      noise,
      noisyDistribution,
      barLimit
    )
  }, [drift, result, state, aligned, shots, noise, noisyDistribution, barLimit])

  if (result === null) return <Pending job={job} />

  if (comparison !== null && state !== null) {
    return (
      <HardwareComparisonPanel
        state={state}
        comparison={comparison}
        backend={job.backend}
        barLimit={barLimit}
        noiseProfileName={noiseProfileName}
      />
    )
  }

  /*
   * There is a result and no comparison. Say which of the reasons it is, then
   * show the counts as themselves — a device's answer is worth reading even
   * when it cannot be laid over a chart, and it is the only artefact on this
   * page that cost quantum time.
   */
  return (
    <section className="hardware-comparison hardware-comparison--refused">
      <h3 className="hardware-comparison__heading">
        {t('comparison.refused.heading')}
      </h3>
      <p className="hardware-comparison__lead">
        {reasonFor({
          circuit,
          aligned,
          idealRefusal,
          simulating,
          shots,
          drift,
          counts: result.counts,
          state,
          t,
        })}
      </p>
      <p className="hardware-comparison__note">
        {t('comparison.refused.note')}
      </p>
      <DeviceCounts counts={result.counts} />
    </section>
  )
}

/**
 * Which qubit each classical bit of the device's answer holds.
 *
 * ── THE FROZEN MAP WINS, ALWAYS ──────────────────────────────────────────
 *
 * The device's keys are the classical register of the **submitted** program,
 * so the mapping that turns one into a basis state has to come from the
 * document that was submitted. Re-deriving it from the document as it is *now*
 * is how one drag in the editor — rewiring `c[0]=measure q0` to
 * `c[2]=measure q0`, same qubits, same clbits, same gate counts — silently
 * moves every bar of the device's column to a different basis state. Nothing
 * refuses it: the re-derived map is still a valid bijection, the alignment
 * still answers `ok`, and there is no ideal distribution beside a hardware
 * result that could notice.
 *
 * So `program.qubitOfClbit`, written into the row at submission, is the
 * authority. `alignMeasurements` is the fallback for rows written before that
 * field existed, and it is the same computation applied to today's document —
 * correct when the circuit has not moved, which is what `driftOf` is for.
 */
function resolveAlignment(
  job: HardwareJob,
  circuit: Circuit | null,
  shots: number
): ReadingAlignment | null {
  const { result } = job
  if (result === null || shots === 0) return null
  const width = widthOf(result.counts)

  const frozen = job.program?.qubitOfClbit
  if (frozen !== undefined) {
    if (frozen.length !== width) {
      /*
       * The counts are not the register the submitted program declared. Its
       * own reason, because every other refusal on this panel is a sentence
       * about the *circuit* and this one is a fact about the answer: these
       * counts do not belong to this job.
       */
      return { ok: false, code: 'register-mismatch' }
    }
    return { ok: true, qubitOfClbit: frozen }
  }

  if (circuit === null) return null
  return alignMeasurements(circuit, width)
}

/**
 * Which of the five reasons there is no comparison, as a sentence.
 *
 * Ordered from the most specific cause to the least, because they can hold at
 * once — a circuit that could not be loaded also could not be simulated — and
 * the reader is owed the one that is actually actionable. "The circuit could
 * not be loaded" is a different problem from "this circuit has no ideal state",
 * and reporting the second when the first is true would send somebody to redraw
 * a perfectly good circuit.
 */
function reasonFor({
  circuit,
  aligned,
  idealRefusal,
  simulating,
  shots,
  drift,
  counts,
  state,
  t,
}: {
  readonly circuit: Circuit | null
  readonly aligned: ReadingAlignment | null
  readonly idealRefusal: IdealRefusal | null
  readonly simulating: boolean
  readonly shots: number
  readonly drift: VersionDrift
  readonly counts: Readonly<Record<string, number>>
  readonly state: Statevector | null
  readonly t: (key: string) => string
}): string {
  // First of all, because it is a fact about the answer rather than about the
  // circuit, and every sentence below would blame the circuit.
  if (shots === 0) return t('comparison.refused.noCounts')
  /*
   * Second, because it outranks every sentence about the circuit *on screen*:
   * those describe a document the device never ran.
   */
  if (drift === 'changed') return t('comparison.refused.circuit-changed')
  if (circuit === null) return t('job.circuitMissing')
  if (idealRefusal !== null) return t(`comparison.refused.${idealRefusal}`)
  if (aligned !== null && !aligned.ok) {
    return t(`comparison.refused.${aligned.code satisfies ReadingRefusal}`)
  }
  /*
   * The register is a relabelling and the simulation ran, so what is left is a
   * width the chart cannot hold: the device answered on a register of a
   * different size from the state being drawn, or a key inside the counts is
   * not the width of the rest of them. Both mean the counts do not belong to
   * this chart, which is the same sentence.
   */
  if (
    aligned !== null &&
    aligned.ok &&
    state !== null &&
    (aligned.qubitOfClbit.length !== state.qubits ||
      Object.keys(counts).some(
        (key) => key.length !== aligned.qubitOfClbit.length
      ))
  ) {
    return t('comparison.refused.register-mismatch')
  }
  return simulating ? t('job.simulating') : t('job.simulationFailed')
}

/** The device's own answer, in its own register, with nothing laid over it. */
function DeviceCounts({
  counts,
}: {
  readonly counts: Readonly<Record<string, number>>
}) {
  const { t, i18n } = useTranslation('hardware')
  const language = i18n.language
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  // Sorted by outcome rather than by frequency, so the table has a fixed
  // address per row — the same ruling `buildHistogram` makes about its bars.
  const rows = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))

  return (
    <table className="hardware-counts">
      <caption>{t('comparison.deviceCounts.heading')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('comparison.deviceCounts.outcome')}</th>
          <th scope="col">{t('comparison.deviceCounts.count')}</th>
          <th scope="col">{t('comparison.deviceCounts.share')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, count]) => (
          <tr key={key}>
            <th scope="row">
              <Notation value={ket(key)} />
            </th>
            <td className="tabular-numbers">{formatCount(count, language)}</td>
            <td className="tabular-numbers">
              {formatProbability(total === 0 ? 0 : count / total, language)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* ─────────────────────── not finished, or finished badly ────────────── */

function Pending({ job }: { readonly job: HardwareJob }) {
  const { t } = useTranslation('hardware')
  const failed = job.status === HardwareJobStatus.FAILED

  return (
    <section className="hardware-result__pending">
      <h3 className="hardware-result__pending-heading">
        {failed ? t('failure.heading') : t('status.heading')}
      </h3>
      <p className="hardware-result__pending-body">
        {failed
          ? failureSentence(t, job.error)
          : t(`status.${job.status}`, { backend: job.backend })}
      </p>
    </section>
  )
}

/**
 * A stored failure code as a sentence.
 *
 * The code is what the worker wrote, never prose (D2 — `@qsim/jobs` argues it:
 * a sentence in a column is an English sentence on a French screen, outside
 * every catalog parity test). A code this build has no name for still produces
 * a sentence, carrying the code, because "something went wrong" without the
 * word the provider's console also uses leaves a reader with nothing to search
 * for.
 */
function failureSentence(
  t: (key: string, options?: Record<string, unknown>) => string,
  code: string | null
): string {
  if (code === null) return t('failure.unknown', { code: '—' })
  const sentence = t(`failure.${code}`, { defaultValue: '' })
  return sentence === '' ? t('failure.unknown', { code }) : sentence
}

/* ───────────────────────── drawn against executed ───────────────────── */

function ProgramSection({
  job,
  circuit,
}: {
  readonly job: HardwareJob
  readonly circuit: Circuit | null
}) {
  const program = job.program
  const comparison = useMemo(
    () =>
      program === null || circuit === null
        ? null
        : compareProgram(circuit, program.qasm, program.layout),
    [program, circuit]
  )

  if (program === null || comparison === null) return null

  return (
    <ExecutedProgram
      comparison={comparison}
      qasm={program.qasm}
      backend={job.backend}
      layout={program.layout}
    />
  )
}

/* ──────────────────────────────── internals ─────────────────────────── */

/**
 * How wide the device's register is, read from the counts themselves.
 *
 * The stored program carries `clbits` and would be the obvious source, but the
 * counts are what is being drawn — so the width that matters is theirs, and
 * taking it from the other field would let a program and a result that
 * disagreed produce a plausible chart instead of the refusal `basisIndexOf`
 * exists to raise. Zero for an empty result, which fails the alignment check on
 * its own rather than needing a case here.
 */
function widthOf(counts: Readonly<Record<string, number>>): number {
  for (const key of Object.keys(counts)) return key.length
  return 0
}

function shotsOf(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}
