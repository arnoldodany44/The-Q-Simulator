/**
 * @qsim/collab — a circuit as a Yjs document (§3.4, §14 Fase 5).
 *
 * This package holds the *shape*: how a circuit maps onto Yjs types, how an
 * update is applied, and how a document is read back as a `Circuit` the
 * contract accepts. Nothing here connects to anything — no socket, no
 * provider, no awareness — because the shape has to be shared and the
 * transport does not.
 *
 * ── Why the server needs the same reading the client has ──────────────────
 *
 * A relay that cannot interpret a document cannot validate one, and §11 does
 * not exempt a binary channel from validation. If the mapping lived in
 * `apps/web`, the API would be forwarding opaque bytes between browsers and
 * hoping: it could not refuse a hostile update, could not persist a version,
 * could not simulate a challenge submission against the document two people
 * are editing. So the mapping is a package, and the API and the browser share
 * one implementation of it — the same argument §12.1 makes for `qsim` and
 * `schema`, applied to the one new thing this phase introduces.
 *
 * Where things live:
 *   - `document.ts` the representation, and the argument for it
 *   - `project.ts`  reading a document as a circuit, and what happens to a
 *                   merge that broke §6 — the decision this phase turns on
 *   - `write.ts`    writing a circuit in as a difference, and the origin rule
 *                   that keeps a two-way bridge from looping
 *   - `update.ts`   taking bytes from a stranger
 *
 * Start at `projectCircuit`. Everything else exists to feed it.
 */

export {
  FIELD_CLBIT_TARGETS,
  FIELD_COLUMN,
  FIELD_CONDITION,
  FIELD_CONTROLS,
  FIELD_GATE,
  FIELD_ID,
  FIELD_PARAMS,
  FIELD_SEQ,
  FIELD_TARGETS,
  META_CLBITS,
  META_QUBITS,
  META_SCHEMA_VERSION,
  PARAMETER_SEQ,
  PARAMETER_VALUE,
  ROOT_GATES,
  ROOT_LABELS,
  ROOT_META,
  ROOT_OPERATIONS,
  ROOT_PARAMETERS,
  circuitRoots,
  isEmptyDocument,
  nextSeq,
  slotFields,
  slotKeys,
  slotMinter,
} from './document.js'
export type { CircuitRoots } from './document.js'

export {
  MAX_DOCUMENT_GATES,
  MAX_DOCUMENT_OPERATIONS,
  defaultQubitLabel,
  projectCircuit,
} from './project.js'
export type {
  CircuitProjection,
  DeferralReason,
  DeferredOperation,
} from './project.js'

export {
  documentOf,
  restampOperations,
  widenRegister,
  writeCircuit,
} from './write.js'
export type { WriteOptions } from './write.js'

export { MAX_UPDATE_BYTES, applyCircuitUpdate } from './update.js'
export type { ApplyOptions, UpdateRefusal, UpdateResult } from './update.js'
