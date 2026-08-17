/**
 * A comment's text, as text — §11, Fase 5 (M5.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ALLOW-LIST HAS TWO PRODUCTIONS IN IT, AND THAT IS THE WHOLE FORMAT
 *
 * A comment is written by one user and read by others, so §11's rule applies:
 * user content is untrusted. The usual answer is a sanitiser — parse the markup,
 * strip what is dangerous, keep the rest — and a sanitiser is a deny list
 * whatever it is called: it is a promise about every construction an HTML parser
 * will ever accept, made by code that has to be right about `<svg><style>`,
 * `javascript:` in an attribute nobody remembered, and whatever the next browser
 * adds. This project will not make that promise.
 *
 * So the format is not "markdown minus the dangerous parts". It is a format with
 * exactly two productions:
 *
 *   1. a blank-line-or-newline break, which becomes a paragraph;
 *   2. a span between backticks, which becomes `Notation` — the convention the
 *      lesson catalogs already use (`lib/prose.ts`), and the one route this
 *      project sanctions for text that must be identical in all three languages.
 *
 * Everything else is a character. `<script>alert(1)</script>` in a comment is
 * five words a reader can see, because React renders a string as a text node and
 * there is no `dangerouslySetInnerHTML` anywhere on this path — asserted by
 * `CommentBody.test.tsx`, which greps this file rather than trusting the review
 * that noticed. No links, no images, no raw HTML: there is nothing here for a
 * sanitiser to be wrong about, which is the only version of "safe" that stays
 * true when somebody adds a feature next year.
 *
 * ── Why the length bound is not enforced here ─────────────────────────────
 *
 * `MAX_COMMENT_LENGTH` is checked by the contract on the way in, on both sides of
 * the wire. Truncating on render would hide a stored body that got past both,
 * which is a defect worth seeing rather than eliding; what this does instead is
 * wrap, so a two-thousand-character paragraph cannot push the panel sideways.
 */

import { Fragment } from 'react'

import { Notation } from '../../components/Notation'
import { splitNotation } from '../../lib/prose'

export interface CommentBodyProps {
  /** Verbatim, as it was stored. Never HTML. */
  readonly body: string
  readonly className?: string
}

/**
 * Splits on newlines, which the contract's `storableProse` is the only control
 * character it allows through.
 *
 * Empty runs are dropped rather than rendered as empty paragraphs: somebody who
 * pressed return six times meant one break, and six empty paragraphs would let a
 * comment take a screen's worth of a shared panel.
 */
function paragraphsOf(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function CommentBody({
  body,
  className = 'comment-body',
}: CommentBodyProps) {
  return (
    <div className={className}>
      {paragraphsOf(body).map((paragraph, index) => (
        /*
         * `dir="auto"` because a comment is the first surface in this product
         * where one user writes prose another user reads, and the document's
         * direction follows the *UI* language rather than the comment's. Without
         * it a comment in Arabic or Hebrew is laid out left-to-right: leading and
         * trailing punctuation lands on the wrong side and an embedded `Notation`
         * span is mis-ordered against the words around it. Per-comment `lang`
         * needs language detection and is a separate problem; the direction is
         * one attribute and the browser infers it from the first strong character.
         */
        <p className="comment-body__paragraph" dir="auto" key={index}>
          {splitNotation(paragraph).map((span, spanIndex) =>
            span.notation ? (
              <Notation
                className="comment-body__notation"
                key={spanIndex}
                value={span.text}
              />
            ) : (
              <Fragment key={spanIndex}>{span.text}</Fragment>
            )
          )}
        </p>
      ))}
    </div>
  )
}
