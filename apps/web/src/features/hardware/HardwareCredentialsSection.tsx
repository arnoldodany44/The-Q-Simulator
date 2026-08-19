/**
 * Where an IBM Quantum key goes — §3.7's missing front door.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS LATE
 *
 * Phase 4 built all of §3.7 except the way in. The API could store a
 * credential, list a fleet with its queue lengths and submit a job; the web
 * app could only *display* a finished run at `/runs/:jobId`. So the one thing
 * a person had to do before any of it worked — hand over their key — had no
 * screen, and the only way to do it was to paste `fetch` into a browser
 * console. Every test passed, because each half was tested against its own
 * half.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 *
 * **The key is write-only.** It goes to our API once, over TLS, and is
 * encrypted at rest; what comes back is `{id, provider, label, createdAt}`,
 * which has no field a secret could hide in. So this screen cannot show a key,
 * cannot mask one, and does not pretend to — the label is how a person tells
 * two of them apart, which is what the label is for.
 *
 * **The field is cleared on success**, and the browser is asked not to
 * remember it. An API key left sitting in a form is an API key in a session
 * restore, and `autoComplete="off"` with `type="password"` is the least this
 * owes somebody typing a credential into a page.
 *
 * **Removal is offered plainly and is not disguised as danger.** Removing a key
 * is how you rotate one, which is a thing people should do often, so it lives
 * beside the row rather than behind a confirmation that trains them not to.
 */

import { MAX_CREDENTIAL_LABEL } from '@qsim/contract'
import type { HardwareCredential } from '@qsim/contract'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  useApiErrorMessage,
  useCreateHardwareCredential,
  useDeleteHardwareCredential,
  useHardwareCredentials,
} from '../../lib/api'

export function HardwareCredentialsSection({
  enabled,
}: {
  readonly enabled: boolean
}) {
  const { t, i18n } = useTranslation('hardware')
  const describeError = useApiErrorMessage()
  const credentials = useHardwareCredentials(enabled)
  const create = useCreateHardwareCredential()
  const remove = useDeleteHardwareCredential()

  const [apiKey, setApiKey] = useState('')
  const [instance, setInstance] = useState('')
  const [label, setLabel] = useState('')

  const dates = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })

  const submit = (): void => {
    create.mutate(
      {
        provider: 'ibm_quantum',
        apiKey: apiKey.trim(),
        instance: instance.trim(),
        label: label.trim() === '' ? null : label.trim(),
      },
      {
        onSuccess: () => {
          // Nothing of the secret is kept once the server has it.
          setApiKey('')
          setInstance('')
          setLabel('')
        },
      }
    )
  }

  return (
    <section
      className="settings-section"
      aria-labelledby="settings-hardware-heading"
    >
      <h2 id="settings-hardware-heading">
        {t('hardware:credentials.heading')}
      </h2>
      <p className="settings-section__note">{t('hardware:credentials.note')}</p>

      {!enabled ? (
        <p className="auth-notice">{t('hardware:credentials.signedOut')}</p>
      ) : (
        <>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <label className="field" htmlFor="hardware-api-key">
              {t('hardware:credentials.apiKey')}
              <input
                id="hardware-api-key"
                /*
                 * A password field for a credential that is not a password:
                 * what is wanted is the concealment and the browser's refusal
                 * to autofill or remember it, which this is the only input
                 * type that asks for.
                 */
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                }}
              />
            </label>
            <p className="field__hint">
              {t('hardware:credentials.apiKeyHint')}
            </p>

            <label className="field" htmlFor="hardware-instance">
              {t('hardware:credentials.instance')}
              <input
                id="hardware-instance"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={instance}
                onChange={(event) => {
                  setInstance(event.target.value)
                }}
              />
            </label>
            <p className="field__hint">
              {t('hardware:credentials.instanceHint')}
            </p>

            <label className="field" htmlFor="hardware-label">
              {t('hardware:credentials.label')}
              <input
                id="hardware-label"
                type="text"
                maxLength={MAX_CREDENTIAL_LABEL}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value)
                }}
              />
            </label>

            <button
              type="submit"
              className="page__cta"
              disabled={
                create.isPending ||
                apiKey.trim() === '' ||
                instance.trim() === ''
              }
            >
              {t('hardware:credentials.save')}
            </button>
          </form>

          {create.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(create.error)}
            </p>
          ) : null}
          {remove.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(remove.error)}
            </p>
          ) : null}

          {credentials.isPending ? (
            <p className="page__loading">{t('hardware:submit.loading')}</p>
          ) : credentials.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(credentials.error)}
            </p>
          ) : credentials.data.length === 0 ? (
            <p className="settings-section__note">
              {t('hardware:credentials.none')}
            </p>
          ) : (
            <ul className="api-key-list">
              {credentials.data.map((credential: HardwareCredential) => (
                <li key={credential.id}>
                  <span>
                    {credential.label ?? t('hardware:credentials.unlabelled')}
                  </span>{' '}
                  <span className="settings-section__note">
                    {dates.format(new Date(credential.createdAt))}
                  </span>{' '}
                  <button
                    type="button"
                    className="page__cta page__cta--quiet"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(credential.id)
                    }}
                  >
                    {t('hardware:credentials.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
