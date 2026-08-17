/**
 * Entanglement — the second lesson (§3.6, §15's "estados producto vs.
 * entrelazados, entropía de von Neumann").
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES, AND WHAT IT ARGUES.
 *
 * It assumes superposition: the reader has watched a full-length Bloch arrow
 * on the equator and been told that a *short* arrow is what ignorance looks
 * like. This lesson spends that. Two qubits go into a Bell pair, both arrows
 * shrink to nothing, and the reader is looking at a state that is perfectly
 * known as a pair and completely unknown as two qubits — which is the whole
 * definition of entanglement, drawn rather than asserted.
 *
 * The belief being taken apart here is the one every reader arrives with and
 * that no histogram alone can refute: **that the pair is just a shared coin.**
 * Two bars at `|00⟩` and `|11⟩` are exactly what you would see if a machine had
 * flipped a coin and printed the answer twice, and nothing in that picture says
 * otherwise. So the argument is step 6, and it is the reason this lesson exists
 * in this order:
 *
 *   turn *both* qubits with an `H` before reading, and the correlation survives.
 *
 * A shared coin does not do that. Mixing `|00⟩` and `|11⟩` fifty-fifty and then
 * applying `H` to each side gives all four outcomes at a quarter — the
 * correlation is destroyed by the change of basis, because it only ever existed
 * in one basis. A Bell pair is correlated in *every* basis, `H⊗H|Φ+⟩ = |Φ+⟩`
 * exactly, and the histogram still shows two bars. That is a fact the reader
 * can see in three seconds and that a classical story cannot reproduce, and it
 * is the same fact Bell's theorem is built on.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 *   |00⟩ →H(q0)→ (|00⟩+|01⟩)/√2 →CNOT→ (|00⟩+|11⟩)/√2 →H⊗H→ (|00⟩+|11⟩)/√2
 *
 * with S(q0) = 1 bit from the CNOT onward, and every Bloch vector of length
 * zero from the CNOT onward. `lessons.test.ts` asserts all four.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE OBJECTIVE ASKS FOR ANTI-CORRELATION, NOT FOR ENTANGLEMENT.
 *
 * `entangled` is the check this lesson looks like it wants, and it is the wrong
 * one here: the circuit the reader arrives holding is *already* a Bell pair, so
 * an entropy threshold would report "done" before they touched anything. What
 * the closing step asks instead is for the two qubits to *disagree* — one gate,
 * any of `X`, `Y`, or an `X` on either wire — which is a change the reader has
 * to make and which the histogram answers immediately. `probabilities` because
 * the phase of the result is not part of the question.
 */

import type { Lesson } from '../format'

export const ENTANGLEMENT_SLUG = 'entanglement'

export const entanglement: Lesson = {
  slug: ENTANGLEMENT_SLUG,
  // entrelazamiento, intrication — an ordinary word in each language, so the
  // title lives in the catalogs (D2).
  properName: null,
  base: { qubits: 2 },
  steps: [
    {
      id: 'twoWires',
      patch: {},
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'separate',
      patch: { add: [{ id: 'en_h', gate: 'h', targets: [0], column: 0 }] },
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      id: 'link',
      patch: {
        add: [
          { id: 'en_cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'noArrows',
      patch: {},
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      id: 'oneBit',
      patch: {},
      focus: 'entanglement',
      objective: { kind: 'read' },
    },
    {
      // The step the lesson is for: the same correlation, in a second basis.
      id: 'turnBoth',
      patch: {
        add: [
          { id: 'en_h0', gate: 'h', targets: [0], column: 2 },
          { id: 'en_h1', gate: 'h', targets: [1], column: 2 },
        ],
      },
      focus: 'histogram',
      objective: { kind: 'read' },
    },
    {
      id: 'disagree',
      patch: { add: [{ id: 'en_x', gate: 'x', targets: [0], column: 3 }] },
      focus: 'histogram',
      objective: {
        kind: 'build',
        check: {
          kind: 'probabilities',
          expected: { '01': 0.5, '10': 0.5 },
        },
      },
    },
  ],
}
