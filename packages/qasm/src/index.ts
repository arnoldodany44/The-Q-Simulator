/**
 * @qsim/qasm — the circuit contract, written out in other languages.
 *
 * Milestone M1.7, specification §3.5. This package is the **serialiser** half
 * of interoperability; reading OpenQASM back in is Phase 2, and the two are
 * deliberately separate pieces of work — a parser tested only against its own
 * writer proves nothing about the files anyone else produces.
 *
 * Dependency rule (§12.3): this package may import `packages/schema` and
 * nothing else in the workspace. It touches no DOM and no Node API, so it runs
 * in the browser, in the API and in a worker alike. The rendered diagram
 * (SVG/PNG) is deliberately *not* here: drawing needs the canvas components,
 * which are React, which is an app concern — see `apps/web/src/features/export`.
 *
 * Where things live:
 *   - `qasm3.ts`   OpenQASM 3, the interchange format
 *   - `qiskit.ts`  Qiskit Python, the thing you paste into a notebook
 *   - `json.ts`    the native document, which loses nothing
 *   - `angles.ts`  how an angle becomes a literal in either language
 *   - `program.ts` the reading of the document both text emitters share
 *
 * The one claim worth checking before trusting any of it is endianness: `q[k]`
 * is qubit `k`, unmirrored, because decision D1 chose Qiskit's convention. See
 * `verification/qiskit-agreement.test.ts`, which reads the emitted OpenQASM
 * back with an independent simulator and compares distributions against
 * `@qsim/core`.
 */

export { asPiMultiple, formatAngle, usesPi } from './angles.js'
export type { PiMultiple } from './angles.js'

export { toOpenQasm3 } from './qasm3.js'
export { toQiskit } from './qiskit.js'
export { toCircuitJson } from './json.js'

export {
  CircuitExportError,
  commentText,
  describeExport,
  orderedCustomGates,
  orderedOperations,
} from './program.js'
export type { ExportOptions } from './program.js'
