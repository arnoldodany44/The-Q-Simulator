/**
 * Guided lessons — §3.6, Phase 3.
 *
 * Where things live:
 *   - `format.ts`      the shape of a lesson, and the four decisions behind it
 *   - `patch.ts`       a step's circuit written as a diff from the last one
 *   - `navigation.ts`  what the canvas holds when the reader moves
 *   - `objectives.ts`  whether a build step is done, and why the browser says
 *   - `prose.ts`       notation inside a translated paragraph
 *   - `progress.ts`    the bookmark: two stores, and how they merge
 *   - `catalog/`       the lessons themselves
 *
 * Start at `format.ts`. Everything else is a consequence of it.
 */

export { LessonPlayer } from './LessonPlayer'
export type { LessonPlayerProps } from './LessonPlayer'

export { LessonProse } from './LessonProse'
export { LessonStepPane } from './LessonStepPane'

export {
  LESSON_FOCUS_SELECTORS,
  LESSON_FOCUS_TARGETS,
  baseCircuitOf,
  circuitAtStep,
  lessonKey,
  requiredKeys,
  stepCircuits,
  stepKey,
} from './format'
export type {
  Lesson,
  LessonCheck,
  LessonFocusTarget,
  LessonObjective,
  LessonStep,
} from './format'

export { applyPatch, foldPatches, lessonBaseCircuit } from './patch'
export type { CircuitPatch, PatchResult } from './patch'

export {
  circuitForNavigation,
  solutionCircuit,
  startingCircuit,
} from './navigation'

export {
  DEFAULT_MIN_ENTROPY,
  DEFAULT_MIN_FIDELITY,
  DEFAULT_PROBABILITY_TOLERANCE,
  MAX_LESSON_QUBITS,
  checkObjective,
  lessonState,
} from './objectives'
export type { ObjectiveReading, ObjectiveStatus } from './objectives'

export { splitNotation } from './prose'
export type { ProseSpan } from './prose'

export {
  EMPTY_PROGRESS,
  LESSON_PROGRESS_STORAGE_KEY,
  mergeProgress,
  parseProgress,
  progressFor,
  readStoredProgress,
  writeStoredProgress,
} from './progress'
export type { LessonProgressEntry, LessonProgressMap } from './progress'

export { useLessonProgress } from './useLessonProgress'
export type { LessonProgressStore } from './useLessonProgress'

export { LESSONS, LESSON_SLUGS, lessonAfter, lessonBySlug } from './catalog'

export { LESSONS_PATH, LESSON_ROUTE_PATH, lessonPath } from './paths'
