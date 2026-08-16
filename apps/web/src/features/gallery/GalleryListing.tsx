/**
 * The cards, and everything that happens when there are none — M1.5b.
 *
 * Shared by the gallery and by an author's page, because they are one query
 * with one more `AND` on the server (`gallery.ts` in apps/api says so in the
 * same words). Two renderings would be two places for the star wiring, the
 * empty state and the pager to drift.
 *
 * ── Pages, or scroll? Neither, and on purpose ─────────────────────────────
 *
 * Numbered pages are not available: the listing is keyset-paginated, because
 * the default ordering is by a column other people change while a reader is
 * reading and an offset into a shifting ordering silently repeats or skips
 * rows (`GalleryCursor` in @qsim/db). There is no way to ask for page four
 * without walking to it, so a pager would be a lie about what the server can
 * do.
 *
 * Infinite scroll is available and is not accessible. An `IntersectionObserver`
 * on a sentinel responds to a wheel and to nothing else: a keyboard user tabs
 * to the end of the list and finds nothing there, a screen-reader user is
 * never told that more arrived, and neither has any way to reach the end of a
 * document that grows as they approach it.
 *
 * So: an explicit **Show more** button, which is the keyboard-operable form of
 * the same idea. It is a real button, it is the last thing in the tab order
 * after the cards, pressing it appends rather than replaces, and focus stays
 * on it — so a second press is the same key again, and the cards that arrived
 * are between the reader and the control they are still standing on. The
 * status line above it is a live region, so what changed is announced rather
 * than merely rendered.
 *
 * ── "Pending" and "waiting for the network" are different sentences ───────
 *
 * React Query separates `status` from `fetchStatus`, and offline is the case
 * that needs both: the fetch is *paused* — never sent — while the status stays
 * `pending`. A listing that branches on `isPending` alone says "Loading…" for
 * as long as the connection is down, with no error, no retry and nothing that
 * mentions the network. `routes/circuits.tsx` learned this the same way.
 */

import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type {
  UseInfiniteQueryResult,
  InfiniteData,
} from '@tanstack/react-query'
import type { CircuitCard } from '@qsim/contract'

import { useApiErrorMessage } from '../../lib/api'
import { GalleryCard } from './GalleryCard'

/** What this component needs of a page, whichever listing produced it. */
export interface ListingPage {
  readonly items: CircuitCard[]
  readonly starred: string[]
  readonly nextCursor: string | null
}

export interface GalleryListingProps<T extends ListingPage> {
  readonly query: UseInfiniteQueryResult<InfiniteData<T>, unknown>
  /** Choosing a tag from a card. Absent on a listing with no tag facet. */
  readonly onSelectTag?: ((tag: string) => void) | undefined
  readonly showAuthor?: boolean
  /** What to say when the listing is genuinely empty. */
  readonly empty: ReactNode
  /** Names the list for assistive technology. */
  readonly label: string
}

export function GalleryListing<T extends ListingPage>({
  query,
  onSelectTag,
  showAuthor = true,
  empty,
  label,
}: GalleryListingProps<T>) {
  const { t, i18n } = useTranslation('gallery')
  const describeError = useApiErrorMessage()
  const numbers = new Intl.NumberFormat(i18n.language)

  const pages = query.data?.pages ?? []
  const items = pages.flatMap((page) => page.items)
  /*
   * Flattened across pages, because a circuit appears on exactly one page and
   * the card does not know which. A `Set` rather than an array scan: a listing
   * walked to a few hundred cards would otherwise be a linear search per card
   * on every render.
   */
  const starred = new Set(pages.flatMap((page) => page.starred))

  if (query.isPending && query.fetchStatus === 'paused') {
    return (
      <p className="notice" role="status">
        {t('listing.offline')}
      </p>
    )
  }

  if (query.isPending) {
    return (
      <p className="page__loading" role="status">
        {t('listing.loading')}
      </p>
    )
  }

  /*
   * A failure with nothing on screen is the whole page; a failure with cards
   * already on it is a notice beside the button (below). The distinction is
   * `items.length` and not which callback failed, because it is the one the
   * reader experiences: throwing away a listing they are reading in order to
   * report that *more* of it did not arrive is a worse answer than saying so.
   */
  const failed = query.isError

  if (failed && items.length === 0) {
    return (
      <div className="notice" role="alert">
        {/* The API sends a code; every word here is this app's, in three
            languages (§11, D2). */}
        <p>{describeError(query.error)}</p>
        <button
          className="page__cta page__cta--quiet"
          type="button"
          onClick={() => {
            void query.refetch()
          }}
        >
          {t('listing.retry')}
        </button>
      </div>
    )
  }

  if (items.length === 0) return <>{empty}</>

  return (
    <>
      <ul className="gallery-list" aria-label={label}>
        {items.map((circuit) => (
          <GalleryCard
            key={circuit.id}
            circuit={circuit}
            starred={starred.has(circuit.id)}
            onSelectTag={onSelectTag}
            showAuthor={showAuthor}
          />
        ))}
      </ul>

      <div className="gallery-more">
        {/*
         * A live region, because appending cards moves nothing a screen reader
         * announces on its own: the heading stays, the list grows below the
         * reader's position, and without this the only feedback is a button
         * that briefly changed its label. `total` rather than `count` so
         * i18next treats it as an ordinary interpolation — a plural key would
         * need a different set of categories per language and would break the
         * three catalogs' parity (D2).
         */}
        <p className="gallery-more__status" role="status">
          {t('listing.shown', { total: numbers.format(items.length) })}
          {query.hasNextPage ? '' : ` ${t('listing.end')}`}
        </p>

        {query.hasNextPage ? (
          <button
            className="page__cta page__cta--quiet"
            type="button"
            /*
             * `aria-disabled`, never `disabled`: this is the button the reader
             * just pressed, and a disabled element drops focus to the document
             * body — sending a keyboard user back to the top of a list that
             * has just grown. The handler declines instead.
             */
            aria-disabled={query.isFetchingNextPage}
            onClick={() => {
              if (query.isFetchingNextPage) return
              void query.fetchNextPage()
            }}
          >
            {query.isFetchingNextPage
              ? t('listing.loadingMore')
              : t('listing.more')}
          </button>
        ) : null}

        {/*
         * A page that failed *after* the first one succeeded. The cards
         * already on screen are still true, so this is a notice beside the
         * button rather than the error state above, which would throw away a
         * listing the reader is reading. Pressing Show more again retries it.
         */}
        {failed ? (
          <p className="gallery-more__error" role="alert">
            {describeError(query.error)}
          </p>
        ) : null}
      </div>
    </>
  )
}
