/**
 * `/settings` — display name, username, picture, leaderboard listing, language,
 * and the way out (§3.4, §3.6, milestones M1.9 and the leaderboard).
 *
 * ── Five settings, four of which live on the server ───────────────────────
 *
 * The name, the handle, the picture and the leaderboard listing are columns on
 * `User` and are saved with `PATCH /me`. The *language* is not, and that is a
 * decision rather than an omission: it is chosen before anyone has an account,
 * it is what the detector already resolved from the browser, and
 * `qsim.language` in `localStorage` already persists it. Storing a second copy
 * on the server would create two sources of truth that disagree the first time
 * somebody switches language while signed out — and the loser of that argument
 * would be the choice the reader just made with their own hands. So the picker
 * on this page is the same `LanguagePicker` the header carries, and the page
 * says plainly that the setting belongs to this browser.
 *
 * ── Why the leaderboard control is not a fifth field in the profile form ──
 *
 * It is the only setting here that governs what *other people* see, and it is
 * the only one that should take effect at the moment it is chosen rather than
 * when a form is submitted. A privacy control behind a save button is one
 * somebody will believe they used. `PrivacySection` below has the rest.
 *
 * ── The username is the one field that can be refused ─────────────────────
 *
 * It is a public address (`/users/:username`), so it is unique, and the server
 * decides with the unique index rather than with a lookup — there is no
 * "is this available?" call anywhere in this app, and there is no endpoint for
 * one, because that would be a cheap scriptable oracle over every handle in
 * the database. What the user gets instead is the refusal on save, translated,
 * with the field still holding what they typed.
 *
 * ── Deleting an account is deliberately awkward ───────────────────────────
 *
 * It is the one irreversible action in the product, so it is behind a
 * disclosure, it asks the person to type their own handle, and the button
 * declines until what they typed matches. The server checks the same thing
 * again — a client cannot decide what counts as confirmation — and the report
 * that comes back is rendered rather than swallowed: somebody who has just
 * destroyed twelve circuits deserves to be told it was twelve.
 *
 * What is *not* deleted is stated on the page, because it is surprising: the
 * sign-in identity itself lives in Supabase, and this API deliberately holds
 * no key that could remove it. Signing in again gives a new, empty account.
 *
 * ── Why the session guard is inside this file ─────────────────────────────
 *
 * This is the one screen that stops needing a session halfway through. The
 * deletion succeeds, the token now names nobody, and what should be on screen
 * is the report of what was destroyed and a way home — for a reader who, by
 * definition, no longer has an account.
 *
 * With `RequireSession` wrapped around the route in `App.tsx`, that report
 * could not survive: signing out flipped the guard, the guard redirected to
 * /sign-in, and the confirmation was measured on screen for about 130 ms — two
 * samples out of a hundred and twenty — which is not long enough for a
 * `role="status"` region to be announced before its subtree is removed. Three
 * translated keys in three languages were dead copy, and the only account
 * anyone would ever get of what was irreversibly deleted flashed past.
 *
 * So the guard moved in here and now covers the *settings screen* rather than
 * the address. `AccountDeleted` renders outside it, holds the counts in state
 * that no query can invalidate, and stays until the reader follows
 * `danger.doneHome`. An anonymous visitor to `/settings` is still redirected
 * to sign in, exactly as before.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { MAX_DISPLAY_NAME_LENGTH, USERNAME_PATTERN } from '@qsim/contract'
import type { AvatarSource } from '@qsim/contract'

import { LanguagePicker } from '../components/LanguagePicker'
import { ApiKeysSection } from '../features/api-keys'
import {
  AccountMenu,
  RequireSession,
  useSession,
  useSessionActions,
} from '../features/auth'
import { COLLECTIONS_PATH } from '../features/collections/paths'
import { profilePath } from '../features/gallery/paths'
import { Avatar } from '../features/profile'
import { pluralCount } from '../features/analysis/format'
import {
  useAccount,
  useApiErrorMessage,
  useDeleteAccount,
  useUpdateProfile,
} from '../lib/api'

/** What a completed deletion destroyed, as the API reported it. */
interface DeletionReport {
  readonly circuits: number
  readonly collections: number
}

export function SettingsRoute() {
  /*
   * Held above the guard on purpose. Once this is set the account is gone and
   * the session is on its way out, so anything rendered *under* `RequireSession`
   * is about to be redirected away — including the only account the reader will
   * ever get of what was deleted. See the header.
   */
  const [deleted, setDeleted] = useState<DeletionReport | null>(null)

  if (deleted !== null) return <AccountDeleted deleted={deleted} />

  return (
    <RequireSession>
      <SettingsScreen onDeleted={setDeleted} />
    </RequireSession>
  )
}

function SettingsScreen({
  onDeleted,
}: {
  readonly onDeleted: (deleted: DeletionReport) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const session = useSession()
  const describeError = useApiErrorMessage()

  /*
   * Only once the session has resolved. Firing `GET /me` while supabase-js is
   * still reading storage would send it anonymously and cache the 401 under
   * the key the signed-in view then reads (`sessionState.ts` on why "not known
   * yet" is a third state and not a falsy user).
   */
  const account = useAccount(session.status === 'authenticated')

  return (
    <main className="page">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      <h2 className="auth-page__title">{t('settings:title')}</h2>
      <p className="auth-page__lead">{t('settings:lead')}</p>

      {account.isPending ? (
        <p className="page__loading" role="status">
          {t('settings:loading')}
        </p>
      ) : null}

      {account.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(account.error)}
        </p>
      ) : null}

      {account.data === undefined ? null : (
        <>
          <ProfileSection
            user={account.data.user}
            email={session.user?.email ?? null}
          />
          <PrivacySection optedOut={account.data.leaderboardOptOut} />
          {/*
           * §3.5. `enabled` is threaded from the session state for the reason
           * `useAccount` above takes it: the listing must not be requested
           * before supabase-js has finished reading storage, or the 401 is
           * cached under the key the signed-in view then reads.
           */}
          <ApiKeysSection enabled={session.status === 'authenticated'} />
          <LanguageSection />
          <DangerSection
            username={account.data.user.username}
            onDeleted={onDeleted}
          />
        </>
      )}
    </main>
  )
}

/**
 * The last thing this screen says, and the only place it is said.
 *
 * Rendered outside `RequireSession` (see the header), so it persists after the
 * sign-out that follows it: the reader leaves by pressing `danger.doneHome`,
 * which is the one exit the screen offers, rather than being dropped on a
 * sign-in form a tenth of a second later.
 *
 * The sign-out itself happens *here*, in an effect, rather than in the
 * mutation's `onSuccess`. That ordering is the whole point: the effect runs
 * after this subtree has committed, so the session is only torn down once the
 * report a reader needs is already on screen and the guard around the form is
 * already unmounted.
 */
function AccountDeleted({ deleted }: { readonly deleted: DeletionReport }) {
  const { t, i18n } = useTranslation(['settings', 'common'])
  const actions = useSessionActions()
  const numbers = new Intl.NumberFormat(i18n.language)

  useEffect(() => {
    // The rows are gone; the token that is still in storage now names nobody.
    void actions.signOut()
  }, [actions])

  return (
    <main className="page">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <LanguagePicker />
        </div>
      </header>

      <section className="settings-section settings-section--danger">
        <h2 className="auth-page__title">{t('settings:danger.doneHeading')}</h2>
        {/*
         * The counts, rendered rather than swallowed: somebody who has just
         * destroyed twelve circuits deserves to be told it was twelve. A live
         * region because nothing else on this page moved focus — and it now
         * stays mounted long enough for that to mean something.
         *
         * Two counted phrases composed into one sentence rather than one key
         * with two numbers in it, which is what `ExportPanel` does and for the
         * same reason: i18next resolves a plural against a single `count`, so
         * "1 circuits and 0 collections" is what a single key can produce. The
         * figure on screen goes through `Intl.NumberFormat` separately from the
         * number that selects the form — the rule `format.ts` states.
         */}
        <p role="status">
          {t('settings:danger.doneBody', {
            circuits: t('settings:danger.doneCircuits', {
              count: pluralCount(deleted.circuits),
              value: numbers.format(deleted.circuits),
            }),
            collections: t('settings:danger.doneCollections', {
              count: pluralCount(deleted.collections),
              value: numbers.format(deleted.collections),
            }),
          })}
        </p>
        <Link className="page__cta" to="/">
          {t('settings:danger.doneHome')}
        </Link>
      </section>
    </main>
  )
}

interface AccountUser {
  readonly id: string
  readonly username: string
  readonly displayName: string | null
  readonly avatarUrl: string | null
}

/** What the picture control means, derived from the row rather than stored. */
function avatarSourceOf(user: AccountUser): AvatarSource {
  return user.avatarUrl === null ? 'generated' : 'provider'
}

function ProfileSection({
  user,
  email,
}: {
  readonly user: AccountUser
  readonly email: string | null
}) {
  const { t } = useTranslation('settings')
  const describeError = useApiErrorMessage()
  const update = useUpdateProfile()

  /*
   * The form's own state is seeded from the row and has to be re-seeded when
   * the row changes underneath it — after a save, and after a rename made in
   * another tab invalidates the cache. Without that, the fields keep showing
   * what was typed before something else won.
   *
   * Done with a `key` rather than with an effect that calls `setState`. That
   * is React's own answer to "reset state when a prop changes" and it is not a
   * lint workaround: an effect would render the stale values once, then render
   * again with the fresh ones, and the intermediate frame is a form that
   * briefly disagrees with the server. Remounting has no such frame. The
   * mutation, and therefore the "saved" notice below, lives *outside* the
   * keyed subtree so a successful save does not erase its own confirmation.
   */
  const signature = [
    user.username,
    user.displayName ?? '',
    user.avatarUrl ?? '',
  ].join(' ')

  return (
    <section className="settings-section" aria-labelledby="settings-profile">
      <h3 id="settings-profile">{t('profile.heading')}</h3>

      {/*
       * The address is shown and is not editable here: it belongs to the
       * sign-in identity, which Supabase owns (§11). Saying so is better than
       * an input that would have to explain why it refuses.
       */}
      {email === null ? null : (
        <p className="settings-section__note">
          {t('profile.signedInAs', { email })}
        </p>
      )}

      {update.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(update.error)}
        </p>
      ) : null}

      {update.isSuccess ? (
        <p className="auth-notice" role="status">
          {t('profile.saved')}
        </p>
      ) : null}

      <ProfileForm
        key={signature}
        user={user}
        pending={update.isPending}
        onSubmit={(changes) => {
          update.mutate(changes)
        }}
      />

      <p className="settings-section__note">
        <Link to={COLLECTIONS_PATH}>{t('profile.collections')}</Link>
      </p>
    </section>
  )
}

interface ProfileChanges {
  readonly displayName: string | null
  readonly username: string
  readonly avatar: AvatarSource
}

function ProfileForm({
  user,
  pending,
  onSubmit,
}: {
  readonly user: AccountUser
  readonly pending: boolean
  readonly onSubmit: (changes: ProfileChanges) => void
}) {
  const { t } = useTranslation('settings')

  const [displayName, setDisplayName] = useState(user.displayName ?? '')
  const [username, setUsername] = useState(user.username)
  const [avatar, setAvatar] = useState<AvatarSource>(avatarSourceOf(user))

  const handleShape = USERNAME_PATTERN.test(username)
  const unchanged =
    displayName === (user.displayName ?? '') &&
    username === user.username &&
    avatar === avatarSourceOf(user)

  return (
    <>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (pending || unchanged || !handleShape) return
          onSubmit({
            displayName: displayName.trim() === '' ? null : displayName.trim(),
            username,
            avatar,
          })
        }}
      >
        <div className="field">
          <label htmlFor="settings-display-name">
            {t('profile.displayName')}
          </label>
          <input
            id="settings-display-name"
            type="text"
            value={displayName}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            autoComplete="nickname"
            onChange={(event) => {
              setDisplayName(event.target.value)
            }}
          />
          <p className="field__hint">{t('profile.displayNameHint')}</p>
        </div>

        <div className="field">
          <label htmlFor="settings-username">{t('profile.username')}</label>
          <input
            id="settings-username"
            type="text"
            value={username}
            autoComplete="username"
            aria-describedby="settings-username-hint"
            aria-invalid={!handleShape}
            onChange={(event) => {
              setUsername(event.target.value)
            }}
          />
          <p className="field__hint" id="settings-username-hint">
            {handleShape
              ? t('profile.usernameHint')
              : /*
                 * Shape only. Whether the handle is *taken* is the server's
                 * answer and arrives on save — see the header for why this app
                 * has no availability check.
                 */
                t('profile.usernameShape')}
          </p>
          <p className="field__hint">
            <Link to={profilePath(user.username)}>
              {t('profile.viewPublic')}
            </Link>
          </p>
        </div>

        <fieldset className="field">
          <legend>{t('profile.avatar')}</legend>
          <div className="settings-avatar">
            {/* Both options are previewed, so the choice is visible rather
                than described. */}
            <Avatar identity={user.id} avatarUrl={null} size={64} />
            <Avatar identity={user.id} avatarUrl={user.avatarUrl} size={64} />
          </div>
          <label>
            <input
              type="radio"
              name="avatar"
              value="generated"
              checked={avatar === 'generated'}
              onChange={() => {
                setAvatar('generated')
              }}
            />{' '}
            {t('profile.avatarGenerated')}
          </label>
          <label>
            <input
              type="radio"
              name="avatar"
              value="provider"
              checked={avatar === 'provider'}
              onChange={() => {
                setAvatar('provider')
              }}
            />{' '}
            {t('profile.avatarProvider')}
          </label>
          <p className="field__hint">{t('profile.avatarHint')}</p>
        </fieldset>

        <button
          className="page__cta"
          type="submit"
          /*
           * `aria-disabled`, never `disabled`: a disabled control cannot hold
           * focus, so clearing the last edit would drop the keyboard user to
           * the document body. Announced as unavailable, still reachable, and
           * the handler declines.
           */
          aria-disabled={pending || unchanged || !handleShape}
        >
          {pending ? t('profile.saving') : t('profile.save')}
        </button>
      </form>
    </>
  )
}

/**
 * Whether this account's name appears on a challenge leaderboard (§3.6).
 *
 * ── Why this is a section of its own and not a fourth field above ─────────
 *
 * Everything in `ProfileSection` describes the person and is saved together
 * behind one button. This is a *decision about other people's screens*, and it
 * takes effect the moment it is made rather than when a form is submitted —
 * the same immediacy the language picker has, and for the same reason: a
 * privacy control that needs a second click to take hold is a control somebody
 * will believe they used.
 *
 * ── What the sentence has to say, and what it must not imply ──────────────
 *
 * Opting out withdraws the *name* from the listing and nothing else: the
 * result still counts, the rank is still the reader's own, and the page still
 * shows them where they stand. Saying so matters, because the obvious guess —
 * "this deletes my scores" — would make the honest choice look expensive.
 * `privacy.note` is that sentence, and the server enforces the same rule by
 * filtering after the rank is assigned.
 *
 * The checkbox is phrased positively ("show my name") while the stored column
 * is the refusal, so the two are inverses. That is deliberate on both sides: a
 * control reads better as a thing you turn on, and a column reads better as a
 * choice somebody made — see the model comment in schema.prisma.
 */
function PrivacySection({ optedOut }: { readonly optedOut: boolean }) {
  const { t } = useTranslation('settings')
  const describeError = useApiErrorMessage()
  const update = useUpdateProfile()

  return (
    <section className="settings-section" aria-labelledby="settings-privacy">
      <h3 id="settings-privacy">{t('privacy.heading')}</h3>

      {update.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(update.error)}
        </p>
      ) : null}

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={!optedOut}
            /*
             * `aria-disabled`, never `disabled`, exactly as the save button
             * above: a disabled control cannot hold focus, so a keyboard
             * reader who toggles this would be dropped to the document body
             * for the length of a round trip. Announced as unavailable, still
             * reachable, and the handler declines.
             */
            aria-disabled={update.isPending}
            onChange={(event) => {
              if (update.isPending) return
              update.mutate({ leaderboardOptOut: !event.target.checked })
            }}
          />{' '}
          {t('privacy.listMe')}
        </label>
        <p className="field__hint">{t('privacy.note')}</p>
      </div>
    </section>
  )
}

/**
 * The language, which is the one setting on this page that never leaves the
 * browser. See the header.
 */
function LanguageSection() {
  const { t } = useTranslation('settings')
  return (
    <section className="settings-section" aria-labelledby="settings-language">
      <h3 id="settings-language">{t('language.heading')}</h3>
      <p className="settings-section__note">{t('language.note')}</p>
      <LanguagePicker />
    </section>
  )
}

function DangerSection({
  username,
  onDeleted,
}: {
  readonly username: string
  readonly onDeleted: (deleted: DeletionReport) => void
}) {
  const { t } = useTranslation('settings')
  const describeError = useApiErrorMessage()
  const remove = useDeleteAccount()

  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const matches = confirm === username

  return (
    <section className="settings-section settings-section--danger">
      <h3>{t('danger.heading')}</h3>
      <p>{t('danger.body')}</p>
      {/* The surprising part, said on the page rather than only in the code. */}
      <p className="settings-section__note">{t('danger.identityNote')}</p>

      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (remove.isPending || !matches) return
            remove.mutate(confirm, {
              onSuccess: (result) => {
                /*
                 * Hand the report up and stop. Signing out is `AccountDeleted`'s
                 * job, in an effect that runs once the report has been painted
                 * — doing it here tore down the very thing it was announcing,
                 * because this subtree is inside the session guard and that one
                 * is not.
                 */
                onDeleted(result.deleted)
              },
            })
          }}
        >
          {remove.isError ? (
            <p className="auth-alert" role="alert">
              {describeError(remove.error)}
            </p>
          ) : null}

          <div className="field">
            <label htmlFor="settings-confirm">
              {t('danger.confirmLabel', { username })}
            </label>
            <input
              id="settings-confirm"
              type="text"
              value={confirm}
              autoComplete="off"
              onChange={(event) => {
                setConfirm(event.target.value)
              }}
            />
          </div>

          <button
            className="page__cta page__cta--danger"
            type="submit"
            aria-disabled={remove.isPending || !matches}
          >
            {remove.isPending ? t('danger.deleting') : t('danger.confirm')}
          </button>
        </form>
      ) : (
        <button
          className="page__cta page__cta--quiet"
          type="button"
          onClick={() => {
            setOpen(true)
          }}
        >
          {t('danger.reveal')}
        </button>
      )}
    </section>
  )
}
