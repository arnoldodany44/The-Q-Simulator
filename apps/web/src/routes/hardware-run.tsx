/**
 * `/runs/:jobId` — one stored hardware run, and §3.7's three columns.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE PAGE OPENS FROM STORAGE, WHICH IS THE WHOLE POINT
 *
 * A queue on a shared device is hours deep, and a demonstration is not
 * something to gamble on one. So the intended use is: submit a job the evening
 * before, open this address the next morning, present the saved answer. That is
 * only true if the page needs **nothing from the provider**, and it needs
 * nothing: one `GET /hardware/jobs/:id` returns the row, and the row carries
 * the transpiled program, the layout, the counts, the calibration timestamp and
 * both ends of the wait.
 *
 * The first two columns are computed here, in this tab, and that is not a
 * hidden round trip — it is the same worker the editor uses, on a circuit small
 * enough to have reached a device, answering in milliseconds and offline. What
 * is never recomputed is anything about the device: re-transpiling now would
 * place the circuit against today's calibration while the samples came off the
 * qubits chosen yesterday.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE NOISE PANEL IS ON THIS PAGE, AND IT IS THE INTERACTION
 *
 * §3.3's controls are here rather than a fixed profile, because with a real
 * device in the third column they stop being a study aid and become an
 * instrument: turn the coherence and the gate errors until the middle column
 * lands on the right-hand one, and the "model against device" fidelity is the
 * score. That is the exercise §3.7 calls the most valuable lesson in quantum
 * computing today, and it is not available anywhere else in the product.
 *
 * It opens on `superconducting` rather than on `teaching` — the opposite of the
 * editor's default, deliberately. The editor's noise mode is a study mode whose
 * job is to make an effect visible on a lesson circuit; this page's third column
 * is a transmon, so the model beside it should start as a transmon. Opening on
 * a profile thirty times noisier than the machine would put the model further
 * from the device than the ideal circuit is, and the first thing a reader saw
 * would be a model that is worse than no model.
 *
 * ════════════════════════════════════════════════════════════════════════
 * ANONYMOUS READS ARE NOT PROMISED HERE
 *
 * Unlike `/c/:slug`, this route sits behind nothing in the router and behind
 * the *server's* rule in practice: a hardware job belongs to whoever spent the
 * allowance, and `GET /hardware/jobs/:id` answers 404 to everybody else. That
 * check is not repeated here — repeating it would be a second, weaker copy of
 * §11 running in a browser — so a signed-out reader reaches the same "no such
 * run" sentence a wrong id produces, which is the sentence that does not
 * confirm the run exists.
 */

import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import { NoisePanel } from '../features/analysis/NoisePanel'
import { buildNoiseComparison } from '../features/analysis/noiseComparison'
import {
  INITIAL_NOISE,
  specOf,
  type NoiseSettings,
} from '../features/analysis/noiseSettings'
import { CIRCUIT_ROUTE_PATH } from '../features/circuit-storage/paths'
import { HardwareResultView, idealCircuitOf } from '../features/hardware'
import { useSimulation } from '../features/simulation/useSimulation'
import {
  isNotFound,
  useApiErrorMessage,
  useCircuit,
  useHardwareJob,
} from '../lib/api'

/**
 * Where the noise controls start on this page. See the header for why it is not
 * the editor's `INITIAL_NOISE`.
 */
const DEVICE_LIKE_NOISE: NoiseSettings = {
  ...INITIAL_NOISE,
  enabled: true,
  profileId: 'superconducting',
}

export function HardwareRunRoute() {
  const { t } = useTranslation(['hardware', 'common', 'analysis'])
  const { jobId = '' } = useParams<{ jobId: string }>()
  const describeError = useApiErrorMessage()

  const jobQuery = useHardwareJob(jobId)
  const job = jobQuery.data ?? null

  /*
   * The circuit is fetched by the id the job names rather than by a slug: a
   * hardware job is attributed to a stored circuit row (§7 makes `circuitId`
   * not nullable), and the id is what survives a rename.
   */
  const circuitQuery = useCircuit(job?.circuitId ?? null)
  /*
   * `version.circuit` is the document; `circuit` beside it is the row's
   * metadata. The read route answers with the *current* version, and a device
   * queue is hours deep — 24 862 jobs on `ibm_fez` on one morning — so a
   * circuit edited since the job was submitted is the ordinary case rather than
   * an edge case.
   *
   * That is why `version.id` travels down with it. The job row records the
   * version it transpiled (`program.versionId`), so the view can *check*
   * rather than hope: when the two disagree it refuses to draw the ideal and
   * modelled columns instead of printing an edit in the place reserved for
   * physics. This page used to name the risk in a comment and then assert "the
   * device's own half of the page is unaffected", which was the half that was
   * wrong — the counts are re-keyed onto basis states, and the mapping came
   * from the current document too.
   */
  const stored = circuitQuery.data?.version.circuit ?? null
  const versionId = circuitQuery.data?.version.id ?? null
  const slug = circuitQuery.data?.circuit.slug ?? null

  const [noise, setNoise] = useState<NoiseSettings>(DEVICE_LIKE_NOISE)

  /*
   * The selected profile's own name, from the same catalog entry the select
   * shows. Read here rather than inside the comparison panel because this is
   * the component that owns the setting — the panel is handed a string and has
   * nothing to be wrong about.
   */
  const profileName = t(`analysis:noise.profile.${noise.profileId}.name`)

  /*
   * Analytic mode refuses a circuit that measures, and every circuit that
   * reached a device measures — see `features/hardware/ideal.ts`, which is also
   * where the two shapes that have no ideal state at all are refused by name.
   */
  const ideal = useMemo(
    () => (stored === null ? null : idealCircuitOf(stored)),
    [stored]
  )
  const runnable = ideal !== null && ideal.ok ? ideal.circuit : null

  const noiseSpec = useMemo(
    () =>
      runnable === null
        ? null
        : specOf(noise, runnable.qubits, runnable.operations.length),
    [noise, runnable]
  )

  const simulation = useSimulation(runnable ?? EMPTY_CIRCUIT, {
    enabled: runnable !== null,
    mode: 'analytic',
    noise: noiseSpec,
  })

  const outcome = simulation.outcome
  const analytic = outcome?.mode === 'analytic' ? outcome : null
  const reading =
    analytic?.noise !== null && analytic?.noise?.ok === true
      ? analytic.noise.reading
      : null

  /*
   * Built here rather than inside the view because §3.3's comparison is the
   * authority on the noisy column — this page adds a third reading to it and
   * must not produce a second answer to a question that one already answered
   * (`features/hardware/comparison.ts`).
   */
  const noiseComparison = useMemo(
    () =>
      analytic === null || reading === null
        ? null
        : buildNoiseComparison(analytic.state, reading),
    [analytic, reading]
  )

  const missing = jobQuery.isError && isNotFound(jobQuery.error)

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      {missing ? (
        <div className="notice" role="alert">
          {/*
           * "No such run, or not yours" — the server does not distinguish the
           * two and neither does this sentence, because distinguishing them
           * would confirm that somebody else's run exists.
           */}
          <p>{t('hardware:job.missing')}</p>
        </div>
      ) : null}

      {jobQuery.isPending && !missing ? (
        <p className="page__loading" role="status">
          {t('hardware:job.loading')}
        </p>
      ) : null}

      {jobQuery.isError && !missing ? (
        <p className="auth-alert" role="alert">
          {describeError(jobQuery.error)}
        </p>
      ) : null}

      {job === null ? null : (
        <>
          <HardwareResultView
            job={job}
            circuit={stored}
            state={analytic?.state ?? null}
            noise={noiseComparison}
            /*
             * The exact method answers with a distribution over every basis
             * state; the sampled one answers with a tally. Only the first can
             * be compared against the device as a distribution, and passing
             * `null` for the second is what keeps that figure honest rather
             * than reconstructed.
             */
            noisyDistribution={reading?.distribution ?? null}
            idealRefusal={ideal !== null && !ideal.ok ? ideal.code : null}
            simulating={
              simulation.status === 'running' ||
              simulation.status === 'scheduled'
            }
            currentVersionId={versionId}
            /*
             * The profile the reader has actually selected, translated here
             * because this is where the control lives. The panel used to
             * assert a transmon profile in prose whatever the select said.
             */
            noiseProfileName={profileName}
          />

          {runnable === null ? null : (
            <NoisePanel
              settings={noise}
              onChange={setNoise}
              qubits={runnable.qubits}
              operations={runnable.operations.length}
            />
          )}

          {/*
           * Only once there is a slug to point at. Rendering it eagerly would
           * build `/c/` out of an empty string — a link that looks live and
           * lands on a 404, which is worse than no link while the circuit is
           * still loading or could not be read at all.
           */}
          {slug === null ? null : (
            <p className="page__actions">
              <Link
                className="page__cta page__cta--quiet"
                to={CIRCUIT_ROUTE_PATH.replace(
                  ':slug',
                  encodeURIComponent(slug)
                )}
              >
                {t('hardware:job.backToCircuit')}
              </Link>
            </p>
          )}
        </>
      )}
    </main>
  )
}

/**
 * What `useSimulation` is handed while there is no circuit to run.
 *
 * The hook takes a circuit rather than a nullable one, and `enabled: false`
 * already stops anything from being scheduled — so this is a placeholder whose
 * only requirement is that it parse. A single qubit and no operations is the
 * cheapest document that does.
 */
const EMPTY_CIRCUIT: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 1,
  clbits: 0,
  operations: [],
}
