import { describe, expect, it } from 'vitest'

import {
  LessonSlugParams,
  MAX_LESSON_SLUG_LENGTH,
  MAX_LESSON_STEP_INDEX,
  UpdateLessonProgressBody,
  wireLessonResponses,
} from './lessons.js'
import { lessonPath } from './paths.js'

/**
 * The bookmark's wire contract.
 *
 * The interesting assertions are all about the slug, because the API has no
 * lesson table by design: it cannot ask whether a slug names anything, so the
 * *shape* is the whole of the check, and it is what stands between a path
 * parameter and a column.
 */

describe('the lesson slug', () => {
  it.each(['superposition', 'deutsch-jozsa', 'bb84', 'qpe2'])(
    'accepts "%s"',
    (slug) => {
      expect(LessonSlugParams.safeParse({ slug }).success).toBe(true)
    }
  )

  it.each([
    ['Superposition', 'an uppercase letter'],
    ['a lesson', 'a space'],
    ['../etc/passwd', 'a path'],
    ['-leading', 'a leading hyphen'],
    ['trailing-', 'a trailing hyphen'],
    ['double--hyphen', 'an empty segment'],
    ['', 'nothing at all'],
  ])('refuses "%s" (%s)', (slug) => {
    expect(LessonSlugParams.safeParse({ slug }).success).toBe(false)
  })

  it('refuses a slug longer than a column should hold', () => {
    const long = 'a'.repeat(MAX_LESSON_SLUG_LENGTH + 1)
    expect(LessonSlugParams.safeParse({ slug: long }).success).toBe(false)
  })
})

describe('the body of a bookmark write', () => {
  it('takes a step and a completion flag', () => {
    const parsed = UpdateLessonProgressBody.safeParse({
      stepIndex: 3,
      completed: false,
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a step that is negative, fractional or absurd', () => {
    for (const stepIndex of [-1, 1.5, MAX_LESSON_STEP_INDEX + 1]) {
      expect(
        UpdateLessonProgressBody.safeParse({ stepIndex, completed: false })
          .success,
        `stepIndex ${stepIndex}`
      ).toBe(false)
    }
  })

  /*
   * `completed` is required rather than defaulted. A default of `false` would
   * mean a client that forgot the field claimed the lesson was unfinished,
   * and the server ORs the flag — so the claim would be ignored rather than
   * corrected, which is a silent disagreement between the two ends.
   */
  it('requires the completion flag rather than defaulting it', () => {
    expect(UpdateLessonProgressBody.safeParse({ stepIndex: 0 }).success).toBe(
      false
    )
  })
})

describe('what comes back', () => {
  it('parses an ISO timestamp into a Date', () => {
    const parsed = wireLessonResponses.LessonProgressResponse.parse({
      slug: 'superposition',
      stepIndex: 2,
      completed: true,
      updatedAt: '2026-08-16T10:00:00.000Z',
    })
    expect(parsed.updatedAt).toBeInstanceOf(Date)
  })

  it('answers the whole list in one envelope, with no page', () => {
    const parsed = wireLessonResponses.LessonProgressListResponse.parse({
      items: [],
    })
    expect(parsed).toEqual({ items: [] })
  })
})

describe('lessonPath', () => {
  it('builds both routes, encoding the segment', () => {
    expect(lessonPath.progress()).toBe('/lessons/progress')
    expect(lessonPath.item('superposition')).toBe(
      '/lessons/superposition/progress'
    )
    expect(lessonPath.item('a/b')).toBe('/lessons/a%2Fb/progress')
  })

  it('never leaves Fastify parameter notation in a built path', () => {
    for (const path of [lessonPath.progress(), lessonPath.item('x')]) {
      expect(path).not.toMatch(/:[A-Za-z]/)
    }
  })
})
