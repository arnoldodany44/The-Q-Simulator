/**
 * `/gallery` — every published circuit, and the way in to somebody else's
 * work (§3.4, milestone M1.5b).
 *
 * ── It is anonymous, and that is the whole design ─────────────────────────
 *
 * `GET /gallery` is `auth: 'optional'`, so this route is not behind a guard
 * and must not become one: the gallery is the front door, and a stranger who
 * has never signed in is exactly who it is for. What a viewer may see is
 * decided on the server, in the query, every time — `listableCircuitFilter` in
 * @qsim/db — and never here. A signed-in reader additionally sees their own
 * PRIVATE and UNLISTED circuits in it, which is why the card shows a
 * visibility badge when it is anything other than PUBLIC.
 *
 * ── The selection lives in the address ────────────────────────────────────
 *
 * `?sort=`, `?tag=` and `?q=` rather than component state, because a filtered
 * listing is a place: Back returns to it, a reload stays on it, and a link to
 * it works. `features/gallery/selection.ts` owns the parsing, so the address
 * and the React Query cache key are derived from one normalisation rather than
 * from two that agree until they do not.
 *
 * ── Empty is three different situations ───────────────────────────────────
 *
 * A gallery with nothing in it on a new deployment is an invitation to publish
 * the first circuit — not an error, and not "no results". A gallery with
 * nothing matching a *search* is a search that missed. A tag facet with
 * nothing in it is a facet nobody has used yet. Each gets its own sentence and
 * its own way out, because "no circuits found" for all three would be wrong
 * twice.
 */

import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import {
  GalleryFilters,
  GalleryListing,
  isFiltered,
  searchWithSelection,
  selectionFromSearch,
} from '../features/gallery'
import { useGallery, type GallerySelection } from '../lib/api'

export function GalleryRoute() {
  const { t } = useTranslation(['gallery', 'common'])
  const [search, setSearch] = useSearchParams()

  const selection = selectionFromSearch(search)
  const query = useGallery(selection)

  const apply = (next: GallerySelection): void => {
    /*
     * `setSearch` over the current address rather than a built one, so every
     * parameter this feature does not own survives. `replace: false`: changing
     * a filter is navigation, and Back returning to the previous listing is
     * what a reader expects of it.
     */
    setSearch(searchWithSelection(search, next))
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

      <h2 className="auth-page__title">{t('gallery:title')}</h2>
      <p className="auth-page__lead">{t('gallery:lead')}</p>

      <GalleryFilters selection={selection} onChange={apply} />

      <GalleryListing
        query={query}
        label={t('gallery:listing.label')}
        onSelectTag={(tag) => {
          apply({ ...selection, tag })
        }}
        empty={<GalleryEmpty selection={selection} onClear={apply} />}
      />
    </main>
  )
}

/**
 * Nothing to show — which of the three it is decides what to say.
 *
 * The first-circuit invitation is the one that matters most and is the easiest
 * to get wrong: an empty gallery on a new deployment looks broken, and a page
 * that says "no results" about a database with nothing in it tells the one
 * person who could fix that exactly nothing.
 */
function GalleryEmpty({
  selection,
  onClear,
}: {
  readonly selection: GallerySelection
  readonly onClear: (next: GallerySelection) => void
}) {
  const { t } = useTranslation('gallery')

  if (isFiltered(selection)) {
    return (
      <div className="notice">
        <p>
          <strong>{t('empty.filtered.heading')}</strong>
        </p>
        <p>
          {(selection.q ?? '') === ''
            ? t('empty.filtered.byTag')
            : t('empty.filtered.bySearch')}
        </p>
        <p>
          <button
            className="page__cta page__cta--quiet"
            type="button"
            onClick={() => {
              // Both at once: a reader who narrowed twice should not have to
              // undo twice to see the gallery again.
              onClear({ ...selection, tag: '', q: '' })
            }}
          >
            {t('empty.filtered.clear')}
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="notice">
      <p>
        <strong>{t('empty.gallery.heading')}</strong>
      </p>
      <p>{t('empty.gallery.body')}</p>
      <p>
        <Link className="page__cta" to="/new">
          {t('empty.gallery.action')}
        </Link>
      </p>
    </div>
  )
}
