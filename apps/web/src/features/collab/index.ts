/**
 * Real-time collaboration — §3.4, §8, §14 (Fase 5).
 *
 * The shape in one paragraph: a circuit is a Y.Doc (`@qsim/collab`), the store
 * still judges every local edit, and `circuitDocument.ts` bridges the two in both
 * directions without letting them chase each other. `collabSession.ts` is the
 * browser's end of §8's `circuit:<id>` — one socket, one join, one presence
 * heartbeat — and `useCollabSession` ties its lifetime to a component. Presence
 * is ephemeral and never part of the document: a caret is drawn by
 * `PresenceCursors` over the canvas and said in words by `PresenceRoster`, which
 * is the accessible half of the pair.
 *
 * What a *page* needs from all of that is three imports, and they are the first
 * three below: the hook, the layer the canvas draws, and the panel that says who
 * is here, whether this session is writable, and what the document holds that the
 * canvas cannot (M5.6). Everything else is exported for the tests and the
 * verification suites that drive the layers directly.
 *
 * Nothing here reaches into `features/circuit-editor` except `geometry.ts`,
 * `operationRoles.ts` and the store's public interface, and the editor reaches
 * back into nothing here — `.dependency-cruiser.cjs` keeps that arrow pointing
 * one way, because a solo editor must not download a CRDT to find out it is solo.
 */

export { useCollabSession } from './useCollabSession'
export type {
  CollabSessionView,
  UseCollabSessionOptions,
} from './useCollabSession'

export { PresenceCursorLayer, PresenceCursors } from './PresenceCursors'
export type {
  PresenceCursorLayerProps,
  PresenceCursorsProps,
} from './PresenceCursors'

export { CollabPanel } from './CollabPanel'
export type { CollabPanelProps } from './CollabPanel'

export { DeferredOperations, MAX_LISTED_DEFERRALS } from './DeferredOperations'
export type { DeferredOperationsProps } from './DeferredOperations'

export { PresenceRoster } from './PresenceRoster'
export type { PresenceRosterProps } from './PresenceRoster'

export { applyRepair, repairFor, revealBlockers } from './deferredResolution'
export type { DeferralRepair } from './deferredResolution'

export { createPresenceStore } from './presence'
export type {
  PeerPresence,
  PresenceEvent,
  PresenceSnapshot,
  PresenceStore,
} from './presence'
