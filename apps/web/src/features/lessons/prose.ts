/**
 * Notation inside a translated paragraph — D2, §1.1.
 *
 * A lesson's prose is the one place in this product where invariant notation
 * has to appear *inside* a sentence rather than beside one. "Apply an `H` to
 * `q0` and the single bar becomes two" is a sentence whose meaning depends on
 * three tokens that must be identical in Spanish, English and French, and on a
 * word order that is not.
 *
 * The three ways to do that, and why this is the one:
 *
 *   - **Split the sentence into fragments around the notation.** Three keys
 *     per sentence, a translator who cannot see the sentence, and a French
 *     word order that cannot be expressed at all because the fragments are
 *     concatenated in the order the English needed.
 *   - **`<Trans>` with interpolated components.** i18next's answer, and it
 *     works — at the cost of `<0>` and `</0>` markers in the catalog. That is
 *     exactly the unreviewable JSON the format decision (`format.ts`, 5) is
 *     trying to avoid, on the largest body of translated text in the product,
 *     and a translator who drops a closing marker breaks the render rather
 *     than the prose.
 *   - **A backtick**, which is what this implements. One character, the
 *     convention every technical writer already has, invisible to the meaning
 *     of the sentence, and it survives being pasted into any translation tool.
 *
 * What a span between backticks buys is not styling. It is `Notation`, which
 * is the only sanctioned route for invariant text (§1.1) and which marks the
 * span `translate="no"` — so Chrome's page translator cannot turn a `CNOT`
 * into a French verb, which it will otherwise happily do.
 *
 * A backtick with no partner is literal text. That is the forgiving reading
 * and it is the right one here: the failure mode of the strict reading is that
 * a translator's typo swallows the rest of a paragraph into a code span, and
 * nothing in the build would notice.
 */

export interface ProseSpan {
  readonly text: string
  /** True for a span that was between backticks — render it as `Notation`. */
  readonly notation: boolean
}

/**
 * Splits a paragraph into ordinary text and notation.
 *
 * Empty spans are dropped, so a paragraph that is nothing but notation yields
 * one span rather than three, and adjacent notation never produces an empty
 * text node between the two.
 */
export function splitNotation(paragraph: string): ProseSpan[] {
  const spans: ProseSpan[] = []
  let cursor = 0

  for (;;) {
    const open = paragraph.indexOf('`', cursor)
    if (open === -1) break
    const close = paragraph.indexOf('`', open + 1)
    // An unpaired backtick is literal — see the header.
    if (close === -1) break

    push(spans, paragraph.slice(cursor, open), false)
    push(spans, paragraph.slice(open + 1, close), true)
    cursor = close + 1
  }

  push(spans, paragraph.slice(cursor), false)
  return spans
}

function push(spans: ProseSpan[], text: string, notation: boolean): void {
  if (text === '') return
  spans.push({ text, notation })
}
