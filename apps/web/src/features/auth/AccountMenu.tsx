/**
 * Who you are, where your circuits are, and the way out — in the page header.
 *
 * ── The loading state renders neither shape ───────────────────────────────
 *
 * The same rule the route guards follow (`RequireSession.tsx`), applied to a
 * control instead of a page. A menu that treats "not known yet" as "signed
 * out" puts a **Sign in** link in the header of every page for the frame or
 * two it takes supabase-js to read storage, and then swaps it for the user's
 * own address. On a slow refresh that is long enough to click — and clicking
 * it navigates an authenticated user to a sign-in screen that immediately
 * redirects them back. So while the status is `loading` this renders an inert
 * placeholder: it holds the space, so the header does not jump when the
 * answer arrives, and it is `aria-hidden` because "…" is not information and
 * the real control announces itself when it exists.
 *
 * ── Nothing here is a permission check ────────────────────────────────────
 *
 * §11: the server decides. Hiding the menu from an anonymous visitor is a
 * convenience — the circuits listing behind it is `auth: 'required'` in
 * `apps/api`, and typing the URL in reaches the same 401 the menu would have
 * avoided. Removing this component changes what is comfortable, not what is
 * permitted.
 *
 * ── A disclosure, not an ARIA menu ────────────────────────────────────────
 *
 * `role="menu"` comes with a keyboard contract — arrow keys move between
 * items, Tab leaves the whole widget, items are `menuitem` and not links —
 * that is right for an application menu bar and wrong for two links in a
 * header. Half-implemented, it is worse than nothing: a screen reader
 * announces "menu, 2 items" and then the arrow keys do not work. This is a
 * button with `aria-expanded` revealing ordinary links, which every user
 * already knows how to operate, plus the two behaviours a popup owes: Escape
 * closes it and returns focus to the button, and a click elsewhere dismisses
 * it.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import {
  useAuthRuntime,
  useSession,
  useSessionActions,
} from './SessionContext.js'
/*
 * From the leaf modules, which import nothing: this component is rendered by
 * the shell on every page, and reaching for either feature's barrel would pull
 * the collection forms and the settings screen into the entry chunk (M0.9b).
 */
import { COLLECTIONS_PATH } from '../collections/paths.js'
import { SETTINGS_PATH } from '../profile/paths.js'
import { CIRCUITS_PATH, SIGN_IN_PATH } from './paths.js'

export function AccountMenu() {
  const { t } = useTranslation('common')
  const runtime = useAuthRuntime()
  const session = useSession()
  const actions = useSessionActions()

  const [open, setOpen] = useState(false)
  const [signOutFailed, setSignOutFailed] = useState(false)
  const panelId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const dismiss = (event: Event): void => {
      // A click inside the panel is the user using the menu, including the
      // moment before a link navigates.
      if (rootRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Focus goes back to the control that opened the panel; leaving it on a
      // removed element drops the keyboard user at the top of the document.
      buttonRef.current?.focus()
    }

    /*
     * `pointerdown` rather than `click`: a mousedown that starts outside and
     * releases inside produces no click on either element, so a `click`
     * listener leaves the panel open with the pointer somewhere else.
     */
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // No Supabase project on this deployment: there are no accounts to have a
  // menu for, and a sign-in link would lead to a form that can only refuse.
  if (runtime === null) return null

  if (session.status === 'loading') {
    return (
      <span className="account-menu account-menu__pending" aria-hidden="true" />
    )
  }

  if (session.status === 'anonymous') {
    return (
      <Link className="account-menu__signin" to={SIGN_IN_PATH}>
        {t('account.signIn')}
      </Link>
    )
  }

  const { email } = session.user
  // A provider that releases no address still has an account to sign out of.
  const name = email ?? t('account.unnamed')

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        className="account-menu__toggle"
        type="button"
        ref={buttonRef}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen)
        }}
      >
        <span className="account-menu__name">{name}</span>{' '}
        {/* The visible label is the identity; the suffix is what makes the
            accessible name say what the control does. Keeping the visible
            text inside the accessible name is what WCAG 2.5.3 asks for. */}
        <span className="visually-hidden">{t('account.menu')}</span>
      </button>

      {open ? (
        <div className="account-menu__panel" id={panelId}>
          <p className="account-menu__identity">
            {email === null
              ? t('account.signedIn')
              : t('account.signedInAs', { email })}
          </p>

          <ul className="account-menu__items">
            <li>
              <Link
                to={CIRCUITS_PATH}
                onClick={() => {
                  setOpen(false)
                }}
              >
                {t('account.circuits')}
              </Link>
            </li>
            <li>
              <Link
                to={COLLECTIONS_PATH}
                onClick={() => {
                  setOpen(false)
                }}
              >
                {t('account.collections')}
              </Link>
            </li>
            <li>
              <Link
                to={SETTINGS_PATH}
                onClick={() => {
                  setOpen(false)
                }}
              >
                {t('account.settings')}
              </Link>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setSignOutFailed(false)
                  void actions.signOut().then((outcome) => {
                    /*
                     * A failed sign-out is not cosmetic: the session may still
                     * be live, so saying nothing would leave somebody walking
                     * away from a shared machine believing they had signed
                     * out. On success the session turns anonymous and this
                     * whole subtree is replaced by the sign-in link.
                     */
                    if (outcome.ok) setOpen(false)
                    else setSignOutFailed(true)
                  })
                }}
              >
                {t('account.signOut')}
              </button>
            </li>
          </ul>

          {signOutFailed ? (
            <p className="account-menu__error" role="alert">
              {t('account.signOutFailed')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
