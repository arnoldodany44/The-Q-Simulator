/**
 * What a thread is about, in words — Fase 5, M5.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS THE ACCESSIBLE HALF OF THE MARKER ON THE CANVAS
 *
 * `CommentMarkers` draws a badge on the anchored cell, and that badge is pixels:
 * it lives in an `aria-hidden` layer over an `aria-hidden` plot, for the reason
 * the presence carets do (`CircuitCanvas.tsx`). So the anchor has to be *said*
 * somewhere, and this is where — one sentence per thread, in the panel, naming
 * the gate, its wire and its column.
 *
 * That is also what makes the panel usable by everybody as an index: a reader who
 * cannot see the canvas, and a reader who simply does not want to hunt across
 * ninety columns, both get the same sentence.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THREE STATES, AND THE THIRD IS THE ONE THIS MILESTONE IS ABOUT
 *
 *   - **A gate.** "H on q0, column 3". The symbol and the wire's name are
 *     notation and are interpolated fenced, so each reaches the DOM inside
 *     `Notation` with `translate="no"` on it — see `lib/prose.ts`. A wire's name
 *     is *user* text (`qubitLabels`), which is exactly why it may not be pasted
 *     into a translated sentence unmarked: a page translator would rewrite
 *     somebody's label.
 *   - **The circuit.** §3.4's original comments, which had no anchor at all. Not
 *     an error and not an orphan: it is a comment about the whole document.
 *   - **A gate that is no longer here.** The anchor names an `operations[].id`
 *     nothing in *this* document carries. The thread is kept, listed, and
 *     labelled — the third of the three answers weighed in `@qsim/contract`'s
 *     `comments.ts`, and the only one where the reader is never misled: they can
 *     read what was said *and* they are told its subject is gone.
 *
 * The distinction is recomputed on every render against the document on screen,
 * because it is a property of the pair (comment, document) rather than of the
 * comment. Undo the deletion and the sentence changes back with no request sent
 * anywhere.
 */

import { qubitsOf, type Circuit } from '@qsim/schema'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { fenceNotation, splitFencedNotation } from '../../lib/prose'
import { gateSymbol, qubitLabel } from '../circuit-editor/operationRoles'
import { operationForAnchor } from './anchors'

export interface AnchorLabelProps {
  /** The document on screen. The anchor is resolved against *this*. */
  readonly circuit: Circuit
  /** `null` for a comment about the circuit as a whole. */
  readonly anchorOpId: string | null
  readonly className?: string
}

export function AnchorLabel({
  circuit,
  anchorOpId,
  className = 'comment-anchor',
}: AnchorLabelProps) {
  const { t } = useTranslation('collab')

  if (anchorOpId === null) {
    return <span className={className}>{t('comments.anchor.circuit')}</span>
  }

  const operation = operationForAnchor(circuit, anchorOpId)
  if (operation === undefined) {
    return (
      <span className={`${className} ${className}--orphaned`}>
        {t('comments.anchor.orphaned')}
      </span>
    )
  }

  /*
   * The topmost wire the operation touches, which is the same cell
   * `anchorCellOf` puts the marker on — a two-wire `cx` gets one sentence about
   * the operation, not one per wire, and it names the wire the badge is drawn on
   * so the words and the pixels point at the same square.
   */
  const wire = Math.min(...qubitsOf(operation))
  const sentence = t('comments.anchor.gate', {
    gate: fenceNotation(gateSymbol(operation.gate, circuit)),
    qubit: fenceNotation(qubitLabel(circuit, wire)),
    column: operation.column,
  })

  return (
    <span className={className}>
      {splitFencedNotation(sentence).map((span, index) => (
        <Fragment key={`${String(index)}:${span.text}`}>
          {span.notation ? <Notation value={span.text} /> : span.text}
        </Fragment>
      ))}
    </span>
  )
}
