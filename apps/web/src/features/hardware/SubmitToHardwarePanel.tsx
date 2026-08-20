/**
 * Sending the circuit on screen to a real quantum computer — §3.7's other
 * missing half.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY IT IS ON THE EDITOR AND NOT IN SETTINGS
 *
 * The credential belongs to the account, so it lives in Settings beside the API
 * keys. A submission belongs to a *circuit*, and the circuit you mean is the one
 * you are looking at. Splitting them that way is the same line the export panel
 * and the save panel already sit on.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ONLY FOR A CIRCUIT THAT HAS A HOME
 *
 * `POST /hardware/jobs` names a *stored* circuit, because the row it writes has
 * a foreign key to one and because §3.7 wants the result kept beside the circuit
 * it describes. An unsaved draft has nothing to key against, so this renders a
 * sentence saying to save first rather than a form that could only ever fail.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE QUEUE IS THE FIELD THAT MATTERS
 *
 * Devices are listed with their queue length, and the list is sorted by it,
 * because that number is the whole difference between a demonstration and a
 * promise to send results later — one fleet has had a device with a single job
 * waiting beside one with twenty-four thousand. `operational` is a separate
 * column and not folded into the sort: a device that is paused with an empty
 * queue would otherwise sort to the top and look like the obvious choice.
 *
 * A missing queue length stays missing and sorts last. `deviceTargetFromIbm`
 * takes the same line, and for the same reason: a `null` shown as zero would
 * rank a device this system knows nothing about above one it has measured.
 */

import { MAX_HARDWARE_JOB_SHOTS, MIN_HARDWARE_JOB_SHOTS } from '@qsim/contract'
import type { HardwareBackendResponse } from '@qsim/contract'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import {
  isApiRequestError,
  useApiErrorMessage,
  useHardwareBackends,
  useHardwareCredentials,
  useHardwareJobs,
  useSubmitHardwareJob,
} from '../../lib/api'
import { hardwareRunPath } from './paths'

/** Shots that cost a fraction of a second of QPU time and still show a shape. */
const DEFAULT_SHOTS = 1_024

/**
 * Every reason the transpiler will refuse a circuit, as `RefusalCode` spells
 * them.
 *
 * ── WHY THIS LIST IS HERE ────────────────────────────────────────────────
 *
 * A refusal arrives as `HARDWARE_UNRUNNABLE` with the real reason in
 * `details`, and until now the panel rendered only the top-level message. That
 * message describes *one* of these eleven — connectivity — so a circuit refused
 * for any other reason was told to "try a shallower circuit or another
 * backend".
 *
 * The Bell example made that concrete: it has no measurement, so a device would
 * return no bits and `no-measurement` is the refusal. The advice on screen was
 * about wiring, and neither a shallower circuit nor a different backend would
 * ever have helped.
 *
 * `packages/transpile/src/refusal.ts` says the point of a coded refusal is that
 * "a fact is what makes a refusal worth reading". This is the client half of
 * that, which was missing.
 *
 * Duplicated rather than imported because `.dependency-cruiser.cjs` keeps
 * `apps/web` out of the transpiler, and the codes cross the wire as opaque
 * strings anyway. `verification/refusal-coverage` is what stops the two lists
 * drifting.
 */
const REFUSAL_CODES = new Set([
  'unsupported-gate',
  'too-many-controls',
  'unsupported-parameter',
  'device-basis-mismatch',
  'too-many-qubits',
  'degree-exceeded',
  'cycle-too-short',
  'no-placement',
  'search-exhausted',
  'too-deep',
  'no-measurement',
])

/**
 * The refusal reason inside an error, or null for anything else.
 *
 * The API sends the code as a detail on `body.circuit`, beside `key:value`
 * details carrying the numbers and one entry per implicated operation. Matching
 * against the known set rather than taking the first detail is what keeps a
 * `key:value` pair from being read as a reason.
 */
function refusalCodeOf(error: unknown): string | null {
  if (!isApiRequestError(error)) return null
  for (const detail of error.details) {
    if (REFUSAL_CODES.has(detail.code)) return detail.code
  }
  return null
}

export interface SubmitToHardwarePanelProps {
  /** The saved circuit's slug, or null for a draft with no home yet. */
  readonly handle: string | null
  /**
   * The saved circuit's id, for listing its runs.
   *
   * The slug addresses a circuit for a person and the id is what a job row
   * keys against, and the listing filter wants the id. Separate props rather
   * than one, because a draft has neither and a reader of this signature should
   * not have to know which of the two the API happens to take.
   */
  readonly circuitId: string | null
  readonly signedIn: boolean
}

/** Queue first, unknown last, and never mixed with whether it is online. */
function byQueue(
  a: HardwareBackendResponse,
  b: HardwareBackendResponse
): number {
  if (a.queueLength === b.queueLength) return a.name.localeCompare(b.name)
  if (a.queueLength === null) return 1
  if (b.queueLength === null) return -1
  return a.queueLength - b.queueLength
}

export function SubmitToHardwarePanel({
  handle,
  circuitId,
  signedIn,
}: SubmitToHardwarePanelProps) {
  const { t, i18n } = useTranslation('hardware')
  const describeError = useApiErrorMessage()
  const credentials = useHardwareCredentials(signedIn)
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [backend, setBackend] = useState('')
  const [shots, setShots] = useState(DEFAULT_SHOTS)
  const submit = useSubmitHardwareJob()
  /*
   * This circuit's runs, so a result survives navigating away from it.
   *
   * `/runs/:jobId` renders forever and there was no way back to it: the only
   * address a person ever saw was the link the panel showed once, right after
   * submitting. Leave the page and the run was unreachable — while the server
   * held it and could list it. Reported exactly that way.
   */
  const runs = useHardwareJobs(circuitId, signedIn && circuitId !== null)
  const dates = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  /*
   * The first stored credential, until the reader picks another. Most people
   * have exactly one, and making them choose from a list of one before the
   * device list will load is a step that answers nothing.
   */
  const chosen = credentialId ?? credentials.data?.[0]?.id ?? null
  const backends = useHardwareBackends(chosen)
  const numbers = new Intl.NumberFormat(i18n.language)

  if (!signedIn) {
    return (
      <section className="submit-hardware" aria-labelledby="submit-hardware-h">
        <h2 className="submit-hardware__heading" id="submit-hardware-h">
          {t('submit.heading')}
        </h2>
        <p className="submit-hardware__note">{t('submit.signedOut')}</p>
      </section>
    )
  }

  return (
    <section className="submit-hardware" aria-labelledby="submit-hardware-h">
      <h2 className="submit-hardware__heading" id="submit-hardware-h">
        {t('submit.heading')}
      </h2>

      {handle === null ? (
        <p className="submit-hardware__note">{t('submit.saveFirst')}</p>
      ) : credentials.isPending ? (
        <p className="submit-hardware__note">{t('submit.loading')}</p>
      ) : credentials.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(credentials.error)}
        </p>
      ) : credentials.data.length === 0 ? (
        <p className="submit-hardware__note">{t('submit.noCredential')}</p>
      ) : (
        <>
          {credentials.data.length > 1 ? (
            <label className="field" htmlFor="submit-hardware-credential">
              {t('submit.credential')}
              <select
                id="submit-hardware-credential"
                value={chosen ?? ''}
                onChange={(event) => {
                  setCredentialId(event.target.value)
                  // The fleet belongs to the credential, so the choice of
                  // device cannot survive a change of key.
                  setBackend('')
                }}
              >
                {credentials.data.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.label ?? credential.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field" htmlFor="submit-hardware-backend">
            {t('submit.backend')}
            <select
              id="submit-hardware-backend"
              value={backend}
              disabled={backends.isPending || backends.isError}
              onChange={(event) => {
                setBackend(event.target.value)
              }}
            >
              <option value="">{t('submit.pickBackend')}</option>
              {[...(backends.data ?? [])].sort(byQueue).map((device) => (
                <option key={device.name} value={device.name}>
                  {t('submit.device', {
                    name: device.name,
                    queue:
                      device.queueLength === null
                        ? t('submit.queueUnknown')
                        : numbers.format(device.queueLength),
                    qubits:
                      device.qubits === null
                        ? t('submit.qubitsUnknown')
                        : numbers.format(device.qubits),
                    state: device.operational
                      ? t('submit.online')
                      : t('submit.offline'),
                  })}
                </option>
              ))}
            </select>
          </label>

          {backends.isPending ? (
            <p className="submit-hardware__note">
              {t('submit.loadingDevices')}
            </p>
          ) : backends.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(backends.error)}
            </p>
          ) : null}

          <label className="field" htmlFor="submit-hardware-shots">
            {t('submit.shots')}
            <input
              id="submit-hardware-shots"
              type="number"
              min={MIN_HARDWARE_JOB_SHOTS}
              max={MAX_HARDWARE_JOB_SHOTS}
              value={shots}
              onChange={(event) => {
                setShots(Number(event.target.value))
              }}
            />
          </label>
          <p className="field__hint">{t('submit.shotsHint')}</p>
          {/*
             Said before the press rather than after it. A device answers with
             bits and nothing else, so a circuit with no measurement cannot run
             on one — and five of the six worked examples have none, because in
             a simulator measuring collapses the state you came to look at.
           */}
          <p className="field__hint">{t('submit.needsMeasurement')}</p>

          <button
            type="button"
            className="page__cta"
            disabled={submit.isPending || backend === '' || chosen === null}
            onClick={() => {
              if (chosen === null) return
              submit.mutate({
                circuit: handle,
                credentialId: chosen,
                backend,
                shots,
              })
            }}
          >
            {t('submit.send')}
          </button>

          {submit.isError ? (
            <p className="auth-alert" role="alert">
              {/*
               * The specific reason when the server sent one, and only then the
               * generic sentence. See `REFUSAL_CODES` for what this replaced.
               */}
              {(() => {
                const code = refusalCodeOf(submit.error)
                return code === null
                  ? describeError(submit.error)
                  : t(`refusal.${code}`)
              })()}
            </p>
          ) : null}

          {/*
           * The receipt, and the only thing worth showing: a device answers in
           * minutes or hours, so what a reader needs is the address of the page
           * that will hold the answer. `role="status"` announces it once.
           */}
          {submit.data === undefined ? null : (
            <p className="submit-hardware__receipt" role="status">
              {t('submit.queued')}{' '}
              <Link to={hardwareRunPath(submit.data.id)}>
                {t('submit.openRun')}
              </Link>
            </p>
          )}

          {/*
           * Every run this circuit has had, newest first. Not only the one just
           * started: the reason this list exists is that a result outlived the
           * one link that pointed at it.
           */}
          {runs.data !== undefined && runs.data.length > 0 ? (
            <div className="submit-hardware__runs">
              <h3 className="submit-hardware__runs-heading">
                {t('runs.heading')}
              </h3>
              <ul className="submit-hardware__run-list">
                {runs.data.map((job) => (
                  <li key={job.id}>
                    <Link to={hardwareRunPath(job.id)}>
                      {t('runs.entry', {
                        backend: job.backend,
                        shots: numbers.format(job.shots),
                        // `submittedAt`, not a created stamp: the row is written when the
                        // submission is accepted, and that is the moment a person
                        // means by "when did I run this".
                        date: dates.format(new Date(job.submittedAt)),
                      })}
                    </Link>{' '}
                    <span className="submit-hardware__run-status">
                      {t(`runs.status.${job.status}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
