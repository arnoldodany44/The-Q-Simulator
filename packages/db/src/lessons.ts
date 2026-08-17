/**
 * Lesson bookmarks — §3.6, Phase 3.
 *
 * The smallest repository in this package, and its smallness is the design.
 * A lesson lives in `apps/web`: its prose is in the i18n catalogs, its
 * circuits and objectives are TypeScript, and the set of lessons changes with
 * a deploy of the client. The only thing this side has any business knowing is
 * where a reader stopped.
 *
 * ── Two rows this deliberately does not have ──────────────────────────────
 *
 * There is no `Lesson` table, so `slug` carries no foreign key. The trade is
 * written out in the migration: a row may name a lesson that no longer exists,
 * and in exchange adding a lesson is a deploy of the browser app rather than a
 * migration of the one shared database.
 *
 * There is no circuit column. Resuming mid-build would mean a second,
 * unversioned copy of `CircuitVersion.data` with §11's visibility question
 * reopened for it, to save a reader from placing two gates.
 *
 * ── Why an upsert and not an update ───────────────────────────────────────
 *
 * The route is a `PUT` on `(caller, slug)` and there is no `POST` — the client
 * always knows the whole address before it writes, so the first write and the
 * hundredth must be the same call. `upsert` on the primary key is exactly
 * that, and it means a client that is unsure whether its last write landed can
 * simply send it again.
 *
 * ── `stepIndex` moves in both directions, and `completed` only forwards ───
 *
 * Going back to re-read step 2 is a real thing to do, so the bookmark follows
 * the reader rather than tracking a high-water mark. `completed` is the
 * opposite: it records that the end was reached *at some point*, so it is
 * OR-ed with what is stored rather than overwritten. Without that, opening a
 * finished lesson and reading the first page again would un-finish it.
 */

import type { PrismaClient } from './generated/prisma/client.js'

export interface LessonProgressRecord {
  readonly slug: string
  readonly stepIndex: number
  readonly completed: boolean
  readonly updatedAt: Date
}

export interface SaveLessonProgressInput {
  readonly userId: string
  readonly slug: string
  readonly stepIndex: number
  readonly completed: boolean
}

export interface LessonRepository {
  /** Every lesson this caller has a bookmark in, most recently read first. */
  listLessonProgress(userId: string): Promise<LessonProgressRecord[]>

  /**
   * Records where the caller stopped in one lesson, creating the row if this
   * is the first time. Idempotent — see the header.
   */
  saveLessonProgress(
    input: SaveLessonProgressInput
  ): Promise<LessonProgressRecord>
}

const lessonProgressSelect = {
  slug: true,
  stepIndex: true,
  completed: true,
  updatedAt: true,
} as const

export function prismaLessonRepository(prisma: PrismaClient): LessonRepository {
  return {
    listLessonProgress(userId) {
      return prisma.lessonProgress.findMany({
        where: { userId },
        // A prefix scan of the primary key, then a sort of at most nine rows —
        // §3.6 plans nine lessons, so there is no page and no cursor here.
        orderBy: { updatedAt: 'desc' },
        select: lessonProgressSelect,
      })
    },

    saveLessonProgress({ userId, slug, stepIndex, completed }) {
      return prisma.lessonProgress.upsert({
        where: { userId_slug: { userId, slug } },
        create: { userId, slug, stepIndex, completed },
        /*
         * `completed` is OR-ed rather than assigned, and it cannot be done in
         * a single `update` expression — Prisma has no boolean `or` operator —
         * so the false case simply leaves the column alone. Writing `false`
         * over a `true` is the one update this row must never make: it would
         * un-finish a lesson the moment its author went back to re-read a page.
         */
        update: completed ? { stepIndex, completed: true } : { stepIndex },
        select: lessonProgressSelect,
      })
    },
  }
}
