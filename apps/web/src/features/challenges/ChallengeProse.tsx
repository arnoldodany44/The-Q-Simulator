/**
 * A challenge's prompt, with its notation rendered through `Notation`.
 *
 * A prompt is prose about states — "produce (|00⟩ + |11⟩)/√2" — so it has the
 * same problem a lesson paragraph has: tokens that must be identical in all
 * three languages, inside a sentence whose word order is not. The convention is
 * the same one the lesson catalogs use, a backtick, and `splitNotation` is the
 * module that owns it.
 *
 * Reached across from `features/lessons` rather than copied, because it is one
 * convention: a translator who learns the rule for a lesson has learnt it for a
 * challenge, and two implementations would be two chances to disagree about
 * what an unpaired backtick means. If a third feature needs it, it should move
 * down to `src/lib/`.
 *
 * The class names are this feature's own — a challenge is not a lesson, and
 * borrowing `lesson-prose` would make §10's type scale hard to change for one
 * without changing the other.
 */

import { Fragment } from 'react'

import { Notation } from '../../components/Notation'
import { splitNotation } from '../../lib/prose'

export interface ChallengeProseProps {
  /** One translated paragraph. Backticks mark invariant notation. */
  readonly paragraph: string
  readonly className?: string
}

export function ChallengeProse({
  paragraph,
  className = 'challenge-prose',
}: ChallengeProseProps) {
  return (
    <p className={className}>
      {splitNotation(paragraph).map((span, index) =>
        span.notation ? (
          <Notation
            key={index}
            className="challenge-prose__notation"
            value={span.text}
          />
        ) : (
          <Fragment key={index}>{span.text}</Fragment>
        )
      )}
    </p>
  )
}
