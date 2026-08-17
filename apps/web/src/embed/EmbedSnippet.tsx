/**
 * "Copy this circuit as an embed" — the teacher-facing half of §3.4.
 *
 * It sits beside `ShareLink` on the circuit page and is deliberately its
 * sibling: same read-only field, same copy button, same fallback reasoning.
 * `navigator.clipboard` is absent over plain HTTP, absent in some embedded
 * webviews, and can be refused at any moment, so the markup is *shown* in a
 * field that selects itself on focus — Tab-then-Ctrl+C is a complete keyboard
 * path that never touches the clipboard API.
 *
 * The markup itself is built by `snippet.ts`, which is where the escaping and
 * the height estimate live and are argued.
 *
 * ── It appears only for a circuit that can actually be embedded ──────────
 *
 * PUBLIC and UNLISTED, and nothing else, because those are the two the API
 * will serve (`apps/api/src/routes/embed.ts`). This check is a courtesy, not
 * the rule: the rule is the visibility filter inside the server's query, and
 * handing somebody a snippet that renders "this circuit is not available"
 * inside their blog post would be a worse way to tell them. A PRIVATE circuit
 * gets a sentence saying which two visibilities work, so the owner knows what
 * to change rather than wondering where the control went.
 *
 * ── The language is pinned, once, by whoever copies ──────────────────────
 *
 * The URL carries `?lang=` set to the language this page is being read in.
 * Everywhere else in the product i18next detects the *reader's* language (D2);
 * an embed must not, because the frame lands inside a page written in one
 * language and a French analysis panel in the middle of an English slide is
 * worse than either alone. `embed/paths.ts` argues it in full.
 */

import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { circuitPagePath } from '../features/circuit-storage/paths'
import { embedCircuitUrl } from './paths'
import { buildSnippet, suggestedFrameHeight } from './snippet'

/** What the copy button has to say for itself, if anything. */
type CopyOutcome = 'copied' | 'failed' | null

export interface EmbedSnippetProps {
  readonly slug: string
  readonly title: string
  readonly qubitCount: number
  readonly visibility: string
  /** The app's own origin. Passed in so a test needs no `window`. */
  readonly origin: string
}

export function EmbedSnippet({
  slug,
  title,
  qubitCount,
  visibility,
  origin,
}: EmbedSnippetProps) {
  const { t, i18n } = useTranslation('embed')
  const headingId = useId()
  const fieldId = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const [attempt, setAttempt] = useState<{
    readonly snippet: string
    readonly outcome: CopyOutcome
  } | null>(null)

  const embeddable = visibility === 'PUBLIC' || visibility === 'UNLISTED'

  const snippet = buildSnippet({
    url: embedCircuitUrl(origin, slug, i18n.language),
    page: `${origin}${circuitPagePath(slug)}`,
    title,
    height: suggestedFrameHeight(qubitCount),
    credit: t('snippet.credit'),
  })

  /*
   * "Copied" is a claim about one particular snippet, so it is stored *with*
   * that snippet and derived back out during render — the same move
   * `ShareLink` makes, and for the same reason: the alternative renders one
   * frame of "copied" over markup that has since changed.
   */
  const outcome =
    attempt !== null && attempt.snippet === snippet ? attempt.outcome : null

  return (
    <section className="embed-snippet" aria-labelledby={headingId}>
      <h3 id={headingId} className="embed-snippet__heading">
        {t('snippet.heading')}
      </h3>

      {embeddable ? (
        <>
          <p className="embed-snippet__hint">{t('snippet.hint')}</p>

          <label className="visually-hidden" htmlFor={fieldId}>
            {t('snippet.field')}
          </label>
          <textarea
            id={fieldId}
            ref={field}
            className="embed-snippet__field"
            readOnly
            rows={4}
            value={snippet}
            spellCheck={false}
            // Markup, not prose: an automatic translator that rewrote an
            // attribute would hand the teacher a broken snippet.
            translate="no"
            onFocus={(event) => {
              event.currentTarget.select()
            }}
          />

          <div className="embed-snippet__row">
            <button
              type="button"
              className="embed-snippet__copy"
              onClick={() => {
                void copyToClipboard(snippet, field.current).then((result) => {
                  setAttempt({ snippet, outcome: result })
                })
              }}
            >
              {t('snippet.copy')}
            </button>
            <p className="embed-snippet__status" role="status">
              {outcome === null ? null : t(`snippet.${outcome}`)}
            </p>
          </div>

          {/*
           * The sandbox note. Written down rather than left to be discovered,
           * because the obvious tightening is the one that empties the frame:
           * `allow-scripts` alone gives the document an opaque origin, and a
           * module script is always fetched in CORS mode — so every chunk is
           * refused and NOTHING renders, not "the diagram without the chart",
           * which is what this comment and the catalog sentence beside it used
           * to promise. `useEmbedSimulation.ts` sets out the mechanism. A
           * teacher needs the pair, and needs to know that the alternative is
           * a blank rectangle rather than a reduced one.
           */}
          <p className="embed-snippet__note">{t('snippet.sandbox')}</p>
        </>
      ) : (
        <p className="embed-snippet__refusal">{t('snippet.private')}</p>
      )}
    </section>
  )
}

/**
 * The clipboard, with the field as the fallback — the same two-step
 * `ShareLink` uses, and for the same reasons written there.
 */
async function copyToClipboard(
  text: string,
  field: HTMLTextAreaElement | null
): Promise<CopyOutcome> {
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    // The field is still on screen with the whole snippet selected, which is
    // a complete manual path rather than a dead end.
    field?.select()
    return 'failed'
  }
}
