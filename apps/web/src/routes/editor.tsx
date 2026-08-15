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
 *
 * ── Why the URL lives here and not in `CircuitEditor` (M0.9) ─────────────
 *
 * `useCircuitUrl` is mounted by the *page*, not by the editor component, and
 * the reason is the same one that makes the editor take its store as a prop:
 * a preview or a diff view will eventually put two editors on one screen, and
 * two components fighting over one address bar is not a thing that can be
 * made to work. There is one URL per page, so the page owns it. It also keeps
 * `CircuitEditor` free of the browser's history, which is what lets its own
 * tests build circuits without leaving a `?c=` behind for the next one.
 *
 * The examples and the share control sit above the editor rather than inside
 * it for the same reason: they are commands about the *document* — open
 * another one, hand this one to somebody — while everything in the editor
 * card is a command about the circuit already open.
 *
 * `useExample` is the second half of that ownership (M0.9b): the landing page
 * links here with `?example=bell`, and the parameter names an opening document
 * exactly as `?c=` does. It is mounted second because `?c=` outranks it.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { CircuitEditor } from '../features/circuit-editor/CircuitEditor'
import { PresetPicker } from '../features/circuit-editor/PresetPicker'
import { ShareLink } from '../features/circuit-editor/ShareLink'
import { useCircuitStore } from '../features/circuit-editor/useCircuitStore'
import { useCircuitUrl } from '../features/circuit-editor/useCircuitUrl'
import { useExample } from '../features/circuit-editor/useExample'

export function EditorRoute() {
  const { t } = useTranslation(['editor', 'common'])
  const url = useCircuitUrl({ store: useCircuitStore })
  // After `useCircuitUrl`, never before: layout effects run in hook order and
  // a shared `?c=` circuit outranks a named example. See `useExample.ts`.
  useExample({ store: useCircuitStore })

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

      <div className="document-bar">
        <PresetPicker store={useCircuitStore} />
        <ShareLink url={url} />
      </div>

      <CircuitEditor />
    </main>
  )
}
