/**
 * API keys, on the settings screen — §3.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE-TIME DISPLAY IS THE WHOLE DESIGN OF THIS COMPONENT
 *
 * A key exists in exactly one response and can never be fetched again, so this
 * screen is the only moment it will ever be on anybody's screen. That creates
 * two failure modes pulling in opposite directions, and both are real:
 *
 *   - **Lost.** The reader clicks away, reloads, or is interrupted, and the
 *     key is gone for ever. The remedy is to revoke and mint again, which is
 *     fine once and a support burden at scale.
 *   - **Left.** The key sits on a screen in an office, in a screen share, in a
 *     screenshot somebody pastes into a ticket.
 *
 * Four decisions resolve them, and each rules out an obvious alternative:
 *
 *   1. **The panel is dismissed by the reader, never by a timer.** A countdown
 *      is the tempting answer to "left on screen" and it is wrong: it fires
 *      while somebody is alt-tabbed into their password manager, which is
 *      exactly when they are doing the right thing. Losing a credential is a
 *      worse outcome than showing one for a minute longer.
 *   2. **The key lives in this component's state and nowhere else.** Not in
 *      the query cache, not in `localStorage`, not in a URL. Reloading loses
 *      it, and that is correct — a secret that survives a reload is a secret
 *      with a storage location, and a storage location is a thing that leaks.
 *   3. **The mint form is replaced by the panel, not shown beside it.** So a
 *      reader cannot mint a second key on top of an undismissed first one,
 *      which is the specific way people lose the first.
 *   4. **Copying is offered but never required.** The value is in a read-only
 *      input, selectable, so a blocked clipboard API — a permission prompt, an
 *      insecure origin, a locked-down browser — degrades to selecting text
 *      rather than to a dead end with the key still unrecoverable.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REVOKING IS TWO CLICKS, AND NOT A `confirm()`
 *
 * Revocation is immediate and cannot be undone, so it needs a confirmation —
 * and `window.confirm` is not one this application may use: its text is not in
 * any of the three catalogs (D2), it cannot be styled or read by the same
 * screen-reader flow as the rest of the page, and some browsers suppress it
 * entirely. So the button reveals an inline confirmation naming the key, which
 * is translatable, focusable and testable.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { API_KEY_SCOPES, MAX_API_KEY_NAME_LENGTH } from '@qsim/contract'
import type { ApiKey, ApiKeyScope } from '@qsim/contract'

import {
  useApiErrorMessage,
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from '../../lib/api'

/** What `POST /api-keys` handed back, held for exactly as long as it is shown. */
interface MintedKey {
  readonly key: string
  readonly name: string
}

export function ApiKeysSection({ enabled }: { readonly enabled: boolean }) {
  const { t } = useTranslation('settings')
  const describeError = useApiErrorMessage()
  const keys = useApiKeys(enabled)

  /*
   * Held here rather than anywhere durable. See decision 2 in the header: this
   * is the entire lifetime of the secret inside this application.
   */
  const [minted, setMinted] = useState<MintedKey | null>(null)

  return (
    <section className="settings-section" aria-labelledby="settings-api-keys">
      <h3 id="settings-api-keys">{t('apiKeys.heading')}</h3>
      <p className="settings-section__note">{t('apiKeys.lead')}</p>

      {keys.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(keys.error)}
        </p>
      ) : null}

      {minted === null ? (
        <CreateKeyForm onMinted={setMinted} />
      ) : (
        <MintedKeyPanel
          minted={minted}
          onDismiss={() => {
            setMinted(null)
          }}
        />
      )}

      {keys.isPending ? (
        <p className="page__loading" role="status">
          {t('apiKeys.loading')}
        </p>
      ) : null}

      {keys.data === undefined ? null : (
        <ApiKeyList apiKeys={keys.data.apiKeys} />
      )}
    </section>
  )
}

/**
 * The mint form.
 *
 * Both fields are required by the contract and both are required here, for the
 * reasons stated where the schema is: an unnamed key cannot be revoked
 * confidently, and a default scope set would be either too generous or ticked
 * through out of irritation.
 */
function CreateKeyForm({
  onMinted,
}: {
  readonly onMinted: (minted: MintedKey) => void
}) {
  const { t } = useTranslation('settings')
  const describeError = useApiErrorMessage()
  /*
   * The secret arrives through this callback and is never the mutation's
   * result, so React Query's MutationCache cannot hold it — see
   * `useApiKeys.ts`. What it does hold is the key's metadata row, which is the
   * same row the listing beside this form shows.
   */
  const create = useCreateApiKey((created) => {
    onMinted({ key: created.key, name: created.apiKey.name })
  })

  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<readonly ApiKeyScope[]>(['read'])

  const trimmed = name.trim()
  const ready = trimmed.length > 0 && scopes.length > 0

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (create.isPending || !ready) return
        /*
         * No `onSuccess` handler for the key: it was already delivered by the
         * callback above, from inside `mutationFn`, which is what keeps it out
         * of the cache. The form unmounts as the panel takes its place
         * (decision 3), so anything this component held is dropped along with
         * it — which is the behaviour, not a hazard.
         */
        create.mutate({ name: trimmed, scopes: [...scopes] })
      }}
    >
      {create.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(create.error)}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="api-key-name">{t('apiKeys.nameLabel')}</label>
        <input
          id="api-key-name"
          type="text"
          value={name}
          maxLength={MAX_API_KEY_NAME_LENGTH}
          autoComplete="off"
          aria-describedby="api-key-name-hint"
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <p className="field__hint" id="api-key-name-hint">
          {t('apiKeys.nameHint')}
        </p>
      </div>

      <fieldset className="field">
        <legend>{t('apiKeys.scopesLabel')}</legend>
        {API_KEY_SCOPES.map((scope) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={(event) => {
                setScopes((current) =>
                  event.target.checked
                    ? [...current, scope]
                    : current.filter((held) => held !== scope)
                )
              }}
            />{' '}
            {t(`apiKeys.scope.${scope}`)}{' '}
            <span className="field__hint">
              {t(`apiKeys.scopeHint.${scope}`)}
            </span>
          </label>
        ))}
        <p className="field__hint">{t('apiKeys.scopesNote')}</p>
      </fieldset>

      <button
        className="page__cta"
        type="submit"
        /*
         * `aria-disabled`, never `disabled`, as everywhere else on this
         * screen: a disabled control cannot hold focus, so clearing the name
         * would drop a keyboard user to the document body.
         */
        aria-disabled={create.isPending || !ready}
      >
        {create.isPending ? t('apiKeys.creating') : t('apiKeys.create')}
      </button>
    </form>
  )
}

/** Whether the clipboard write succeeded, failed, or has not been tried. */
type CopyState = 'idle' | 'copied' | 'failed'

function MintedKeyPanel({
  minted,
  onDismiss,
}: {
  readonly minted: MintedKey
  readonly onDismiss: () => void
}) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState<CopyState>('idle')

  return (
    <div className="settings-section settings-section--danger">
      {/*
       * `role="status"` rather than `alert`: nothing has gone wrong, and the
       * arrival of the key is exactly the kind of thing a polite live region
       * exists to announce. The heading is inside it so a screen reader hears
       * what this is before it hears the value.
       */}
      <div role="status">
        <h4>{t('apiKeys.created.heading')}</h4>
        <p>{t('apiKeys.created.body', { name: minted.name })}</p>
      </div>

      <div className="field">
        <label htmlFor="api-key-value">{t('apiKeys.created.label')}</label>
        {/*
         * Read-only rather than a `<code>` block, so the value can be
         * selected, tabbed to, and read by the browser's own controls when the
         * clipboard API is unavailable (decision 4). `autoComplete`,
         * `spellCheck` and `autoCorrect` are all off: a password manager
         * offering to save this in the wrong field, or a spellchecker sending
         * it somewhere for a suggestion, are both ways a secret leaves.
         */}
        <input
          id="api-key-value"
          className="api-key-value"
          type="text"
          value={minted.key}
          readOnly
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          onFocus={(event) => {
            event.target.select()
          }}
        />
      </div>

      <button
        className="page__cta"
        type="button"
        onClick={() => {
          /*
           * `navigator.clipboard` can be absent (an insecure origin) and can
           * reject (a denied permission). Both are ordinary, so the failure is
           * a message telling the reader to select the field rather than a
           * thrown error — the value is still on screen either way, which is
           * the whole reason it is in an input.
           */
          void navigator.clipboard
            ?.writeText(minted.key)
            .then(() => {
              setCopied('copied')
            })
            .catch(() => {
              setCopied('failed')
            })
        }}
      >
        {t('apiKeys.created.copy')}
      </button>

      {copied === 'copied' ? (
        <p className="auth-notice" role="status">
          {t('apiKeys.created.copied')}
        </p>
      ) : null}
      {copied === 'failed' ? (
        <p className="auth-alert" role="alert">
          {t('apiKeys.created.copyFailed')}
        </p>
      ) : null}

      <p className="settings-section__note">{t('apiKeys.created.warning')}</p>

      <button
        className="page__cta page__cta--quiet"
        type="button"
        onClick={onDismiss}
      >
        {t('apiKeys.created.dismiss')}
      </button>
    </div>
  )
}

function ApiKeyList({ apiKeys }: { readonly apiKeys: readonly ApiKey[] }) {
  const { t } = useTranslation('settings')

  if (apiKeys.length === 0) {
    return <p className="settings-section__note">{t('apiKeys.empty')}</p>
  }

  return (
    <ul className="api-key-list">
      {apiKeys.map((apiKey) => (
        <ApiKeyRow key={apiKey.id} apiKey={apiKey} />
      ))}
    </ul>
  )
}

function ApiKeyRow({ apiKey }: { readonly apiKey: ApiKey }) {
  const { t, i18n } = useTranslation('settings')
  const describeError = useApiErrorMessage()
  const revoke = useRevokeApiKey()
  const [confirming, setConfirming] = useState(false)

  const dates = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })
  const revoked = apiKey.revokedAt !== null

  return (
    <li className={revoked ? 'api-key api-key--revoked' : 'api-key'}>
      <div>
        <strong>{apiKey.name}</strong>{' '}
        {/* The stored head of the key: enough to tell two rows apart, and
            nowhere near enough to be a credential. */}
        <code>{apiKey.keyPrefix}…</code>
      </div>

      <p className="field__hint">
        {apiKey.scopes.length === 0
          ? t('apiKeys.row.noScopes')
          : apiKey.scopes
              .map((scope) => t(`apiKeys.scope.${scope}`))
              .join(', ')}
      </p>

      <p className="field__hint">
        {t('apiKeys.row.created', { date: dates.format(apiKey.createdAt) })}
        {' · '}
        {/*
         * The field that makes revoking safe. "Never used" is the state that
         * tells its owner nothing depends on this key, which is why it is a
         * sentence of its own rather than an empty cell.
         */}
        {apiKey.lastUsedAt === null
          ? t('apiKeys.row.neverUsed')
          : t('apiKeys.row.lastUsed', {
              date: dates.format(apiKey.lastUsedAt),
            })}
      </p>

      {revoked ? (
        <p className="field__hint">
          {t('apiKeys.row.revoked', {
            date: dates.format(apiKey.revokedAt as Date),
          })}
        </p>
      ) : confirming ? (
        <>
          <p className="field__hint">
            {t('apiKeys.row.confirmBody', { name: apiKey.name })}
          </p>
          {revoke.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(revoke.error)}
            </p>
          ) : null}
          <button
            className="page__cta page__cta--danger"
            type="button"
            aria-disabled={revoke.isPending}
            onClick={() => {
              if (revoke.isPending) return
              revoke.mutate(apiKey.id)
            }}
          >
            {revoke.isPending
              ? t('apiKeys.row.revoking')
              : t('apiKeys.row.confirm')}
          </button>
          <button
            className="page__cta page__cta--quiet"
            type="button"
            onClick={() => {
              setConfirming(false)
            }}
          >
            {t('apiKeys.row.cancel')}
          </button>
        </>
      ) : (
        <button
          className="page__cta page__cta--quiet"
          type="button"
          onClick={() => {
            setConfirming(true)
          }}
        >
          {t('apiKeys.row.revoke')}
        </button>
      )}
    </li>
  )
}
