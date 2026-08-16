/**
 * One collection in a listing — M1.9.
 *
 * ── Visibility is shown only when it is news ──────────────────────────────
 *
 * Same rule as `GalleryCard`: a listing on somebody's profile is public by
 * construction, so a PUBLIC badge on every card is noise. What the owner sees
 * in *their own* index does need it, because there the badge is the only thing
 * on screen that says why a stranger cannot open this one.
 *
 * ── The count is the stored one ───────────────────────────────────────────
 *
 * `itemCount` includes circuits the reader may not see, and a card is not the
 * place to explain that — the collection's own page carries
 * `withheldItemCount` and says so in a sentence. On a card the honest figure
 * is "how many things the curator put in here", which is what this is.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { CollectionCard as CollectionCardData } from '@qsim/contract'

import { collectionPagePath } from './paths'

export interface CollectionCardProps {
  readonly collection: CollectionCardData
  /** Suppressed where every card on the page is public by construction. */
  readonly showVisibility?: boolean
}

export function CollectionCard({
  collection,
  showVisibility = true,
}: CollectionCardProps) {
  const { t, i18n } = useTranslation(['collections', 'circuits'])
  const numbers = new Intl.NumberFormat(i18n.language)
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })

  return (
    <li className="collection-card">
      <h3 className="collection-card__title">
        {/* The title is the link, for the reason `GalleryCard` gives: the thing
            a reader is looking for is the name. */}
        <Link to={collectionPagePath(collection.id)}>{collection.title}</Link>
      </h3>

      {showVisibility && collection.visibility !== 'PUBLIC' ? (
        <p className="collection-card__visibility">
          {t(`circuits:visibility.${collection.visibility}`)}
        </p>
      ) : null}

      {collection.description === null ||
      collection.description === '' ? null : (
        <p className="collection-card__description">
          {/* The curator's own words: text, escaped by React, never through
              the catalog. */}
          {collection.description}
        </p>
      )}

      <dl className="collection-card__meta">
        <div>
          <dt>{t('collections:card.items')}</dt>
          <dd className="tabular-numbers">
            {numbers.format(collection.itemCount)}
          </dd>
        </div>
        <div>
          <dt>{t('collections:card.updated')}</dt>
          <dd>
            <time dateTime={collection.updatedAt.toISOString()}>
              {date.format(collection.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </li>
  )
}
