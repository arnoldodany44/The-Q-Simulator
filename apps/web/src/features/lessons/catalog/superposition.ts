/**
 * Superposition — the first lesson, and the proof that the format works
 * (§3.6, §15's first row).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ARGUES, AND WHY IN THIS ORDER.
 *
 * The thing a first-time reader believes about a superposition is that it is
 * ignorance: the qubit is secretly 0 or 1 and the histogram is a bookmaker's
 * odds. Every step here exists to take that apart, and the taking-apart is
 * done by the panel rather than by the prose.
 *
 *   1. `still`      one wire, no gates, one bar. Certainty has a picture.
 *   2. `hadamard`   one `H`, two bars. This is the picture that looks like a coin.
 *   3. `notACoin`   the Bloch arrow — full length, on the equator. A coin's
 *                   arrow would be *short*, and the reader can see that this
 *                   one is not. This is the whole lesson in one chart.
 *   4. `phasors`    the little arrows on the bars: each amplitude has a
 *                   direction, and both point the same way right now.
 *   5. `turn`       a `Z`. The bars do not move and one phasor turns half a
 *                   turn. Something changed that the odds cannot see.
 *   6. `cancel`     a second `H`. One bar, at |1⟩. Two paths to |0⟩ arrived
 *                   pointing opposite ways and cancelled — which no
 *                   distribution over hidden coins can do.
 *   7. `equal`      the reader's turn: get back to fifty-fifty, any way at all.
 *
 * Steps 3 and 4 carry no patch, and that is the format working rather than a
 * gap: a step that says something about the circuit already on screen is a
 * step whose diff is empty.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 *   |0⟩ →H→ (|0⟩+|1⟩)/√2 →Z→ (|0⟩−|1⟩)/√2 →H→ |1⟩
 *
 * `HZH = X`, which is why step 6 lands on a single bar and not on a smaller
 * pair. `lessons.test.ts` runs every step through `@qsim/core` and asserts
 * exactly this, for the reason `presets.test.ts` gives: a lesson called
 * superposition that does not produce one teaches the wrong thing to precisely
 * the reader who cannot tell.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE OBJECTIVE IS THE OPEN KIND ON PURPOSE.
 *
 * Step 7 asks for a distribution, not for a gate. `H` is the answer the lesson
 * would give, and `Ry(π/2)`, `√X` and `X` then `H` are equally right — a check
 * over the circuit text would have called three of those wrong. `probabilities`
 * rather than `state` because the question really is about the odds: any phase
 * is a correct answer to "make the two outcomes equally likely", and demanding
 * one would be demanding something the sentence did not ask for.
 */

import type { Lesson } from '../format'

export const SUPERPOSITION_SLUG = 'superposition'

export const superposition: Lesson = {
  slug: SUPERPOSITION_SLUG,
  // An ordinary word every language has its own form of — superposición,
  // superposition — so the title lives in the catalogs (D2, and the same rule
  // `presets.ts` follows for its six).
  properName: null,
  base: { qubits: 1 },
  steps: [
    {
      id: 'still',
      patch: {},
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'hadamard',
      patch: { add: [{ id: 'ls_h1', gate: 'h', targets: [0], column: 0 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'notACoin',
      patch: {},
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      id: 'phasors',
      patch: {},
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'turn',
      patch: { add: [{ id: 'ls_z', gate: 'z', targets: [0], column: 1 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'cancel',
      patch: { add: [{ id: 'ls_h2', gate: 'h', targets: [0], column: 2 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'equal',
      patch: { add: [{ id: 'ls_h3', gate: 'h', targets: [0], column: 3 }] },
      focus: 'histogram',
      objective: {
        kind: 'build',
        // Both outcomes, equally likely, by any route and at any phase.
        check: { kind: 'probabilities', expected: { '0': 0.5, '1': 0.5 } },
      },
    },
  ],
}
