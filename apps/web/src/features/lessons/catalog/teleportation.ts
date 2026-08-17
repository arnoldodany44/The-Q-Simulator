/**
 * Teleportation — moving a state you cannot read (§3.6).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSUMES.
 *
 * Entanglement, for the pair that does the work, and superposition for the
 * Bloch arrow the whole lesson is watched on. The reader has seen that a Bell
 * pair leaves each qubit with an arrow of length zero; here that is not a
 * curiosity, it is the mechanism.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CORRECTIONS ARE CONTROLLED GATES, NOT MEASUREMENTS, AND THE LESSON SAYS
 * SO OUT LOUD.
 *
 * The protocol measures two qubits, telephones two classical bits, and applies
 * `X` and `Z` according to what arrives. This circuit replaces that with a
 * `CNOT` and a `CZ` — the principle of deferred measurement — and the two are
 * the same operation on the third qubit. What differs is *when* the randomness
 * is resolved, not what comes out.
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. **It is what the analysis panel can explain.** A mid-circuit measurement
 *      has no single final state (§5.3), so the Bloch spheres — the entire
 *      argument of this lesson, since the payoff is *seeing the arrow arrive on
 *      the third wire* — would go blank exactly where the reader needs them.
 *   2. `objectives.ts` reports `unavailable` for such a circuit, so the closing
 *      build step could not be checked at all.
 *   3. The editor can draw a conditioned gate but cannot yet build one
 *      (`presets.ts` records that limit), so a reader who wanted to experiment
 *      would be stuck.
 *
 * None of that would justify quietly teaching the wrong circuit, which is why
 * step 4 exists and does nothing except explain the substitution, name the two
 * classical bits, and say the thing every popular account of teleportation gets
 * wrong: the pair is prepared in advance, the two bits travel no faster than
 * anything else, and until they arrive the third qubit is in a state that
 * carries no information about the input at all.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PHYSICS, WRITTEN DOWN SO THE TEST CAN CHECK IT.
 *
 * With |ψ⟩ = Rz(π/4)·Ry(3π/8)|0⟩ on q0 and a Bell pair on q1, q2:
 *
 *   after the Bell basis change   q2's Bloch vector is (0, 0, 0)
 *   after the CNOT correction     q2's Bloch vector is (0, 0, 0.3827)
 *   after the CZ correction       q2's Bloch vector is q0's original,
 *                                 (0.6533, 0.6533, 0.3827), and the whole
 *                                 register is |+⟩|+⟩|ψ⟩ — a product state, so
 *                                 every entropy is zero and q0 no longer holds
 *                                 anything of what it started with.
 *
 * That last line is no-cloning, on screen: the state did not spread, it moved.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE ANGLES ARE SIXTEENTHS OF π BECAUSE THE SLIDER IS.
 *
 * 3π/8 and π/4 both sit on a stop of `ParameterEditor`'s slider, so a reader
 * who drags the input state somewhere else can drag it back exactly. An angle
 * off the grid would make "undo my experiment" a thing only the keyboard could
 * do, in the one lesson whose whole point is that the arrow on the third wire
 * copies the arrow on the first.
 */

import type { Lesson } from '../format'

export const TELEPORTATION_SLUG = 'teleportation'

export const teleportation: Lesson = {
  slug: TELEPORTATION_SLUG,
  // teletransportación, téléportation — an ordinary word, like the preset of
  // the same name.
  properName: null,
  base: { qubits: 3 },
  steps: [
    {
      id: 'payload',
      patch: {
        add: [
          {
            id: 'tp_ry',
            gate: 'ry',
            targets: [0],
            params: [(3 * Math.PI) / 8],
            column: 0,
          },
          {
            id: 'tp_rz',
            gate: 'rz',
            targets: [0],
            params: [Math.PI / 4],
            column: 1,
          },
        ],
      },
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      id: 'resource',
      patch: {
        add: [
          { id: 'tp_h', gate: 'h', targets: [1], column: 2 },
          { id: 'tp_cx', gate: 'cx', targets: [2], controls: [1], column: 3 },
        ],
      },
      focus: 'entanglement',
      objective: { kind: 'read' },
    },
    {
      id: 'mix',
      patch: {
        add: [
          { id: 'tp_cx2', gate: 'cx', targets: [1], controls: [0], column: 4 },
          { id: 'tp_h2', gate: 'h', targets: [0], column: 5 },
        ],
      },
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      // The step that keeps the lesson honest. See the header.
      id: 'twoBits',
      patch: {},
      focus: 'circuit',
      objective: { kind: 'read' },
    },
    {
      id: 'firstFix',
      patch: {
        add: [
          { id: 'tp_cx3', gate: 'cx', targets: [2], controls: [1], column: 6 },
        ],
      },
      focus: 'bloch',
      objective: { kind: 'read' },
    },
    {
      id: 'arrival',
      patch: {
        add: [
          { id: 'tp_cz', gate: 'cz', targets: [2], controls: [0], column: 7 },
        ],
      },
      focus: 'bloch',
      objective: {
        kind: 'build',
        // `state` rather than `probabilities`: the phase of the teleported
        // qubit is precisely what the reader is being asked to deliver, and a
        // distribution cannot see it. `CZ` is symmetric, so pointing it the
        // other way is the same gate and passes.
        check: { kind: 'state' },
      },
    },
  ],
}
