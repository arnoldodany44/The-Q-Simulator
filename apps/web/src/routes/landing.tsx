/**
 * `/` — the landing page (specification §2, work plan M0.9).
 *
 * §2 does not describe this page, it sets it a test: *someone who has never
 * seen a quantum circuit should understand, in under a minute, what
 * superposition is and what entanglement is.* Not "looks professional", not
 * "lists what the product does". Two specific ideas, one stranger, one minute.
 *
 * So the page is built around one thing — `LiveDemo`, four real circuits
 * simulated by `@qsim/core` as the reader watches — and everything else here
 * is the frame around it: a sentence saying what they are about to see, two
 * ways onwards, and three short notes for the reader who is still here
 * afterwards. There is no feature list, because a feature list answers a
 * question a first-time reader has not asked yet.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT THIS ROUTE MAY IMPORT.
 *
 * Nothing from the editor's document model, and no *value* from
 * `@qsim/schema`. Both rules exist for the same reason: `App.tsx` splits the
 * editor into its own chunk, and an import reaching into `useCircuitStore` or
 * into a Zod schema would pull the store, Zundo, dnd-kit or Zod straight back
 * across the split and into the one route that has to arrive before a stranger
 * loses interest. `features/landing/` holds what is left after that rule, and
 * each file there says which import it is avoiding and why.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TWO WAYS ONWARDS, AND THEY ARE DIFFERENT PLACES.
 *
 * `/new` is a blank editor. `/new?example=bell` is the same editor already
 * holding the circuit the demo just finished on — the fastest route from
 * "I understood that" to "let me move something and see what breaks", which is
 * what the examples strip exists for (`presets.ts`). Both are ordinary links,
 * so they open in a new tab, they can be bookmarked, and they work before any
 * JavaScript has decided anything.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
/*
 * The path template only, from a module that imports nothing — the same rule
 * `App.tsx` follows for the same reason. Reaching for the gallery feature's
 * barrel would pull React Query, the thumbnail renderer and the star wiring
 * into the one route that must arrive before a stranger loses interest.
 */
import { GALLERY_PATH } from '../features/gallery/paths'
import { LiveDemo } from '../features/landing/LiveDemo'

/** The example the demo ends on, so "start from an example" starts from it. */
const EXAMPLE_ROUTE = '/new?example=bell'

export function LandingRoute() {
  const { t } = useTranslation(['landing', 'common'])
  const notesId = useId()

  return (
    <main className="page landing">
      <header className="page__header">
        <h1>{t('common:appName')}</h1>
        {/*
         * The account menu is shell, so it is here as well as in the editor:
         * this is the page a signed-in reader lands on, and "where are my
         * circuits" has to be answerable from it. It renders nothing at all
         * on a deployment with no Supabase project, which is what Phase 0's
         * deployment was — see `AccountMenu.tsx`.
         */}
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      <p className="tagline">{t('landing:tagline')}</p>
      <p className="landing__lead">{t('landing:lead')}</p>

      <Actions />
      <p className="landing__note">{t('landing:cta.note')}</p>

      <LiveDemo />

      <section className="landing__notes" aria-labelledby={notesId}>
        <h2 id={notesId} className="section-heading">
          {t('landing:notes.heading')}
        </h2>

        {/*
         * A description list rather than three headings: each note is a short
         * label and the sentence that qualifies it, which is what a `dl` is
         * for — and it keeps the page's heading outline to one level per
         * section, so the document reads as three sections rather than as
         * three sections and six subsections.
         */}
        <dl className="landing__note-list">
          {(['local', 'link', 'state'] as const).map((note) => (
            <div className="landing__note-item" key={note}>
              <dt>{t(`landing:notes.${note}.title`)}</dt>
              <dd>{t(`landing:notes.${note}.body`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="landing__closing">{t('landing:closing')}</p>
      <Actions />
    </main>
  )
}

/**
 * The ways onwards, rendered twice: once above the demonstration for the
 * reader who arrived knowing what they want, and once below it for the reader
 * the demonstration has just convinced. Same destinations and the same labels
 * both times — a second set of buttons with different wording would read as
 * different offers.
 *
 * The gallery (M1.5b) is the third and is deliberately last: the first two
 * answer "let me try this", which is what the page has just argued for, and
 * the third answers "show me what people have made", which is a different
 * appetite and a weaker one at this moment. It is a plain `<Link>` like the
 * others, so it opens in a new tab, can be bookmarked, and works before any
 * JavaScript has decided anything.
 */
function Actions() {
  const { t } = useTranslation('landing')
  return (
    <p className="landing__actions">
      <Link className="page__cta" to="/new">
        {t('cta.editor')}
      </Link>
      <Link className="page__cta page__cta--quiet" to={EXAMPLE_ROUTE}>
        {t('cta.examples')}
      </Link>
      <Link className="page__cta page__cta--quiet" to={GALLERY_PATH}>
        {t('cta.gallery')}
      </Link>
    </p>
  )
}
