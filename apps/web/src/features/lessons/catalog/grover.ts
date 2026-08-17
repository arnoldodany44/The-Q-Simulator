/**
 * Grover — search as interference, on four items (§3.6).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES.
 *
 * Deutsch–Jozsa, and through it interference. The reader has already seen an
 * oracle put a minus sign on part of a superposition without moving a single
 * bar of the histogram; this lesson is about what you do with that minus sign
 * afterwards. Nothing here re-explains kickback — it points back at it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * FOUR ITEMS, AND ONE ROUND, BECAUSE THE ANSWER IS THEN EXACT.
 *
 * N = 4 with one marked item is the case where a single Grover round lands on
 * the answer with probability exactly 1 — sin(3θ) = 1 when sin θ = 1/√4. That
 * is worth a great deal in a lesson: the reader sees *one* bar, not a tall bar
 * beside three short ones, and there is no "about" anywhere in the text.
 *
 * It also sets up the honest closing step. A second round is not better, it is
 * worse: sin(5θ) = 1/2 at this size, so the distribution goes back to a flat
 * quarter each — exactly what you would get by guessing. `lessons.test.ts`
 * asserts that too, because "more rounds is not better" is the single most
 * common thing people believe about Grover that is false.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE ORACLE IS WRAPPED IN `X` GATES FROM THE FIRST STEP, ON PURPOSE.
 *
 * A bare `CZ` marks `|11⟩` and would need no wrapping at all. This lesson marks
 * `|10⟩` instead, with `X` on the first wire on either side of the `CZ`, and
 * pays two columns for it, because that is what makes the closing exercise
 * possible: the reader retargets the search by moving the wrapper to the other
 * wire, using the columns that are already there. An oracle that started as one
 * gate would leave them nowhere to put anything, since the editor can delete a
 * gate and place a gate but has no gesture for inserting a column.
 *
 * The cost is that step 2 introduces two ideas instead of one, and the prose
 * pays it back immediately by naming the `X` gates for what they are: a
 * relabelling, so that the item the `CZ` always marks is the item we want.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 *   H⊗H                     → four amplitudes at 1/2
 *   X·CZ·X (on q0)          → the amplitude of `|10⟩` becomes −1/2
 *   diffuser                → `|10⟩` with probability 1
 *   oracle + diffuser again → all four back at 1/4
 *
 * The diffuser is `H⊗H · X⊗X · CZ · X⊗X · H⊗H`, which is the reflection about
 * the average up to an overall sign — and the overall sign is why the prose can
 * describe it as "reflect every amplitude about the average" without hedging.
 */

import type { Lesson } from '../format'

export const GROVER_SLUG = 'grover'

export const grover: Lesson = {
  slug: GROVER_SLUG,
  // A person's name (D2), like Bell and GHZ in `presets.ts`.
  properName: 'Grover',
  base: { qubits: 2 },
  steps: [
    {
      id: 'fourItems',
      patch: {
        add: [
          { id: 'gr_h0', gate: 'h', targets: [0], column: 0 },
          { id: 'gr_h1', gate: 'h', targets: [1], column: 0 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'oracle',
      patch: {
        add: [
          { id: 'gr_x0a', gate: 'x', targets: [0], column: 1 },
          { id: 'gr_cz', gate: 'cz', targets: [1], controls: [0], column: 2 },
          { id: 'gr_x0b', gate: 'x', targets: [0], column: 3 },
        ],
      },
      focus: 'amplitudes',
      objective: { kind: 'read' },
    },
    {
      // No patch: the arithmetic of the next step, done on the table that is
      // already on screen. Reflecting 1/2, 1/2, −1/2, 1/2 about their average
      // of 1/4 gives 0, 0, 1, 0, and a reader who does that sum themselves
      // never has to take the diffuser on faith.
      id: 'average',
      patch: {},
      focus: 'amplitudes',
      objective: { kind: 'read' },
    },
    {
      id: 'diffuse',
      patch: {
        add: [
          { id: 'gr_d_h0', gate: 'h', targets: [0], column: 4 },
          { id: 'gr_d_h1', gate: 'h', targets: [1], column: 4 },
          { id: 'gr_d_x0', gate: 'x', targets: [0], column: 5 },
          { id: 'gr_d_x1', gate: 'x', targets: [1], column: 5 },
          { id: 'gr_d_cz', gate: 'cz', targets: [1], controls: [0], column: 6 },
          { id: 'gr_d_y0', gate: 'x', targets: [0], column: 7 },
          { id: 'gr_d_y1', gate: 'x', targets: [1], column: 7 },
          { id: 'gr_d_g0', gate: 'h', targets: [0], column: 8 },
          { id: 'gr_d_g1', gate: 'h', targets: [1], column: 8 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'howMany',
      patch: {},
      focus: 'circuit',
      objective: { kind: 'read' },
    },
    {
      id: 'retarget',
      patch: {
        remove: ['gr_x0a', 'gr_x0b'],
        add: [
          { id: 'gr_x1a', gate: 'x', targets: [1], column: 1 },
          { id: 'gr_x1b', gate: 'x', targets: [1], column: 3 },
        ],
      },
      focus: 'histogram',
      objective: {
        kind: 'build',
        check: { kind: 'probabilities', expected: { '01': 1 } },
      },
    },
  ],
}
