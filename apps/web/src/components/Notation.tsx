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
import type { Ref, SVGProps } from 'react'

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

/**
 * The same guarantee inside an SVG, where a `<span>` is not allowed.
 *
 * The circuit canvas paints gate symbols as SVG text, so without this the
 * one sanctioned route for invariant notation would stop at the edge of the
 * diagram — and the diagram is where nearly all of the notation lives.
 * Centring is baked in because every label on the canvas is centred on its
 * cell, and a caller that had to remember `textAnchor` would eventually
 * forget it.
 */
/*
 * `translate` is an HTML global attribute, and React's SVG typings do not
 * carry it — but browsers apply it to SVG text all the same, which is the
 * whole reason this component exists. One named cast is preferable to
 * augmenting React's global JSX types, which would let the attribute appear
 * unremarked on every element in the codebase.
 */
const NO_TRANSLATE = {
  translate: 'no',
} as unknown as SVGProps<SVGTextElement>

export function NotationText({
  value,
  x,
  y,
  className,
  ref,
}: {
  value: string
  x: number
  y: number
  className?: string
  /**
   * The element itself, for a caller that has to move the label after React
   * has placed it — the Bloch spheres write their two rotating axis labels
   * from an animation frame rather than from state, exactly as the phasors
   * write their rotation (M0.7b). Plain prop rather than `forwardRef`: React
   * 19 passes `ref` to function components like any other prop, and the
   * wrapper `forwardRef` used to add is now noise.
   */
  ref?: Ref<SVGTextElement>
}) {
  return (
    <text
      {...NO_TRANSLATE}
      ref={ref}
      x={x}
      y={y}
      className={className}
      textAnchor="middle"
      dominantBaseline="central"
    >
      {value}
    </text>
  )
}
