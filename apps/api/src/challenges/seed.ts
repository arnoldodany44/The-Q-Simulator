/**
 * Seeding the ladder — §3.6, Phase 3.
 *
 * ── A SCRIPT AND NOT A MIGRATION, AND THE REASON IS THE TARGETS ───────────
 *
 * The brief allows either. A data migration would have to carry the targets as
 * SQL literals, which is exactly the hand-transcription the catalog exists to
 * avoid: 64 amplitudes typed into a file, correct on the day they were written
 * and unverifiable afterwards. Here the targets are *computed* — every one of
 * them comes out of `@qsim/core` running the reference circuit, in the same
 * process, seconds before the write.
 *
 * The other half of the argument is convergence. A migration runs once, ever,
 * so correcting a prompt or a gate budget means another migration; this runs on
 * every release and brings the rows to whatever the catalog now says.
 *
 * ── IDEMPOTENT, AND IT NEVER DELETES ──────────────────────────────────────
 *
 * The write is an upsert keyed on the unique `slug`, so running it twice is
 * running it once. It removes nothing: a challenge dropped from the catalog
 * keeps its row, because `ChallengeSubmission` has a foreign key to it and
 * somebody earned those. A challenge that should disappear from the product
 * disappears from the client's list; the row stays.
 *
 * This is the one write in the system that touches the shared database without
 * a request behind it, so it also reports what it did — created, updated,
 * unchanged — rather than succeeding silently.
 */

import { circuitUnitary, run, runFromState, alloc } from '@qsim/core'
import type { ChallengeSeed, ChallengeRepository } from '@qsim/db'
import type { Circuit } from '@qsim/schema'

import { CHALLENGES, type ChallengeDefinition } from './catalog.js'

/** A complex number as the target JSON stores it. */
type WireComplex = [number, number]

/**
 * Rounds away the Float64 dust a simulation leaves.
 *
 * A Hadamard's 1/√2 comes back as 0.7071067811865476 and its square as
 * 0.5000000000000001 — fine for a fidelity, and noise in a stored constant. The
 * targets are rounded to twelve decimals, two orders inside D6's 1e-10
 * tolerance, so a re-seed produces byte-identical JSON and a diff of the table
 * shows only what actually changed.
 *
 * `+ 0` turns `-0` into `0`: they compare equal, and only one of them survives
 * a JSON round trip looking like what it is.
 */
function tidy(value: number): number {
  return Number(value.toFixed(12)) + 0
}

function complexAt(re: number, im: number): WireComplex {
  return [tidy(re), tidy(im)]
}

/** The target JSON for one definition, computed by running its reference. */
export function targetFor(definition: ChallengeDefinition): {
  targetType: string
  /* Typed as the column takes it, so the JSON shape is checked here rather
     than cast at the write. */
  targetData: ChallengeSeed['targetData']
  qubitCount: number
} {
  const reference: Circuit = definition.reference
  const qubitCount = reference.qubits

  switch (definition.targetType) {
    case 'state': {
      const result = run(reference)
      if (result.mode !== 'analytic') {
        throw new Error(`${definition.slug}: a state target needs a state.`)
      }
      const amplitudes: WireComplex[] = []
      for (let i = 0; i < result.state.size; i++) {
        amplitudes.push(
          complexAt(result.state.re[i] as number, result.state.im[i] as number)
        )
      }
      return {
        targetType: 'state',
        targetData: { type: 'state', qubits: qubitCount, amplitudes },
        qubitCount,
      }
    }

    case 'unitary': {
      const matrix = circuitUnitary(reference)
      const entries: WireComplex[] = []
      for (let i = 0; i < matrix.re.length; i++) {
        entries.push(complexAt(matrix.re[i] as number, matrix.im[i] as number))
      }
      return {
        targetType: 'unitary',
        targetData: { type: 'unitary', qubits: qubitCount, entries },
        qubitCount,
      }
    }

    case 'truth_table': {
      const inputs = definition.truthTableInputs
      if (inputs === null || inputs.length === 0) {
        throw new Error(
          `${definition.slug}: a truth-table target must say which basis ` +
            'inputs it checks.'
        )
      }
      const rows = inputs.map((input) => ({
        input,
        output: definiteOutcome(reference, input, definition.slug),
      }))
      return {
        targetType: 'truth_table',
        targetData: { type: 'truth_table', qubits: qubitCount, rows },
        qubitCount,
      }
    }
  }
}

/**
 * Where the reference circuit sends one basis state — and a refusal if the
 * answer is not a basis state.
 *
 * A truth table can only describe a circuit that maps basis states to basis
 * states. Deriving one from a circuit that produces a superposition would
 * silently record whichever outcome happened to be largest, and every learner
 * would then be scored against a fiction. So it is checked at seed time, where
 * a broken catalog entry stops the seed instead of shipping.
 */
function definiteOutcome(
  reference: Circuit,
  input: number,
  slug: string
): number {
  const { state } = runFromState(reference, basisState(reference.qubits, input))
  let best = 0
  let bestProbability = 0
  for (let i = 0; i < state.size; i++) {
    const re = state.re[i] as number
    const im = state.im[i] as number
    const probability = re * re + im * im
    if (probability > bestProbability) {
      bestProbability = probability
      best = i
    }
  }
  if (bestProbability < 1 - 1e-9) {
    throw new Error(
      `${slug}: input ${input} does not land on a basis state ` +
        `(largest outcome ${bestProbability.toFixed(6)}), so this challenge ` +
        'cannot have a truth-table target.'
    )
  }
  return best
}

function basisState(qubits: number, index: number) {
  const state = alloc(qubits)
  state.re[0] = 0
  state.re[index] = 1
  return state
}

/** One definition as the row it becomes. */
export function seedRowFor(
  definition: ChallengeDefinition,
  orderIndex: number
): ChallengeSeed {
  const target = targetFor(definition)
  return {
    slug: definition.slug,
    title: definition.title,
    prompt: definition.prompt,
    difficulty: definition.difficulty,
    qubitCount: target.qubitCount,
    targetType: target.targetType,
    targetData: target.targetData,
    allowedGates: definition.allowedGates,
    maxGates: definition.maxGates,
    fidelityThreshold: definition.fidelityThreshold,
    orderIndex,
  }
}

/** Every row of the ladder, targets computed, in catalog order. */
export function challengeSeedRows(): ChallengeSeed[] {
  return CHALLENGES.map((definition, index) => seedRowFor(definition, index))
}

export interface SeedReport {
  readonly created: string[]
  readonly converged: string[]
}

/**
 * Writes the whole ladder. Safe to run on every release.
 *
 * Sequential rather than concurrent: the pooler's budget for this service is
 * one connection (§12.6), nine rows take milliseconds, and a `Promise.all` here
 * would be nine statements racing for it to save nothing.
 */
export async function seedChallenges(
  repository: ChallengeRepository
): Promise<SeedReport> {
  const created: string[] = []
  const converged: string[] = []
  for (const row of challengeSeedRows()) {
    const result = await repository.upsertChallenge(row)
    if (result.created) created.push(row.slug)
    else converged.push(row.slug)
  }
  return { created, converged }
}
