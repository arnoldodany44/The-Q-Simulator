/**
 * "Copy this circuit as a link" — the visible half of decision D4.
 *
 * There is no server in Phase 0, so the link is not a pointer to a saved
 * document: it *is* the document. That is worth saying on screen, which is
 * what the hint under the control does — a reader who thinks the circuit was
 * uploaded somewhere will also think it can be deleted from somewhere.
 *
 * ── The field is not decoration ──────────────────────────────────────────
 *
 * The link is shown in a read-only text field beside the copy button, and
 * that field is the fallback that makes the control work at all in the cases
 * the button cannot cover. `navigator.clipboard` is absent over plain HTTP,
 * absent in some embedded webviews, and can be refused by permission at any
 * moment; a copy button alone would simply fail for those readers with
 * nothing to fall back on. Focusing the field selects the whole link, so
 * Tab-then-Ctrl+C is a complete keyboard path that never touches the
 * clipboard API.
 *
 * ── A refused link is reported where the reader is looking ───────────────
 *
 * A `?c=` payload that could not be opened is answered here rather than in
 * a corner of the page, because this is the part of the interface that is
 * about links. It is an `alert`, unlike the copy status below it: the reader
 * asked for one circuit and is looking at another, which is news they cannot
 * infer from anything on screen.
 */

import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CircuitUrlView } from './useCircuitUrl'

/** What the copy button has to say for itself, if anything. */
type CopyOutcome = 'copied' | 'failed' | null

export interface ShareLinkProps {
  readonly url: CircuitUrlView
}

export function ShareLink({ url }: ShareLinkProps) {
  const { t } = useTranslation('editor')
  const headingId = useId()
  const fieldId = useId()
  const field = useRef<HTMLInputElement>(null)
  const link = url.link

  /*
   * "Copied" is a claim about one particular address, so it is stored *with*
   * that address and derived back out during render.
   *
   * The obvious alternative — a bare `outcome` plus an effect that clears it
   * when the link changes — would render one frame of "Link copied." over the
   * new link before the effect ran, which is the frame in which the sentence
   * is false. Deriving cannot have that frame.
   */
  const [attempt, setAttempt] = useState<{
    readonly link: string
    readonly outcome: CopyOutcome
  } | null>(null)
  const outcome =
    attempt !== null && attempt.link === link ? attempt.outcome : null

  return (
    <section className="share-link" aria-labelledby={headingId}>
      <h3 id={headingId} className="share-link__heading">
        {t('share.heading')}
      </h3>
      <p className="share-link__hint">{t('share.hint')}</p>

      {url.rejected === null ? null : (
        <p className="share-link__rejected" role="alert">
          {t(`share.rejected.${url.rejected}`)}{' '}
          <button
            type="button"
            className="share-link__dismiss"
            onClick={url.dismiss}
          >
            {t('share.dismiss')}
          </button>
        </p>
      )}

      <div className="share-link__row">
        <label className="visually-hidden" htmlFor={fieldId}>
          {t('share.field')}
        </label>
        <input
          id={fieldId}
          ref={field}
          className="share-link__field"
          type="text"
          readOnly
          value={link ?? ''}
          // Selecting on focus is what makes the manual path one keystroke
          // rather than a drag across a hundred characters of base64.
          onFocus={(event) => {
            event.currentTarget.select()
          }}
        />
        <button
          type="button"
          className="share-link__copy"
          disabled={link === null}
          onClick={() => {
            if (link === null) return
            void copyToClipboard(link, field.current).then((outcome) => {
              setAttempt({ link, outcome })
            })
          }}
        >
          {t('share.copy')}
        </button>
      </div>

      <p className="share-link__status" role="status">
        {url.tooLarge ? t('share.tooLarge') : null}
        {url.tooLarge || outcome === null ? null : t(`share.${outcome}`)}
      </p>
    </section>
  )
}

/**
 * Copy through the clipboard API, falling back to the field's own selection.
 *
 * `document.execCommand('copy')` is deprecated and is deliberately still here:
 * it is the only copy that works without a secure context, and a circuit
 * shared off a local dev server or an intranet page is exactly the case the
 * modern API refuses. When both fail the caller says so, and the field beside
 * the button is already selected for a manual Ctrl+C.
 */
async function copyToClipboard(
  link: string,
  field: HTMLInputElement | null
): Promise<CopyOutcome> {
  try {
    await navigator.clipboard.writeText(link)
    return 'copied'
  } catch {
    // Fall through to the selection path below.
  }

  if (field === null) return 'failed'
  field.focus()
  field.select()
  try {
    return document.execCommand('copy') ? 'copied' : 'failed'
  } catch {
    return 'failed'
  }
}
