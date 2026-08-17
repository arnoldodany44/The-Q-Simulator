/**
 * One formatter for every fidelity this feature prints — §3.6, D2/§1.1.
 *
 * ── WHY IT IS SHARED ──────────────────────────────────────────────────────
 *
 * The brief shows the fidelity a learner must reach and the verdict shows the
 * one they achieved. They are the same quantity under the same definition,
 * |⟨ψ|φ⟩|², and the entire point of showing both is that a reader compares
 * one against the other. They were formatted differently: the threshold went
 * through an `Intl` percent formatter and read `99 %`, the achievement went
 * through a three-decimal number formatter and read `0.985`, and nothing on
 * screen said the two were commensurable. One function, so they cannot drift
 * again.
 *
 * ── WHY IT TAKES A LANGUAGE ───────────────────────────────────────────────
 *
 * Both formatters used to pass `undefined`, which resolves to the RUNTIME's
 * default locale — `navigator.language` — and not to the language the reader
 * chose. So a reader on `fr` saw English decimal points while the lesson
 * player two panes away, in the same product, wrote `0,833` correctly. D2's
 * §1.1 names `Intl.NumberFormat` per locale as one of the four things the
 * trilingual decision costs; this is where that was not paid.
 *
 * ── WHY THREE DECIMALS ────────────────────────────────────────────────────
 *
 * The default threshold is 0.99, so two would round a near miss into a pass on
 * screen.
 */
export function fidelityFormat(language: string): Intl.NumberFormat {
  return new Intl.NumberFormat(language, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })
}
