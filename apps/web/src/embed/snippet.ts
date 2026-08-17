/**
 * The markup a teacher pastes, as a string — §3.4.
 *
 * Separate from `EmbedSnippet.tsx` because it is the half that has nothing to
 * do with React: a pure function from four values to a block of HTML, and the
 * one place in this project where a *string of markup* is produced for
 * somebody else's document. That is exactly the kind of code that wants to be
 * called directly from a test, and keeping it out of the component file also
 * keeps that file exporting components alone, which is what fast refresh
 * needs.
 *
 * ── IT ESCAPES ITSELF, AND THAT IS NOT OPTIONAL ─────────────────────────
 *
 * React escapes everything it renders, which is why nothing else in this app
 * has to think about it. This string is *for copying out of React* — it is
 * pasted into a CMS, a Markdown file, a slide — so nothing downstream will
 * escape it. A circuit title is arbitrary user text, and one containing a
 * quotation mark would otherwise close the `title` attribute and continue as
 * markup in a page this project has no relationship with.
 */

/** Every part of the frame that is not fixed. */
export interface SnippetParts {
  /** The `<iframe src>`, absolute. */
  readonly url: string
  /** The circuit's own page, for the caption's link. */
  readonly page: string
  /** The circuit's title. Arbitrary user text; escaped below. */
  readonly title: string
  /** The `height` attribute. See `suggestedFrameHeight`. */
  readonly height: number
  /** The credit line, translated by the caller (D2). */
  readonly credit: string
}

/**
 * The frame's height, estimated from the circuit.
 *
 * A cross-origin frame cannot size itself to its contents — that needs
 * `postMessage` between two origins, which is precisely the channel an embed
 * should not open — so the number is a starting point the teacher adjusts.
 * Getting it wrong scrolls; it never crops.
 *
 * The parts, so the arithmetic is arguable rather than magic: a header and a
 * counters row that do not change, a diagram row per qubit, and a histogram
 * whose height grows with the number of basis states it will draw — capped,
 * like the histogram itself, at thirty-two rows (§3.2). Past five qubits only
 * the diagram grows, which is why the estimate does not run away.
 *
 * Deliberately NOT importing `DEFAULT_BAR_LIMIT` from `analysis/histogram.ts`:
 * this is a hint printed into a text field, not a layout, and the day the
 * chart's row height changes by two pixels is not a day this number has to
 * change with it.
 */
export function suggestedFrameHeight(qubits: number): number {
  const chrome = 190
  const diagram = Math.max(2, qubits) * 44
  const bars = Math.min(2 ** Math.max(1, qubits), 32)
  return chrome + diagram + bars * 22
}

/**
 * The `<figure>` a teacher pastes.
 *
 * ── Why the credit link is out here rather than inside the frame ────────
 *
 * A link in the parent page is an ordinary link in a document the teacher
 * controls, and it survives a strict `sandbox`; a link inside the frame needs
 * `allow-popups` before it can open anything. The frame carries one too
 * (`EmbedView.tsx` argues why), so a reader has a way through either way —
 * but the one that always works is this one.
 *
 * ── The three attributes that are not decoration ────────────────────────
 *
 *   `title`     WCAG 4.1.2. A frame with no title is announced as "frame",
 *               and six of them in an article are announced as six frames.
 *   `loading`   `lazy`, which is the "six circuits must be cheap" requirement
 *               expressed in one attribute: frames below the fold are not
 *               fetched until the reader scrolls to them.
 *   `style`     `border:0`, because the default frame border is a 3D inset
 *               from 1996 and every CMS renders it differently.
 */
export function buildSnippet({
  url,
  page,
  title,
  height,
  credit,
}: SnippetParts): string {
  const safeTitle = escapeAttribute(title)
  return [
    '<figure>',
    `  <iframe src="${escapeAttribute(url)}"`,
    `    title="${safeTitle}"`,
    `    width="100%" height="${height}"`,
    '    loading="lazy" style="border:0"></iframe>',
    `  <figcaption><a href="${escapeAttribute(page)}">${safeTitle}</a>` +
      ` — ${escapeText(credit)}</figcaption>`,
    '</figure>',
  ].join('\n')
}

/** Text inside an attribute, quoted with `"`. */
function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/** Text between tags. `&` first, or the other two get double-escaped. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
