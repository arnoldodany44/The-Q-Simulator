/**
 * The frame the four account screens share.
 *
 * Same header as every other page — the product name linking home, and the
 * language picker — because a user who cannot read the interface has to be
 * able to change it from the screen they are stuck on, and the sign-in screen
 * is exactly where somebody arrives having never chosen a language (D2).
 *
 * Deliberately no account menu here. It renders "Sign in" for an anonymous
 * visitor, and these pages *are* the sign-in; the menu would be a link to the
 * page it is on. Three of the four are behind `RedirectWhenSignedIn` anyway,
 * so the signed-in shape of the menu is unreachable from them.
 *
 * The heading level is the one the rest of the app uses: `h1` is the product,
 * `h2` is what this page is for. Consistent with `routes/editor.tsx`, and it
 * keeps every route to exactly one `h1`.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { ReactNode } from 'react'

import { LanguagePicker } from '../../components/LanguagePicker.js'

export interface AuthPageProps {
  readonly title: string
  /** One sentence saying why this screen exists. */
  readonly lead?: string | undefined
  readonly children: ReactNode
}

export function AuthPage({ title, lead, children }: AuthPageProps) {
  const { t } = useTranslation('common')

  return (
    <main className="page auth-page">
      <header className="page__header">
        <h1>
          <Link to="/">{t('appName')}</Link>
        </h1>
        <LanguagePicker />
      </header>

      <h2 className="auth-page__title">{title}</h2>
      {lead === undefined ? null : <p className="auth-page__lead">{lead}</p>}

      {children}
    </main>
  )
}
