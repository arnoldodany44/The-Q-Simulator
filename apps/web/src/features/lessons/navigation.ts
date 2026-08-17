/**
 * What the canvas holds when the reader moves between steps — Phase 3.
 *
 * Pulled out of the player because it is arithmetic over a lesson and a
 * circuit, with no React in it, and because it is the part of the player most
 * worth testing directly: every one of its branches is a thing a reader can
 * do.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE RULE, IN ONE SENTENCE.
 *
 * Moving to a step puts the lesson's own circuit for that step on the canvas —
 * except that a **build** step puts the *previous* step's circuit there,
 * because that is the document the reader is being asked to change; and except
 * that a **single step forward** is applied as the step's own patch to
 * whatever is on the canvas now, so that a reader who built the state their
 * own way keeps their version rather than having it replaced by the lesson's.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY FORWARD AND BACKWARD ARE NOT SYMMETRIC.
 *
 * Forward is the reader continuing, and continuing from what is in front of
 * them is the whole reason the format is a diff: "now add a CNOT" applied to
 * the circuit they built means their circuit gains a CNOT. Replacing the
 * document with the lesson's canonical version at that moment would silently
 * throw away a correct answer for being differently spelled — the single
 * worst thing this feature could do, since the objectives are deliberately
 * open (`objectives.ts`).
 *
 * Backward is the reader asking to see something again, and what they want to
 * see again is the *lesson*, not their experiment. Folding from step zero is
 * total, needs nothing but the lesson, and repairs any divergence — including
 * the one case forward cannot handle, where the patch does not apply because
 * the reader put something in its way.
 *
 * A jump of more than one step is treated as backward for the same reason: it
 * is not continuation, and there is no sequence of diffs to walk.
 */

import type { Circuit } from '@qsim/schema'

import { baseCircuitOf, circuitAtStep, type Lesson } from './format'
import { applyPatch } from './patch'

/**
 * The circuit a step *starts* from — the lesson's own answer, and what
 * backward navigation restores.
 *
 * For a build step this is the previous step's circuit, which is the one thing
 * about this function that is not obvious: a build step's own patch is the
 * answer, and putting the answer on the canvas when the reader arrives would
 * be handing them the exercise already done.
 */
export function startingCircuit(lesson: Lesson, index: number): Circuit {
  const step = lesson.steps[index]
  const base = baseCircuitOf(lesson)
  if (step === undefined) return base
  const target = step.objective.kind === 'build' ? index - 1 : index
  if (target < 0) return base
  // `null` means the lesson itself is broken at that step, which `lessons.
  // test.ts` fails the build on — falling back to the base register keeps a
  // reader out of a crash if one ever ships.
  return circuitAtStep(lesson, target) ?? base
}

/** The circuit a step's objective is checked against, or `null` for a read. */
export function solutionCircuit(lesson: Lesson, index: number): Circuit | null {
  return circuitAtStep(lesson, index)
}

/**
 * What the canvas should hold after moving from `from` to `to`.
 *
 * `current` is what is on it now — the reader's document, which may be their
 * own construction rather than the lesson's.
 */
export function circuitForNavigation(
  lesson: Lesson,
  current: Circuit,
  from: number,
  to: number
): Circuit {
  const step = lesson.steps[to]
  if (step === undefined) return current

  // One step forward, into a step the reader is meant to do: leave the canvas
  // exactly as it is. They arrived holding the circuit they are asked to
  // change, and replacing it would be replacing it with itself at best.
  if (to === from + 1 && step.objective.kind === 'build') return current

  if (to === from + 1) {
    const applied = applyPatch(current, step.patch)
    if (applied.ok) return applied.circuit
    // The reader put something where the patch was going. Fall back to the
    // lesson's own circuit, which is always available — see the header.
  }

  return startingCircuit(lesson, to)
}
