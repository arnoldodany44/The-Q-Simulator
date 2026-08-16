/**
 * Handing a generated file to the browser so that it actually saves.
 *
 * ── WHY NOT `href="data:…"` ──────────────────────────────────────────────
 *
 * The obvious version of this — an `<a download>` pointing at a `data:` URL —
 * is the version browsers block. Chrome and Edge refuse downloads initiated
 * from a `data:` URL outright (the same rule that blocks top-level navigation
 * to one), and Safari has historically capped their length. The failure is
 * silent: no error, no file, nothing in the console. So the payload becomes a
 * `Blob`, and the anchor points at a same-origin `blob:` URL, which is the one
 * form of generated download every current browser honours.
 *
 * `download` itself is only honoured for a same-origin (or `blob:`/`data:`)
 * href, which is another reason the object URL is the right vehicle: it is
 * always same-origin by construction.
 *
 * ── WHY THE ANCHOR IS PUT IN THE DOCUMENT ────────────────────────────────
 *
 * Firefox does not dispatch a click on a detached node, so an anchor built and
 * clicked without being appended works in Chrome and quietly does nothing in
 * Firefox. It is removed again in the same tick, so nothing is ever visible.
 *
 * ── WHY REVOCATION IS DELAYED ────────────────────────────────────────────
 *
 * `URL.revokeObjectURL` immediately after `click()` races the browser's own
 * fetch of the blob, and losing that race cancels the download. The delay
 * below is the same trade FileSaver.js settles on: long enough that no browser
 * is still reading, short enough that a few megabytes of SVG are not pinned
 * for the rest of the session.
 */

/** How long an object URL is kept alive after the click that used it. */
const REVOKE_DELAY_MS = 40_000

/** Media types the export produces. Each one names the format exactly. */
export const MEDIA_TYPES = {
  /* `charset=utf-8` on every text type: the circuit title travels inside
   * these files and is arbitrary Unicode, and a consumer that guesses latin-1
   * turns a French title into mojibake. */
  qasm: 'text/x-openqasm;charset=utf-8',
  python: 'text/x-python;charset=utf-8',
  json: 'application/json;charset=utf-8',
  svg: 'image/svg+xml;charset=utf-8',
  png: 'image/png',
} as const

/**
 * Saves a blob under `filename`.
 *
 * Returns nothing and throws nothing: from here on the browser owns the
 * outcome, and there is no event that tells a page whether the user kept the
 * file. The caller's status line says what was offered, not what was saved —
 * claiming more than that would be a claim the page cannot check.
 */
export function saveFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  // Nothing here opens a window, but an anchor that could is an anchor that
  // hands `window.opener` to whatever it opens.
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, REVOKE_DELAY_MS)
}

/** Saves text under `filename`, with the media type that names its format. */
export function saveText(
  filename: string,
  text: string,
  mediaType: string
): void {
  saveFile(filename, new Blob([text], { type: mediaType }))
}
