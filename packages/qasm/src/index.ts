/**
 * @qsim/qasm — the circuit contract, written out in other languages and read
 * back from one of them.
 *
 * Specification §3.5. Milestone M1.7 built the serialisers; the OpenQASM
 * importer is the inverse of the OpenQASM 3 one and lives here beside it,
 * because a format has one place where it is understood or it has two that
 * disagree. The two halves were nevertheless *written* apart on purpose: a
 * parser tested only against its own writer proves nothing about the files
 * anyone else produces, which is why the importer's suite reads Qiskit's own
 * output and hand-written OpenQASM 2 as well as this package's exports.
 *
 * Dependency rule (§12.3): this package may import `packages/schema` and
 * nothing else in the workspace. It touches no DOM and no Node API, so it runs
 * in the browser, in the API and in a worker alike — and the importer inherits
 * that, which is why `include "stdgates.inc";` is *known* rather than fetched.
 * The rendered diagram (SVG/PNG) is deliberately not here: drawing needs the
 * canvas components, which are React, which is an app concern — see
 * `apps/web/src/features/export`.
 *
 * Where things live:
 *   - `qasm3.ts`   OpenQASM 3, the interchange format
 *   - `qiskit.ts`  Qiskit Python, the thing you paste into a notebook
 *   - `json.ts`    the native document, which loses nothing
 *   - `angles.ts`  how an angle becomes a literal in either language
 *   - `program.ts` the reading of the document both text emitters share
 *   - `import/`    the reader: tokeniser, recursive-descent parser, lowering
 *
 * The one claim worth checking before trusting any of it is endianness: `q[k]`
 * is qubit `k`, unmirrored, because decision D1 chose Qiskit's convention. See
 * `verification/qiskit-agreement.test.ts` for the way out and
 * `verification/import-agreement.test.ts` for the way in; both compare
 * distributions on asymmetric circuits, because a mirrored pair agrees with
 * itself and text cannot show it.
 */

export { asPiMultiple, formatAngle, usesPi } from './angles.js'
export type { PiMultiple } from './angles.js'

export { toOpenQasm3 } from './qasm3.js'
export { toQiskit } from './qiskit.js'
export { toCircuitJson } from './json.js'

export { tallyQasm3 } from './tally.js'
export type { QasmGateTally, QasmTally } from './tally.js'

export {
  CircuitExportError,
  commentText,
  describeExport,
  finalClassicalRegister,
  orderedCustomGates,
  orderedOperations,
} from './program.js'
export type { ExportOptions } from './program.js'

export {
  detectQasmVersion,
  importOpenQasm,
  safeImportOpenQasm,
  KNOWN_UNSUPPORTED,
  MAX_IDENTIFIER_LENGTH,
  MAX_OPERATIONS,
  MAX_SOURCE_LENGTH,
  QasmImportError,
  START_OF_FILE,
  unsupportedKeywords,
} from './import/index.js'
export type {
  QasmImport,
  QasmImportCode,
  QasmImportErrorOptions,
  QasmImportResult,
  QasmPosition,
  QasmVersion,
} from './import/index.js'

export {
  ANGLE_TOLERANCE,
  equivalentCircuits,
  fingerprintCircuit,
} from './import/equivalence.js'
export type {
  CircuitFingerprint,
  ClassicalEvent,
  EquivalenceResult,
  WireEvent,
} from './import/equivalence.js'
