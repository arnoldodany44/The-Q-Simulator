/**
 * `/circuits` — the signed-in user's own, a page at a time (M1.3b, M1.4a).
 *
 * The listing itself is `GET /circuits`, which `apps/api` declares
 * `auth: 'required'` and scopes to the caller's own rows. That is what makes
 * this page private; `RequireSession` around it in `App.tsx` only spares an
 * anonymous visitor a round trip ending in a 401 they cannot read (§11). It is
 * also the one listing where PRIVATE and UNLISTED circuits belong — they are
 * the caller's own — which is why the visibility is shown on every card rather
 * than assumed.
 *
 * ── Still deliberately not a gallery ──────────────────────────────────────
 *
 * No sorting, no search, no stars, no forks: that is M1.5, over a different
 * route with a different authorisation story. What M1.4a added is the pair of
 * things that make this a way *into* the work rather than a receipt for it —
 * every card opens `/c/:slug` in the editor, and the pager reaches past the
 * first twenty.
 *
 * ── The page number lives in the URL ──────────────────────────────────────
 *
 * `?page=3` rather than component state, because a page of a listing is a
 * place: Back should return to it, a reload should stay on it, and a link to
 * it should work. It is also the one query parameter here that is safe to
 * expose — unlike a slug, a page number is not access control (§11 and
 * `features/auth/paths.ts` on why `?next=` is not used for the same reason).
 *
 * ── Server state stays server state ───────────────────────────────────────
 *
 * §9: React Query owns everything from the server, Zustand owns the document
 * being edited, and the two do not mix. Nothing here writes into
 * `useCircuitStore`; a circuit reaches the editor through `/c/:slug`, where
 * `useCircuitDocument` performs that crossing once, explicitly.
 *
 * ── "Pending" and "waiting for the network" are different sentences ───────
 *
 * React Query separates `status` from `fetchStatus`, and offline is the case
 * that needs both: the fetch is *paused* — never sent — while the status stays
 * `pending`. A page that branches on `isPending` alone therefore says "Loading
 * your circuits…" for as long as the connection is down, with no error, no
 * retry control and nothing that mentions the network. Observed at six
 * seconds, and at fifteen; it resolves on its own when connectivity returns,
 * which is correct behaviour reported as a hang.
 */

import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import type { CircuitCard } from '@qsim/contract'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
// From the leaf modules rather than the feature's barrel: this route needs a
// path builder and a query-string reader, and the barrel would pull the save
// panel and its mutations into a chunk that renders none of them.
import {
  PAGE_PARAM,
  pageFromSearch,
} from '../features/circuit-storage/pagination'
import { circuitPagePath } from '../features/circuit-storage/paths'
import { useApiErrorMessage, useCircuits } from '../lib/api'

export function CircuitsRoute() {
  const { t, i18n } = useTranslation(['circuits', 'common'])
  const describeError = useApiErrorMessage()
  const [search, setSearch] = useSearchParams()

  const page = pageFromSearch(search)
  const query = useCircuits({ page })
  const data = query.data
  /*
   * §10: every figure the reader sees goes through `Intl.NumberFormat` in the
   * active language. The cards below already did, and the pager under them did
   * not — so one screen spelled the same magnitude two ways, "12 345" on a card
   * and "12345" in the line beneath it.
   */
  const numbers = new Intl.NumberFormat(i18n.language)

  const goTo = (next: number): void => {
    /*
     * `setSearch` rather than a `<Link>` pair, because the page number is the
     * only thing changing and every other parameter on the address has to
     * survive it. `replace: false` on purpose: paging is navigation, and Back
     * returning to the previous page is what a reader expects of it.
     */
    const params = new URLSearchParams(search)
    params.set(PAGE_PARAM, String(next))
    setSearch(params)
  }

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

      <h2 className="auth-page__title">{t('circuits:title')}</h2>
      <p className="auth-page__lead">{t('circuits:lead')}</p>

      {query.isPending && query.fetchStatus !== 'paused' ? (
        <p className="page__loading" role="status">
          {t('circuits:loading')}
        </p>
      ) : null}

      {query.fetchStatus === 'paused' ? (
        <p className="notice" role="status">
          {t('circuits:offline')}
        </p>
      ) : null}

      {query.isError ? (
        <>
          {/*
           * The API sends a code; the sentence is this app's, in three
           * languages (§11, D2). `useApiErrorMessage` is the only translator.
           */}
          <p className="auth-alert" role="alert">
            {describeError(query.error)}
          </p>
          <button
            className="page__cta page__cta--quiet"
            type="button"
            onClick={() => {
              void query.refetch()
            }}
          >
            {t('circuits:retry')}
          </button>
        </>
      ) : null}

      {data === undefined ? null : data.items.length === 0 ? (
        <EmptyState page={page} />
      ) : (
        <>
          <ul className="circuit-list">
            {data.items.map((circuit) => (
              <CircuitRow
                key={circuit.id}
                circuit={circuit}
                locale={i18n.language}
              />
            ))}
          </ul>

          {data.totalPages > 1 ? (
            <nav className="pager" aria-label={t('circuits:pager.label')}>
              {/*
               * `aria-disabled`, not `disabled`. Pressing Next on the
               * second-to-last page makes it the last page and the button
               * unusable — and a disabled button cannot hold focus, so the
               * keyboard user who just pressed it is returned to the document
               * body with the whole listing to tab through again. Announced as
               * unavailable, still reachable, and the handler declines.
               */}
              <button
                type="button"
                aria-disabled={data.page <= 1}
                onClick={() => {
                  if (data.page <= 1) return
                  goTo(data.page - 1)
                }}
              >
                {t('circuits:pager.previous')}
              </button>
              {/*
               * A live region, because pressing Next moves nothing that a
               * screen reader announces on its own: the heading stays, the
               * list is replaced in place, and without this the only feedback
               * is a button that stopped being available.
               */}
              <p className="pager__position" role="status">
                {t('circuits:pager.position', {
                  page: numbers.format(data.page),
                  pages: numbers.format(data.totalPages),
                  total: numbers.format(data.total),
                })}
              </p>
              <button
                type="button"
                aria-disabled={data.page >= data.totalPages}
                onClick={() => {
                  if (data.page >= data.totalPages) return
                  goTo(data.page + 1)
                }}
              >
                {t('circuits:pager.next')}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </main>
  )
}

/**
 * Nothing to show, which is two different situations.
 *
 * A first page with no rows is an account with no circuits, and the answer is
 * the editor. A *later* page with no rows is a page number that outran the
 * listing — a stale link, or a deletion since — and the answer is page one.
 * Offering "open the editor" there would be a non sequitur.
 */
function EmptyState({ page }: { readonly page: number }) {
  const { t } = useTranslation('circuits')

  if (page > 1) {
    return (
      <div className="notice">
        <p>{t('empty.pastTheEnd')}</p>
        <p>
          <Link className="page__cta" to="/circuits">
            {t('empty.firstPage')}
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="notice">
      <p>
        <strong>{t('empty.heading')}</strong>
      </p>
      <p>{t('empty.body')}</p>
      <p>
        <Link className="page__cta" to="/new">
          {t('empty.action')}
        </Link>
      </p>
    </div>
  )
}

interface CircuitRowProps {
  readonly circuit: CircuitCard
  readonly locale: string
}

/**
 * One saved circuit. The counts are a description list rather than a sentence
 * with a number in it: "3 qubits" needs a plural rule per language and the
 * three catalogs have to hold identical keys, so a label and a figure is both
 * simpler and correct in all three (D2).
 *
 * The figures go through `Intl.NumberFormat` for the same reason every number
 * in the analysis panel does — a French reader groups thousands differently —
 * and the timestamp through `Intl.DateTimeFormat`, with the machine-readable
 * value kept in `<time datetime>`.
 *
 * The title is the link, not a separate "open" button beside it: the thing on
 * the card the reader is looking for is the name, and making the name the
 * target is both the larger hit area and the accessible name a screen reader
 * announces for the link.
 */
function CircuitRow({ circuit, locale }: CircuitRowProps) {
  const { t } = useTranslation('circuits')
  const number = new Intl.NumberFormat(locale)
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })

  return (
    <li className="circuit-card">
      <h3 className="circuit-card__title">
        <Link to={circuitPagePath(circuit.slug)}>{circuit.title}</Link>
      </h3>
      <dl className="circuit-card__meta">
        <div>
          <dt>{t('item.visibility')}</dt>
          <dd>{t(`visibility.${circuit.visibility}`)}</dd>
        </div>
        <div>
          <dt>{t('item.qubits')}</dt>
          <dd className="tabular-numbers">
            {number.format(circuit.qubitCount)}
          </dd>
        </div>
        <div>
          <dt>{t('item.gates')}</dt>
          <dd className="tabular-numbers">
            {number.format(circuit.gateCount)}
          </dd>
        </div>
        <div>
          <dt>{t('item.depth')}</dt>
          <dd className="tabular-numbers">{number.format(circuit.depth)}</dd>
        </div>
        <div>
          <dt>{t('item.updated')}</dt>
          <dd>
            <time dateTime={circuit.updatedAt.toISOString()}>
              {date.format(circuit.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </li>
  )
}
