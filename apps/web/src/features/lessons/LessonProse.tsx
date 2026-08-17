/**
 * A lesson paragraph, with its notation rendered through `Notation`.
 *
 * The splitting rule and the argument for a backtick are in `prose.ts`. This
 * component is only the JSX half: every span that was between backticks
 * becomes a `Notation`, which is what marks it `translate="no"` and what keeps
 * `i18next/no-literal-string` meaningful — the text arrives as a prop from a
 * catalog, never as a literal in this file.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERY LESSON STRING GOES THROUGH HERE, INCLUDING THE TWO OUTSIDE A STEP.
 *
 * `summary` and `goal` used to be rendered with a bare `t()` — a `<p>` on the
 * index card and a `<p>` above the player — because at one lesson neither of
 * them contained any notation. The moment one did, the reader saw the
 * backticks: `prose.ts` never ran, so the convention `format.ts` documents for
 * *a lesson's prose* silently applied to four of its six string kinds.
 *
 * That is the whole reason this component takes a `className`. A lesson string
 * is a lesson string, the format's rule is one rule, and the way to keep it one
 * rule is that there is exactly one component that turns catalog text into
 * elements — with the caller choosing what it looks like, not whether the
 * backticks mean anything.
 */

import { Fragment } from 'react'

import { Notation } from '../../components/Notation'
import { splitNotation } from '../../lib/prose'

export interface LessonProseProps {
  /** One translated paragraph. Backticks mark invariant notation. */
  readonly paragraph: string
  /**
   * The paragraph's own class. Defaults to the body style; the index card and
   * the player's goal line pass their own, which is what lets them keep §10's
   * type scale without giving up the notation rule.
   */
  readonly className?: string
}

export function LessonProse({
  paragraph,
  className = 'lesson-prose',
}: LessonProseProps) {
  const spans = splitNotation(paragraph)
  return (
    <p className={className}>
      {spans.map((span, index) =>
        span.notation ? (
          <Notation
            key={index}
            className="lesson-prose__notation"
            value={span.text}
          />
        ) : (
          /*
           * A fragment rather than a `<span>`: an ordinary run of text is not
           * an element, and wrapping it in one would put a box around every
           * other word for a screen reader to announce as a boundary.
           */
          <Fragment key={index}>{span.text}</Fragment>
        )
      )}
    </p>
  )
}
