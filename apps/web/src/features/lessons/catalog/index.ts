/**
 * The lessons, in the order §3.6 lists them.
 *
 * All nine are written: superposition, entanglement, interference,
 * Deutsch–Jozsa, Grover, teleportation, superdense coding, BB84, QPE. The
 * order is a curriculum rather than a menu, the same way `presets.ts`'s six
 * are — each lesson assumes the picture the previous one left behind, which is
 * why the list is an array and the index route walks it in order rather than
 * sorting by anything.
 *
 * The dependencies are real, and each lesson's header names its own. Briefly:
 *
 *   superposition  →  a full-length Bloch arrow is not ignorance
 *   entanglement   →  spends that: two arrows of length zero, one known pair
 *   interference   →  phase decides whether paths add, and marking kills it
 *   Deutsch–Jozsa  →  interference with a job: kickback, one query
 *   Grover         →  kickback plus a reflection, √N times
 *   teleportation  →  a Bell pair as a channel
 *   superdense     →  the same pair, read backwards, plus the accounting
 *   BB84           →  measurement as disturbance, which needs all of the above
 *   QPE            →  kickback with doubling angles; the hardest of the nine
 *
 * A lesson joins this list only once its prose exists in all three catalogs;
 * `lessons.test.ts` fails the build otherwise, so a half-translated lesson
 * cannot reach a reader in the language it is missing.
 */

import type { Lesson } from '../format'
import { bb84 } from './bb84'
import { deutschJozsa } from './deutschJozsa'
import { entanglement } from './entanglement'
import { grover } from './grover'
import { interference } from './interference'
import { qpe } from './qpe'
import { superdenseCoding } from './superdenseCoding'
import { superposition } from './superposition'
import { teleportation } from './teleportation'

export const LESSONS: readonly Lesson[] = [
  superposition,
  entanglement,
  interference,
  deutschJozsa,
  grover,
  teleportation,
  superdenseCoding,
  bb84,
  qpe,
]

export const LESSON_SLUGS: readonly string[] = LESSONS.map(
  (lesson) => lesson.slug
)

/** The lesson at a slug, or `null` — the route renders a sentence for null. */
export function lessonBySlug(slug: string | undefined): Lesson | null {
  if (slug === undefined) return null
  return LESSONS.find((lesson) => lesson.slug === slug) ?? null
}

/** Where a lesson sits in the sequence, for "next up" at the end of one. */
export function lessonAfter(lesson: Lesson): Lesson | null {
  const index = LESSONS.indexOf(lesson)
  if (index === -1) return null
  return LESSONS[index + 1] ?? null
}
