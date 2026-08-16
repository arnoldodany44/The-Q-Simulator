/**
 * `/collections` — the signed-in user's own collections (§3.4, M1.9).
 *
 * Behind `RequireSession` in `App.tsx`, which spares an anonymous visitor a
 * round trip that would end in a 401 they cannot read. The listing itself is
 * `GET /collections`, which `apps/api` declares `auth: 'required'` and scopes
 * to the caller's own rows — that is what makes this page private, not the
 * guard (§11).
 *
 * It is the one listing where a PRIVATE collection belongs, because they are
 * the caller's own, which is why every card here shows its visibility rather
 * than assuming it.
 */

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import { CollectionCard, CollectionForm } from '../features/collections'
import type { CollectionDraft } from '../features/collections'
import {
  PAGE_PARAM,
  pageFromSearch,
} from '../features/circuit-storage/pagination'
import {
  useApiErrorMessage,
  useCollections,
  useCreateCollection,
} from '../lib/api'

export function CollectionsRoute() {
  const { t, i18n } = useTranslation(['collections', 'common'])
  const describeError = useApiErrorMessage()
  const [search, setSearch] = useSearchParams()
  const [creating, setCreating] = useState(false)
  /*
   * The control that opens the form, so focus can come back to it when the
   * form goes away. Creating a collection unmounted the form and left
   * `document.activeElement` on `document.body` — the outcome every other
   * async completion in this app engineers around (`VersionPreview` focuses a
   * heading after a restore, `SaveCircuitPanel` and all four auth routes focus
   * a field), and the one that `aria-disabled` is used everywhere else
   * precisely to avoid.
   */
  const openButton = useRef<HTMLButtonElement>(null)

  const page = pageFromSearch(search)
  const query = useCollections({ page })
  const create = useCreateCollection()
  const numbers = new Intl.NumberFormat(i18n.language)

  const goTo = (next: number): void => {
    const params = new URLSearchParams(search)
    params.set(PAGE_PARAM, String(next))
    setSearch(params)
  }

  const submit = (draft: CollectionDraft): void => {
    create.mutate(
      {
        title: draft.title,
        description: draft.description === '' ? null : draft.description,
        visibility: draft.visibility,
      },
      {
        onSuccess: () => {
          setCreating(false)
          /*
           * After the render that unmounts the form, not during it: the button
           * does not exist yet at the moment `setCreating(false)` is called.
           * Returning focus to the control that opened the form is where the
           * reader was, and it is beside the list their new collection is now
           * at the top of.
           */
          queueMicrotask(() => {
            openButton.current?.focus()
          })
        },
      }
    )
  }

  const data = query.data

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

      <h2 className="auth-page__title">{t('collections:title')}</h2>
      <p className="auth-page__lead">{t('collections:lead')}</p>

      {creating ? (
        <CollectionForm
          submitLabel={t('collections:create.submit')}
          pending={create.isPending}
          onSubmit={submit}
          error={create.isError ? describeError(create.error) : null}
        />
      ) : (
        <button
          className="page__cta"
          type="button"
          ref={openButton}
          onClick={() => {
            setCreating(true)
          }}
        >
          {t('collections:create.open')}
        </button>
      )}

      {query.isPending && query.fetchStatus !== 'paused' ? (
        <p className="page__loading" role="status">
          {t('collections:loading')}
        </p>
      ) : null}

      {query.fetchStatus === 'paused' ? (
        <p className="notice" role="status">
          {t('collections:offline')}
        </p>
      ) : null}

      {query.isError ? (
        <div className="notice" role="alert">
          <p>{describeError(query.error)}</p>
          <button
            className="page__cta page__cta--quiet"
            type="button"
            onClick={() => {
              void query.refetch()
            }}
          >
            {t('collections:retry')}
          </button>
        </div>
      ) : null}

      {data === undefined ? null : data.items.length === 0 ? (
        <div className="notice">
          <p>
            <strong>{t('collections:empty.heading')}</strong>
          </p>
          <p>{t('collections:empty.body')}</p>
        </div>
      ) : (
        <>
          <ul className="collection-list" aria-label={t('collections:listing')}>
            {data.items.map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </ul>

          {data.totalPages > 1 ? (
            <nav className="pager" aria-label={t('collections:pager.label')}>
              {/*
               * `aria-disabled` rather than `disabled` throughout, for the
               * reason `routes/circuits.tsx` documents: a disabled button
               * cannot hold focus, so the keyboard user who just pressed it is
               * returned to the top of the document.
               */}
              <button
                type="button"
                aria-disabled={data.page <= 1}
                onClick={() => {
                  if (data.page <= 1) return
                  goTo(data.page - 1)
                }}
              >
                {t('collections:pager.previous')}
              </button>
              <p className="pager__position" role="status">
                {t('collections:pager.position', {
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
                {t('collections:pager.next')}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </main>
  )
}
