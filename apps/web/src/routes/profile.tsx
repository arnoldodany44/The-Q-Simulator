/**
 * `/u/:username` — one person's public page (§3.4, §8, milestones M1.5b and
 * M1.9).
 *
 * ── The same query, and that is deliberate ────────────────────────────────
 *
 * `GET /users/:username/circuits` is the gallery with one more `AND ownerId =`
 * on the server, and this page is `/gallery` with one more scope on the client:
 * the same listing component, the same cards, the same star wiring. Two
 * implementations would be two places for a visibility rule to go missing, and
 * `apps/api/src/routes/gallery.ts` refuses to have two for exactly that reason.
 *
 * The consequence is worth restating on the page it applies to: a stranger sees
 * this author's PUBLIC circuits; the author, signed in, sees all of their own;
 * and nobody's UNLISTED circuits appear here, because a listing is discovery
 * and UNLISTED means "reachable by whoever holds the link" (§11).
 *
 * ── What M1.9 added, and what it is careful about ─────────────────────────
 *
 * A picture, a display name, a join date, two counts and the author's public
 * collections. Every one of them comes from `publicUserSelect` or from a count
 * the server computed through the very filters the listings use — so the
 * figure a stranger reads is the number of cards they would get by paging to
 * the end, and the author reading their own page sees their own larger one.
 * There is no `email` in any of it and there is no projection that has one.
 *
 * ── The author is not a search result ─────────────────────────────────────
 *
 * A username nobody holds is a 404 from the API, and this page says so as its
 * own sentence rather than showing an empty listing. Those are different facts
 * — "no such person" and "this person has published nothing" — and conflating
 * them would tell a reader who mistyped a name that somebody's work had
 * disappeared.
 *
 * There is no tag facet here. The gallery has one because browsing by subject
 * is what a gallery is for; inside one author's page the same control would
 * silently mean something narrower, so a card's tags render as plain text and
 * the way to browse a tag is the gallery.
 */

import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import {
  PAGE_PARAM,
  pageFromSearch,
} from '../features/circuit-storage/pagination'
import { CollectionCard } from '../features/collections'
import {
  GALLERY_PATH,
  GalleryFilters,
  GalleryListing,
  searchWithSelection,
  selectionFromSearch,
} from '../features/gallery'
import { Avatar } from '../features/profile'
import {
  isNotFound,
  useProfile,
  useUserCircuits,
  useUserCollections,
  type GallerySelection,
} from '../lib/api'

/**
 * The first of these that is a name rather than an absence.
 *
 * `??` is not this: it falls through for `null` and `undefined` and stops at
 * `''`, which is exactly the value a blank display name used to be stored as.
 */
function firstNonEmpty(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (
      candidate !== null &&
      candidate !== undefined &&
      candidate.trim() !== ''
    )
      return candidate
  }
  return ''
}

export function ProfileRoute() {
  const { t, i18n } = useTranslation(['gallery', 'collections', 'common'])
  const { username = null } = useParams<{ username: string }>()
  const [search, setSearch] = useSearchParams()

  const selection = selectionFromSearch(search)
  const query = useUserCircuits(username, selection)
  const profile = useProfile(username)
  /*
   * Paged, and the page comes from the address. Called with the default
   * pagination this returned the first twenty rows and the route rendered
   * `items` whole — discarding `page`, `total` and `totalPages` — so an author
   * with twenty-three collections had a page that said "Collections 23" beside
   * exactly twenty cards, with no pager, no "show more" and no link to the
   * rest. Three of somebody's collections were unreachable from their own
   * public page while the number beside them insisted otherwise.
   *
   * `PAGE_PARAM` is the same parameter `/collections` and `/circuits` use, and
   * nothing else on this route claims it: the circuits listing below is an
   * infinite query and pages itself with a cursor.
   */
  const collectionsPage = pageFromSearch(search)
  const collections = useUserCollections(username, { page: collectionsPage })

  const apply = (next: GallerySelection): void => {
    setSearch(searchWithSelection(search, next))
  }

  const goToCollectionsPage = (next: number): void => {
    const params = new URLSearchParams(search)
    params.set(PAGE_PARAM, String(next))
    setSearch(params)
  }

  /*
   * The author's row, preferred from the profile request and falling back to
   * the listing's envelope — both are the same `publicUserSelect` projection,
   * which has no `email` in it and cannot acquire one (§11). Taking whichever
   * arrives first is what keeps the heading from appearing a beat late.
   */
  const author = profile.data?.user ?? query.data?.pages[0]?.user ?? null
  const missing =
    (profile.isError && isNotFound(profile.error)) ||
    (query.isError && isNotFound(query.error))

  const numbers = new Intl.NumberFormat(i18n.language)
  const joined = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' })
  const publicCollections = collections.data?.items ?? []
  const collectionPages = collections.data?.totalPages ?? 1

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
          <p>{t('gallery:profile.unknown')}</p>
          <p>
            <Link className="page__cta" to={GALLERY_PATH}>
              {t('gallery:profile.toGallery')}
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="profile-header">
            {author === null ? null : (
              <Avatar
                identity={author.id}
                avatarUrl={author.avatarUrl}
                size={72}
              />
            )}
            <div>
              <h2 className="auth-page__title">
                {/*
                 * The author's display name is their own words: rendered as
                 * text, escaped by React, never through the catalog. Until the
                 * first response arrives the heading is the handle from the
                 * address, which is also theirs — a heading that read
                 * "Loading…" for a second would move under the reader and be
                 * announced twice.
                 *
                 * `firstNonEmpty` rather than `??`, because `??` falls through
                 * for `null` and not for `''` — and a stored empty display name
                 * rendered this, the page's only name heading, with no text in
                 * it whatsoever. The contract now refuses a blank name and
                 * `ensureUser` trims the provider's claim, so this is the belt
                 * for rows written before either.
                 */}
                {firstNonEmpty(author?.displayName, author?.username, username)}
              </h2>
              <p className="auth-page__lead">
                {t('gallery:profile.lead', {
                  author: author?.username ?? username ?? '',
                })}
              </p>
              {author === null ? null : (
                <dl className="profile-header__meta">
                  <div>
                    <dt>{t('gallery:profile.joined')}</dt>
                    <dd>
                      <time dateTime={author.createdAt.toISOString()}>
                        {joined.format(author.createdAt)}
                      </time>
                    </dd>
                  </div>
                  {profile.data === undefined ? null : (
                    <>
                      <div>
                        <dt>{t('gallery:profile.circuits')}</dt>
                        <dd className="tabular-numbers">
                          {numbers.format(profile.data.circuitCount)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('gallery:profile.collections')}</dt>
                        <dd className="tabular-numbers">
                          {numbers.format(profile.data.collectionCount)}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              )}
            </div>
          </div>

          {publicCollections.length === 0 ? null : (
            <section aria-labelledby="profile-collections">
              <h3 id="profile-collections">
                {t('collections:profile.heading')}
              </h3>
              <ul
                className="collection-list"
                aria-label={t('collections:profile.listing')}
              >
                {publicCollections.map((collection) => (
                  <CollectionCard
                    key={collection.id}
                    collection={collection}
                    /*
                     * A stranger's view of this list is public by
                     * construction, so a PUBLIC badge on every card would be
                     * noise — the same rule `GalleryCard` follows. The author
                     * seeing their own private collections here is the one
                     * case where it is news, which is why the badge is not
                     * removed outright.
                     */
                  />
                ))}
              </ul>

              {/*
               * The same pager `/collections` draws, from the same catalog
               * keys. Without it this section rendered the first page and said
               * nothing about the rest, while the count in the meta block above
               * named a larger number — a page disagreeing with itself, and
               * somebody's older work with no address that reaches it.
               */}
              {collectionPages > 1 ? (
                <nav
                  className="pager"
                  aria-label={t('collections:pager.label')}
                >
                  {/*
                   * `aria-disabled` rather than `disabled` on both, for the
                   * reason every other control in this app gives: a disabled
                   * element cannot hold focus, so the keyboard user who just
                   * reached the last page is returned to the top of the
                   * document.
                   */}
                  <button
                    type="button"
                    aria-disabled={collectionsPage <= 1}
                    onClick={() => {
                      if (collectionsPage <= 1) return
                      goToCollectionsPage(collectionsPage - 1)
                    }}
                  >
                    {t('collections:pager.previous')}
                  </button>
                  <p className="pager__position" role="status">
                    {t('collections:pager.position', {
                      page: numbers.format(collectionsPage),
                      pages: numbers.format(collectionPages),
                      total: numbers.format(collections.data?.total ?? 0),
                    })}
                  </p>
                  <button
                    type="button"
                    aria-disabled={collectionsPage >= collectionPages}
                    onClick={() => {
                      if (collectionsPage >= collectionPages) return
                      goToCollectionsPage(collectionsPage + 1)
                    }}
                  >
                    {t('collections:pager.next')}
                  </button>
                </nav>
              ) : null}
            </section>
          )}

          <GalleryFilters selection={selection} onChange={apply} />

          <GalleryListing
            query={query}
            label={t('gallery:profile.listingLabel')}
            // No author byline: every card on this page has the same one, and
            // repeating it is a line of noise per card for a screen reader.
            showAuthor={false}
            empty={
              <div className="notice">
                <p>{t('gallery:empty.author.heading')}</p>
                <p>{t('gallery:empty.author.body')}</p>
              </div>
            }
          />
        </>
      )}
    </main>
  )
}
