/**
 * One circuit in a public listing — M1.5b.
 *
 * ── Everything on it comes from the listing's own response ────────────────
 *
 * The title, the author, the counters, the tags and the *drawing* all arrive
 * in the one request that produced the page. That is the point of the
 * thumbnail living on `CircuitCardResponse`: a card that fetched its own
 * picture would be fifty round trips and fifty full documents on the front
 * page of the product. See `previewOf` in @qsim/schema, and the migration that
 * put the column there.
 *
 * ── The title is the link ─────────────────────────────────────────────────
 *
 * Not a separate "open" button beside it, for the reason `routes/circuits.tsx`
 * gives: the thing on the card a reader is looking for is the name, so making
 * the name the target is both the larger hit area and the accessible name a
 * screen reader announces. The thumbnail is `aria-hidden` and deliberately not
 * a second link to the same place — a duplicate link with no text is a stop on
 * every keyboard user's way through the list that leads exactly where the one
 * above it already led.
 *
 * ── The figures are a description list, not a sentence ────────────────────
 *
 * "3 qubits" needs a plural rule per language and all three catalogs must hold
 * identical keys (D2), so a label and a figure is both simpler and correct in
 * all three. Every number goes through `Intl.NumberFormat` for the active
 * language, and the timestamp through `Intl.DateTimeFormat` with the
 * machine-readable value kept in `<time datetime>` (§10).
 *
 * ── Visibility is shown only when it is news ──────────────────────────────
 *
 * A public listing is public by construction, so a PUBLIC badge on every card
 * would be noise. The owner's own PRIVATE and UNLISTED circuits *do* appear in
 * their own view of the gallery (`listableCircuitFilter` admits `ownerId =
 * viewer`), and there the badge is the only thing on screen that says why a
 * stranger cannot see this one.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { ReactNode } from 'react'
import type { CircuitCard as CircuitCardData } from '@qsim/contract'

import { circuitPagePath } from '../circuit-storage/paths'
import { CircuitThumbnail } from './CircuitThumbnail'
import { ForkButton } from './ForkButton'
import { StarButton } from './StarButton'
import { profilePath } from './paths'

export interface GalleryCardProps {
  readonly circuit: CircuitCardData
  /** Whether this viewer has starred it — from the page envelope, not the card. */
  readonly starred: boolean
  /** Chosen from the card's own tags; `null` on a listing with no tag facet. */
  readonly onSelectTag?: ((tag: string) => void) | undefined
  /** The author's byline is redundant on their own profile page. */
  readonly showAuthor?: boolean
  /**
   * One more control beside the star and the fork — M1.9's "remove from this
   * collection", and nothing else so far.
   *
   * A slot rather than a second card component: the card *is* the same card,
   * with the same thumbnail, counters and star wiring, and a copy of it that
   * differed by one button is a copy that would drift. It renders inside the
   * card's own actions group so the tab order stays where a reader expects it.
   */
  readonly actions?: ReactNode
}

export function GalleryCard({
  circuit,
  starred,
  onSelectTag,
  showAuthor = true,
  actions,
}: GalleryCardProps) {
  const { t, i18n } = useTranslation(['gallery', 'circuits'])
  const numbers = new Intl.NumberFormat(i18n.language)
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })

  return (
    <li className="gallery-card">
      <div className="gallery-card__figure">
        {circuit.preview === null ? (
          /*
           * A circuit stored before M1.5b, or one whose thumbnail no longer
           * parses. The counters below say what it is; an empty frame keeps
           * the row heights even so a listing does not look broken where it is
           * merely older. See `safeParsePreview` on why this is never a 500.
           */
          <div className="circuit-thumbnail circuit-thumbnail--absent" />
        ) : (
          <CircuitThumbnail preview={circuit.preview} />
        )}
      </div>

      <div className="gallery-card__body">
        <h3 className="gallery-card__title">
          <Link to={circuitPagePath(circuit.slug)}>{circuit.title}</Link>
        </h3>

        {showAuthor ? (
          <p className="gallery-card__byline">
            {/*
             * The author's own words — a username they chose — rendered as
             * text and escaped by React, never through the catalog. The label
             * around it is this app's and is translated.
             */}
            <span className="visually-hidden">{t('gallery:card.author')}</span>
            <Link to={profilePath(circuit.owner.username)}>
              {circuit.owner.username}
            </Link>
          </p>
        ) : null}

        {circuit.visibility === 'PUBLIC' ? null : (
          <p className="gallery-card__visibility">
            {t(`circuits:visibility.${circuit.visibility}`)}
          </p>
        )}

        <dl className="gallery-card__meta">
          <div>
            <dt>{t('circuits:item.qubits')}</dt>
            <dd className="tabular-numbers">
              {numbers.format(circuit.qubitCount)}
            </dd>
          </div>
          <div>
            <dt>{t('circuits:item.gates')}</dt>
            <dd className="tabular-numbers">
              {numbers.format(circuit.gateCount)}
            </dd>
          </div>
          <div>
            <dt>{t('circuits:item.depth')}</dt>
            <dd className="tabular-numbers">{numbers.format(circuit.depth)}</dd>
          </div>
          <div>
            <dt>{t('circuits:item.updated')}</dt>
            <dd>
              <time dateTime={circuit.updatedAt.toISOString()}>
                {date.format(circuit.updatedAt)}
              </time>
            </dd>
          </div>
        </dl>

        {circuit.tags.length === 0 ? null : (
          <ul
            className="gallery-card__tags"
            aria-label={t('gallery:card.tags')}
          >
            {circuit.tags.map((tag) => (
              <li key={tag}>
                {/*
                 * A button rather than a link, because choosing a facet
                 * rewrites the listing this card is standing in rather than
                 * navigating away from it — and a `<a>` that does not go
                 * anywhere is a lie told to every assistive technology. On a
                 * listing with no facet (a profile page) the tag is plain text
                 * instead of a control that would do nothing.
                 */}
                {onSelectTag === undefined ? (
                  <span className="tag-chip tag-chip--static">{tag}</span>
                ) : (
                  <button
                    className="tag-chip"
                    type="button"
                    onClick={() => {
                      onSelectTag(tag)
                    }}
                  >
                    {tag}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="gallery-card__actions">
        <StarButton
          slug={circuit.slug}
          circuitId={circuit.id}
          starred={starred}
          starCount={circuit.starCount}
        />
        <ForkButton
          slug={circuit.slug}
          title={circuit.title}
          username={circuit.owner.username}
        />
        {actions}
      </div>
    </li>
  )
}
