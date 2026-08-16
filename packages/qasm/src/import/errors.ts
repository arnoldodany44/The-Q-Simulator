/**
 * What an import can refuse with, and where in the file it refused.
 *
 * ── WHY EVERY FAILURE CARRIES A LINE AND A COLUMN ────────────────────────
 *
 * A QASM file is somebody else's text. The only useful thing a reader can be
 * told about a file that will not load is *where* to look, so every path out of
 * this importer that is not a circuit is one of these, and every one of them
 * has a position. "Invalid OpenQASM" is an error nobody can act on — the same
 * argument `validate.ts` makes for naming the offending operation.
 *
 * ── WHY THE CODE IS SEPARATE FROM THE MESSAGE ────────────────────────────
 *
 * `message` is English written for whoever is debugging. The user-facing
 * sentence is assembled by the UI from `code`, `position` and `construct`,
 * through i18next into all three catalogs (D2) — so the two never have to be
 * the same string, and a translator never has to translate a parser's idea of a
 * token.
 *
 * `construct` is the load-bearing field for `unsupported`. A file using `def`,
 * `for` or `defcal` is *valid* OpenQASM that this contract has no shape for,
 * and the reader needs to be told which feature that was, by name, rather than
 * that their file is broken. The name is the language's own keyword and is
 * therefore not translated, exactly like a gate symbol (D2).
 */

import type { ValidationIssue } from '@qsim/schema'

/**
 * Why an import failed.
 *
 *  - `syntax`      the text is not OpenQASM at all: an unclosed comment, a
 *                  missing semicolon, a truncated file.
 *  - `unsupported` valid OpenQASM using a feature the circuit contract cannot
 *                  express. `construct` names it.
 *  - `semantic`    well-formed OpenQASM that does not mean anything: an
 *                  undeclared register, a gate given three qubits when it takes
 *                  two, a gate that calls itself.
 *  - `limit`       past one of the ceilings in `limits.ts` (§11), or past one of
 *                  the contract's own — a chain of gate definitions expands to
 *                  more operations than a document holds, and that is a limit
 *                  however late it is discovered.
 *  - `contract`    the circuit that came out was refused by `parseCircuit` for
 *                  a reason that is not a ceiling. Carries `issues`. Reaching
 *                  this is a defect in the importer rather than in the file — it
 *                  is a code because the check is real and must report
 *                  *something* if it ever fires, never because it is expected
 *                  to.
 */
export type QasmImportCode =
  'syntax' | 'unsupported' | 'semantic' | 'limit' | 'contract'

/** One-based line and column, counted in code points. */
export interface QasmPosition {
  readonly line: number
  readonly column: number
}

/** The start of a file, for failures that belong to no particular token. */
export const START_OF_FILE: QasmPosition = { line: 1, column: 1 }

export interface QasmImportErrorOptions {
  readonly construct?: string
  readonly issues?: readonly ValidationIssue[]
}

/**
 * An OpenQASM file that did not become a circuit.
 *
 * There is exactly one error class rather than one per phase: the lexer, the
 * parser and the lowering all fail in the same way as far as a caller is
 * concerned — a position and a reason — and a UI that had to catch three
 * classes would eventually catch two.
 */
export class QasmImportError extends Error {
  readonly code: QasmImportCode
  readonly position: QasmPosition
  /** For `unsupported`: the language feature, spelled as the language spells it. */
  readonly construct: string | undefined
  /** For `contract`: what `parseCircuit` objected to. */
  readonly issues: readonly ValidationIssue[]

  constructor(
    code: QasmImportCode,
    position: QasmPosition,
    message: string,
    options: QasmImportErrorOptions = {}
  ) {
    super(`${message} (line ${position.line}, column ${position.column})`)
    this.name = 'QasmImportError'
    this.code = code
    this.position = position
    this.construct = options.construct
    this.issues = options.issues ?? []
  }
}

/** Convenience for the common shapes, so call sites stay one line. */
export function syntaxError(
  position: QasmPosition,
  message: string
): QasmImportError {
  return new QasmImportError('syntax', position, message)
}

export function semanticError(
  position: QasmPosition,
  message: string
): QasmImportError {
  return new QasmImportError('semantic', position, message)
}

export function limitError(
  position: QasmPosition,
  message: string
): QasmImportError {
  return new QasmImportError('limit', position, message)
}

/**
 * A feature this importer understands well enough to name and refuses anyway.
 *
 * The distinction from `semanticError` matters to the reader: "this file uses
 * `for`, which is not supported" sends them to rewrite one loop, while "unknown
 * token `for`" sends them looking for a typo they did not make.
 */
export function unsupportedError(
  position: QasmPosition,
  construct: string,
  message: string
): QasmImportError {
  return new QasmImportError('unsupported', position, message, { construct })
}
