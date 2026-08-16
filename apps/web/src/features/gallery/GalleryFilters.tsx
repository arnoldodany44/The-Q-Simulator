/**
 * How a reader narrows a public listing — M1.5b.
 *
 * ── The search is submitted, not typed ────────────────────────────────────
 *
 * A search box that fires on every keystroke is the reflex, and it is wrong
 * against this API for two reasons that are not about taste. `@qsim/contract`
 * refuses a term shorter than three characters — a term with no trigrams in it
 * cannot use the index, and the gallery is unauthenticated — so the first two
 * keystrokes of every query are requests that cannot be served. And the term
 * is part of the cache key *and* of the address, so a per-keystroke search
 * writes a history entry and a cache entry per character: eight of each to
 * type "teleport", seven of them for prefixes nobody wanted.
 *
 * Submitting is also the accessible shape. A listing that rewrites itself
 * while a screen-reader user is still typing gives them no moment at which the
 * result is stable enough to be announced; a submit is a discrete event with a
 * result, and the status line under the list says what it was.
 *
 * ── The sort is a radio group in a fieldset ───────────────────────────────
 *
 * Not a `<select>`, and not two buttons. There are exactly two orderings, both
 * always available, exactly one active — which is what a radio group *is*, and
 * it is the control every screen reader announces as "2 of 2, selected". Two
 * toggle buttons would have to carry `aria-pressed` and would still not say
 * that choosing one unchooses the other.
 *
 * ── The tag is shown, not typed ───────────────────────────────────────────
 *
 * A facet is entered by pressing a tag on a card and left by pressing the chip
 * here, so there is no free-text tag field to mistype. What this renders is the
 * facet the reader is standing inside — which the gallery would otherwise not
 * say anywhere — and the way out of it.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_GALLERY_SORT,
  GALLERY_SORTS,
  MIN_SEARCH_LENGTH,
} from '@qsim/contract'
import type { GallerySort } from '@qsim/contract'

import type { GallerySelection } from '../../lib/api'

export interface GalleryFiltersProps {
  readonly selection: GallerySelection
  readonly onChange: (next: GallerySelection) => void
}

export function GalleryFilters({ selection, onChange }: GalleryFiltersProps) {
  const { t } = useTranslation('gallery')
  const searchId = useId()
  const sortName = useId()

  /*
   * The field's own text, which is not the applied term: between typing and
   * submitting they differ, and that difference is the whole point of a
   * submitted search.
   *
   * It is re-seeded when the applied term changes from outside — pressing
   * Back, following a link into a filtered listing, clearing the facet — so the
   * box never contradicts the results underneath it. Adjusted *during render*
   * rather than in an effect, which is React's own answer to "a value derived
   * from a prop that the user can then edit": an effect would paint the stale
   * text for one frame and then paint again, and `react-hooks/set-state-in-
   * effect` rejects it for exactly that reason. Storing the value it was
   * derived from is what makes the comparison possible.
   */
  const applied = selection.q ?? ''
  const [draft, setDraft] = useState({ from: applied, term: applied })
  if (draft.from !== applied) setDraft({ from: applied, term: applied })
  const term = draft.term
  const setTerm = (next: string): void => {
    setDraft({ from: applied, term: next })
  }

  const tooShort =
    term.trim().length > 0 && term.trim().length < MIN_SEARCH_LENGTH

  return (
    <div className="gallery-filters">
      <form
        className="gallery-search"
        role="search"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          onChange({ ...selection, q: term.trim() })
        }}
      >
        <label className="field__label" htmlFor={searchId}>
          {t('filters.search.label')}
        </label>
        <p className="field__hint" id={`${searchId}-hint`}>
          {t('filters.search.hint', { least: MIN_SEARCH_LENGTH })}
        </p>
        <div className="gallery-search__row">
          <input
            className="field__input"
            id={searchId}
            name="q"
            type="search"
            value={term}
            aria-describedby={
              tooShort
                ? `${searchId}-hint ${searchId}-short`
                : `${searchId}-hint`
            }
            onChange={(event) => {
              setTerm(event.target.value)
            }}
          />
          <button type="submit">{t('filters.search.submit')}</button>
          {applied === '' ? null : (
            <button
              type="button"
              onClick={() => {
                setTerm('')
                onChange({ ...selection, q: '' })
              }}
            >
              {t('filters.search.clear')}
            </button>
          )}
        </div>
        {tooShort ? (
          /*
           * Said before the request rather than after a 400. The bound is the
           * server's and the sentence is this app's, in three languages (D2).
           */
          <p className="field__hint" id={`${searchId}-short`} role="status">
            {t('filters.search.tooShort', { least: MIN_SEARCH_LENGTH })}
          </p>
        ) : null}
      </form>

      <fieldset className="gallery-sort">
        <legend>{t('filters.sort.label')}</legend>
        {GALLERY_SORTS.map((sort: GallerySort) => (
          <label className="gallery-sort__choice" key={sort}>
            <input
              type="radio"
              name={sortName}
              value={sort}
              /*
               * The server's default, not the first entry of the list: which
               * ordering a listing with no `?sort=` is actually showing is
               * `DEFAULT_GALLERY_SORT`'s decision, and reading it off the
               * vocabulary's order would make reordering that array silently
               * check the wrong radio.
               */
              checked={(selection.sort ?? DEFAULT_GALLERY_SORT) === sort}
              onChange={() => {
                onChange({ ...selection, sort })
              }}
            />
            <span>{t(`filters.sort.${sort}`)}</span>
          </label>
        ))}
      </fieldset>

      {(selection.tag ?? '') === '' ? null : (
        <p className="gallery-facet">
          <span className="gallery-facet__label">
            {t('filters.tag.active')}
          </span>
          <span className="tag-chip tag-chip--static">{selection.tag}</span>
          <button
            type="button"
            onClick={() => {
              onChange({ ...selection, tag: '' })
            }}
          >
            {t('filters.tag.clear')}
          </button>
        </p>
      )}
    </div>
  )
}
