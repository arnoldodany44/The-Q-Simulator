/**
 * Superdense coding — two bits down one wire (§3.6).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES, AND WHY IT COMES AFTER TELEPORTATION.
 *
 * The same Bell pair, read backwards. Teleportation spends one shared pair and
 * two classical bits to move one qubit; this spends one shared pair and one
 * qubit to move two classical bits. Putting them in this order means the reader
 * meets the second one already knowing what a pre-shared pair costs and who
 * holds which half, so the whole lesson can be about the accounting.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE EMPTY COLUMNS ARE THE POINT.
 *
 * Two columns sit between the pair and the decoder and hold nothing until step
 * 3. That is Alice's slot: everything she does to her own qubit happens there,
 * and the message is *which gates are in those two columns*. A reader looking
 * at the canvas can see the entire protocol as "make a pair, write in the gap,
 * undo the pair", which is a shape worth handing over intact.
 *
 * It is also what makes the closing step possible: the reader adds a gate to a
 * column that is already free, rather than needing to insert one between two
 * others, which the editor has no gesture for.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 * Ket order is little-endian (D1), so the printed pair is `q1 q0` and Alice
 * holds q0 — the wire that travels:
 *
 *   nothing  → `00`      Z       → `01`
 *   X        → `10`      Z then X→ `11`   (and a single `Y`, which is `XZ` up
 *                                          to a phase, gives `11` too)
 *
 * Four gates, four messages, and the decoder is the encoder run backwards.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CLOSING STEP IS THE ACCOUNTING, AND IT IS WHERE THE NAME IS EARNED —
 * OR NOT.
 *
 * "Two bits in one qubit" is the sentence everyone repeats and it is not what
 * happened. Two qubits were sent: one in advance, before Alice knew her
 * message, and one afterwards. What the protocol shows is that the first one
 * can be sent *early*, which is a real and useful thing, and that a qubit
 * cannot carry more than one bit on its own — Holevo's bound — which is the
 * part the popular version leaves out. The catalog says so in step 6 rather
 * than letting the reader leave with a false conservation law.
 */

import type { Lesson } from '../format'

export const SUPERDENSE_CODING_SLUG = 'superdense-coding'

export const superdenseCoding: Lesson = {
  slug: SUPERDENSE_CODING_SLUG,
  // codificación superdensa, codage superdense — ordinary words (D2).
  properName: null,
  base: { qubits: 2 },
  steps: [
    {
      id: 'shared',
      patch: {
        add: [
          { id: 'sd_h', gate: 'h', targets: [0], column: 0 },
          { id: 'sd_cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
        ],
      },
      focus: 'entanglement',
      objective: { kind: 'read' },
    },
    {
      // The decoder goes in before the message does, so that columns 2 and 3
      // are visibly a gap the reader will fill.
      id: 'decoder',
      patch: {
        add: [
          { id: 'sd_dcx', gate: 'cx', targets: [1], controls: [0], column: 4 },
          { id: 'sd_dh', gate: 'h', targets: [0], column: 5 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'flip',
      patch: { add: [{ id: 'sd_e1', gate: 'x', targets: [0], column: 2 }] },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'phase',
      patch: {
        remove: ['sd_e1'],
        add: [{ id: 'sd_e1', gate: 'z', targets: [0], column: 2 }],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'both',
      patch: { add: [{ id: 'sd_e2', gate: 'x', targets: [0], column: 3 }] },
      focus: 'histogram',
      objective: {
        kind: 'build',
        check: { kind: 'probabilities', expected: { '11': 1 } },
      },
    },
    {
      id: 'accounting',
      patch: {},
      focus: 'circuit',
      objective: { kind: 'read' },
    },
  ],
}
