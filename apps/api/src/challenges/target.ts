/**
 * What a challenge is asking for — §3.6, and the one column that never leaves
 * this process.
 *
 * `Challenge.targetData` is `Json` in Postgres and `unknown` on the way out of
 * `@qsim/db`, which is deliberate: the persistence layer has no opinion about
 * physics (see the boundary rule `db-depends-only-on-schema`). This module is
 * where it becomes a shape, and it lives beside the validator that consumes it
 * rather than in `@qsim/contract`, because the target is the one thing the wire
 * must never carry. A schema in the shared package would be a schema the
 * browser bundle imports, and the next step after that is a response field.
 *
 * ── THE THREE KINDS, AND WHY EACH IS STORED THE WAY IT IS ─────────────────
 *
 * **state** — 2ⁿ amplitudes, in the little-endian index order D1 fixes, so
 * entry `i` is the amplitude of the basis state whose qubit q is `(i >> q) & 1`.
 * Stored as `[re, im]` pairs rather than two arrays: a pair survives being read
 * by a human in a database client, and 2ⁿ is small.
 *
 * **unitary** — 4ⁿ entries in the same column-major order `@qsim/core`'s
 * `Unitary` uses, so column `c` (the contiguous run at `c * 2ⁿ`) is the image
 * of the basis state |c⟩. Capped far below the state cap, because a unitary is
 * the square of a state: see `MAX_UNITARY_TARGET_QUBITS`.
 *
 * **truth_table** — a list of (input, output) basis indices. NOT a complete
 * function: a challenge may list a subset, and the rows it lists are exactly
 * the rows that are checked. That is a real limitation and the validator says
 * so out loud rather than leaving it implicit — see `basis-states-only` in
 * `feedback.ts`, and the long argument in `validate.ts` about why a truth table
 * cannot pin down an operation.
 *
 * ── EVERY TARGET IS PARSED, EVERY TIME ────────────────────────────────────
 *
 * A row could have been written by an older seed, by a hand-edited `UPDATE`, or
 * by a migration that has not run. `parseChallengeTarget` refuses anything it
 * cannot read rather than handing the engine a ragged array — which would
 * either throw somewhere unrecognisable or, worse, compare against a state
 * shorter than the register and quietly call everybody wrong.
 *
 * ── AND THE SHAPE IS NOT THE WHOLE CHECK ──────────────────────────────────
 *
 * Quietly calling everybody *right* is the failure that matters more, and it
 * is not a shape error. `stateFidelity` is |⟨ψ|φ⟩|² and does not normalise, so
 * a state target scaled by k reports k² times the true fidelity — and
 * `clampFidelity` in the validator then caps the impossible number at 1, which
 * turns a corrupted row into a challenge that passes every submission.
 * `unitaryFidelity` behaves the same way for a matrix that is not unitary.
 *
 * So the physics is checked here too, to D6's tolerance: a state target must
 * have norm 1, and a unitary target must satisfy U†U = I. Both are properties
 * of the stored row rather than of any request, which is why they belong in
 * the parser rather than in the comparison.
 */

import { MAX_UNITARY_QUBITS } from '@qsim/core'
import { z } from 'zod'

/**
 * The widest register a challenge may name.
 *
 * Six qubits is 64 amplitudes and a puzzle nobody solves by accident; §3.6's
 * challenges are teaching pieces on one to three wires. The ceiling exists so
 * that a hand-written row cannot ask this process to allocate something large,
 * and it is checked before any array is read.
 */
export const MAX_CHALLENGE_QUBITS = 6

/**
 * The widest register a *unitary* target may name.
 *
 * A unitary is 4ⁿ entries where a state is 2ⁿ, and building one costs 2ⁿ runs
 * of the submitted circuit. Four qubits is 256 entries and 16 runs; six would
 * be 4096 entries and a JSON column of some hundred kilobytes for a puzzle that
 * would be unreadable anyway. Bounded by `MAX_UNITARY_QUBITS` as well, so this
 * constant can never promise something the engine refuses to build.
 */
export const MAX_UNITARY_TARGET_QUBITS = Math.min(4, MAX_UNITARY_QUBITS)

/** One complex number, as `[re, im]`. Finite, because a NaN is not a target. */
const ComplexSchema = z.tuple([z.number().finite(), z.number().finite()])

const QubitsSchema = z.int().min(1).max(MAX_CHALLENGE_QUBITS)

/**
 * D6's tolerance, applied to a stored target rather than to a computation.
 *
 * The seed writes these by running a circuit through @qsim/core, so a genuine
 * row is normalised to a few ulps; anything outside this is a row that was not
 * written that way.
 */
const TOLERANCE = 1e-10

/** Whether a list of `[re, im]` pairs has ‖·‖ = 1. */
function isNormalised(amplitudes: readonly (readonly [number, number])[]) {
  let total = 0
  for (const pair of amplitudes) {
    const [re, im] = pair
    total += re * re + im * im
  }
  return Math.abs(total - 1) <= TOLERANCE
}

/**
 * Whether the column-major entries really are a unitary: U†U = I.
 *
 * Every pair of columns, because normalising each one on its own would accept
 * a matrix whose columns are parallel — which maps two basis states onto the
 * same image and is not an operation any circuit performs.
 */
function isUnitary(
  entries: readonly (readonly [number, number])[],
  qubits: number
) {
  const dim = 2 ** qubits
  // The count refinement above may have failed already — Zod runs every
  // refinement on the object rather than stopping at the first — so this one
  // must survive a short array rather than index past its end.
  if (entries.length !== dim * dim) return false
  for (let a = 0; a < dim; a++) {
    for (let b = a; b < dim; b++) {
      let re = 0
      let im = 0
      for (let row = 0; row < dim; row++) {
        const [ar, ai] = entries[a * dim + row] as [number, number]
        const [br, bi] = entries[b * dim + row] as [number, number]
        // ⟨column a | column b⟩, so column a is the one conjugated.
        re += ar * br + ai * bi
        im += ar * bi - ai * br
      }
      const wanted = a === b ? 1 : 0
      if (Math.abs(re - wanted) > TOLERANCE || Math.abs(im) > TOLERANCE) {
        return false
      }
    }
  }
  return true
}

const StateTargetSchema = z
  .object({
    type: z.literal('state'),
    qubits: QubitsSchema,
    amplitudes: z.array(ComplexSchema).min(2),
  })
  .refine((target) => target.amplitudes.length === 2 ** target.qubits, {
    message: 'A state target needs exactly 2^qubits amplitudes.',
  })
  /*
   * See the header. An un-normalised target inflates every fidelity, and the
   * validator's clamp then turns the overflow into a pass for everybody.
   */
  .refine((target) => isNormalised(target.amplitudes), {
    message: 'A state target must have norm 1.',
  })

const UnitaryTargetSchema = z
  .object({
    type: z.literal('unitary'),
    qubits: z.int().min(1).max(MAX_UNITARY_TARGET_QUBITS),
    /** Column-major, matching `@qsim/core`'s `Unitary`. */
    entries: z.array(ComplexSchema).min(4),
  })
  .refine((target) => target.entries.length === 4 ** target.qubits, {
    message: 'A unitary target needs exactly 4^qubits entries.',
  })
  .refine((target) => isUnitary(target.entries, target.qubits), {
    message: 'A unitary target must satisfy U†U = I.',
  })

const TruthTableRowSchema = z.object({
  /** A basis index, little-endian like every other index in this system. */
  input: z.int().min(0),
  output: z.int().min(0),
})

const TruthTableTargetSchema = z
  .object({
    type: z.literal('truth_table'),
    qubits: QubitsSchema,
    rows: z.array(TruthTableRowSchema).min(1),
  })
  .refine(
    (target) =>
      target.rows.every(
        (row) =>
          row.input < 2 ** target.qubits && row.output < 2 ** target.qubits
      ),
    { message: 'A truth-table row names a basis state outside the register.' }
  )
  .refine(
    (target) =>
      new Set(target.rows.map((row) => row.input)).size === target.rows.length,
    { message: 'A truth table names the same input twice.' }
  )

/**
 * The union, discriminated by `type`.
 *
 * `type` is carried inside the JSON as well as in the `targetType` column, and
 * `parseChallengeTarget` checks the two agree. They are written by the same
 * seed, so a disagreement is a corrupted row rather than a request — but a
 * corrupted row that read as a *different kind* of target would compare a state
 * against a matrix and answer a fidelity, which is the sort of wrong answer
 * nobody notices.
 */
export const ChallengeTargetSchema = z.discriminatedUnion('type', [
  StateTargetSchema,
  UnitaryTargetSchema,
  TruthTableTargetSchema,
])

export type ChallengeTarget = z.infer<typeof ChallengeTargetSchema>
export type StateTarget = z.infer<typeof StateTargetSchema>
export type UnitaryTarget = z.infer<typeof UnitaryTargetSchema>
export type TruthTableTarget = z.infer<typeof TruthTableTargetSchema>

/** A stored target this process cannot read. Always a 5xx, never a 4xx. */
export class ChallengeTargetError extends Error {
  readonly slug: string

  constructor(slug: string, detail: string) {
    super(`The target stored for challenge "${slug}" is unreadable: ${detail}`)
    this.name = 'ChallengeTargetError'
    this.slug = slug
  }
}

/**
 * Reads one stored target, or throws.
 *
 * Takes the `targetType` column as well as the JSON, and requires them to
 * agree — see the note on the union above.
 */
export function parseChallengeTarget(input: {
  slug: string
  targetType: string
  targetData: unknown
}): ChallengeTarget {
  const parsed = ChallengeTargetSchema.safeParse(input.targetData)
  if (!parsed.success) {
    throw new ChallengeTargetError(
      input.slug,
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
        .join('; ')
    )
  }
  if (parsed.data.type !== input.targetType) {
    throw new ChallengeTargetError(
      input.slug,
      `the row says ${input.targetType} and the JSON says ${parsed.data.type}`
    )
  }
  return parsed.data
}
