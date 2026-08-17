/**
 * The ladder — §3.6, Phase 3.
 *
 * Nine challenges, ordered by difficulty, from "put one qubit in superposition"
 * to "build a Toffoli out of the gates real hardware has". It climbs on three
 * axes at once, and deliberately: one wire to three, a *state* to an
 * *operation* to a *truth table*, and a free hand to a gate set that forces the
 * identity the challenge is about.
 *
 * ════════════════════════════════════════════════════════════════════════
 * EVERY TARGET IS COMPUTED, NOT TYPED.
 *
 * Each entry carries a **reference circuit**, and the seed runs it through
 * @qsim/core to produce the target. Nobody writes an amplitude by hand, so
 * there is no transcription to get wrong, no stale target when the engine's
 * conventions are re-examined, and no possibility of a challenge whose answer
 * is unreachable — the reference circuit *is* a solution, and a test submits
 * every one of them to the validator and requires a pass.
 *
 * The reference circuit is not always the intended solution, and that is where
 * the interesting challenges live. `hadamard-conjugation` computes its target
 * from `z` while allowing only `h` and `x`, so the learner has to discover that
 * H·X·H is Z. `swap-from-cnots` computes its target from `swap` while allowing
 * only `cx`. The reference says *what* the answer must do; `allowedGates` says
 * what they may do it with, and the gap between the two is the puzzle.
 *
 * THE INVARIANT THAT MAKES THAT SAFE: whenever the reference circuit is not
 * the intended solution, the gate it is built from is ABSENT from
 * `allowedGates`. Otherwise the puzzle is "write the target out", the identity
 * it exists to teach is never forced, and the one-gate answer owns rank 1
 * forever. `catalog.test.ts` submits every reference circuit to the validator
 * and requires exactly this: a pass where the reference is a solution, and a
 * refusal naming the reference gate where it is not.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE PROSE IS NOT HERE.
 *
 * `title` and `prompt` below are the English source that goes into the two §7
 * columns, for an operator reading the table. They never reach a browser: D2
 * puts every user-facing word in `apps/web`'s three catalogs, keyed by the same
 * slug. See the header of `@qsim/contract`'s `challenges.ts`.
 */

import { CHALLENGE_SLUGS } from '@qsim/contract'
import type { ChallengeSlug } from '@qsim/contract'
import {
  CIRCUIT_SCHEMA_VERSION,
  type Circuit,
  type Operation,
} from '@qsim/schema'

export interface ChallengeDefinition {
  readonly slug: ChallengeSlug
  /** English source for the §7 column. Never sent to a client. */
  readonly title: string
  readonly prompt: string
  readonly difficulty: number
  readonly targetType: 'state' | 'unitary' | 'truth_table'
  /**
   * A circuit that produces the target. The seed runs it; nothing here is a
   * literal amplitude.
   */
  readonly reference: Circuit
  /**
   * Which basis inputs a truth-table challenge checks. `null` for the other
   * two kinds, and "every basis state" is spelled out rather than defaulted —
   * a table's scope is the one thing about it a reader has to be told.
   */
  readonly truthTableInputs: readonly number[] | null
  readonly allowedGates: readonly string[]
  /**
   * The gate ceiling, and it is deliberately a little above the best known
   * answer rather than equal to it.
   *
   * A budget equal to the optimum makes the leaderboard pointless: every
   * passing submission ties at the only length that passes, and §3.6's "fewest
   * gates, least depth" ranks nothing. Slack is what separates the two jobs —
   * the ceiling bounds the search so a brute-force pile of gates cannot pass,
   * and the ranking is what rewards the elegant answer.
   */
  readonly maxGates: number | null
  readonly fidelityThreshold: number
}

function op(
  id: string,
  gate: string,
  targets: number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate, targets, column, ...extra }
}

function circuit(qubits: number, operations: Operation[]): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  }
}

/** Every basis index of an n-qubit register, in order. */
function allBasisStates(qubits: number): number[] {
  return Array.from({ length: 2 ** qubits }, (_value, index) => index)
}

/**
 * The nine, in ladder order. `orderIndex` is the position in this array, so
 * the array *is* the curriculum and there is no second place to keep in step.
 */
export const CHALLENGES: readonly ChallengeDefinition[] = [
  {
    slug: 'superposition',
    title: 'A coin in the air',
    prompt:
      'Put the single qubit into an equal superposition of |0> and |1>, so ' +
      'that measuring it gives each outcome half the time.',
    difficulty: 1,
    targetType: 'state',
    reference: circuit(1, [op('ref1', 'h', [0], 0)]),
    truthTableInputs: null,
    allowedGates: ['h', 'x', 'z', 's', 'sdg', 't', 'tdg'],
    maxGates: 3,
    fidelityThreshold: 0.99,
  },
  {
    slug: 'minus-state',
    /*
     * The second challenge is the first one with a phase in it, on purpose:
     * |+> and |-> have identical histograms and are different states, which is
     * the fact the whole design system is built around (§10).
     */
    title: 'The same halves, the other sign',
    prompt:
      'Produce the state (|0> - |1>)/sqrt(2). Its probabilities are the same ' +
      'as the previous challenge; its phase is not.',
    difficulty: 1,
    targetType: 'state',
    reference: circuit(1, [op('ref1', 'x', [0], 0), op('ref2', 'h', [0], 1)]),
    truthTableInputs: null,
    allowedGates: ['h', 'x', 'z', 's', 'sdg', 't', 'tdg'],
    maxGates: 4,
    fidelityThreshold: 0.99,
  },
  {
    slug: 'bell-pair',
    title: 'Two qubits, one answer',
    prompt:
      'Produce the entangled state (|00> + |11>)/sqrt(2): two qubits that ' +
      'each look random on their own and always agree with each other.',
    difficulty: 2,
    targetType: 'state',
    reference: circuit(2, [
      op('ref1', 'h', [0], 0),
      op('ref2', 'cx', [1], 1, { controls: [0] }),
    ]),
    truthTableInputs: null,
    allowedGates: ['h', 'x', 'z', 'cx', 'cz'],
    maxGates: 4,
    fidelityThreshold: 0.99,
  },
  {
    slug: 'ghz-three',
    title: 'All three at once',
    prompt: 'Extend the Bell pair to three qubits: (|000> + |111>)/sqrt(2).',
    difficulty: 2,
    targetType: 'state',
    reference: circuit(3, [
      op('ref1', 'h', [0], 0),
      op('ref2', 'cx', [1], 1, { controls: [0] }),
      op('ref3', 'cx', [2], 2, { controls: [0] }),
    ]),
    truthTableInputs: null,
    allowedGates: ['h', 'cx'],
    maxGates: 5,
    fidelityThreshold: 0.99,
  },
  {
    slug: 'y-eigenstate',
    title: 'A quarter turn',
    prompt:
      'Produce the state (|0> + i|1>)/sqrt(2). Same probabilities again, and ' +
      'a phase a quarter of the way round the circle.',
    difficulty: 2,
    targetType: 'state',
    reference: circuit(1, [op('ref1', 'h', [0], 0), op('ref2', 's', [0], 1)]),
    truthTableInputs: null,
    allowedGates: ['h', 'x', 'z', 's', 'sdg', 't', 'tdg'],
    maxGates: 4,
    fidelityThreshold: 0.99,
  },
  {
    /*
     * The first challenge whose target is an OPERATION rather than a state,
     * and the first whose reference circuit is not a legal solution: the
     * target is computed from `z`, and `z` is not in the allowed set.
     */
    slug: 'hadamard-conjugation',
    title: 'Z without a Z',
    prompt:
      'Build the Z gate using only H and X. A state target could not ask ' +
      'this: what is being compared is what your circuit does to every input, ' +
      'not just to |0>.',
    difficulty: 3,
    targetType: 'unitary',
    reference: circuit(1, [op('ref1', 'z', [0], 0)]),
    truthTableInputs: null,
    allowedGates: ['h', 'x'],
    maxGates: 5,
    fidelityThreshold: 0.99,
  },
  {
    /*
     * The rule is `allowedGates`, or it is not a rule.
     *
     * This challenge used to compute its target from `cx` and then allow `cx`,
     * so the answer was to write the target gate out — one gate, fidelity 1,
     * and permanent ownership of rank 1 over everybody who did the exercise.
     * The prompt said "using CNOTs that run the other way", but a prompt never
     * reaches the server (see THE PROSE IS NOT HERE below), and a rule the
     * server cannot see is not a rule. Both directions of a CNOT are spelled
     * `cx`, so no allowed set containing `cx` can force the identity.
     *
     * `cz` can. A `CZ` is symmetric and has no direction at all, so the
     * Hadamards are the entire content of the answer: H(q0)·CZ·H(q0) is the
     * CNOT pointing from qubit 1 to qubit 0, and conjugating the *other* wire
     * gives the CNOT pointing the other way. That is the same lesson — a
     * Hadamard exchanges X and Z, and that is what decides which way the arrow
     * points — and now the server enforces it.
     */
    slug: 'cnot-reversed',
    title: 'Turn the arrow around',
    prompt:
      'Build a CNOT whose control is qubit 1 and whose target is qubit 0, ' +
      'using a CZ and Hadamards. A CZ has no arrow; the Hadamards are what ' +
      'decide which way the CNOT points.',
    difficulty: 3,
    targetType: 'unitary',
    reference: circuit(2, [op('ref1', 'cx', [0], 0, { controls: [1] })]),
    truthTableInputs: null,
    allowedGates: ['h', 'cz'],
    maxGates: 5,
    fidelityThreshold: 0.99,
  },
  {
    slug: 'swap-from-cnots',
    title: 'Exchange, with nothing to exchange with',
    prompt:
      'Swap two qubits using CNOT gates alone. Real hardware often has no ' +
      'SWAP, and this is what it does instead.',
    difficulty: 4,
    targetType: 'unitary',
    reference: circuit(2, [op('ref1', 'swap', [0, 1], 0)]),
    truthTableInputs: null,
    allowedGates: ['cx'],
    maxGates: 5,
    fidelityThreshold: 0.99,
  },
  {
    slug: 'toffoli-truth-table',
    title: 'A classical gate, built from quantum ones',
    prompt:
      'Flip qubit 2 exactly when qubits 0 and 1 are both 1, using only H, T, ' +
      'T-dagger and CNOT. This one is scored on the eight basis inputs: it ' +
      'asks what your circuit does to definite bits, and nothing about phases.',
    difficulty: 5,
    targetType: 'truth_table',
    reference: circuit(3, [op('ref1', 'ccx', [2], 0, { controls: [0, 1] })]),
    truthTableInputs: allBasisStates(3),
    allowedGates: ['h', 't', 'tdg', 'cx'],
    /*
     * The standard decomposition is six CNOTs, seven T/T† and two Hadamards —
     * fifteen. The budget is a little above it for the reason every budget
     * here is (see `maxGates` on the interface): the ceiling bounds the search
     * and the leaderboard rewards the minimum.
     */
    maxGates: 18,
    fidelityThreshold: 0.99,
  },
]

/**
 * The catalog and the published vocabulary are the same list, in the same
 * order.
 *
 * Asserted at module load rather than in a test alone: `CHALLENGE_SLUGS` is
 * what `apps/web` builds its prose keys from, so a catalog that drifted from it
 * would seed a challenge nobody can read the title of. Failing here means the
 * seed refuses to run, which is the right moment to find out.
 */
if (
  CHALLENGES.length !== CHALLENGE_SLUGS.length ||
  CHALLENGES.some((entry, index) => entry.slug !== CHALLENGE_SLUGS[index])
) {
  throw new Error(
    'The challenge catalog and CHALLENGE_SLUGS disagree. The contract list is ' +
      'what apps/web keys its prose on; they must be the same slugs in the ' +
      'same order.'
  )
}
