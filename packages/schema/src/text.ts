/**
 * The rule every free-text field in this system obeys before it is stored.
 *
 * ── Why a shape check is not enough ───────────────────────────────────────
 *
 * `z.string().min(1).max(64)` describes a JavaScript string, and JavaScript
 * strings can hold two things PostgreSQL cannot:
 *
 *   1. **U+0000.** A `text` column is UTF-8 and a NUL byte is not valid UTF-8
 *      for Postgres, which answers SQLSTATE 22021 — `invalid byte sequence
 *      for encoding "UTF8": 0x00`. Inside a `jsonb` value a JSON u0000 escape is
 *      refused separately with 22P05. Neither is something a caller can be
 *      told anything useful about once it has become a driver error: Prisma
 *      reports it as P2010 and the API answers 500. One character an attacker
 *      can type must not be a server fault, so it is refused at the edge with
 *      a 400, like any other malformed field.
 *   2. **A lone surrogate.** `"\uD800"` is a well-formed JavaScript string and
 *      is not well-formed Unicode. Node replaces it with U+FFFD on the way to
 *      the wire, so what comes back out is not what went in — silent
 *      corruption of the one thing an immutable version exists to preserve.
 *
 * The rest of the C0 range goes with them. A tab or a newline inside a circuit
 * title, an operation id or a qubit label is either a paste accident or an
 * attempt to break a log line or a terminal, and none of those fields is a
 * place where a line break carries meaning. A description is the exception and
 * uses `storableProse`, which allows `\t`, `\n` and `\r` and nothing else.
 *
 * The refinements go *last* in a chain, after `.trim()` and the length bounds:
 * trimming first means a title of one NUL and three spaces is reported as the
 * control character it is rather than as an empty string.
 */

import type { z } from 'zod'

/* eslint-disable no-control-regex -- matching them is this module’s job */

/**
 * C0 controls, DEL, and the C1 range. Written as explicit ranges rather than
 * `\p{C}` because `\p{C}` also matches unassigned and private-use code points,
 * which are legitimate in a qubit label built from a symbol font.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

/** As above, minus the three whitespace controls a paragraph may need. */
const CONTROL_CHARACTERS_EXCEPT_BREAKS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

/* eslint-enable no-control-regex */

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** The issue codes this module can raise, as the client branches on them. */
export const TEXT_ISSUE_CONTROL_CHARACTER = 'control_character'
export const TEXT_ISSUE_LONE_SURROGATE = 'lone_surrogate'

/**
 * A surrogate with no partner. `String.prototype.isWellFormed` is the exact
 * test and exists from Node 20; the scan is a fallback for an older runtime
 * rather than a second opinion.
 */
function hasLoneSurrogate(value: string): boolean {
  const wellFormed = (value as { isWellFormed?: () => boolean }).isWellFormed
  if (typeof wellFormed === 'function') return !wellFormed.call(value)
  return LONE_SURROGATE.test(value)
}

function check(value: string, ctx: z.RefinementCtx, controls: RegExp): void {
  if (controls.test(value)) {
    ctx.addIssue({
      code: 'custom',
      params: { qsim: TEXT_ISSUE_CONTROL_CHARACTER },
      message:
        'must not contain control characters: PostgreSQL cannot store U+0000 ' +
        'in a text or jsonb value',
    })
  }
  if (hasLoneSurrogate(value)) {
    ctx.addIssue({
      code: 'custom',
      params: { qsim: TEXT_ISSUE_LONE_SURROGATE },
      message:
        'must be well-formed Unicode: a lone surrogate becomes U+FFFD on the ' +
        'way to storage, which silently changes the value',
    })
  }
}

/**
 * Adds the single-line guarantee to a string schema. No control characters at
 * all, no lone surrogates. For titles, ids, gate names, labels and symbols.
 */
export function storableText<T extends z.ZodType<string, string>>(
  schema: T
): T {
  return schema.superRefine((value, ctx) => {
    check(value, ctx, CONTROL_CHARACTERS)
  })
}

/**
 * The same guarantee, allowing `\t`, `\n` and `\r`. For a description or
 * anything else a person types into a text area.
 */
export function storableProse<T extends z.ZodType<string, string>>(
  schema: T
): T {
  return schema.superRefine((value, ctx) => {
    check(value, ctx, CONTROL_CHARACTERS_EXCEPT_BREAKS)
  })
}

/**
 * Whether a string is storable as it stands. Exported so a caller outside a
 * Zod pipeline — a script, a migration, a check in the repository — can ask
 * the same question the schemas ask.
 */
export function isStorableText(value: string, allowBreaks = false): boolean {
  const controls = allowBreaks
    ? CONTROL_CHARACTERS_EXCEPT_BREAKS
    : CONTROL_CHARACTERS
  return !controls.test(value) && !hasLoneSurrogate(value)
}
