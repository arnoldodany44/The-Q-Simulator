/**
 * What travels on the queue, and how two submissions of the same work are
 * recognised as one.
 *
 * ── The payload is validated on the way *out* of Redis, not only in ───────
 *
 * `apps/api` builds this object and `apps/worker` consumes it, and the worker
 * parses it again with the schema below before it touches anything. That is
 * not belt-and-braces about a bug in the producer. A job in Redis is a job
 * that anything holding the connection string can enqueue, and the process
 * that spends the CPU is the one that has to be sure — the same reason
 * `checkLimits` runs twice and `parseCircuit` runs twice. §11's sentence is
 * that a circuit is validated *before the engine ever sees it*, and the engine
 * lives in the worker.
 *
 * ── The circuit rides whole, and does not ride by reference ───────────────
 *
 * `circuitId` is attribution — which stored circuit this run is *about*, used
 * for the visibility check on the way back out. The document itself travels in
 * the payload. Two reasons: a run may be over a circuit that was never saved
 * (the editor's "run this on the server" has no row behind it), and a run must
 * describe the circuit as it was at submission — a version appended while the
 * job sat in the queue must not change what the job computes. A job that
 * re-read the circuit at execution time would be a run whose answer depends on
 * when it happened to be picked up.
 *
 * ── Determinism, in full ──────────────────────────────────────────────────
 *
 * `seed` is required, not optional. A sampled run with no seed is a run whose
 * result cannot be reproduced, which makes it useless as an authoritative
 * answer (§4's second reason for the server to exist at all) and makes
 * deduplication a lie — two submissions of "the same work" would not be the
 * same work. The API mints one when the caller does not supply one, and it
 * travels in the payload and comes back in the result.
 */

import { NOISE_PROFILE_IDS, type NoiseProfileId } from '@qsim/core'
import {
  CircuitSchema,
  MAX_EXPANDED_OPERATIONS,
  safeExpandCircuit,
  type Circuit,
} from '@qsim/schema'
import { z } from 'zod'
import { MAX_SHOTS, MIN_SHOTS } from './limits.js'
import { SIMULATION_MODES, type SimulationMode } from './run.js'

/**
 * Bound on every identifier that reaches a Redis key or a Postgres column.
 *
 * A cuid2 is 24 characters and a nanoid slug is 21; this is a cheap gate that
 * stops a kilobyte of "run id" from becoming a key, not a statement about
 * either format.
 */
export const MAX_IDENTIFIER_LENGTH = 64

const IdentifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH)

/**
 * `seed` is a 32-bit integer because `createRng` expands one into xoshiro's
 * state. Anything wider would be silently truncated somewhere, which is the
 * one thing a seed may never be.
 */
export const MAX_SEED = 0xffffffff

/**
 * The noise profile, by id and by id only.
 *
 * A `NoiseProfile` is eight numbers that become Kraus operators, and
 * `validateProfile` exists precisely because not every eight numbers are a
 * physical device — T2 > 2·T1 is rejected rather than clamped. Accepting a
 * custom profile from a request would mean accepting a stranger's numbers into
 * a channel builder, and `custom` is in `NOISE_PROFILE_IDS` for the editor's
 * own use rather than for the wire. So the queue takes one of the presets, and
 * the profile itself is looked up in the worker from `NOISE_PROFILES`.
 * User-defined device profiles arrive with the milestone that has somewhere to
 * store them.
 */
const PRESET_PROFILE_IDS = NOISE_PROFILE_IDS.filter((id) => id !== 'custom')

export const NoiseProfileIdSchema = z.enum(
  PRESET_PROFILE_IDS as unknown as [NoiseProfileId, ...NoiseProfileId[]]
)

export const SimulationJobPayloadSchema = z.object({
  /** The `SimulationRun` row this job writes its answer into. */
  runId: IdentifierSchema,
  /**
   * The document, in full. Shape only — `parseCircuit` in the worker is what
   * applies the thirteen rules a shape cannot express (two gates fighting over
   * one qubit in one column, a control on a qubit the gate also targets), and
   * §11 requires that to happen before the engine sees it.
   */
  circuit: CircuitSchema,
  mode: z.enum(
    SIMULATION_MODES as unknown as [SimulationMode, ...SimulationMode[]]
  ),
  /**
   * Shots, or `null` for a mode that draws none.
   *
   * Meaningful in two different ways depending on the mode, which is why it is
   * one nullable field rather than two: for `TRAJECTORIES` it is how many
   * times the circuit is re-run, and for `STATEVECTOR` it is how many draws are
   * taken from the one final state (§5.3). `DENSITY_MATRIX` is exact and takes
   * `null`.
   */
  shots: z.number().int().min(MIN_SHOTS).max(MAX_SHOTS).nullable(),
  seed: z.number().int().min(0).max(MAX_SEED),
  noiseProfileId: NoiseProfileIdSchema.nullable(),
  /**
   * Corrupt the outcome with the profile's readout error.
   *
   * On the wire rather than defaulted in the worker, because it changes the
   * answer: readout error is the largest single term in most hardware
   * histograms, and a result that silently included or excluded it would not be
   * comparable with the one the browser drew.
   */
  readout: z.boolean(),
  /** The verified `sub` of whoever submitted, or `null` for an anonymous run. */
  submittedBy: IdentifierSchema.nullable(),
  /** The stored circuit this run is about, or `null`. Attribution, not input. */
  circuitId: IdentifierSchema.nullable(),
})

export type SimulationJobPayload = z.infer<typeof SimulationJobPayloadSchema>

/** Parses an untrusted payload, throwing `ZodError` on anything unexpected. */
export function parseJobPayload(input: unknown): SimulationJobPayload {
  return SimulationJobPayloadSchema.parse(input)
}

/* ─────────────────────────── deduplication ──────────────────────────── */

/**
 * The fields that decide the *answer*, in a stable textual form.
 *
 * Everything that changes the result is in here and nothing else is. `runId`
 * is deliberately absent — it is the identity of the request, and two requests
 * for identical work are what this function exists to collapse.
 *
 * `submittedBy` and `circuitId` *are* in, and neither is about arithmetic:
 *
 *   - `submittedBy`, because a `SimulationRun` belongs to somebody and reading
 *     one obeys the same visibility rules as everything else. Sharing a row
 *     between two callers because their circuits happened to be identical would
 *     hand the second caller a run the first one owns.
 *   - `circuitId`, because it is what the read filter joins through. A run
 *     attributed to a PUBLIC circuit and a run attributed to a PRIVATE one are
 *     not interchangeable even when the documents are byte-identical.
 *
 * Returns a string rather than a digest because hashing needs a platform
 * primitive and this package has none by design (§12.3 rule 2): `apps/api`
 * feeds this to `node:crypto`. Keeping the canonicalisation here and the
 * hashing there is also what makes the interesting half testable without a
 * runtime.
 */
export function canonicalWork(
  payload: Omit<SimulationJobPayload, 'runId'>
): string {
  return canonicalJson({
    circuit: payload.circuit,
    circuitId: payload.circuitId,
    mode: payload.mode,
    noiseProfileId: payload.noiseProfileId,
    readout: payload.readout,
    seed: payload.seed,
    shots: payload.shots,
    submittedBy: payload.submittedBy,
  })
}

/**
 * `JSON.stringify` with object keys in sorted order, recursively.
 *
 * Necessary because the input is JSON that came off the wire, and key order in
 * a JSON object is preserved by every parser and guaranteed by none of the
 * producers. `{"qubits":2,"clbits":0}` and `{"clbits":0,"qubits":2}` are the
 * same circuit, and a digest that disagreed about that would make
 * deduplication depend on how a client happened to serialise its request —
 * which is the same as no deduplication at all, only harder to notice.
 *
 * Arrays keep their order: an array *is* ordered, and `operations` in a
 * different order is a different document as far as the contract is concerned
 * (§6 grants commutation within a column to the engine, not to this).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not JSON and `JSON.stringify` drops such keys silently;
    // dropping them here too keeps the two renderings of one object equal.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const body = entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')
  return `{${body}}`
}

/**
 * Characters of digest kept in a job id.
 *
 * Thirty-two hex characters is 128 bits, which is the same order as the
 * `nanoid` slug §11 sizes an UNLISTED circuit's whole access control at. It
 * has to be that generous for a reason a shorter id would not survive: a
 * collision here does not produce a wrong hash, it produces *the wrong
 * answer* — the second submitter would be handed the first one's run, over a
 * circuit that is not theirs. This is the one place in the system where a
 * truncation is a security decision.
 */
export const JOB_ID_DIGEST_CHARS = 32

/**
 * The job id a digest becomes.
 *
 * BullMQ builds its Redis keys by concatenating with `:`, so a custom job id
 * containing one would collide with the queue's own key space. A hex digest
 * cannot, and the prefix makes a stray key recognisable in `redis-cli --scan`
 * on an instance this project shares with nothing else.
 */
export function jobIdFrom(digestHex: string): string {
  return `sim-${digestHex.slice(0, JOB_ID_DIGEST_CHARS)}`
}

/**
 * UTF-8 byte length, without `Buffer`.
 *
 * `@qsim/db` measures a stored circuit with `Buffer.byteLength` because it runs
 * in Node; this package may not (§12.3 rule 2, enforced by `"types": []` in
 * the tsconfig), and `String.length` is UTF-16 code units — a result full of
 * ket labels like `|ψ⟩` would pass a byte budget it exceeds by half again.
 *
 * A lone surrogate counts as three bytes because that is what every UTF-8
 * encoder writes for one: U+FFFD.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

/**
 * The circuit's own numbers, as the limit checks and the cost model need them.
 *
 * ── `operations` is the EXPANDED count, and that is a §11 rule ────────────
 *
 * A custom gate stands for its body, and definitions may use other
 * definitions, so a document with ten operations in it can be a million
 * operations of work — the cycle check proves the graph terminates and says
 * nothing about its size (`expand.ts`). Counting `circuit.operations.length`
 * here would let a two-kilobyte payload walk straight past
 * `MAX_SERVER_OPERATIONS` and the work budget derived from it, which is the
 * one thing admission control exists to stop.
 *
 * `safeExpandCircuit` answers `null` for a circuit past the contract's own
 * expansion ceiling. That circuit is refused whatever number appears here, so
 * the fallback is the ceiling itself rather than the flat count: it is the
 * honest lower bound on what running the thing would cost, and it keeps the
 * refusal a limit refusal instead of an acceptance followed by a crash.
 */
export function shapeOf(payload: {
  circuit: Pick<Circuit, 'qubits' | 'operations' | 'customGates'>
  mode: SimulationMode
  shots: number | null
}): {
  mode: SimulationMode
  qubits: number
  operations: number
  shots: number | null
} {
  return {
    mode: payload.mode,
    qubits: payload.circuit.qubits,
    operations: expandedOperationCount(payload.circuit),
    shots: payload.shots,
  }
}

function expandedOperationCount(
  circuit: Pick<Circuit, 'qubits' | 'operations' | 'customGates'>
): number {
  if (circuit.customGates === undefined) return circuit.operations.length
  const expansion = safeExpandCircuit(circuit as Circuit)
  return expansion === null
    ? MAX_EXPANDED_OPERATIONS + 1
    : expansion.circuit.operations.length
}
