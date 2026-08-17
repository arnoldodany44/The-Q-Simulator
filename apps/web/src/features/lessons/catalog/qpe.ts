/**
 * Phase estimation — reading a number out of a gate (§3.6's QPE, and the last
 * lesson of the sequence).
 *
 * ────────────────────────────────────────────────────────────────────────
 * THIS ONE IS HARD, AND THE PROSE SAYS SO IN THE FIRST STEP.
 *
 * It needs four wires, three controlled rotations whose angles double, and a
 * block the lesson does not take apart. Pretending otherwise loses the reader
 * at step 5 with no idea which of the previous four they failed to understand.
 * So the summary says it is the hardest of the nine, the goal says what is
 * being taken on faith, and the closing step is honest that a phase which is
 * not an exact eighth of a turn does not give a single bar.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES.
 *
 * Interference for the phases, Deutsch–Jozsa for kickback — the controlled
 * rotations here do exactly what the oracle did there, put a phase on the
 * *control* — and Grover for the habit of reading an answer out of a register
 * that was uniform a moment ago.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE UNITARY IS `P(φ)` AND THE EIGENSTATE IS `|1⟩`, WHICH IS THE SMALLEST
 * HONEST CHOICE.
 *
 * `P(φ)` multiplies `|1⟩` by e^{iφ} and leaves `|0⟩` alone, so `|1⟩` is an
 * eigenstate with eigenvalue e^{iφ} and nothing about the state changes when
 * you apply it. Step 1 does apply it, and the histogram does not move — which
 * is the definition of an eigenstate made visible, and the reason the number we
 * are after cannot simply be measured.
 *
 * φ = 2π × 3/8 because three counting wires resolve eighths of a turn exactly,
 * so the answer is `011` = 3 with probability 1 and there is no "about" in the
 * text until step 6, where there should be.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE ANGLES DOUBLE, AND THAT IS THE ALGORITHM.
 *
 * The wire that stands for 1 gets φ, the wire that stands for 2 gets 2φ, the
 * wire that stands for 4 gets 4φ. After that the amplitude of the counting
 * register's basis state |k⟩ carries e^{iφk} — a phase that advances by a fixed
 * step as k counts up — and the inverse Fourier transform is precisely the
 * thing that converts "advances by this much per step" into "this number".
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 * Ket order is little-endian (D1), so the printed string is `q3 q2 q1 q0`: the
 * eigenstate wire leads and the counting register is the last three characters.
 *
 *   φ = 2π × 3/8   → `1011` with probability 1          (011 = 3)
 *   φ = 2π × 0.3   → `1010` at ≈ 0.578, `1011` at ≈ 0.259, the rest spread
 *   φ = 2π × 5/8   → `1101` with probability 1          (101 = 5)
 *
 * The middle line is the one worth having in a test: the peak is at 2, which is
 * the nearest eighth below 0.3, and the two nearest values carry ≈ 84% between
 * them. That is what phase estimation does with a phase it cannot represent,
 * and it is not a failure of the circuit.
 */

import type { Lesson } from '../format'

export const QPE_SLUG = 'qpe'

/** The phase the lesson estimates: three eighths of a full turn. */
const PHI = (2 * Math.PI * 3) / 8

/** A phase no three-bit register can hold, for the honest step. */
const MESSY = 2 * Math.PI * 0.3

export const qpe: Lesson = {
  slug: QPE_SLUG,
  // "QPE" is an initialism of a phrase every language has its own form of —
  // estimación de fase, estimation de phase — so unlike Grover and BB84 the
  // title is translated, and the acronym appears in the summary as notation.
  properName: null,
  base: { qubits: 4 },
  steps: [
    {
      id: 'eigenstate',
      patch: {
        add: [
          { id: 'qp_x', gate: 'x', targets: [3], column: 0 },
          {
            id: 'qp_demo',
            gate: 'p',
            targets: [3],
            params: [PHI],
            column: 1,
          },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      // The demonstration gate comes back out: it was there to show that
      // nothing happens, and leaving it in would put a phase on the eigenstate
      // wire that the algorithm never asked for.
      id: 'ruler',
      patch: {
        remove: ['qp_demo'],
        add: [
          { id: 'qp_h0', gate: 'h', targets: [0], column: 1 },
          { id: 'qp_h1', gate: 'h', targets: [1], column: 1 },
          { id: 'qp_h2', gate: 'h', targets: [2], column: 1 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'kickback',
      patch: {
        add: [
          {
            id: 'qp_cp0',
            gate: 'cp',
            targets: [3],
            controls: [0],
            params: [PHI],
            column: 2,
          },
        ],
      },
      focus: 'amplitudes',
      objective: { kind: 'read' },
    },
    {
      id: 'doubling',
      patch: {
        add: [
          {
            id: 'qp_cp1',
            gate: 'cp',
            targets: [3],
            controls: [1],
            params: [2 * PHI],
            column: 3,
          },
          {
            id: 'qp_cp2',
            gate: 'cp',
            targets: [3],
            controls: [2],
            params: [4 * PHI],
            column: 4,
          },
        ],
      },
      focus: 'amplitudes',
      objective: { kind: 'read' },
    },
    {
      /*
       * The inverse quantum Fourier transform on the three counting wires, as
       * one block. The lesson names what it does and does not take it apart:
       * the Fourier transform is a lesson of its own, and the honest thing is
       * to say which sentence is being taken on faith rather than to bury nine
       * gates under a paragraph that pretends to have explained them.
       *
       * The `SWAP` is the part worth pointing at, and step 5's prose does: the
       * transform comes out with the wires in the opposite order to the one
       * they went in, so the last gate of the block is a relabelling.
       */
      id: 'readOut',
      patch: {
        add: [
          { id: 'qp_swap', gate: 'swap', targets: [0, 2], column: 5 },
          { id: 'qp_i0', gate: 'h', targets: [0], column: 6 },
          {
            id: 'qp_i01',
            gate: 'cp',
            targets: [1],
            controls: [0],
            params: [-Math.PI / 2],
            column: 7,
          },
          { id: 'qp_i1', gate: 'h', targets: [1], column: 8 },
          {
            id: 'qp_i02',
            gate: 'cp',
            targets: [2],
            controls: [0],
            params: [-Math.PI / 4],
            column: 9,
          },
          {
            id: 'qp_i12',
            gate: 'cp',
            targets: [2],
            controls: [1],
            params: [-Math.PI / 2],
            column: 10,
          },
          { id: 'qp_i2', gate: 'h', targets: [2], column: 11 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'awkward',
      patch: {
        remove: ['qp_cp0', 'qp_cp1', 'qp_cp2'],
        add: [
          {
            id: 'qp_cp0',
            gate: 'cp',
            targets: [3],
            controls: [0],
            params: [MESSY],
            column: 2,
          },
          {
            id: 'qp_cp1',
            gate: 'cp',
            targets: [3],
            controls: [1],
            params: [2 * MESSY],
            column: 3,
          },
          {
            id: 'qp_cp2',
            gate: 'cp',
            targets: [3],
            controls: [2],
            params: [4 * MESSY],
            column: 4,
          },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      /*
       * Five eighths of a turn, written already reduced modulo 2π: 2×(5π/4) is
       * 5π/2 and 4×(5π/4) is 5π, and both are shown here as the equivalent
       * angle inside one turn so that "show me" hands the reader values their
       * slider can actually reach. The hint says why they are equal.
       */
      id: 'yourTurn',
      patch: {
        remove: ['qp_cp0', 'qp_cp1', 'qp_cp2'],
        add: [
          {
            id: 'qp_cp0',
            gate: 'cp',
            targets: [3],
            controls: [0],
            params: [(5 * Math.PI) / 4],
            column: 2,
          },
          {
            id: 'qp_cp1',
            gate: 'cp',
            targets: [3],
            controls: [1],
            params: [Math.PI / 2],
            column: 3,
          },
          {
            id: 'qp_cp2',
            gate: 'cp',
            targets: [3],
            controls: [2],
            params: [Math.PI],
            column: 4,
          },
        ],
      },
      focus: 'histogram',
      objective: {
        kind: 'build',
        check: { kind: 'probabilities', expected: { '1101': 1 } },
      },
    },
  ],
}
