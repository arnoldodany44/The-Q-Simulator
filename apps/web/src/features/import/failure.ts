/**
 * Everything that can go wrong on the way in, as one translated sentence.
 *
 * ── WHY THE IMPORTER'S OWN MESSAGE IS NOT SHOWN ──────────────────────────
 *
 * `QasmImportError.message` is English written for whoever is debugging: it
 * names tokens, quotes keywords and cites the specification. D2 says every
 * user-facing string goes through i18next into all three catalogs, really
 * translated — so what the reader sees is assembled here from the parts of the
 * error that are language-independent: a code, a line, a column, and for an
 * unsupported feature the construct's own name. The English message goes to the
 * console, where whoever is debugging can have it.
 *
 * The construct is interpolated untranslated, like a gate symbol or a format
 * name (D2): `def`, `for` and `rzz` are the language's own words, and a French
 * reader looking for the offending line needs the string that is actually in
 * their file. It is the same reasoning the export panel applies to `OpenQASM 3`.
 *
 * ── WHY THE LINE AND COLUMN ARE IN EVERY IMPORTER SENTENCE ───────────────
 *
 * Because the only useful thing to tell somebody about a file that will not load
 * is where to look. A panel that says "this file could not be read" has handed
 * the work back with none of what the parser already knew. Every path out of
 * `@qsim/qasm` that is not a circuit carries a position for exactly this.
 */

import { QasmImportError, type QasmImportCode } from '@qsim/qasm'

/**
 * Failures this app raises before the importer is called, alongside the ones the
 * importer raises. One union, so the panel has one thing to render and the
 * catalog has one block of keys.
 */
export type ImportFailureCode =
  | QasmImportCode
  /** Nothing was typed and no file was chosen. */
  | 'empty'
  /** The chosen file is larger than the importer will read. */
  | 'too-large'
  /** The browser could not hand over the file's text. */
  | 'unreadable'

export interface ImportFailure {
  readonly code: ImportFailureCode
  /** One-based, from the importer. Absent for the three app-level codes. */
  readonly line?: number
  readonly column?: number
  /** The OpenQASM feature, for `unsupported`. Never translated. */
  readonly construct?: string
}

/** Anything thrown on the import path, as a failure the panel can show. */
export function asImportFailure(cause: unknown): ImportFailure {
  if (cause instanceof QasmImportError) {
    return {
      code: cause.code,
      line: cause.position.line,
      column: cause.position.column,
      ...(cause.construct === undefined ? {} : { construct: cause.construct }),
    }
  }
  return { code: 'unreadable' }
}

/**
 * The catalog key a failure renders through.
 *
 * `unsupported` has two, because the sentence that names a construct cannot be
 * written without one and an empty pair of quotation marks is worse than a
 * vaguer sentence. Every other code has exactly one.
 */
export function importFailureKey(failure: ImportFailure): string {
  if (failure.code !== 'unsupported') return `failure.${failure.code}`
  return failure.construct === undefined
    ? 'failure.unsupportedUnnamed'
    : 'failure.unsupported'
}

/** What the key needs interpolated. */
export function importFailureValues(
  failure: ImportFailure
): Record<string, string | number> {
  return {
    line: failure.line ?? 0,
    column: failure.column ?? 0,
    construct: failure.construct ?? '',
  }
}
