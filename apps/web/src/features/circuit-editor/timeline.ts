/**
 * Where the timeline scrubber is parked, as arithmetic (M0.8, §3.1).
 *
 * No React and no DOM, for the same reason `geometry.ts` has none: this is the
 * mapping between three things that must never disagree — the position the
 * engine is asked for, the stop the slider is sitting on, and what happens to
 * both when the circuit under them changes shape. A scrubber that names a
 * column the circuit no longer has does not throw; it quietly captions the
 * final state with a column number that means nothing.
 *
 * ────────────────────────────────────────────────────────────────────────
 * A POSITION IS A CUT, NOT A COLUMN.
 *
 * `stateAfterColumn(cache, circuit, c)` answers "the state once every column
 * up to and including `c` has run", so a position is really the gap *after* a
 * column. That makes two of them worth naming:
 *
 *  - **`-1`** is the cut before column 0: the ground state, |0…0⟩, before the
 *    circuit has done anything. It is a real position rather than an edge case
 *    — it is where playback starts, and watching the first H turn one bar into
 *    two is the entire teaching moment §3.1 calls the most powerful in the
 *    editor. The engine answers it directly.
 *  - **`null`** is the cut after the last column, spelled as an absence
 *    because that is what it is: nothing is being held back, so the panel runs
 *    the whole circuit exactly as it did before this feature existed. That
 *    matters twice over. An editor nobody has scrubbed asks the worker the
 *    same question M0.7 asked it, so the resting state of the app is
 *    unchanged; and "the state at the last column" and "the final state" are
 *    the same vector, so spelling them the same way makes them incapable of
 *    disagreeing.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE STOPS ARE WHAT THE SLIDER COUNTS.
 *
 * A circuit of `columns` columns offers `columns + 1` stops: one before each
 * column, and one at the end. Stop `i` is position `i - 1`, and the last stop
 * is `null`. Everything below is that one relation, so the slider cannot drift
 * out of step with the engine.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EDITING WHILE SCRUBBED: THE POSITION IS CLAMPED, NOT RESET.
 *
 * The three candidates were reset-to-the-end, keep, and clamp.
 *
 * **Reset** is what a naive implementation does and it destroys the loop the
 * feature exists for: park on column 3, change the gate in column 3, watch the
 * state change. Under reset the very edit being studied throws the reader back
 * to the end of the circuit, and they have to scrub back after every keystroke.
 *
 * **Keep** is right until the circuit gets shorter. Delete the tail of a
 * twelve-column circuit down to four and a kept position of 9 names a cut that
 * does not exist: the engine answers with the final state (it has nothing else
 * to give), the slider sits past its own maximum, and the caption says "up to
 * column 9" over a state that is nothing of the kind.
 *
 * **Clamp** is keep, with the one correction a shortened circuit forces, and
 * it is what `clampPosition` implements. It is applied *on read* rather than
 * on write — the same discipline `useKeyboardGrid` applies to its cursor — so
 * an accidental deletion that shortens the circuit does not erase where the
 * reader was: undo restores the circuit, and the position comes back with it.
 */

import type { Circuit } from '@qsim/schema'

import { columnCount } from './geometry'

/**
 * A cut in the circuit: the column the state has run through, `-1` for the
 * state before anything ran, or `null` for the end of the circuit.
 */
export type TimelinePosition = number | null

/** How many stops a circuit of `columns` columns offers. */
export function stopCount(columns: number): number {
  return Math.max(0, columns) + 1
}

/** The stop a position sits on. The inverse of `positionAt`. */
export function stopOf(position: TimelinePosition, columns: number): number {
  if (position === null) return stopCount(columns) - 1
  return position + 1
}

/**
 * The position a stop names, with the stop brought inside the circuit first —
 * so this is also how an out-of-range stop (a slider from a longer circuit, a
 * step past either end) is answered. The inverse of `stopOf`.
 */
export function positionAt(stop: number, columns: number): TimelinePosition {
  const last = stopCount(columns) - 1
  const inside = Math.min(last, Math.max(0, stop))
  return inside >= last ? null : inside - 1
}

/**
 * The position, brought back inside a circuit of `columns` columns.
 *
 * A circuit with no columns has exactly one position — the end — because there
 * is no time in it to travel through.
 */
export function clampPosition(
  position: TimelinePosition,
  columns: number
): TimelinePosition {
  return positionAt(stopOf(position, columns), columns)
}

/** `delta` stops along the timeline, stopping dead at either end. */
export function stepPosition(
  position: TimelinePosition,
  columns: number,
  delta: number
): TimelinePosition {
  return positionAt(stopOf(position, columns) + delta, columns)
}

/** Columns the circuit occupies — the length of its timeline. */
export function timelineLength(circuit: Circuit): number {
  return columnCount(circuit)
}
