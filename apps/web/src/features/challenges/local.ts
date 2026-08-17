/**
 * What the browser may say about a submission before asking — Phase 3.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SERVER DECIDES. THIS SIDE ONLY DESCRIBES.
 *
 * §4 and risk 5 put the judgement on the server with the same engine, and the
 * target never reaches this process — so nothing here can compute a fidelity,
 * and nothing here is allowed to say "solved". What it computes is the part of
 * the rules that is a property of *the reader's own circuit*:
 *
 *     how many gates it has        @qsim/schema, over the expanded circuit
 *     how deep it is               the same
 *     which gates it uses          the same
 *     whether the register matches the challenge's
 *
 * Every one of those is recomputed on the server as well, and this is not
 * duplication for its own sake: it is the difference between a reader who finds
 * out they used a forbidden gate as they place it, and one who finds out after
 * a round trip. The server's copy is the one that counts; this one is the one
 * that is fast.
 *
 * The counts use the *same functions* the server calls — `gateCount`, `depth`
 * and `gatesUsed` from `@qsim/schema` — for the reason §12.1 gives about the
 * engine: two implementations of one number is how a learner comes to see "2
 * gates" on their screen and "4 gates" in their result.
 */

import { depth, gateCount, gatesUsed } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import type { Challenge } from '@qsim/contract'

export interface LocalReading {
  readonly gateCount: number
  readonly depth: number
  /** Gates used that the challenge does not allow, sorted, without repeats. */
  readonly disallowed: readonly string[]
  /** True when the circuit is on a register the challenge did not ask for. */
  readonly wrongRegister: boolean
  readonly overBudget: boolean
  /**
   * Whether anything here would stop the server accepting the submission.
   *
   * Deliberately NOT the opposite of "would pass": a circuit with none of these
   * problems may still be the wrong state, and only the server can say. This is
   * "nothing is obviously wrong yet", which is why the control it gates is
   * enabled rather than labelled correct.
   */
  readonly blocked: boolean
}

export function readLocally(
  circuit: Circuit,
  challenge: Challenge
): LocalReading {
  const gates = gateCount(circuit)
  const allowed = new Set(challenge.allowedGates)
  const disallowed =
    challenge.allowedGates.length === 0
      ? []
      : gatesUsed(circuit).filter((gate) => !allowed.has(gate))

  const wrongRegister = circuit.qubits !== challenge.qubitCount
  const overBudget = challenge.maxGates !== null && gates > challenge.maxGates

  return {
    gateCount: gates,
    depth: depth(circuit),
    disallowed,
    wrongRegister,
    overBudget,
    blocked: wrongRegister || disallowed.length > 0 || overBudget,
  }
}
