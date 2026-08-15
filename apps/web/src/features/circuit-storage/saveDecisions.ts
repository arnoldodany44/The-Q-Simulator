/**
 * The rules a save obeys, as functions with no React and no network in them.
 *
 * ── THE CONFLICT CASE, AND WHAT THE API ACTUALLY DOES ─────────────────────
 *
 * Read `apps/api/src/routes/circuits.ts` and `packages/db/src/circuits.ts`
 * before changing anything here, because the client half only makes sense
 * against what the server half really does:
 *
 *   `POST /circuits/:id/versions` takes `{ circuit, message }`. There is no
 *   base-version field in `CreateVersionBody`, and the handler does not look
 *   for one. It allocates `max(versionNum) + 1`, and when two writers race for
 *   the same number the unique index fires and the loser *retries with the
 *   next number*. `VERSION_CONFLICT` (409) is raised only when those retries
 *   are exhausted — that is write contention, not staleness.
 *
 * So the server never rejects a stale save. Two tabs opened on version 2 both
 * succeed: one becomes version 3, the other version 4. Nothing is destroyed —
 * immutability guarantees that much — but the second tab's document becomes
 * "the latest" without its author ever having seen the first tab's work, and
 * neither user is told. That silent win is the defect, and it can only be
 * caught here: the browser is the only party that knows which version the
 * editor was seeded from.
 *
 * Hence two checks, and they catch different things:
 *
 *   1. `staleAgainst` runs *before* the write. The client re-reads the circuit
 *      and compares the server's latest version number with the one the editor
 *      descends from. Different means somebody else saved; the save is refused
 *      by the client and the user is shown the choice.
 *   2. `racedOn` runs *after* a write that passed the first check. The window
 *      between the check and the write is small and it is not zero, and the
 *      response says exactly which number was allocated: anything other than
 *      `base + 1` means somebody slipped in. The save has already succeeded by
 *      then and is not undone — history is append-only, and pretending
 *      otherwise would be a second lie — so it is reported rather than
 *      reversed: your work is version N, and version N-1 is somebody else's
 *      that you have not read.
 *
 * Neither check is an authorisation decision. Ownership and visibility are the
 * server's (§11); this is about not overwriting a colleague in silence.
 */

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from '@qsim/contract'

/**
 * Why a field was refused, as a code the `circuits` catalog translates (D2).
 * The same vocabulary the API's own validation uses: never a sentence.
 */
export const SAVE_PROBLEMS = [
  'title-required',
  'title-too-long',
  'description-too-long',
  'message-too-long',
] as const

export type SaveProblem = (typeof SAVE_PROBLEMS)[number]

/**
 * The limits are the contract's, imported rather than repeated.
 *
 * A copy would be a second number that agrees with the server until somebody
 * raises one of them, and the failure mode is the worst kind: the user types a
 * title the client accepts and the API answers 400 on a field the form said
 * was fine.
 *
 * Trimmed before measuring, exactly as `TitleSchema` trims before `.min(1)`,
 * so a title of three spaces is refused here for the same reason it would be
 * refused there rather than accepted and then rejected over the wire.
 */
export function titleProblem(value: string): SaveProblem | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'title-required'
  if (trimmed.length > MAX_TITLE_LENGTH) return 'title-too-long'
  return null
}

export function descriptionProblem(value: string): SaveProblem | null {
  return value.trim().length > MAX_DESCRIPTION_LENGTH
    ? 'description-too-long'
    : null
}

export function messageProblem(value: string): SaveProblem | null {
  return value.trim().length > MAX_MESSAGE_LENGTH ? 'message-too-long' : null
}

/**
 * What the wire wants for an optional text field the user left empty.
 *
 * `null`, not `''`: an empty description is the absence of one, and storing
 * the empty string would make "has a description" true for every circuit
 * anybody ever opened the form on.
 */
export function optionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A save that would land on top of work nobody in this tab has read.
 *
 * `base` is the version the editor descends from; `server` is where the server
 * had got to when the pre-flight asked.
 */
export interface StaleSave {
  readonly base: number
  readonly server: number
}

/** A save that already landed, on a number it was not promised. */
export interface RacedSave {
  readonly base: number
  readonly landed: number
}

/**
 * Before the write: is the server still where this document started?
 *
 * `!==` and not `>`. A server number *below* the base cannot happen through
 * the API — versions are only appended — so if it ever does, the assumption
 * this whole file rests on is wrong, and stopping to say so beats treating
 * "impossible" as "fine".
 */
export function staleAgainst(base: number, server: number): StaleSave | null {
  return server === base ? null : { base, server }
}

/** After the write: did this save get the number it was promised? */
export function racedOn(base: number, landed: number): RacedSave | null {
  return landed === base + 1 ? null : { base, landed }
}
