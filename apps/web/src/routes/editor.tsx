/**
 * `/new` — a blank circuit, ready to edit (specification §9).
 *
 * The route is thin on purpose: it is a page frame around `CircuitEditor`,
 * which owns everything that is actually the editor. `/c/:slug` arrives with
 * persistence in Phase 1 and will render the same component against a
 * circuit loaded from the API, so anything this file grew would have to be
 * grown twice.
 *
 * The page is wider than the landing's reading column: a circuit is a wide
 * thing, and forcing it into 42rem would put a scrollbar under every gate
 * from the third column onwards.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { CircuitEditor } from '../features/circuit-editor/CircuitEditor'

export function EditorRoute() {
  const { t } = useTranslation(['editor', 'common'])

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <LanguagePicker />
      </header>

      <h2 className="section-heading">{t('editor:page.heading')}</h2>
      <p>{t('editor:page.intro')}</p>

      <CircuitEditor />
    </main>
  )
}
