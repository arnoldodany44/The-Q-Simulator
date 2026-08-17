/**
 * How a lesson step names its circuit: as the difference from the step
 * before it (§3.6, Phase 3).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY A DIFF AND NOT A WHOLE CIRCUIT PER STEP.
 *
 * Three shapes were possible and each answers a different question.
 *
 *   - **Inline JSON per step.** Every step carries a complete `Circuit`. It is
 *     the easiest to implement and the worst to read: a nine-step lesson is
 *     nine near-identical documents, the change between two of them is
 *     something the reader of the *source* has to compute by eye, and the day
 *     somebody renames a qubit in step 2 the other eight quietly disagree.
 *   - **A preset id per step.** Steps point at `presets.ts`. That works only
 *     while a lesson happens to walk through circuits somebody already needed
 *     for the landing page, and it inverts the dependency: the examples exist
 *     to be a menu, and a lesson is a sequence.
 *   - **A diff from the previous step**, which is what this file implements.
 *
 * The diff wins because it makes the *prose* and the *data* say the same
 * thing. A step whose text is "now add a CNOT" has `add: [cx]` beside it and
 * nothing else; a reviewer checking the translation against the circuit is
 * comparing one sentence with one line. It is also what makes the player able
 * to *show* the change — the step applies its patch to the circuit already on
 * screen, so the reader watches a gate appear on the canvas they were looking
 * at, rather than watching the whole document be replaced.
 *
 * ────────────────────────────────────────────────────────────────────────
 * A PATCH IS TOTAL, AND FOLDING IT FROM ZERO IS ALWAYS AVAILABLE.
 *
 * `applyPatch` never throws and never half-applies: it builds the whole next
 * circuit and validates it with the same `validateCircuit` the editor and the
 * API use, so a patch that would produce an impossible document is refused
 * with the contract's own issues rather than accepted into the store.
 *
 * That matters because the reader is *also* editing. A build step hands the
 * canvas over — the reader may put a gate exactly where the next step's patch
 * meant to put one, or delete the wire it names — so applying a patch forward
 * is a thing that can legitimately fail. `foldPatches` is the repair: the
 * circuit at step *n* is the fold of patches 0…n from the empty register, it
 * needs nothing but the lesson itself, and the player falls back to it
 * whenever the forward patch is refused. See `LessonPlayer.tsx` for the
 * navigation rule this supports.
 *
 * ────────────────────────────────────────────────────────────────────────
 * REMOVE RUNS BEFORE ADD, SO REPLACEMENT IS ONE PATCH.
 *
 * "Change the Rz angle" and "swap this H for an X" are the same edit written
 * as `remove: ['op_h']` plus `add: [{ id: 'op_h', … }]`. If add ran first the
 * contract would reject it as a duplicate id halfway through an operation the
 * lesson author reasonably thinks of as one change.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  emptyCircuit,
  validateCircuit,
  type Circuit,
  type Operation,
  type ValidationIssue,
} from '@qsim/schema'

/**
 * A change to a circuit, expressed the way a lesson sentence expresses it.
 *
 * Every field is optional, and a patch with none of them is the identity —
 * which is the honest spelling of a step that only says something about the
 * circuit already on screen ("look at the phase of the second bar").
 */
export interface CircuitPatch {
  /** Resize the quantum register. Shrinking is refused if a gate is on it. */
  readonly qubits?: number
  /** Resize the classical register. */
  readonly clbits?: number
  /** Operation ids to take out, applied before `add` — see the header. */
  readonly remove?: readonly string[]
  /** Operations to put in. Ids are the lesson's, and they must be stable. */
  readonly add?: readonly Operation[]
}

export type PatchResult =
  | { readonly ok: true; readonly circuit: Circuit }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

/** The register a lesson starts from before its first patch runs. */
export function lessonBaseCircuit(qubits = 1, clbits = 0): Circuit {
  return emptyCircuit(qubits, clbits)
}

/**
 * The circuit `patch` describes, given the one before it.
 *
 * The result is validated, so a caller that gets `ok: true` holds a document
 * the editor store, the engine and the API would each accept unchanged.
 */
export function applyPatch(circuit: Circuit, patch: CircuitPatch): PatchResult {
  const removed = new Set(patch.remove ?? [])
  const kept = circuit.operations.filter(
    (operation) => !removed.has(operation.id)
  )

  const next = {
    ...circuit,
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: patch.qubits ?? circuit.qubits,
    clbits: patch.clbits ?? circuit.clbits,
    operations: [...kept, ...(patch.add ?? [])],
  } satisfies Circuit

  /*
   * `qubitLabels` is sized by the register, so a resize that left it alone
   * would produce a `qubit-label-count` issue nobody wrote. Trimmed rather
   * than padded: the contract allows the array to be absent, and a label the
   * lesson never chose is better absent than invented.
   */
  const labels = next.qubitLabels
  if (labels !== undefined && labels.length !== next.qubits) {
    if (next.qubits < labels.length) {
      next.qubitLabels = labels.slice(0, next.qubits)
    } else {
      delete (next as { qubitLabels?: readonly string[] }).qubitLabels
    }
  }

  const issues = validateCircuit(next)
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, circuit: next }
}

/**
 * The circuit a lesson stands at after `patches` have all been applied to
 * `base`, or the first refusal.
 *
 * This is the lesson's own answer, computed from the lesson alone, and it is
 * what the player falls back to when the reader's document has drifted too
 * far for a forward patch to land. It is also what a test uses to assert that
 * every step of every lesson really produces a contract-valid circuit —
 * a lesson whose step 4 cannot be built is a lesson nobody finds broken until
 * a reader reaches step 4.
 */
export function foldPatches(
  base: Circuit,
  patches: readonly CircuitPatch[]
): PatchResult {
  let circuit = base
  for (const patch of patches) {
    const result = applyPatch(circuit, patch)
    if (!result.ok) return result
    circuit = result.circuit
  }
  return { ok: true, circuit }
}
