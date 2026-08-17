/**
 * BB84 — why eavesdropping leaves a mark (§3.6).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES, AND WHY IT IS HARD.
 *
 * Superposition for the two bases, interference for what an `H` does, and
 * entanglement for the last three steps. It is the first lesson that is about a
 * *protocol* rather than a circuit — there are two people, a random choice each
 * makes privately, and a public conversation afterwards — and the prose says
 * that plainly rather than pretending the picture is simpler than it is. One
 * run of this circuit is **one round** of a protocol that needs thousands.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVE IS A `CNOT`, AND THAT IS NOT A SIMPLIFICATION.
 *
 * The obvious way to model an eavesdropper is a mid-circuit measurement. This
 * lesson uses a `CNOT` onto a second wire instead, and the substitution is
 * exact rather than convenient: copying a qubit's value onto a fresh wire in
 * the `|0⟩`/`|1⟩` basis leaves the travelling qubit in precisely the mixed
 * state a measurement would have left it in — that is what a measurement *is*,
 * once you include the apparatus in the circuit. The reduced state of Bob's
 * qubit is identical either way, so every number the histogram shows is the
 * number the real protocol produces.
 *
 * What it buys is everything the analysis panel does: the state stays pure, so
 * §3.2's entanglement metrics can show Eve's mark as one bit of entropy on a
 * wire that should have carried none (§5.3 would otherwise leave the panel with
 * nothing to say), and the closing build step can be checked at all.
 *
 * The reader is told this in step 6 rather than left to assume the model is a
 * cartoon.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE REGISTER GROWS MID-LESSON, WHICH NO OTHER LESSON DOES.
 *
 * Steps 1 to 4 are one wire, because for four steps there is genuinely only one
 * qubit in the story and a second, idle wire would be a question the reader
 * cannot answer. Eve's arrival is `patch.qubits: 2` — the moment a third party
 * appears is the moment the register needs to hold them, and watching a wire
 * appear is a better sentence than any prose about it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 *   bases differ            → `0` and `1` at 1/2 each: the round is discarded
 *   bases match             → `1` with probability 1: the key bit agrees
 *   + Eve in the wrong basis→ all four at 1/4, S(q0) = 1 bit: Bob is wrong half
 *                             the time on a round that should have been certain
 *   + Eve in the right basis→ `11` with probability 1, S(q0) = 0: she learns the
 *                             bit and leaves nothing behind
 *
 * The last two together are the whole security argument, and the second of them
 * is the half that gets left out: a lucky Eve is undetectable. What makes the
 * protocol work is that she cannot be lucky every time.
 */

import type { Lesson } from '../format'

export const BB84_SLUG = 'bb84'

export const bb84: Lesson = {
  slug: BB84_SLUG,
  // Bennett and Brassard, 1984. A proper name (D2), like Bell and GHZ.
  properName: 'BB84',
  base: { qubits: 1 },
  steps: [
    {
      id: 'sendBit',
      patch: { add: [{ id: 'bb_bit', gate: 'x', targets: [0], column: 0 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      // Bob's basis lives at column 5, which leaves columns 2 to 4 empty for
      // the length of the journey — and step 4 makes that gap the point.
      id: 'wrongBasis',
      patch: { add: [{ id: 'bb_bob', gate: 'h', targets: [0], column: 5 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'sameBasis',
      patch: { add: [{ id: 'bb_alice', gate: 'h', targets: [0], column: 1 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'sifting',
      patch: {},
      focus: 'circuit',
      objective: { kind: 'read' },
    },
    {
      id: 'eve',
      patch: {
        qubits: 2,
        add: [
          { id: 'bb_eve', gate: 'cx', targets: [1], controls: [0], column: 3 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'mark',
      patch: {},
      focus: 'entanglement',
      objective: { kind: 'read' },
    },
    {
      id: 'lucky',
      patch: {
        add: [
          { id: 'bb_e1', gate: 'h', targets: [0], column: 2 },
          { id: 'bb_e2', gate: 'h', targets: [0], column: 4 },
        ],
      },
      focus: 'histogram',
      objective: {
        kind: 'build',
        // Both wires certain: Bob reads the bit Alice sent, and Eve's wire
        // holds a copy. Any pair of gates that reads and restores the diagonal
        // basis does it, which is why the check is on the outcome.
        check: { kind: 'probabilities', expected: { '11': 1 } },
      },
    },
  ],
}
