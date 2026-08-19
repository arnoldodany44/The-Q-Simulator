/**
 * Where an IBM Quantum key goes — §3.7's missing front door.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS LATE
 *
 * Phase 4 built all of §3.7 except the way in. The API could store a
 * credential, list a fleet with its queue lengths and submit a job; the web app
 * could only *display* a finished run at `/runs/:jobId`. So the one thing a
 * person had to do before any of it worked — hand over their key — had no
 * screen, and the only way to do it was to paste `fetch` into a browser
 * console.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 *
 * **The key is write-only.** It goes to our API once, over TLS, and is
 * encrypted at rest; a listing answers `{id, provider, label, createdAt}`, which
 * has no field a secret could hide in. So this screen cannot show a key, cannot
 * mask one, and does not pretend to — and it says so in as many words, because a
 * form that silently swallows a credential is a form people are right not to
 * trust. The label is how a person tells two of them apart.
 *
 * **The field is cleared on success**, and the browser is asked not to remember
 * it: a key left sitting in a form is a key in a session restore.
 *
 * **Both fields say where to find the value.** The two things being asked for
 * live in different corners of somebody else's dashboard, and "Instance CRN"
 * means nothing to a reader who has not been told it is the long string
 * beginning `crn:v1`. This is the screen where being told is cheap.
 *
 * **The stored keys come before the form.** Somebody arriving to check whether a
 * key is here should not have to read past a form to find out.
 *
 * **Removing is not dressed as danger.** Removing a key is how you rotate one,
 * which is a thing people should do often, so it sits beside its row rather than
 * behind a confirmation that teaches them to click through warnings.
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

/** Where both values come from, for the link in the hint. */
const IBM_DASHBOARD = 'https://quantum.cloud.ibm.com/'

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
  /** Counts saves, so the live region announces each one. See its comment. */
  const [saved, setSaved] = useState(0)

  const dates = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })
  const incomplete = apiKey.trim() === '' || instance.trim() === ''

  return (
    <section
      className="settings-section"
      aria-labelledby="settings-hardware-heading"
    >
      <h2 id="settings-hardware-heading">{t('credentials.heading')}</h2>
      <p className="settings-section__note">{t('credentials.note')}</p>

      {!enabled ? (
        <p className="auth-notice">{t('credentials.signedOut')}</p>
      ) : (
        <>
          {credentials.isPending ? (
            <p className="page__loading">{t('credentials.loading')}</p>
          ) : credentials.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(credentials.error)}
            </p>
          ) : credentials.data.length === 0 ? (
            <p className="hardware-keys__empty">{t('credentials.none')}</p>
          ) : (
            <ul className="hardware-keys">
              {credentials.data.map((credential: HardwareCredential) => (
                <li className="hardware-keys__row" key={credential.id}>
                  <span className="hardware-keys__name">
                    {credential.label ?? t('credentials.unlabelled')}
                  </span>
                  <span className="hardware-keys__meta">
                    {t('credentials.storedOn', {
                      date: dates.format(new Date(credential.createdAt)),
                    })}
                  </span>
                  <button
                    type="button"
                    className="page__cta page__cta--quiet"
                    disabled={remove.isPending}
                    title={t('credentials.removeHint')}
                    onClick={() => {
                      remove.mutate(credential.id)
                    }}
                  >
                    {t('credentials.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="hardware-form"
            onSubmit={(event) => {
              event.preventDefault()
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
                    setSaved((count) => count + 1)
                  },
                }
              )
            }}
          >
            <h3 className="hardware-form__heading">{t('credentials.add')}</h3>
            <p className="hardware-form__where">
              {t('credentials.where')}{' '}
              <a href={IBM_DASHBOARD} target="_blank" rel="noreferrer noopener">
                {t('credentials.whereLink')}
              </a>
            </p>

            <div className="hardware-form__field">
              <label htmlFor="hardware-api-key">
                {t('credentials.apiKey')}
              </label>
              <input
                id="hardware-api-key"
                /*
                 * A password field for a credential that is not a password:
                 * what is wanted is the concealment and the browser's refusal to
                 * autofill or remember it, which this is the only type that asks
                 * for.
                 */
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('credentials.apiKeyPlaceholder')}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                }}
              />
              <p className="hardware-form__hint">
                {t('credentials.apiKeyHint')}
              </p>
            </div>

            <div className="hardware-form__field">
              <label htmlFor="hardware-instance">
                {t('credentials.instance')}
              </label>
              <input
                id="hardware-instance"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('credentials.instancePlaceholder')}
                value={instance}
                onChange={(event) => {
                  setInstance(event.target.value)
                }}
              />
              <p className="hardware-form__hint">
                {t('credentials.instanceHint')}
              </p>
            </div>

            <div className="hardware-form__field">
              <label htmlFor="hardware-label">{t('credentials.label')}</label>
              <input
                id="hardware-label"
                type="text"
                maxLength={MAX_CREDENTIAL_LABEL}
                placeholder={t('credentials.labelPlaceholder')}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value)
                }}
              />
              <p className="hardware-form__hint">
                {t('credentials.labelHint')}
              </p>
            </div>

            <div className="hardware-form__actions">
              <button
                type="submit"
                className="page__cta"
                disabled={create.isPending || incomplete}
              >
                {create.isPending
                  ? t('credentials.saving')
                  : t('credentials.save')}
              </button>
              {/*
               * Why the button is off, beside the button. A disabled control with
               * no explanation is the commonest way a form wastes somebody's
               * time.
               */}
              {incomplete ? (
                <span className="hardware-form__hint">
                  {t('credentials.needBoth')}
                </span>
              ) : null}
            </div>
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

          {/*
           * Keyed on a count for the reason every live region in this app is:
           * two identical messages in a row leave the text node untouched, and a
           * region that did not change announces nothing.
           */}
          <p className="hardware-form__saved" role="status">
            {saved === 0 ? null : (
              <span key={saved}>{t('credentials.savedNotice')}</span>
            )}
          </p>
        </>
      )}
    </section>
  )
}
