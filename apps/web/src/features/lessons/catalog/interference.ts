/**
 * Interference — the third lesson, and the one the four algorithm lessons are
 * built on (§3.6).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES.
 *
 * Superposition, for two paths cancelling; entanglement, for the second half.
 * The reader has already watched `H·Z·H` turn `|0⟩` into `|1⟩`, so this lesson
 * does not have to argue that phase matters. It argues two things that lesson
 * could not:
 *
 *   1. **The phase is a continuous knob, and the outcome follows it.** `T`,
 *      then `S`, then `Z` in the same slot: 15%, 50%, 100%. One gate changes,
 *      one number moves, and the reader can see that "interference" is not a
 *      binary trick but an angle.
 *   2. **Interference dies the moment the paths become distinguishable.** A
 *      `CNOT` onto a second wire records which path was taken — nobody looks,
 *      nothing is measured, the second wire is just *correlated* — and the
 *      cancellation stops. This is the double-slit which-path experiment,
 *      exactly, and it is the reason every quantum algorithm has to uncompute.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE LAST STEP IS THE QUANTUM ERASER, AND IT IS EASY TO GET WRONG IN PROSE.
 *
 * Adding an `H` to the marker wire brings the two bars back: `|00⟩` and `|11⟩`,
 * half each. What has *not* happened is that the first qubit became predictable
 * again — its own odds are still fifty-fifty, and no gate on the second wire
 * could ever change that. What came back is the *correlation*: sort the runs by
 * what the second wire says and each half is certain.
 *
 * The catalog text says exactly that, and says why, because the version that
 * omits it is how a reader ends up believing something is signalled backwards
 * in time. §2's audience includes people who will go on to read a textbook, and
 * this is the step where an enthusiastic lesson costs them the most.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 *   H·H          → P(|0⟩) = 1
 *   H·T·H        → P(|1⟩) = (2−√2)/4 ≈ 0.1464
 *   H·S·H        → P(|1⟩) = 1/2
 *   H·Z·H        → P(|1⟩) = 1
 *   H·CNOT·H     → all four basis states at 1/4, S(q0) = 1 bit
 *   …then H(q1)  → |00⟩ and |11⟩ at 1/2, S(q0) still 1 bit
 *
 * The empty column between the two `H` gates is deliberate and is named in the
 * prose: it is the slot every later step writes into, and a lesson that had to
 * shuffle gates sideways to make room would be teaching the editor instead.
 */

import type { Lesson } from '../format'

export const INTERFERENCE_SLUG = 'interference'

export const interference: Lesson = {
  slug: INTERFERENCE_SLUG,
  properName: null,
  // Two wires from the first step, though the second stays idle until step 6.
  // The alternative — growing the register mid-lesson — would move every gate
  // on screen at the moment the reader is being asked to watch one number.
  base: { qubits: 2 },
  steps: [
    {
      id: 'split',
      patch: { add: [{ id: 'in_h1', gate: 'h', targets: [0], column: 0 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'rejoin',
      // Column 2, leaving column 1 free: the slot the next three steps use.
      patch: { add: [{ id: 'in_h2', gate: 'h', targets: [0], column: 2 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'eighth',
      patch: { add: [{ id: 'in_phase', gate: 't', targets: [0], column: 1 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      // Same id, same column, different gate: `remove` runs before `add`, so a
      // replacement is one patch. See `patch.ts`.
      id: 'quarter',
      patch: {
        remove: ['in_phase'],
        add: [{ id: 'in_phase', gate: 's', targets: [0], column: 1 }],
      },
      focus: 'amplitudes',
      objective: { kind: 'read' },
    },
    {
      id: 'half',
      patch: {
        remove: ['in_phase'],
        add: [{ id: 'in_phase', gate: 'z', targets: [0], column: 1 }],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'whichPath',
      patch: {
        remove: ['in_phase'],
        add: [
          { id: 'in_mark', gate: 'cx', targets: [1], controls: [0], column: 1 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'noSecret',
      patch: {},
      focus: 'entanglement',
      objective: { kind: 'read' },
    },
    {
      id: 'erase',
      patch: { add: [{ id: 'in_erase', gate: 'h', targets: [1], column: 3 }] },
      focus: 'histogram',
      objective: {
        kind: 'build',
        /*
         * THE QUESTION THE TASK ACTUALLY ASKS: "two bars instead of four".
         *
         * Any gate that reads the marker wire in the X basis erases the
         * record — `H` and `Ry(±π/2)` all do, and they differ only in which
         * of `|+⟩`/`|−⟩` they call zero. So `H` and `Ry(−π/2)` leave `|00⟩`
         * and `|11⟩` while `Ry(+π/2)` leaves `|01⟩` and `|10⟩`: the same
         * physics, the correlation sorted the other way round.
         *
         * This check used to name `|00⟩` and `|11⟩`, so the third of those
         * was refused while the hint offered it — a physically correct
         * quantum eraser told "Not there yet", which is exactly the failure
         * `format.ts` decision 3 exists to prevent. `outcomes` asks about the
         * shape of the histogram and says nothing about the labelling, which
         * is all the task claimed to want.
         *
         * `√X` is still refused, and correctly: it is DIAGONAL in the X basis
         * — the opposite of a reading of it — so it leaves all four bars at a
         * quarter. The catalog comment here used to offer it as equivalent.
         */
        check: { kind: 'outcomes', count: 2 },
      },
    },
  ],
}
