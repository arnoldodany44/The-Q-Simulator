/**
 * One labelled input, with its hint and its error attached to it rather than
 * merely near it.
 *
 * ── What the wiring buys ──────────────────────────────────────────────────
 *
 * A `<p>` under an input is a sentence a sighted user reads and a screen
 * reader user never hears: focus lands on the field, the field announces its
 * label, and the message explaining why the last attempt failed is somewhere
 * else in the reading order. `aria-describedby` makes it part of the field's
 * announcement (WCAG 3.3.1, 3.3.2), which is the difference between "Password"
 * and "Password, at least 6 characters, edit text, invalid".
 *
 * `aria-invalid` is set only while there is a message. Marking a field invalid
 * with nothing to read is worse than not marking it: the user is told
 * something is wrong and not what.
 *
 * The message also carries `role="alert"`, and that is not redundant with the
 * description. `aria-describedby` is read *when focus arrives*, which covers
 * the field a form moves focus to and covers nothing else — and the commonest
 * rejection is the one where focus never moves at all, because the user typed
 * a malformed address in the field they were already in and pressed Enter.
 * `focus()` on the focused element is a no-op, so with the description alone a
 * blind reader heard nothing whatsoever for a rejected submission. The live
 * region is what makes the refusal perceivable; the description is what makes
 * it re-readable when they come back to the field.
 *
 * ── `busy` is not `disabled` ──────────────────────────────────────────────
 *
 * While a request is in flight the field stops accepting edits, and it does so
 * with `readOnly` rather than `disabled`. A disabled element cannot hold
 * focus: disabling the field somebody pressed Enter in hands focus to the
 * document body, the focus ring vanishes, and Tab restarts from the top of the
 * page — with the correction they now have to make several stops away. Read-only
 * refuses the keystroke and keeps the caret.
 *
 * ── Why `autoComplete` is a required prop ─────────────────────────────────
 *
 * Because forgetting it is silent. A password manager keys off `username`,
 * `current-password` and `new-password`; without them it offers nothing on
 * sign-in and saves nothing on sign-up, and the user's answer to that is a
 * password they can type from memory. An accessibility requirement and a
 * security one, in the same attribute (WCAG 1.3.5). Making it non-optional
 * means the value has to be a decision at every call site.
 *
 * The id comes from `useId` so two of these on one page — the new password
 * and its repeat — cannot collide, which is the bug that silently points one
 * label at the other field.
 */

import { useId } from 'react'
import type { RefObject } from 'react'

export interface AuthFieldProps {
  readonly label: string
  readonly type: 'email' | 'password'
  readonly name: string
  /** `username`, `current-password`, `new-password`, `email`. Never omitted. */
  readonly autoComplete: string
  readonly value: string
  readonly onChange: (value: string) => void
  /** Shown, announced, and what makes the field `aria-invalid`. */
  readonly error?: string | undefined
  /** Standing guidance — the password policy, say. Announced with the field. */
  readonly hint?: string | undefined
  /** So a form can move focus to the first field it rejected. */
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined
  /** A request is in flight: refuse edits, but keep the caret. See above. */
  readonly busy?: boolean | undefined
}

export function AuthField({
  label,
  type,
  name,
  autoComplete,
  value,
  onChange,
  error,
  hint,
  inputRef,
  busy,
}: AuthFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  /*
   * Both, in reading order, when both are present: the rule first and then
   * why this attempt broke it. An empty string would be a valid IDREF list of
   * length zero to a browser and a dangling reference to some assistive
   * technology, so the attribute is omitted instead.
   */
  const describedBy =
    [hint === undefined ? '' : hintId, error === undefined ? '' : errorId]
      .filter((token) => token !== '')
      .join(' ') || undefined

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>

      {hint === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}

      <input
        className="field__input"
        id={id}
        ref={inputRef}
        name={name}
        type={type}
        value={value}
        required
        autoComplete={autoComplete}
        // An email address is not a sentence: capitalising its first letter
        // and underlining it in red both help nobody.
        autoCapitalize="none"
        spellCheck={false}
        readOnly={busy}
        aria-disabled={busy === true ? true : undefined}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />

      {error === undefined ? null : (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
