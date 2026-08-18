/**
 * Getting the text out of a file the reader chose — the one part of the import
 * that touches the browser.
 *
 * ── THE SIZE IS CHECKED BEFORE THE FILE IS READ ──────────────────────────
 *
 * `File.text()` decodes the whole thing into a JavaScript string, so a
 * gigabyte-sized file picked by accident is a gigabyte in the tab before
 * anything downstream gets a chance to refuse it. `File.size` is known without
 * reading a byte, which makes the check free and makes it the first thing that
 * happens. The ceiling is the importer's own `MAX_SOURCE_LENGTH`, so the panel
 * and the parser cannot disagree about what is too big — and the reader is told
 * before waiting rather than after.
 *
 * `size` counts bytes and `MAX_SOURCE_LENGTH` counts UTF-16 code units, so this
 * check is conservative for ASCII (which QASM almost entirely is) and generous
 * for text that is not. That is the right direction: a file this rejects is one
 * the parser would certainly have rejected, and a file this admits is checked
 * again there.
 */

import { MAX_SOURCE_LENGTH } from '@qsim/qasm'

export { MAX_SOURCE_LENGTH }

/** Extensions the file picker suggests. Not a check — the content is. */
export const CIRCUIT_FILE_ACCEPT =
  '.qasm,.qasm2,.qasm3,.inc,.txt,.json,.svg,' +
  'text/plain,application/json,image/svg+xml'

export type ReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too-large' | 'unreadable' }

/**
 * Reads a chosen file, refusing an oversized one without decoding it.
 *
 * Never throws: the caller is a click handler, and an exception there is a
 * panel that goes quiet rather than one that says what happened.
 */
export async function readCircuitFile(file: File): Promise<ReadResult> {
  if (file.size > MAX_SOURCE_LENGTH) return { ok: false, reason: 'too-large' }
  try {
    return { ok: true, text: await file.text() }
  } catch (cause) {
    // Logged rather than shown: a failed read is a permission or a device
    // problem, and the browser's own message is in whatever language the
    // browser is, which is not necessarily this app's (D2).
    console.error('import: the chosen file could not be read', cause)
    return { ok: false, reason: 'unreadable' }
  }
}
