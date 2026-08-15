/**
 * The history: every version this circuit has ever had — §3.4, M1.4b.
 *
 * ── It lists, and it does not act ─────────────────────────────────────────
 *
 * Everything here either navigates or changes nothing at all. Opening a
 * version and comparing two of them are both selections, they both land in the
 * address (`useVersionSelection`), and neither writes to the server or to the
 * document on screen. Restoring — the one thing here that creates a row — is
 * deliberately *not* a button on a row of this list: it lives in the preview,
 * one deliberate step further in, so that the control which appends a version
 * is never the control next to the one that merely looks at it.
 *
 * ── As visible as the circuit, and no more ────────────────────────────────
 *
 * `GET /circuits/:id/versions` is `auth: 'optional'` in `apps/api` and applies
 * the same §11 filter as the circuit itself, so a reader who can open a PUBLIC
 * or UNLISTED circuit can read its history and a reader who cannot gets the
 * same 404 they get for the circuit. This panel therefore renders for anyone
 * who has the document open, signed in or not. It is not a permission
 * decision — the server already made it — it is simply the same answer.
 *
 * ── Newest first, and the dates are the reader's ──────────────────────────
 *
 * The API orders by `versionNum` descending, which is what the specification
 * asks for and also what a reader wants: the most recent save is the one being
 * looked for. Timestamps go through `Intl.DateTimeFormat` in the active
 * language, with the machine-readable value in `<time datetime>` — the same
 * arrangement the circuit listing uses, for the same reason. A version saved
 * ten minutes ago and one saved yesterday are told apart by the time, so this
 * one carries a time as well as a date.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CircuitVersionSummary } from '@qsim/contract'

import { useApiErrorMessage, useCircuitVersions } from '../../lib/api'
import type { VersionSelection } from './versionParams.js'

export interface VersionHistoryPanelProps {
  /** The circuit's slug — or its id; the route accepts either. */
  readonly handle: string
  /** The version the open document descends from, marked in the list. */
  readonly currentVersion: number | null
  readonly selection: VersionSelection
  readonly onSelect: (next: VersionSelection) => void
}

export function VersionHistoryPanel({
  handle,
  currentVersion,
  selection,
  onSelect,
}: VersionHistoryPanelProps) {
  const { t } = useTranslation('circuits')
  const headingId = useId()
  const [open, setOpen] = useState(false)

  return (
    <section className="history-panel" aria-labelledby={headingId}>
      <h3 className="history-panel__heading" id={headingId}>
        {t('history.heading')}
      </h3>
      <p className="history-panel__hint">{t('history.hint')}</p>
      <button
        className="history-panel__toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen)
        }}
      >
        {open ? t('history.close') : t('history.open')}
      </button>

      {/*
       * The query is inside the disclosure on purpose: a reader who never
       * opens the history never fetches it, and the editor is the one screen
       * where an extra round trip on every load would be paid by everybody.
       */}
      {open ? (
        <HistoryList
          handle={handle}
          currentVersion={currentVersion}
          selection={selection}
          onSelect={onSelect}
        />
      ) : null}
    </section>
  )
}

function HistoryList({
  handle,
  currentVersion,
  selection,
  onSelect,
}: VersionHistoryPanelProps) {
  const { t, i18n } = useTranslation('circuits')
  const describeError = useApiErrorMessage()
  const [page, setPage] = useState(1)
  // §10, and consistency with the version numbers in the rows below.
  const numbers = new Intl.NumberFormat(i18n.language)

  const query = useCircuitVersions(handle, { page })
  const data = query.data

  if (query.isPending) {
    return (
      <p className="page__loading" role="status">
        {t('history.loading')}
      </p>
    )
  }

  if (query.isError) {
    return (
      <>
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
          {t('retry')}
        </button>
      </>
    )
  }

  if (data === undefined || data.items.length === 0) {
    return <p className="history-panel__empty">{t('history.empty')}</p>
  }

  return (
    <>
      <ol className="history-list">
        {data.items.map((version) => (
          <VersionRow
            key={version.id}
            version={version}
            locale={i18n.language}
            isCurrent={version.versionNum === currentVersion}
            isViewed={version.versionNum === selection.version}
            onSelect={onSelect}
          />
        ))}
      </ol>

      {data.totalPages > 1 ? (
        <nav className="pager" aria-label={t('history.pager.label')}>
          {/* Focusable at the ends of the range — see routes/circuits.tsx. */}
          <button
            type="button"
            aria-disabled={data.page <= 1}
            onClick={() => {
              if (data.page <= 1) return
              setPage(data.page - 1)
            }}
          >
            {t('pager.previous')}
          </button>
          <p className="pager__position" role="status">
            {t('history.pager.position', {
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
              setPage(data.page + 1)
            }}
          >
            {t('pager.next')}
          </button>
        </nav>
      ) : null}

      <CompareForm
        versions={data.items}
        selection={selection}
        onSelect={onSelect}
      />
    </>
  )
}

interface VersionRowProps {
  readonly version: CircuitVersionSummary
  readonly locale: string
  /** The version the editor's document descends from. */
  readonly isCurrent: boolean
  /** The version the page is showing, if any. */
  readonly isViewed: boolean
  readonly onSelect: (next: VersionSelection) => void
}

function VersionRow({
  version,
  locale,
  isCurrent,
  isViewed,
  onSelect,
}: VersionRowProps) {
  const { t } = useTranslation('circuits')
  const numbers = new Intl.NumberFormat(locale)
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <li
      className="history-item"
      // The row the page is showing. `aria-current` rather than a colour or a
      // border, because "this is the one you are looking at" is a fact a
      // screen reader has to be told as well.
      {...(isViewed ? { 'aria-current': true as const } : {})}
    >
      <p className="history-item__version">
        {t('history.version', { number: numbers.format(version.versionNum) })}
        {isCurrent ? (
          <span className="history-item__badge">{t('history.current')}</span>
        ) : null}
      </p>
      <p className="history-item__when">
        <time dateTime={version.createdAt.toISOString()}>
          {when.format(version.createdAt)}
        </time>
      </p>
      {/*
       * The message is what the person who saved it typed. It is user content
       * rendered as text — React escapes it — and it is not run through the
       * catalog because it is not this app's words. Only its absence is.
       */}
      <p
        className={
          version.message === null
            ? 'history-item__message history-item__message--absent'
            : 'history-item__message'
        }
      >
        {version.message ?? t('history.noMessage')}
      </p>
      <div className="history-item__actions">
        <button
          type="button"
          onClick={() => {
            onSelect({ version: version.versionNum, compare: null })
          }}
        >
          {t('history.view')}
        </button>
        {version.versionNum > 1 ? (
          <button
            type="button"
            onClick={() => {
              onSelect({
                version: version.versionNum,
                compare: version.versionNum - 1,
              })
            }}
          >
            {t('history.compareWithPrevious')}
          </button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Comparing any two versions, rather than only a version with the one before
 * it.
 *
 * Two selects and a button, because that is the shape with real labels, a
 * keyboard path that needs no invention, and no hidden state machine counting
 * how many rows are ticked. The options are the versions on the page currently
 * listed — the pager above changes them — which is a limit worth naming: this
 * compares things you can see, and a select holding a thousand numbers would
 * be a worse control than a pager.
 */
function CompareForm({
  versions,
  selection,
  onSelect,
}: {
  versions: readonly CircuitVersionSummary[]
  selection: VersionSelection
  onSelect: (next: VersionSelection) => void
}) {
  const { t, i18n } = useTranslation('circuits')
  const fromId = useId()
  const toId = useId()
  const numbers = new Intl.NumberFormat(i18n.language)

  const newest = versions[0]?.versionNum ?? 1
  const oldest = versions[versions.length - 1]?.versionNum ?? newest

  const [from, setFrom] = useState(String(selection.compare ?? oldest))
  const [to, setTo] = useState(String(selection.version ?? newest))

  if (versions.length < 2) return null

  const label = (versionNum: number): string =>
    t('history.version', { number: numbers.format(versionNum) })

  return (
    <form
      className="history-compare"
      onSubmit={(event) => {
        event.preventDefault()
        const older = Math.min(Number(from), Number(to))
        const newer = Math.max(Number(from), Number(to))
        onSelect({ version: newer, compare: older })
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor={fromId}>
          {t('history.compare.from')}
        </label>
        <select
          className="field__input"
          id={fromId}
          value={from}
          onChange={(event) => {
            setFrom(event.target.value)
          }}
        >
          {versions.map((version) => (
            <option key={version.id} value={String(version.versionNum)}>
              {label(version.versionNum)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={toId}>
          {t('history.compare.to')}
        </label>
        {/*
         * The visible label is one word — "with", "avec", "con" — because the
         * two selects read as one sentence to an eye that takes them in
         * together. Heard on its own it describes nothing, so the accessible
         * name completes it (WCAG 2.2 SC 2.4.6). It still begins with the
         * visible word, which is what SC 2.5.3 asks of a name that overrides a
         * label.
         */}
        <select
          className="field__input"
          id={toId}
          aria-label={t('history.compare.toAccessible')}
          value={to}
          onChange={(event) => {
            setTo(event.target.value)
          }}
        >
          {versions.map((version) => (
            <option key={version.id} value={String(version.versionNum)}>
              {label(version.versionNum)}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" disabled={from === to}>
        {t('history.compare.submit')}
      </button>
    </form>
  )
}
