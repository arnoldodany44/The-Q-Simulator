/**
 * The phase circle, as colour and as direction. Specification §10.
 *
 * Every amplitude has a magnitude and a phase. Most visualisers draw the
 * magnitude and throw the phase away, which is precisely backwards: the phase
 * is what produces interference, and a histogram of magnitudes alone cannot
 * explain why two paths cancel. So the functional palette of this app is not
 * a set of brand colours, it is a function of phase:
 *
 *     hue = phase · 180/π        colour = hsl(hue, 85%, L)
 *
 * The identity in that first equation is the whole idea and the reason
 * `phaseToHue` and `phaseToDegrees` below are the same function under two
 * names: the hue wheel and the phase circle are the same circle. A phase of
 * π and a hue of 180° are one number written twice, so they can never drift
 * apart, and a reader who learns "opposite colours cancel" has learned
 * something true about the physics rather than a convention of this app.
 *
 * ── Why colour is the *second* encoding, never the only one ──────────────
 *
 * A hue wheel is the one chart a colour-blind reader cannot read. Around 8%
 * of men have a red–green deficiency, and the phase circle spends a third of
 * its arc in exactly that confusion. If hue were the only carrier of phase,
 * the signature feature of this app would be unreadable for a large minority
 * of its audience — and unreadable in a way that looks fine, because the
 * chart still has bars and still has numbers.
 *
 * So the encoding is layered, and the ordering is deliberate:
 *
 *   1. **Direction.** The phasor arrow points at the phase. `phasorDirection`
 *      and `phasorRotation` below are the primary channel: an arrow at 90° is
 *      distinguishable from an arrow at 270° with no colour vision at all,
 *      and it is the channel that makes "two opposite phasors cancel" visible
 *      as geometry rather than as a colour coincidence.
 *   2. **Number.** The phase in radians and in degrees, in the amplitude
 *      table and in the phasor's own accessible description. Formatting is
 *      the caller's job, through `Intl.NumberFormat` bound to the active
 *      language — French writes 1,571 rad, and a hardcoded decimal point is
 *      a defect for a third of this app's users (D2).
 *   3. **Hue.** Reinforcement. It is what lets you see at a glance that a
 *      whole row of bars shares a phase, and it is never the only thing
 *      saying so.
 *
 * That ordering also decides what happens under `prefers-reduced-motion`: the
 * phasors stop spinning, but they keep pointing, because direction is the
 * information and rotation is only the animation of it (§10).
 *
 * ── The lightness is 66%, not the 62% §10 first wrote ────────────────────
 *
 * Measured rather than eyeballed, with `contrast.ts`, sweeping the whole
 * circle in quarter-degree steps against the three surfaces a phase colour
 * is ever painted on:
 *
 *     L = 62%   worst hue 240°   3.28:1 on --bg-deep   2.98:1 on --bg-panel
 *                                2.66:1 on --bg-elevated        ← fails
 *     L = 65%   worst hue 240°   3.81 / 3.46 / 3.09             ← 0.09 margin
 *     L = 66%   worst hue 240°   4.02 / 3.65 / 3.26             ← shipped
 *
 * WCAG 2.2 SC 1.4.11 asks 3:1 of graphics required to understand the content,
 * and a histogram bar qualifies twice over: its hue carries the phase, and
 * its *edge against the panel* is what carries the probability. A bar that
 * fades into its background has lost the probability too, so this is not a
 * question about the phase encoding specifically.
 *
 * 65% is where the sweep first crosses the threshold; 66% is the first whole
 * percent that clears it with a margin that survives a renderer rounding a
 * channel. This is the same move §10 already made for `--wire` — hold the
 * hue and the saturation, lift the lightness until it measures, and write
 * down why — so the document and the code stay in agreement.
 *
 * ── The four anchors in §10 are hand-tuned, and the formula wins ─────────
 *
 * §10 prints a table of four swatches and says they come out of the formula.
 * Measured, they do not:
 *
 *     phase   formula (85%, 66%)   §10 swatch   swatch as hsl()      Δhue
 *     0       #F25F5F              #F5445E      351.2°, 90%, 61%     −8.8°
 *     π/2     #A8F25F              #7BE04A      100.4°, 71%, 58%    +10.4°
 *     π       #5FF2F2              #33D6D6      180.0°, 67%, 52%      0.0°
 *     3π/2    #A85FF2              #A24AE0      275.2°, 71%, 58%     +5.2°
 *
 * They are the same four colours a designer would pick by eye off that wheel,
 * within 11° of hue, but with saturation and lightness varying by twenty and
 * nine points respectively. The generative rule is what ships, for a reason
 * that is about the data and not about tidiness: a state of n qubits has 2ⁿ
 * amplitudes and therefore a continuum of phases, not four. A mapping that
 * snapped to hand-tuned swatches at the cardinal phases and interpolated
 * between them would make saturation and lightness jump around the circle —
 * two amplitudes a hundredth of a radian apart would differ in visual weight
 * for no physical reason, and equal phase differences would stop looking
 * equal. One saturation and one lightness for the whole circle is what makes
 * the colour a faithful function of the phase.
 *
 * The anchors are kept below as reference data and the tests hold the mapping
 * to them within the measured 11°, so a future re-tuning of the palette has
 * to argue with a number instead of drifting.
 *
 * Deliberately not imported here: `contrast.ts`. The ratios above are settled
 * at design time, and re-deriving them at render time would put colour-space
 * arithmetic in the hot path of a chart that redraws on every slider tick.
 */

/** One full turn. The phase circle and the hue wheel are both this long. */
export const TAU = 2 * Math.PI

/** §10, unchanged: saturated enough to read as data, on a desaturated UI. */
export const PHASE_SATURATION_PERCENT = 85

/** §10's 62%, lifted to clear 3:1 on every surface — see the header. */
export const PHASE_LIGHTNESS_PERCENT = 66

/**
 * Hue is rounded before it goes into a CSS string. A hundredth of a degree
 * is some four thousand times finer than anything an eye resolves, and a
 * ten-qubit histogram carries 1024 of these strings — printing seventeen
 * significant figures of a hue would be pure payload.
 */
const HUE_STRING_DECIMALS = 2

/**
 * Any real angle folded into `[0, 2π)`, so that −π/2 and 3π/2 are the same
 * phase — which they are, and which callers should never have to arrange.
 *
 * Two guards earn their keep here. A phase a hair below zero (a rounding
 * artefact out of `atan2`, say −1e-18) wraps to a value that is *not*
 * representable as anything below 2π in Float64 and comes back as exactly
 * 2π, breaking the half-open interval this function promises; it is folded
 * to 0 instead. And a non-finite phase — the shape a NaN amplitude takes by
 * the time it reaches a renderer — answers 0 rather than propagating a NaN
 * into a colour string, because a chart that renders one wrong bar is a bug
 * and a chart that renders nothing is an outage.
 */
export function normalizePhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0
  const wrapped = phase - TAU * Math.floor(phase / TAU)
  return wrapped >= TAU || wrapped < 0 ? 0 : wrapped
}

/**
 * The phase as a number of degrees in `[0, 360)`.
 *
 * This is the number the amplitude table shows next to the radian value, and
 * it is the same number `phaseToHue` paints with. See the header: that is the
 * design, not a coincidence to be refactored away.
 */
export function phaseToDegrees(phase: number): number {
  const degrees = (normalizePhase(phase) * 180) / Math.PI
  return degrees >= 360 ? 0 : degrees
}

/** The hue, in degrees, for an amplitude at this phase. §10's `phase · 180/π`. */
export const phaseToHue = phaseToDegrees

/** `hsl(…)` for an amplitude at this phase, ready for a `fill` or a `stroke`. */
export function phaseToColour(phase: number): string {
  const hue = round(phaseToHue(phase), HUE_STRING_DECIMALS)
  // Space-separated CSS Color 4 syntax, matching the `hsl(var(--phase-hue) …)`
  // composition in index.css — a comma-separated form could not take a bare
  // custom property as its hue, and having the two disagree in syntax would
  // invite them to disagree in value.
  return `hsl(${hue} ${PHASE_SATURATION_PERCENT}% ${PHASE_LIGHTNESS_PERCENT}%)`
}

/**
 * The unit vector a phasor at this phase points along, in SVG user space.
 *
 * The y component is negated because SVG's y axis grows downward while the
 * complex plane's grows upward. Without the flip every phasor in the app
 * would be the complex conjugate of the amplitude it describes — a bug that
 * looks like nothing at all until someone checks the sign of an interference
 * term against a textbook.
 */
export function phasorDirection(phase: number): { x: number; y: number } {
  const angle = normalizePhase(phase)
  return { x: Math.cos(angle), y: -Math.sin(angle) }
}

/**
 * The same direction as a value for SVG's `transform="rotate(…)"`, in
 * `[0, 360)`, applied to a marker drawn pointing along +x.
 *
 * SVG's positive rotation is clockwise, the complex plane's is
 * counter-clockwise, so this is the phase negated and folded back into a
 * positive turn. Callers that animate the rotation get a value that only
 * ever increases through a decreasing phase, which is the correct visual:
 * increasing phase spins the arrow anticlockwise.
 */
export function phasorRotation(phase: number): number {
  const degrees = phaseToDegrees(phase)
  return degrees === 0 ? 0 : 360 - degrees
}

/** One cardinal phase of §10's reference table. */
export interface PhaseAnchor {
  /** The phase itself, in radians. */
  readonly phase: number
  /** Its hue, in degrees — `phase · 180/π`. */
  readonly hue: number
  /** The swatch §10 prints for it. Hand-tuned; see the module header. */
  readonly specimen: string
}

/**
 * The four anchors §10 tabulates. Reference data for the tests and for any
 * legend that wants to label the quarter turns; the app paints with the
 * formula, never with these hexes.
 */
export const PHASE_ANCHORS: readonly PhaseAnchor[] = [
  { phase: 0, hue: 0, specimen: '#F5445E' },
  { phase: Math.PI / 2, hue: 90, specimen: '#7BE04A' },
  { phase: Math.PI, hue: 180, specimen: '#33D6D6' },
  { phase: (3 * Math.PI) / 2, hue: 270, specimen: '#A24AE0' },
]

/**
 * How far §10's hand-tuned swatches sit from the hue the formula assigns.
 * Measured at 10.4° (π/2); the bound is the next whole degree, so a swatch
 * re-tuned past the point of being recognisably the same colour fails a test
 * instead of passing unnoticed.
 */
export const ANCHOR_HUE_TOLERANCE_DEGREES = 11

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}
