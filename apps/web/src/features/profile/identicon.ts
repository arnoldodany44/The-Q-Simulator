/**
 * A profile picture derived from a user id — milestone M1.9.
 *
 * ── Why this exists instead of an upload ──────────────────────────────────
 *
 * Supabase Storage is available and uploads were the obvious answer. They were
 * not taken, and the reason is not effort. An upload endpoint is untrusted
 * binary ingest, and doing it properly means: a hard size cap enforced before
 * the bytes are buffered; the type decided by *sniffing the content*, never by
 * the filename or the declared `Content-Type`, because both are attacker
 * chosen; re-encoding rather than storing what arrived, since a file that
 * sniffs as a PNG can still carry an SVG or an HTML document after it; a
 * bucket on an origin that can execute nothing and that is not this app's, so
 * a served file cannot become script in the app's own origin; and a story for
 * deleting the object when the account is deleted, which is a second orphan
 * class beside the four this milestone already had to sweep.
 *
 * Every one of those is a real piece of work, and none of them is the feature.
 * The feature is "a profile has a picture", and a picture derived from the id
 * satisfies it completely, for every user, immediately, with no bytes stored,
 * no bucket, no MIME sniffing, no orphan and no origin to get wrong. It is a
 * legitimate choice and it is made deliberately; uploads are a Phase 2 item
 * with a checklist rather than a gap.
 *
 * A user who *does* have a picture already keeps it: `avatarUrl` holds
 * whatever their identity provider issued, restricted to http and https in
 * `verify.ts`, and the settings screen lets them choose between that and this.
 *
 * ── What the drawing is ───────────────────────────────────────────────────
 *
 * A 5×5 grid, mirrored about the vertical axis, so it reads as a face-like
 * shape rather than as noise; the left three columns are decided by the hash
 * and the right two mirror them. Symmetry is what makes small identicons
 * distinguishable at a glance.
 *
 * The colour comes from the project's own phase circle (§10): the hue is the
 * hash mapped onto [0, 2π) and then through the same `hue = phase · 180/π`
 * rule the amplitude colours use, at the same saturation and lightness. Two
 * consequences, both wanted — an avatar can never be mistaken for interface
 * chrome, and it can never fail the contrast the palette already measures.
 *
 * ── It is decoration, and it says so ──────────────────────────────────────
 *
 * The identity is the display name and the handle beside it, both of which are
 * text. So the SVG is `aria-hidden` and adds nothing to the accessible name:
 * a screen reader announcing "a green pattern" before every username would be
 * noise, and colour is never the only carrier of meaning here because it
 * carries none.
 */

import { phaseToColour, TAU } from '../../lib/phase-colour.js'

/** Columns in the grid. Odd, so there is a centre column to mirror about. */
export const IDENTICON_GRID = 5
/** How many columns the hash decides; the rest are their mirror image. */
const DECIDED_COLUMNS = Math.ceil(IDENTICON_GRID / 2)

/**
 * FNV-1a, 32-bit.
 *
 * Not a cryptographic hash and it does not need to be: the input is a UUID
 * that is already public — it travels in every card's owner reference — so
 * there is nothing here to hide and no preimage worth resisting. What is
 * needed is that two ids differ in the picture, that one id always draws the
 * same picture, and that the arithmetic is identical in every engine. FNV-1a
 * is four lines and gives all three; `Math.imul` keeps the multiply in 32-bit
 * territory rather than drifting into a double.
 */
export function hashIdentity(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  // `>>> 0` because the multiply leaves a signed 32-bit value, and every
  // consumer below wants a non-negative integer.
  return hash >>> 0
}

export interface Identicon {
  /** Row-major, `IDENTICON_GRID × IDENTICON_GRID`, true where a cell is filled. */
  readonly cells: readonly boolean[]
  /** From the project's phase circle (§10), so it is always in the palette. */
  readonly colour: string
}

/**
 * The picture for an identity. Pure: the same id always draws the same thing,
 * which is what makes an avatar recognisable across pages and across sessions.
 */
export function identiconFor(identity: string): Identicon {
  const hash = hashIdentity(identity)
  const cells: boolean[] = []

  for (let row = 0; row < IDENTICON_GRID; row += 1) {
    for (let column = 0; column < IDENTICON_GRID; column += 1) {
      /*
       * Mirrored about the centre column: column 4 repeats column 0, column 3
       * repeats column 1. Only `DECIDED_COLUMNS` bits per row come from the
       * hash, which is what gives the shape its symmetry.
       */
      const source = Math.min(column, IDENTICON_GRID - 1 - column)
      const bit = row * DECIDED_COLUMNS + source
      // Rotating rather than shifting past 31, so a 5×3 grid of bits fits in a
      // 32-bit hash without the last rows all reading zero.
      cells.push(((hash >>> (bit % 32)) & 1) === 1)
    }
  }

  /*
   * The hue is the hash on the phase circle. `phaseToColour` is the one place
   * §10's rule lives, and going through it means an avatar is drawn by the
   * same formula as an amplitude — including the lightness that was raised to
   * 66% in M0.7a so the worst hue still measures 3:1 against the panel.
   */
  const phase = (hash / 0x1_0000_0000) * TAU
  return { cells, colour: phaseToColour(phase) }
}
