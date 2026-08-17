/**
 * Comments anchored to specific gates — §3.4, §14 (Fase 5, M5.4).
 *
 * The shape in one paragraph: a comment carries `anchorOpId`, an
 * `operations[].id` from §6 that survives a column being inserted, a qubit
 * reordering and the gate being dragged, because the editor's store never
 * rewrites an operation's id and never reuses one. Nothing stored anywhere
 * records whether that id still names an operation — `anchors.ts` answers that
 * on every render against the document on screen, which is the only place the
 * question has one answer. A resolved anchor gets a badge on the canvas
 * (`CommentMarkers`) and a sentence in the panel (`AnchorLabel`); an unresolved
 * one gets the sentence alone, saying its subject is gone.
 *
 * Nothing here reaches into `features/circuit-editor` except `geometry.ts`,
 * `operationRoles.ts` and the store's public interface, and the editor reaches
 * back into nothing here — the same one-way arrow `features/collab` has.
 */

export { AnchorLabel } from './AnchorLabel'
export type { AnchorLabelProps } from './AnchorLabel'

export { CommentBody } from './CommentBody'
export type { CommentBodyProps } from './CommentBody'

export { CommentMarkerLayer, CommentMarkers } from './CommentMarkers'
export type {
  CommentMarkerLayerProps,
  CommentMarkersProps,
} from './CommentMarkers'

export { DEFAULT_COMMENT_VIEW } from './view'
export type { CommentView } from './view'

export { CommentThreadView } from './CommentThreadView'
export type { CommentThreadViewProps } from './CommentThreadView'

export { CommentsPanel } from './CommentsPanel'
export type { CommentsPanelProps } from './CommentsPanel'

export { anchorCellOf, operationForAnchor, resolveAnchors } from './anchors'
export type { AnchorCell, AnchorResolution } from './anchors'
