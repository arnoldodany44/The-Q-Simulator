import { Buffer } from 'node:buffer'
import {
  type Circuit,
  type CircuitPreview,
  parseCircuit,
  previewOf,
  safeParsePreview,
} from '@qsim/schema'
import type { Prisma } from './generated/prisma/client.js'
import type { CircuitVersion } from './generated/prisma/client.js'

/**
 * The only sanctioned crossing between `CircuitVersion.data` and the circuit
 * contract.
 *
 * Prisma types that column as `JsonValue`, which is the truth: Postgres holds
 * whatever was written, including rows written months ago by an older build.
 * The contract lives in @qsim/schema and there is exactly one validator for
 * it — `parseCircuit` — so this module does not re-check anything, it just
 * makes sure the check is unavoidable. A route that reaches for `row.data`
 * directly gets `JsonValue` and cannot do anything useful with it; a route
 * that comes through here gets a `Circuit`.
 */

/** A stored version whose payload has been through `parseCircuit`. */
export interface ParsedCircuitVersion extends Omit<CircuitVersion, 'data'> {
  data: Circuit
}

/**
 * Validates a stored payload against the circuit contract.
 *
 * @throws {CircuitValidationError} from @qsim/schema when the row does not
 * satisfy the contract — which is not a client error but a data error, and
 * should be logged with the version id rather than returned verbatim.
 */
export function parseStoredCircuit(data: Prisma.JsonValue): Circuit {
  return parseCircuit(data)
}

/** Narrows a whole row, keeping every other column as Prisma typed it. */
export function parseCircuitVersion(
  version: CircuitVersion
): ParsedCircuitVersion {
  return { ...version, data: parseStoredCircuit(version.data) }
}

/**
 * Ceiling on a single stored circuit, in bytes of JSON.
 *
 * The contract's own limits are generous by design — 28 qubits and 4096
 * columns — because they exist to bound *the engine*, and a statevector's
 * cost has nothing to do with how much text describes it. A payload that
 * fills them is roughly 114,000 operations and about 9 MB, and every one of
 * those bytes would be read back, parsed, and re-validated on every open.
 *
 * 256 KiB is about 3,300 operations at the ~80 bytes an operation actually
 * costs. That is an order of magnitude more gates than the editor can place
 * on a canvas a person can read, and two orders below the pathological case.
 * The API's 1 MiB body limit already refuses the truly absurd; this is the
 * bound on what is allowed to become a permanent, immutable row.
 *
 * It is checked here rather than in a route because versions are immutable:
 * a row written too large can never be shrunk, only orphaned.
 */
export const MAX_CIRCUIT_JSON_BYTES = 256 * 1024

/**
 * Ceiling on a stored *challenge submission*, which is a much smaller thing.
 *
 * A saved circuit is somebody's document and gets the generous bound above. A
 * submission is an answer to a puzzle: the validator refuses one past 256
 * expanded operations before it will run it, and no seeded challenge allows
 * more than eighteen gates. Sixteen kibibytes is two orders above the largest
 * legitimate answer and two below the document ceiling.
 *
 * The gap between the two was a storage amplifier rather than a theoretical
 * one. Submissions are permanent, immutable, unbounded per person, written on
 * every attempt, and nothing in this repository ever deletes one — so the row
 * ceiling times the rate limit is the rate at which one free account can fill
 * the single shared database that the editor and the gallery also live in. At
 * 256 KiB that was about 2 MB a minute; at 16 KiB, with unreferenced
 * definitions pruned before the measurement, a real answer is a few hundred
 * bytes.
 */
export const MAX_SUBMISSION_JSON_BYTES = 16 * 1024

/** Raised by `toCircuitJson` for a circuit too large to store. */
export class CircuitTooLargeError extends Error {
  /** Machine-readable, for the API to map to a code the client translates. */
  readonly code = 'CIRCUIT_TOO_LARGE'

  constructor(
    readonly byteLength: number,
    readonly limit: number = MAX_CIRCUIT_JSON_BYTES
  ) {
    super(
      `Circuit JSON is ${String(byteLength)} bytes, over the ` +
        `${String(limit)} byte storage limit`
    )
    this.name = 'CircuitTooLargeError'
  }
}

/**
 * Size of a circuit as Postgres will hold it.
 *
 * `Buffer.byteLength` and not `String.length`: a qubit label may be `|ψ⟩`,
 * and a limit measured in UTF-16 code units would let a circuit of astral
 * characters through at three times the byte budget it declared.
 */
export function circuitJsonByteLength(circuit: Circuit): number {
  return Buffer.byteLength(JSON.stringify(circuit), 'utf8')
}

/**
 * The write direction, and it compiles with no cast at all — which is the
 * useful part. A `Circuit` is plain JSON-safe data today: no dates, no
 * `undefined`, no class instances, nothing Postgres would have to be told
 * how to store. Routing every write through this signature is what turns
 * that from a property nobody is checking into a compile error the day
 * someone adds a `Map` or a `Date` to the contract.
 *
 * @throws {CircuitTooLargeError} above `MAX_CIRCUIT_JSON_BYTES`. The check
 * lives on the crossing rather than in a route so that no future writer —
 * a fork, an import, a challenge submission — can reach the column without
 * passing it.
 */
export function toCircuitJson(
  circuit: Circuit,
  limit: number = MAX_CIRCUIT_JSON_BYTES
): Prisma.InputJsonValue {
  const bytes = circuitJsonByteLength(circuit)
  if (bytes > limit) throw new CircuitTooLargeError(bytes, limit)
  return circuit
}

/**
 * The other crossing on this table: `Circuit.preview`, the gallery card's
 * thumbnail (M1.5b).
 *
 * Deliberately *not* the same contract as `parseStoredCircuit` above, and the
 * asymmetry is the whole point of having both. A version's payload is the
 * document — a row that does not parse is a fault that must stop the request
 * rather than reach the engine. A preview is a picture derived from data the
 * server already holds, on a route that lists fifty circuits at once, so one
 * unreadable row must cost one thumbnail and never the listing: `null` here
 * means the card draws its counters instead.
 *
 * There is no size check because there is no way to exceed one. `previewOf`
 * bounds the value at `PREVIEW_MAX_QUBITS × PREVIEW_MAX_COLUMNS` operations
 * with no parameters and no labels, so the ceiling is a property of the
 * function rather than something a caller could hand in.
 */
export function parseStoredPreview(
  value: Prisma.JsonValue | null
): CircuitPreview | null {
  return value === null ? null : safeParsePreview(value)
}

/**
 * The write direction, and the only one: a preview is never accepted from a
 * caller, it is computed from the document being stored.
 *
 * That is the same rule `metricsOf` follows and for a sharper reason — a
 * client that could send its own thumbnail could draw a circuit other than
 * the one it published, which is a lie rendered on the front page.
 */
export function toPreviewJson(circuit: Circuit): Prisma.InputJsonValue {
  return previewOf(circuit)
}
