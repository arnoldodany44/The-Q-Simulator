/**
 * Renders text that is deliberately identical in every language: gate names
 * and symbols (H, CNOT, Rz(θ), √X), ket and amplitude notation (|000⟩,
 * a + bi), proper nouns (Bloch, GHZ, Grover), and package identifiers.
 *
 * The content is passed as a prop rather than as JSX children on purpose.
 * `i18next/no-literal-string` only sees bare text nodes, so routing
 * untranslatable text through this component keeps that rule meaningful:
 * a raw string in JSX stays an error, while this is a recorded decision.
 *
 * `translate="no"` additionally tells browser-level page translators to
 * leave it alone — otherwise Chrome's auto-translate happily turns a CNOT
 * label into something else entirely.
 */
export function Notation({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  return (
    <span className={className} translate="no">
      {value}
    </span>
  )
}
