/**
 * Taking an update from somebody else — the one place untrusted bytes enter.
 *
 * §11 asks that every circuit be validated before the engine sees it, and a
 * CRDT update makes that harder than a JSON body does in three specific ways.
 * Each of the three is answered here, and the answers are the reason a relay
 * has to be able to *read* a document rather than merely forward it.
 *
 *  1. **It is opaque.** There is no field to inspect: an update is a binary
 *     encoding of operations against a state vector. So it is bounded by size
 *     before it is decoded — a ceiling on bytes is the only judgement available
 *     before the bytes are understood — and by rate, which is the transport's
 *     job rather than this file's.
 *
 *  2. **It cannot be refused after the fact.** Applying an update mutates the
 *     document and there is no inverse: `Y.applyUpdate` has no rollback, and
 *     `Y.UndoManager` only undoes origins it was tracking. A relay that wanted
 *     to *reject* a hostile update would have to apply it to a scratch copy of
 *     the whole document first, which is a full re-encode per keystroke on a
 *     small container.
 *
 *     So validity is not enforced on the way in. It is enforced on the way out,
 *     by the projection, which every peer computes identically and which is
 *     valid by construction (`project.ts`). What that means in practice:
 *     **nothing downstream may act on the document, only on the projection.**
 *     The relay persists what it projects, the engine simulates what it
 *     projects, and a stranger's bytes can therefore make the document strange
 *     but cannot make the circuit illegal.
 *
 *  3. **A malformed update is a decoder error, not a validation error.** Yjs
 *     throws on garbage, and it throws from inside the integration, so a
 *     document that has taken one is not in a state anybody promised anything
 *     about. That is reported as `malformed` and the honest response is to close
 *     the connection: a peer sending undecodable bytes is broken or hostile, and
 *     either way is not a peer to keep serving.
 */

import { CIRCUIT_SCHEMA_VERSION, validateCircuit } from '@qsim/schema'
import * as Y from 'yjs'

import { projectCircuit, type CircuitProjection } from './project.js'

/**
 * The largest update this layer will apply, in bytes.
 *
 * An incremental edit is around a hundred bytes — a slider frame writes one
 * key — so this ceiling never binds a person editing. What it binds is the
 * other two cases: a full state sync, which is one update carrying the whole
 * document, and an attack.
 *
 * 256 KiB is the same figure `MAX_CIRCUIT_JSON_BYTES` uses in `@qsim/db`, and
 * for the same reason rather than by coincidence: a shared document has to be
 * able to carry a circuit as large as one that can be *saved*, and nothing
 * larger, because a document nobody can persist is a session whose work cannot
 * survive the tab. The number is quoted rather than imported because a package
 * shared with the browser may not reach for the database layer (§12.3).
 *
 * It is deliberately far above `MAX_SOCKET_FRAME_BYTES` (8 KiB), which is what
 * the socket built in Fase 2 will accept per frame. That gap is the transport's
 * problem to solve — a raised `maxPayload` for the collaboration channel, or
 * chunking — and pretending it away by lowering this ceiling would mean a
 * document that cannot be synced at all.
 */
export const MAX_UPDATE_BYTES = 256 * 1024

export type UpdateRefusal =
  /** Larger than the ceiling. Refused before being decoded. */
  | 'too-large'
  /** Yjs could not decode it. The document may have been touched. */
  | 'malformed'
  /**
   * The document is written at a schema version this build does not know. It
   * is not projected, because a v2 document read as a v1 circuit would be a
   * confident misreading — and this peer would then *write* v1 into it.
   */
  | 'incompatible-version'
  /**
   * The projection came out invalid, which `project.ts` guarantees cannot
   * happen. It is reported rather than thrown so that a relay meeting a bug
   * refuses one document instead of dropping every connection it holds.
   */
  | 'not-projectable'

export type UpdateResult =
  | { readonly ok: true; readonly projection: CircuitProjection }
  | { readonly ok: false; readonly reason: UpdateRefusal }

export interface ApplyOptions {
  /**
   * Transaction origin. A relay passes the connection the bytes arrived on, so
   * that its own fan-out can avoid echoing an update back to its sender; the
   * bridge in the browser passes the provider. It must never be the value a
   * client uses for its *own* edits — see `write.ts` on the origin rule.
   */
  readonly origin: unknown
  readonly maxBytes?: number
}

/**
 * Apply one update and return what the document then says.
 *
 * The order is the contract: bound, decode, project, verify. Nothing after a
 * refusal is worth doing, and nothing before the projection may be acted on.
 */
export function applyCircuitUpdate(
  doc: Y.Doc,
  update: Uint8Array,
  options: ApplyOptions
): UpdateResult {
  const ceiling = options.maxBytes ?? MAX_UPDATE_BYTES
  if (update.byteLength > ceiling) return { ok: false, reason: 'too-large' }

  try {
    Y.applyUpdate(doc, update, options.origin)
  } catch {
    // The cause is not logged here and not re-thrown: it is a decoder message
    // about somebody else's bytes, the caller knows which connection sent
    // them, and this layer has no logger (§12.3 — a shared package may not
    // reach for one).
    return { ok: false, reason: 'malformed' }
  }

  const projection = projectCircuit(doc)
  if (
    projection.schemaVersion !== undefined &&
    projection.schemaVersion !== CIRCUIT_SCHEMA_VERSION
  ) {
    return { ok: false, reason: 'incompatible-version' }
  }
  if (validateCircuit(projection.circuit).length > 0) {
    return { ok: false, reason: 'not-projectable' }
  }
  return { ok: true, projection }
}
