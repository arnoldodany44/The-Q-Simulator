/**
 * Notation inside a paragraph — D2, §1.1.
 *
 * A lesson's prose was the first place in this product where invariant notation
 * had to appear *inside* a sentence rather than beside one. "Apply an `H` to
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
 *
 * ── Why it lives in `lib/` and not in `features/lessons/` ─────────────────
 *
 * It started there, and `ChallengeProse` reached across to it with a note saying
 * that a third caller should move it down here. M5.4's comments are that third
 * caller, and they are also the one that makes the move necessary rather than
 * tidy: a comment body is **user content**, so the convention now has to hold
 * for text this project did not write. `features/lessons` is also out of reach
 * of the embed by a boundary rule (`.dependency-cruiser.cjs`), so leaving nine
 * lines of string splitting inside that feature's graph would have put the rule
 * and the reuse in conflict the first time a frame needed to render notation.
 *
 * What has *not* changed is that there is exactly one implementation of the
 * convention. Two would be two answers to "what does an unpaired backtick
 * mean", and the one that differed would be the one a translator hit.
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

/**
 * The fence around a notation *argument* interpolated into a translated string.
 *
 * The backtick above is a convention for text somebody wrote into a catalog. This
 * is the other direction: a sentence whose notation arrives at runtime — a ket
 * the engine computed, a gate symbol read off the document, a wire's own name —
 * and which must still reach the DOM inside `Notation`, because that is what
 * carries `translate="no"` and stops a page translator rewriting `|011⟩` (D2,
 * §1.1).
 *
 * The alternative is matching a notation-shaped regex against the finished
 * sentence, which marks notation by *recognising* it rather than by knowing it —
 * and stops working the day a locale writes something ket-shaped of its own.
 *
 * U+0000 because no catalog and no interpolated value can contain one:
 * `@qsim/schema`'s `storableText` refuses the control ranges, so neither a qubit
 * label nor a custom gate's symbol can carry a fence into a sentence and split it
 * somewhere the caller did not intend. Every occurrence is consumed by
 * `splitFencedNotation`, so none of them reaches the page.
 *
 * It first appeared inside `features/analysis/NoiseComparisonPanel.tsx`, whose
 * own regression test (`verification/ui-truth-a11y/notation-is-marked.test.tsx`)
 * is what proved the mechanism; it moved down here in M5.4, when a comment's
 * anchor sentence — "H on q0, column 3" — needed exactly the same thing, and one
 * fence character defined twice is one place for the two definitions to drift.
 */
export const NOTATION_FENCE = '\u0000'

/** Marks an interpolated value as notation. See `NOTATION_FENCE`. */
export function fenceNotation(value: string): string {
  return `${NOTATION_FENCE}${value}${NOTATION_FENCE}`
}

/**
 * Splits a sentence built with `fenceNotation` back into prose and notation.
 *
 * Odd pieces are the fenced ones, which is what makes this a *split* rather than
 * a search: the positions are decided by the caller that interpolated them, and
 * the translator's prose between them is never inspected.
 */
export function splitFencedNotation(sentence: string): ProseSpan[] {
  const spans: ProseSpan[] = []
  sentence.split(NOTATION_FENCE).forEach((piece, index) => {
    push(spans, piece, index % 2 === 1)
  })
  return spans
}
