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
  useApiErrorMessage,
  useHardwareBackends,
  useHardwareCredentials,
  useSubmitHardwareJob,
} from '../../lib/api'
import { hardwareRunPath } from './paths'

/** Shots that cost a fraction of a second of QPU time and still show a shape. */
const DEFAULT_SHOTS = 1_024

export interface SubmitToHardwarePanelProps {
  /** The saved circuit's slug, or null for a draft with no home yet. */
  readonly handle: string | null
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
              {describeError(submit.error)}
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
        </>
      )}
    </section>
  )
}
