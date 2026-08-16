/**
 * Reading OpenQASM — the inverse of `qasm3.ts`, and §3.5's other half.
 *
 * ── THE ROUND TRIP IS THE CONTRACT BETWEEN THE TWO HALVES ────────────────
 *
 * A circuit written out and read back must be the same circuit, and a file read
 * in and written out must be the same file. Neither claim is about text:
 *
 *  - `circuit → QASM → circuit` is checked as an **equivalence**, defined in
 *    `equivalence.ts` and argued there. It is not equality, because the
 *    exporter is deliberately lossy in two named places — a symbolic parameter
 *    becomes a literal, and `iswap` becomes the decomposition `stdgates.inc`
 *    forces on it — and because a column index is a layout coordinate that a
 *    text file does not carry at all.
 *  - `QASM → circuit → QASM` is checked as a **fixed point**: the first pass
 *    normalises (comments go, a register is flattened, the gate order becomes
 *    the contract's), and every pass after it must produce byte-identical text.
 *    An importer that drifted a little each time would pass any single
 *    comparison and fail this one.
 *
 * ── WHAT AN UNTRUSTED FILE MAY NOT DO (§11) ──────────────────────────────
 *
 * Hang, recurse without bound, allocate without bound, or produce a circuit
 * `parseCircuit` refuses. The first three are `limits.ts`, applied at the token,
 * at the register declaration, at the expression, at the definition graph and at
 * the operation count. The fourth is the last line of `lowerProgram`, which runs
 * the contract's own validator over the result: an import produces something the
 * contract accepts or a clear error, and never something in between.
 */

import type { Circuit } from '@qsim/schema'

import { lowerProgram } from './lower.js'
import { detectVersion, parseProgram } from './parser.js'
import { QasmImportError } from './errors.js'
import { tokenize } from './lexer.js'
import type { QasmVersion } from './ast.js'

export { QasmImportError, START_OF_FILE } from './errors.js'
export type {
  QasmImportCode,
  QasmPosition,
  QasmImportErrorOptions,
} from './errors.js'
export type { QasmVersion } from './ast.js'
export { KNOWN_UNSUPPORTED } from './library.js'
export { unsupportedKeywords } from './parser.js'
export {
  MAX_SOURCE_LENGTH,
  MAX_OPERATIONS,
  MAX_IDENTIFIER_LENGTH,
} from './limits.js'

/** What a successful import knows beyond the circuit itself. */
export interface QasmImport {
  readonly circuit: Circuit
  /** The dialect the file was read as. */
  readonly version: QasmVersion
  /** Whether an `OPENQASM` header said so, or the syntax implied it. */
  readonly versionDeclared: boolean
}

export type QasmImportResult =
  | ({ readonly ok: true } & QasmImport)
  | { readonly ok: false; readonly error: QasmImportError }

/**
 * Reads an OpenQASM 2 or 3 program as a circuit. Throws `QasmImportError`.
 *
 * The version is detected, never asked for: §3.5 says both dialects are
 * supported, and a reader pasting a file out of a notebook has no reason to
 * know which one they have. See `library.ts` for the one case where the answer
 * changes the physics.
 */
export function importOpenQasm(source: string): QasmImport {
  const program = parseProgram(source)
  return {
    circuit: lowerProgram(program),
    version: program.version,
    versionDeclared: program.versionDeclared,
  }
}

/**
 * As `importOpenQasm`, but returning the failure instead of throwing.
 *
 * The shape `safeParseCircuit` uses, for the same reason: a UI that has to
 * catch an exception to render an error message is a UI where one uncaught path
 * is a blank screen.
 */
export function safeImportOpenQasm(source: string): QasmImportResult {
  try {
    return { ok: true, ...importOpenQasm(source) }
  } catch (cause) {
    if (cause instanceof QasmImportError) return { ok: false, error: cause }
    throw cause
  }
}

/**
 * Which dialect a source is, without reading the rest of it.
 *
 * Exposed because an interface may want to *say* what it detected — "read as
 * OpenQASM 2" is a useful thing to show next to an imported circuit, and the
 * one fact about the import a reader might want to overrule by editing their
 * file's header.
 */
export function detectQasmVersion(source: string): QasmVersion {
  return detectVersion(tokenize(source)).version
}
