/**
 * A colour for a collaborator — M5.3.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT THE PHASE WHEEL, AND WHAT IT IS INSTEAD
 *
 * §10's rule is that **the phase is colour**: a hue is a physical quantity here,
 * `hsl(hue, 85%, 66%)` where the hue is an amplitude's argument. Everything else
 * that has ever needed a colour in this app has borrowed that wheel — the four
 * diff marks, the two noise directions — and each time the argument was the same:
 * a bare hue at the phase saturation and lightness inherits the sweep in
 * `verification/design/token-contrast.test.ts`, which proves that *every* hue at
 * those two values clears 3:1 on all three surfaces.
 *
 * A collaborator may not borrow it, and the reason is not aesthetic. Those other
 * borrowings live in views where no phase is drawn: a version diff shows two
 * circuits, a noise comparison shows two histograms whose bars are *already* the
 * data. A collaborator's cursor is drawn **on the circuit canvas, at the same time
 * as everything else**, and the editor's neighbours — the histogram, the amplitude
 * table, the phasors — are the phase circle itself. A caret in `hsl(200, 85%, 66%)`
 * is the exact colour of an amplitude with a phase of 3.5 radians. It would not be
 * "a similar colour"; it would be that colour, next to it, meaning something else.
 *
 * So a collaborator colour is separated on the two axes the wheel does not use:
 *
 *   - **Saturation and lightness.** 55% and 78% against the wheel's 85% and 66%.
 *     Pale and light where a datum is vivid and mid-toned, which is the same
 *     distinction a pencil annotation has from printed ink. It is the load-bearing
 *     half of the separation, because the hue circle is continuous — there is no
 *     hue anywhere that some phase does not also occupy.
 *   - **Hue, as a bonus that costs nothing.** Eight hues 45° apart starting at
 *     27.5°, an offset chosen so that every one of them is at least 17.5° from
 *     every hue this design system has already given a *meaning* to (§10's four
 *     phase anchors at 0/90/180/270, the four diff hues, the two noise hues). No
 *     smaller distance was available at 45° spacing, and the offset is derived
 *     rather than picked: see `collab-colour.test.ts`, which re-derives it.
 *
 * And the third separator is not a colour at all: **a collaborator colour never
 * fills a shape.** It draws an outline, a caret and a name label, and a name is
 * always attached to it (`PresenceCursors.tsx`). §10's ordering — direction first,
 * number second, hue last — applies here as it does to a phasor: the colour is the
 * reinforcement, and the name is the encoding. Which is also why a hash collision
 * between two peers is a cosmetic event rather than a bug: eight colours cannot
 * distinguish sixteen peers, and they are not what is doing the distinguishing.
 *
 * ── Measured, not asserted ────────────────────────────────────────────────
 *
 * Every hue at 55%/78% clears **7:1** on all three surfaces (worst: 252.5° on
 * `--bg-elevated`, 7.18:1). That is deliberately far above the 3:1 the phase
 * circle is held to, and it is not gold-plating: a phase colour fills a
 * histogram bar tens of pixels wide, while a presence mark is a one-pixel
 * outline, and a hairline needs the headroom a fill does not. It also means the
 * name label can be printed *in* the colour and stay at AA.
 *
 * ── Why the client derives it and the server does not send it ─────────────
 *
 * A colour is a rendering decision, and the frame carries facts. Two properties
 * follow from deriving it from the peer id, which every peer in a session sees:
 * everybody agrees about who is blue (so "the blue cursor" is a thing two people
 * can say to each other), and a peer's colour never changes — not when somebody
 * else leaves, not when the roster is reordered, not when a replica hands out the
 * next slot. Assigning slots on the server would have both properties only for as
 * long as one replica held the whole session.
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * The eight hues, in degrees. See the header for where the 27.5° offset comes
 * from and `collab-colour.test.ts` for its re-derivation.
 *
 * Eight rather than sixteen (`MAX_PEERS_PER_DOCUMENT`) because eight is roughly
 * where a set of hues stops being a set of *names* — at 45° apart they are
 * tellable apart at a glance, and at 22.5° they are not. A ninth peer shares a
 * colour with the first, and the name label is what tells them apart.
 */
export const COLLABORATOR_HUES = [
  27.5, 72.5, 117.5, 162.5, 207.5, 252.5, 297.5, 342.5,
] as const

/** Deliberately not `--phase-saturation`. See the header. */
export const COLLAB_SATURATION_PERCENT = 55

/** Deliberately not `--phase-lightness`. See the header. */
export const COLLAB_LIGHTNESS_PERCENT = 78

/**
 * FNV-1a, 32-bit.
 *
 * A hash rather than an index into the roster, because the property needed is
 * *stability*: a peer that keeps its colour when somebody else leaves. Any
 * well-mixing hash does; this one is eight lines, has no dependency, and gives
 * the same answer in every browser — which is what makes two people able to
 * agree about which cursor is which.
 */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    // The FNV prime, as a sum of shifts: `value * 16777619` overflows the 53-bit
    // mantissa for large inputs and starts losing low bits, which is exactly
    // where a hash needs to be exact.
    value +=
      (value << 1) + (value << 4) + (value << 7) + (value << 8) + (value << 24)
    value >>>= 0
  }
  return value
}

/** The hue this peer is drawn in, in degrees. */
export function collaboratorHue(peerId: string): number {
  const index = hash(peerId) % COLLABORATOR_HUES.length
  return COLLABORATOR_HUES[index] as number
}

/**
 * The colour this peer is drawn in, as a CSS value.
 *
 * Composed here in the same shape `index.css` composes it from
 * `--collab-hue`, so an inline style and a class-styled neighbour cannot become
 * two slightly different colours for one peer — the same reason
 * `phase-colour.ts` and its CSS utilities are checked against each other.
 */
export function collaboratorColour(peerId: string): string {
  return `hsl(${collaboratorHue(peerId)} ${COLLAB_SATURATION_PERCENT}% ${COLLAB_LIGHTNESS_PERCENT}%)`
}
