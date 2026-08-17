/**
 * Deutsch–Jozsa — the first lesson in which the circuit *computes* something
 * (§3.6, and the preset of the same name in `presets.ts`).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES.
 *
 * Interference, entirely. The reader has watched amplitudes cancel and knows
 * that a phase decides whether two paths add or subtract. This lesson gives
 * that mechanism a job: **phase kickback**, which is the one idea Grover and
 * QPE both need and the only genuinely new thing here.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PROBLEM, STATED HONESTLY.
 *
 * A function f takes two bits and returns one. It is promised to be either
 * *constant* (same answer for all four inputs) or *balanced* (0 for two of
 * them, 1 for the other two). Which one is it?
 *
 * Classically the worst case is three questions: two answers that agree leave
 * both possibilities open. This circuit asks once. That is the whole claim, and
 * `lessons.test.ts` checks it by running both cases.
 *
 * The honesty the prose owes the reader, and pays in the closing step: the
 * promise is doing a great deal of work. Deutsch–Jozsa answers a question
 * nobody outside a textbook asks, and its speedup is over *this* problem, not
 * over computation in general. What it is genuinely the first example of is the
 * shape every later algorithm has — put every input in at once, arrange for the
 * wrong answers to cancel, read the survivor.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE ANSWER SHEET IS PUT IN |−⟩, AND WHY IT IS PUT BACK.
 *
 * The oracle is a `CNOT` — it writes f(x) onto a third wire. Because that wire
 * holds `(|0⟩−|1⟩)/√2`, writing a 1 onto it swaps the two halves of a state
 * that is already antisymmetric, which multiplies it by −1. The minus sign
 * lands on the *input* register instead: the oracle was asked to write a bit
 * and it turned a phase. That is phase kickback, and it is visible in the
 * amplitude table at step 3 as heights that do not move and signs that do.
 *
 * The final `H` and `X` on the answer wire return it to `|0⟩`. Nothing about
 * the algorithm needs them — they are uncomputation, and they exist so that the
 * histogram at step 4 has **one** bar rather than two identical ones separated
 * by an ancilla nobody is reading. That is a real teaching cost avoided, and it
 * is also the habit every algorithm in Phase 3 relies on (see `interference`,
 * which is where the reader learnt why a leftover record matters).
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 * Ket order is little-endian (D1), so the printed string is `q2 q1 q0` and the
 * answer wire is the leading character:
 *
 *   f(x) = x₀       (balanced)  → `001`  with probability 1
 *   f(x) = 0        (constant)  → `000`  with probability 1
 *   f(x) = x₁       (balanced)  → `010`  with probability 1
 *
 * "All zeros on the input wires" means constant; anything else means balanced.
 */

import type { Lesson } from '../format'

export const DEUTSCH_JOZSA_SLUG = 'deutsch-jozsa'

export const deutschJozsa: Lesson = {
  slug: DEUTSCH_JOZSA_SLUG,
  // A person's name twice over. D2 lists it beside Bell and Grover as text
  // that is identical in all three languages, and `presets.ts` spells it with
  // the same en dash.
  properName: 'Deutsch–Jozsa',
  base: { qubits: 3 },
  steps: [
    {
      id: 'answerSheet',
      patch: {
        add: [
          { id: 'dj_x', gate: 'x', targets: [2], column: 0 },
          { id: 'dj_ha', gate: 'h', targets: [2], column: 1 },
        ],
      },
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      id: 'everyInput',
      patch: {
        add: [
          { id: 'dj_h0', gate: 'h', targets: [0], column: 1 },
          { id: 'dj_h1', gate: 'h', targets: [1], column: 1 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      // Column 2 is the oracle's slot, and it stays a slot: the closing step
      // asks the reader to write into it, and an editor has no gesture for
      // inserting a column between two others.
      id: 'kickback',
      patch: {
        add: [
          { id: 'dj_f', gate: 'cx', targets: [2], controls: [0], column: 2 },
        ],
      },
      focus: 'amplitudes',
      objective: { kind: 'read' },
    },
    {
      id: 'readOff',
      patch: {
        add: [
          { id: 'dj_g0', gate: 'h', targets: [0], column: 3 },
          { id: 'dj_g1', gate: 'h', targets: [1], column: 3 },
          { id: 'dj_ga', gate: 'h', targets: [2], column: 3 },
          { id: 'dj_xa', gate: 'x', targets: [2], column: 4 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      // A constant oracle is no gate at all, which is why the slot is empty
      // here rather than holding an identity.
      id: 'constant',
      patch: { remove: ['dj_f'] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'yourOracle',
      patch: {
        add: [
          { id: 'dj_f', gate: 'cx', targets: [2], controls: [1], column: 2 },
        ],
      },
      focus: 'histogram',
      objective: {
        kind: 'build',
        // `CNOT` from the second input wire is the answer the lesson draws; a
        // bare `Z` on that wire produces the same phase without touching the
        // answer sheet, and the hint says so. Both land on `010`, which is
        // what the check asks about.
        check: { kind: 'probabilities', expected: { '010': 1 } },
      },
    },
  ],
}
