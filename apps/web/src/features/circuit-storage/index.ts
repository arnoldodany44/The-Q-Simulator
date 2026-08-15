/**
 * Where a circuit lives when it is not only in the address bar — M1.4a.
 *
 * The shape in one paragraph: `useCircuitDocument` turns a `/c/:slug` into an
 * open document — fetching it, seeding the editor exactly once, and tracking
 * which immutable version that document descends from; `documentBinding` is
 * where that descent is held so it survives the route swap the first save
 * causes; `useSaveCircuit` performs a save as the three steps it really is —
 * check, write, check what the write returned; `saveDecisions` holds the rules
 * those steps apply, with no React and no network in them; and
 * `SaveCircuitPanel` is the control, which is an invitation to sign in for a
 * visitor who has no account and never a button that can only fail.
 *
 * M1.4b adds the other half of §3.4: `circuitDiff` compares two versions by
 * operation identity and position rather than as text, `CircuitDiffView` draws
 * that comparison on a circuit diagram, `VersionHistoryPanel` lists the
 * history, `versionParams` puts the version being looked at in the address,
 * and `VersionPreview` shows a past version beside the editing session —
 * never inside it — with the restore that appends it as a new version.
 *
 * Nothing here decides who may save what. §11 puts that on the server: every
 * route this directory calls is authorised in `apps/api`, and the most a
 * control here does is decline to offer an action that would be answered with
 * a 403 — while still handling the 403 that arrives anyway, because the answer
 * can change between the paint and the click.
 */

export { SaveCircuitPanel } from './SaveCircuitPanel.js'
export type { SaveCircuitPanelProps } from './SaveCircuitPanel.js'

export { CircuitDiffView } from './CircuitDiffView.js'
export type { CircuitDiffViewProps } from './CircuitDiffView.js'

export { VersionHistoryPanel } from './VersionHistoryPanel.js'
export type { VersionHistoryPanelProps } from './VersionHistoryPanel.js'

export { VersionPreview } from './VersionPreview.js'
export type { VersionPreviewProps } from './VersionPreview.js'

export {
  DIFF_ASPECTS,
  DIFF_KINDS,
  changedEntries,
  diffCircuits,
  operationCells,
} from './circuitDiff.js'
export type {
  CircuitDiff,
  DiffAspect,
  DiffEntry,
  DiffKind,
  RegisterChange,
} from './circuitDiff.js'

export {
  COMPARE_PARAM,
  MAX_VERSION_NUMBER,
  NO_VERSION_SELECTED,
  VERSION_PARAM,
  versionSearch,
  versionSelection,
} from './versionParams.js'
export type { VersionSelection } from './versionParams.js'

export { useVersionSelection } from './useVersionSelection.js'
export type { VersionSelectionView } from './useVersionSelection.js'

export {
  CIRCUIT_ROUTE_PATH,
  NEW_CIRCUIT_PATH,
  circuitPagePath,
} from './paths.js'

export { PAGE_PARAM, pageFromSearch } from './pagination.js'

export { createDocumentBinding, useDocumentBinding } from './documentBinding.js'
export type {
  DocumentBase,
  DocumentBindingState,
  DocumentBindingStore,
} from './documentBinding.js'

export {
  SAVE_PROBLEMS,
  descriptionProblem,
  messageProblem,
  optionalText,
  racedOn,
  staleAgainst,
  titleProblem,
} from './saveDecisions.js'
export type { RacedSave, SaveProblem, StaleSave } from './saveDecisions.js'

export { useCircuitDocument } from './useCircuitDocument.js'
export type {
  CircuitDocumentOptions,
  CircuitDocumentView,
} from './useCircuitDocument.js'

export { useSaveCircuit } from './useSaveCircuit.js'
export type {
  CircuitDetails,
  SaveMutation,
  SaveResult,
  SaveVariables,
} from './useSaveCircuit.js'

export { useUnsavedWork } from './useUnsavedWork.js'
export type { UnsavedWorkOptions } from './useUnsavedWork.js'
