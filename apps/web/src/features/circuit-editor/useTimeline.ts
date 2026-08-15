/**
 * The timeline's state: where it is parked, whether it is playing, and how
 * fast (M0.8).
 *
 * It lives in the editor rather than inside `TimelineScrubber` because two
 * components need the answer and neither owns the other: the canvas draws the
 * playhead at that position, and the analysis panel simulates *to* it. A
 * position held inside the bar would have to be lifted out again the moment
 * either of those was wired up.
 *
 * The arithmetic is not here — it is in `timeline.ts`, with no React around it
 * — so what this file owns is exactly the three things that need a component:
 * the stored position, the playback timer, and the reduced-motion rule.
 *
 * ────────────────────────────────────────────────────────────────────────
 * NOTHING PLAYS UNLESS SOMEBODY PRESSES PLAY.
 *
 * The timer exists only while `playing` is true, nothing sets that true but a
 * press, and `autoPlay` — which a lesson or a preset will eventually want — is
 * refused outright when the reader has asked for reduced motion. That is all of
 * the `prefers-reduced-motion` accommodation on this control, and it is a
 * refusal rather than a slowdown because the setting is a statement about
 * things that move on their own, not about things that move when you ask.
 * Pressing play under reduced motion still plays: an explicit start is
 * explicit, and taking the feature away from a reader who asked for it would
 * be reading the setting as a punishment.
 *
 * The stylesheet answers the same query for the transitions, as it does
 * everywhere else in the app; between the two, nothing on this control moves
 * that the reader did not ask to move.
 *
 * ────────────────────────────────────────────────────────────────────────
 * PLAYBACK STOPS AT THE END, AND EDITING DOES NOT STOP IT.
 *
 * It stops rather than looping because a loop is a timer that runs for as long
 * as the tab is open, and because the end of a circuit is a result rather than
 * a lap marker. Pressing play *at* the end therefore rewinds first — that is
 * what a play button at the end of a track means everywhere else.
 *
 * An edit does not stop it. Watching the playback of a circuit you are
 * changing is a reasonable thing to want, and a control that stopped itself on
 * every keystroke would be impossible to use with a slider in the other hand.
 * A manual move of the bar *does* stop it, because that is two hands on the
 * same wheel.
 *
 * ────────────────────────────────────────────────────────────────────────
 * AN EDIT KEEPS THE POSITION; A NEW DOCUMENT DOES NOT.
 *
 * The two are indistinguishable from the circuit alone — both hand out a new
 * object — so the store counts documents (`documentId`) and this hook watches
 * that counter. See the reset below for what a retained position did to the
 * example chips.
 */

import type { Circuit } from '@qsim/schema'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import {
  clampPosition,
  positionAt,
  stepPosition,
  stopCount,
  stopOf,
  timelineLength,
  type TimelinePosition,
} from './timeline'

/**
 * The three playback rates, in milliseconds per column.
 *
 * Named rather than numbered because the numbers are not the reader's
 * business: what they are choosing is how long they get to look at each
 * column. 600 ms is about a comfortable reading pace for a bar chart that
 * changes shape; 1200 ms is slow enough to follow a phasor turning; 250 ms is
 * fast enough to see a whole algorithm as one motion and too fast to read any
 * single column, which is exactly what that setting is for.
 */
export const PLAYBACK_MS = { slow: 1200, normal: 600, fast: 250 } as const

export type TimelineSpeed = keyof typeof PLAYBACK_MS

export const TIMELINE_SPEEDS = ['slow', 'normal', 'fast'] as const

export const DEFAULT_TIMELINE_SPEED: TimelineSpeed = 'normal'

export interface TimelineOptions {
  readonly circuit: Circuit
  /**
   * Which document is open (`useCircuitStore`'s counter). When it changes, the
   * bar goes back to the end of the circuit — see the header.
   */
  readonly documentId?: number
  /**
   * Start playing as soon as the timeline appears. Off by default and refused
   * under `prefers-reduced-motion` — see the header.
   */
  readonly autoPlay?: boolean
}

export interface Timeline {
  /** Columns the circuit occupies. Zero means there is no timeline. */
  readonly columns: number
  /** The cut the reader is parked on. `null` is the end of the circuit. */
  readonly position: TimelinePosition
  /** The same, as a slider value in `[0, stops - 1]`. */
  readonly stop: number
  /** How many stops the bar has, one more than the circuit has columns. */
  readonly stops: number
  readonly playing: boolean
  readonly speed: TimelineSpeed
  // Properties holding closures rather than methods, the same convention
  // `useKeyboardGrid` follows: every one of them is handed straight to a JSX
  // prop, where a method signature would lose its `this` and say so.
  /** Move the bar to a stop. Stops playback: two hands on the same wheel. */
  readonly goTo: (stop: number) => void
  /** Start playing, or stop. Play at the end rewinds first. */
  readonly toggle: () => void
  readonly setSpeed: (speed: TimelineSpeed) => void
}

export function useTimeline({
  circuit,
  documentId = 0,
  autoPlay = false,
}: TimelineOptions): Timeline {
  const reducedMotion = usePrefersReducedMotion()
  const columns = useMemo(() => timelineLength(circuit), [circuit])

  /*
   * Autoplay begins at the beginning. Starting it where the bar rests — the
   * end of the circuit — would be a playback with nothing left to play, which
   * is the same reason `toggle` rewinds before it starts.
   */
  const autoStart = autoPlay && !reducedMotion
  const [stored, setStored] = useState<TimelinePosition>(() =>
    autoStart ? positionAt(0, columns) : null
  )
  const [requested, setRequested] = useState(autoStart)
  const [speed, setSpeed] = useState<TimelineSpeed>(DEFAULT_TIMELINE_SPEED)

  /*
   * A NEW DOCUMENT PUTS THE BAR BACK AT THE END.
   *
   * §3.1's frozen decision 2 keeps the position across an *edit*, and its
   * stated justification is that undo brings the circuit back and the position
   * with it. A whole-document replacement has no such pairing: `loadCircuit`
   * clears the undo history precisely so nobody can undo their way back into
   * the circuit an example replaced, so a retained position is parked against a
   * circuit that no longer exists.
   *
   * What that looked like: click "Bell" while the bar sits after column 0, and
   * the panel draws |00⟩ and |01⟩ at fifty per cent each — a product state, the
   * very picture the Bell example exists to be contrasted with — under a live
   * region announcing that the two qubits are entangled. The caption did say
   * "the state after column 0", so nothing lied outright; the chart the reader
   * looks at and the sentence the reader just heard simply described different
   * things.
   *
   * Adjusted during render rather than in an effect, which is React's own
   * prescription for state that has to follow a prop: an effect would paint one
   * frame of the old position over the new document first.
   */
  const [openDocument, setOpenDocument] = useState(documentId)
  if (documentId !== openDocument) {
    setOpenDocument(documentId)
    setStored(null)
    setRequested(false)
  }

  /*
   * Clamped on read, never on write. The circuit shrinks under the bar every
   * time a gate at the end is deleted, and storing the correction would throw
   * the reader's position away for good — undo would bring the circuit back
   * and leave the timeline at the end. See the policy in `timeline.ts`.
   */
  const position = clampPosition(stored, columns)

  /**
   * Playing is *asked to play* and *not yet at the end* — derived rather than
   * stored, which is what makes the end of the circuit stop playback without a
   * second piece of state chasing the first.
   *
   * The alternative was an effect that noticed the end and switched a flag
   * off. That is a cascading render for something that is not a fact of its
   * own: whether the timer should be running is a function of where the bar
   * is, and computing it says so. It also removes an entire class of bug —
   * a path that moves the bar to the end without remembering to stop the
   * timer, of which an edit that shortens the circuit is one.
   */
  const playing = requested && position !== null

  const goTo = useCallback(
    (stop: number) => {
      setRequested(false)
      // Resolved against the columns of the render that produced the event,
      // which is the circuit the reader was looking at when they moved the bar.
      setStored(positionAt(stop, columns))
    },
    [columns]
  )

  const toggle = useCallback(() => {
    if (playing) {
      setRequested(false)
      return
    }
    // Play at the end rewinds: there is nothing ahead to show, and a play
    // button that does nothing is a play button that looks broken.
    setStored((current) =>
      clampPosition(current, columns) === null
        ? positionAt(0, columns)
        : current
    )
    setRequested(true)
  }, [playing, columns])

  /*
   * The tick reads the circuit's length through a ref rather than through the
   * dependency list, so that an edit does not restart the timer. With
   * `columns` as a dependency, typing while playback ran would tear the
   * interval down and build a new one on every keystroke, and playback would
   * stall for exactly as long as somebody kept editing — a stall with no
   * visible cause, in the one control whose whole job is to keep moving.
   */
  const length = useRef(columns)
  useEffect(() => {
    length.current = columns
  }, [columns])

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setStored((current) => stepPosition(current, length.current, 1))
    }, PLAYBACK_MS[speed])
    return () => {
      clearInterval(timer)
    }
  }, [playing, speed])

  return {
    columns,
    position,
    stop: stopOf(position, columns),
    stops: stopCount(columns),
    playing,
    speed,
    goTo,
    toggle,
    setSpeed,
  }
}
