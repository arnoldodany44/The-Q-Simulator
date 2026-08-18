import { safeImportOpenQasm } from '@qsim/qasm'
import { safeParseCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'

import { asImportFailure, type ImportFailure } from './failure'

/**
 * Reading a circuit out of whatever the reader handed over.
 *
 * ── WHY THIS IS NOT IN THE PANEL ──────────────────────────────────────────
 *
 * It was, and it made the panel the only thing that could answer "does an
 * export come back". That question is the one this project got wrong: the JSON
 * export described itself as "the one to save if you want to reopen this
 * circuit here" and nothing on the way in could read it, for two whole phases,
 * with every test in `features/import` passing. A round trip is a property of
 * the pair, so it needs to be assertable without rendering a form — see
 * `verification/export-round-trip/`.
 *
 * ── THE FORMAT IS DEDUCED, NEVER ASKED ───────────────────────────────────
 *
 * Three shapes, told apart by their first character: `<` is the diagram, `{` is
 * the native JSON, anything else is OpenQASM, whose own version the importer
 * then works out for itself. The reasoning is the one `ImportPanel`'s header
 * gives for not offering an OpenQASM 2/3 selector, and it extends unchanged:
 * somebody who pasted three lines out of a notebook does not necessarily know
 * what they have, and a control that asks them to classify it first is a
 * control that can be answered wrongly.
 */

/** Dialect names, invariant across locales (D2). */
const DIALECT_LABELS: Readonly<Record<2 | 3, string>> = {
  2: 'OpenQASM 2',
  3: 'OpenQASM 3',
}

/** The native format's name, invariant across locales for the same reason. */
const JSON_LABEL = 'JSON'

/** What a reader hands back: a circuit, or the sentence to show. */
export type Read =
  | { readonly ok: true; readonly circuit: Circuit; readonly format: string }
  | { readonly ok: false; readonly failure: ImportFailure }

/**
 * Which of the two formats this is, decided from the text and not from a
 * control the reader has to set.
 *
 * A JSON document starts with `{` and an OpenQASM program cannot, so one
 * character settles it. This is the same reasoning the panel already applies to
 * OpenQASM 2 versus 3 — see the header: somebody pasting three lines out of a
 * notebook does not necessarily know what they have, and a selector asks them
 * to classify it before they are allowed to act.
 */
function looksLikeJson(text: string): boolean {
  return text.trimStart().startsWith('{')
}

/** An SVG this editor exported, which carries the circuit that drew it. */
function looksLikeSvg(text: string): boolean {
  const head = text.trimStart()
  return head.startsWith('<?xml') || head.startsWith('<svg')
}

/**
 * The editor's own format, which the export panel calls the one that loses
 * nothing — and, until this existed, the one nothing could read back. A JSON
 * file exported from here now returns through the same door as a QASM program.
 */
function readJson(text: string): Read {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, failure: { code: 'json-syntax' } }
  }
  /*
   * `safeParseCircuit` and not a bare cast: this is untrusted text, and the
   * schema is the thing that decides what a circuit is. Its own header names
   * imports as one of the three callers it exists for.
   */
  const result = safeParseCircuit(parsed)
  if (!result.ok) {
    console.error('import: the JSON is not a circuit', result.issues)
    return { ok: false, failure: { code: 'contract' } }
  }
  return { ok: true, circuit: result.circuit, format: JSON_LABEL }
}

/**
 * A diagram exported from here, which carries its own circuit in a
 * `<metadata>` element — see `features/export/diagram.tsx`.
 *
 * Parsed with `DOMParser` rather than a regular expression, because this is
 * XML from a file the reader was handed and pattern-matching markup is how
 * that goes wrong. The parsed document is never inserted anywhere: nothing
 * in it is rendered, no script in it can run, and the only thing taken out
 * of it is the text of one element, which then goes through the same
 * `safeParseCircuit` as a pasted JSON file.
 */
function readSvg(text: string): Read {
  const document_ = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (document_.querySelector('parsererror') !== null) {
    return { ok: false, failure: { code: 'svg-no-circuit' } }
  }
  const carried = document_.querySelector('metadata[data-qsim-format]')
  const payload = carried?.textContent ?? ''
  if (payload.trim() === '') {
    return { ok: false, failure: { code: 'svg-no-circuit' } }
  }
  return readJson(payload)
}

/** OpenQASM 2 or 3, whichever the importer recognises. */
function readQasm(text: string): Read {
  const read = safeImportOpenQasm(text)
  if (!read.ok) {
    console.error('import: the file was refused', read.error)
    return { ok: false, failure: asImportFailure(read.error) }
  }
  return {
    ok: true,
    circuit: read.circuit,
    format: DIALECT_LABELS[read.version],
  }
}

/**
 * The one door in. `text` is whatever was pasted or read out of a file.
 */
export function readCircuitSource(text: string): Read {
  if (looksLikeSvg(text)) return readSvg(text)
  if (looksLikeJson(text)) return readJson(text)
  return readQasm(text)
}
