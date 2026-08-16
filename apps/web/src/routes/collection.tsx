/**
 * `/collections/:id` — one collection (§3.4, milestone M1.9).
 *
 * ── Anonymous, like every other read ──────────────────────────────────────
 *
 * Not behind a guard: `GET /collections/:id` is `auth: 'optional'`, which is
 * what makes a PUBLIC collection something you can send somebody and an
 * UNLISTED one a link that works. What a viewer may see is decided on the
 * server, twice — once whether this collection opens at all, and once for each
 * circuit inside it — and never here.
 *
 * ── The withheld line is the point of this page ───────────────────────────
 *
 * The server returns the items this viewer may see plus a count of the ones it
 * withheld, and this page *says so*. A collection of five that silently
 * rendered two would tell a reader that somebody's curation is nearly empty,
 * which is a lie about their work; the sentence turns it into a fact about the
 * reader's own access. It names no circuit, because the response carries none
 * — the number is all there is, and all there should be.
 *
 * ── Editing happens in place ──────────────────────────────────────────────
 *
 * The owner gets the same page with controls on it rather than a separate
 * edit screen, because the thing being edited is the thing on screen and a
 * second route would be a second place for the visibility note to drift.
 * Whether the controls appear is a convenience: the server checks ownership on
 * every write, and a reader who forges the button reaches a 403.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu, useSession } from '../features/auth'
import {
  AddCircuitToCollection,
  COLLECTIONS_PATH,
  CollectionForm,
} from '../features/collections'
import type { CollectionDraft } from '../features/collections'
import { pluralCount } from '../features/analysis/format'
import { GalleryCard, profilePath } from '../features/gallery'
import { Avatar } from '../features/profile'
import {
  isNotFound,
  useApiErrorMessage,
  useCollection,
  useDeleteCollection,
  useRemoveCollectionItem,
  useUpdateCollection,
} from '../lib/api'

export function CollectionRoute() {
  const { t, i18n } = useTranslation(['collections', 'circuits', 'common'])
  const { id = null } = useParams<{ id: string }>()
  const session = useSession()
  const describeError = useApiErrorMessage()
  const navigate = useNavigate()

  const query = useCollection(id)
  const update = useUpdateCollection()
  const remove = useDeleteCollection()
  const removeItem = useRemoveCollectionItem()
  const [editing, setEditing] = useState(false)
  const numbers = new Intl.NumberFormat(i18n.language)

  const view = query.data ?? null
  const collection = view?.collection ?? null
  /*
   * A convenience only. Every write is authorised on the server against the
   * verified token, so this decides what is *drawn* and never what is allowed
   * (§11).
   */
  const isOwner =
    collection !== null && session.user?.id === collection.owner.id

  const missing = query.isError && isNotFound(query.error)

  const save = (draft: CollectionDraft): void => {
    if (collection === null) return
    update.mutate(
      {
        id: collection.id,
        changes: {
          title: draft.title,
          description: draft.description === '' ? null : draft.description,
          visibility: draft.visibility,
        },
      },
      {
        onSuccess: () => {
          setEditing(false)
        },
      }
    )
  }

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      {missing ? (
        <div className="notice" role="alert">
          {/*
           * "No such collection, or not yours to open" — the server does not
           * distinguish the two and neither does this sentence, because
           * distinguishing them would confirm that a private collection
           * exists.
           */}
          <p>{t('collections:unknown')}</p>
          <p>
            <Link className="page__cta" to="/gallery">
              {t('collections:toGallery')}
            </Link>
          </p>
        </div>
      ) : null}

      {query.isPending && !missing ? (
        <p className="page__loading" role="status">
          {t('collections:loading')}
        </p>
      ) : null}

      {query.isError && !missing ? (
        <p className="auth-alert" role="alert">
          {describeError(query.error)}
        </p>
      ) : null}

      {view === null || collection === null ? null : (
        <>
          <h2 className="auth-page__title">{collection.title}</h2>

          <p className="collection-page__byline">
            <Avatar
              identity={collection.owner.id}
              avatarUrl={collection.owner.avatarUrl}
              size={24}
            />
            <span className="visually-hidden">
              {t('collections:page.curator')}
            </span>
            <Link to={profilePath(collection.owner.username)}>
              {collection.owner.username}
            </Link>
            {collection.visibility === 'PUBLIC' ? null : (
              <span className="collection-card__visibility">
                {t(`circuits:visibility.${collection.visibility}`)}
              </span>
            )}
          </p>

          {collection.description === null ||
          collection.description === '' ? null : (
            <p className="auth-page__lead">{collection.description}</p>
          )}

          {isOwner ? (
            <div className="collection-page__tools">
              <button
                className="page__cta page__cta--quiet"
                type="button"
                onClick={() => {
                  setEditing((was) => !was)
                }}
              >
                {editing
                  ? t('collections:edit.cancel')
                  : t('collections:edit.open')}
              </button>
              <button
                className="page__cta page__cta--danger"
                type="button"
                aria-disabled={remove.isPending}
                onClick={() => {
                  if (remove.isPending) return
                  remove.mutate(collection.id, {
                    onSuccess: () => {
                      void navigate(COLLECTIONS_PATH)
                    },
                  })
                }}
              >
                {remove.isPending
                  ? t('collections:edit.deleting')
                  : t('collections:edit.delete')}
              </button>
            </div>
          ) : null}

          {isOwner && editing ? (
            <CollectionForm
              initial={{
                title: collection.title,
                description: collection.description ?? '',
                visibility: collection.visibility,
              }}
              submitLabel={t('collections:edit.save')}
              pending={update.isPending}
              onSubmit={save}
              error={update.isError ? describeError(update.error) : null}
            />
          ) : null}

          {/*
           * The sentence this page exists for. A live region because the count
           * changes when the owner removes an item, and nothing else on screen
           * announces that.
           *
           * Both halves agree in number. They used to be single keys with no
           * plural forms at all — "Showing 1 of 2 circuits. 1 are not visible
           * to you." in every language — and the `count` option was handed the
           * *formatted* figure, a string, which switches i18next's plural
           * machinery off entirely (`needsPluralHandling` requires a non-string
           * count). So the form is selected by `pluralCount` and the figure is
           * interpolated separately, already written the way the active
           * language writes numbers: the rule `format.ts` states and the whole
           * analysis panel follows.
           */}
          <p className="collection-page__summary" role="status">
            {t('collections:page.shown', {
              count: pluralCount(collection.itemCount),
              shown: numbers.format(view.items.length),
              total: numbers.format(collection.itemCount),
            })}
            {view.withheldItemCount > 0
              ? ` ${t('collections:page.withheld', {
                  count: pluralCount(view.withheldItemCount),
                  value: numbers.format(view.withheldItemCount),
                })}`
              : ''}
          </p>

          {isOwner ? (
            <AddCircuitToCollection
              collectionId={collection.id}
              present={view.items.map((circuit) => circuit.id)}
            />
          ) : null}

          {view.items.length === 0 ? (
            <div className="notice">
              <p>{t('collections:page.empty')}</p>
              {isOwner ? <p>{t('collections:page.emptyOwner')}</p> : null}
            </div>
          ) : (
            <ul className="gallery-list" aria-label={t('collections:listing')}>
              {view.items.map((circuit) => (
                /*
                 * The same card the gallery draws, with the same star and fork
                 * wiring — one implementation, because two would be two
                 * behaviours wearing one word. The owner's "remove" goes in the
                 * card's own actions slot rather than beside it, so the tab
                 * order stays where a reader expects.
                 */
                <GalleryCard
                  key={circuit.id}
                  circuit={circuit}
                  starred={view.starred.includes(circuit.id)}
                  actions={
                    isOwner ? (
                      <button
                        className="page__cta page__cta--quiet"
                        type="button"
                        aria-disabled={removeItem.isPending}
                        onClick={() => {
                          if (removeItem.isPending) return
                          removeItem.mutate({
                            id: collection.id,
                            circuit: circuit.slug,
                            circuitId: circuit.id,
                          })
                        }}
                      >
                        {/* Named, so fifty identical "Remove" buttons are
                            distinguishable in a screen reader's list of
                            controls (WCAG 2.4.6). */}
                        {t('collections:page.remove', { title: circuit.title })}
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
