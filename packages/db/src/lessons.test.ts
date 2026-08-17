import { describe, expect, it } from 'vitest'

import { prismaLessonRepository } from './lessons.js'
import type { PrismaClient } from './generated/prisma/client.js'

/**
 * The two queries this repository makes, asserted as queries.
 *
 * The behaviour is exercised end to end by `apps/api`'s route test, but that
 * suite runs against an in-memory fake — so the one rule this file exists to
 * pin is the one the fake could agree with while production disagreed:
 * **`completed` is OR-ed, never assigned.** Prisma has no boolean `or`
 * operator, so the false case is expressed as an update that simply leaves the
 * column alone, and that is exactly the kind of thing a refactor "tidies" into
 * `{ stepIndex, completed }` — which would un-finish a lesson every time its
 * reader went back to re-read page one.
 */

interface Call {
  readonly method: 'findMany' | 'upsert'
  readonly args: Record<string, unknown>
}

function stubPrisma(calls: Call[]): PrismaClient {
  const record =
    (method: Call['method']) =>
    (args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, args })
      return Promise.resolve(
        method === 'findMany'
          ? []
          : {
              slug: 'superposition',
              stepIndex: 2,
              completed: true,
              updatedAt: new Date(0),
            }
      )
    }

  return {
    lessonProgress: { findMany: record('findMany'), upsert: record('upsert') },
  } as unknown as PrismaClient
}

const USER = '11111111-1111-4111-8111-111111111111'

describe('listing a reader’s bookmarks', () => {
  it('scopes to the caller and orders by when they last read', async () => {
    const calls: Call[] = []
    await prismaLessonRepository(stubPrisma(calls)).listLessonProgress(USER)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toMatchObject({
      where: { userId: USER },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('selects the four columns of the resource and no user id', async () => {
    const calls: Call[] = []
    await prismaLessonRepository(stubPrisma(calls)).listLessonProgress(USER)

    const select = (calls[0]?.args as { select: Record<string, unknown> })
      .select
    expect(Object.keys(select).sort()).toEqual([
      'completed',
      'slug',
      'stepIndex',
      'updatedAt',
    ])
  })
})

describe('recording where a reader stopped', () => {
  it('upserts on the pair, which is the primary key', async () => {
    const calls: Call[] = []
    await prismaLessonRepository(stubPrisma(calls)).saveLessonProgress({
      userId: USER,
      slug: 'superposition',
      stepIndex: 4,
      completed: false,
    })

    expect(calls[0]?.args).toMatchObject({
      where: { userId_slug: { userId: USER, slug: 'superposition' } },
      create: {
        userId: USER,
        slug: 'superposition',
        stepIndex: 4,
        completed: false,
      },
    })
  })

  it('never writes false over a completed lesson', async () => {
    const calls: Call[] = []
    await prismaLessonRepository(stubPrisma(calls)).saveLessonProgress({
      userId: USER,
      slug: 'superposition',
      stepIndex: 0,
      completed: false,
    })

    // The step moves; the flag is absent from the update entirely, which is
    // how "OR" is spelled without a boolean operator.
    expect(calls[0]?.args).toMatchObject({ update: { stepIndex: 0 } })
    expect(
      Object.hasOwn((calls[0]?.args as { update: object }).update, 'completed'),
      'an update carrying completed: false would un-finish the lesson'
    ).toBe(false)
  })

  it('sets the flag when the reader really has finished', async () => {
    const calls: Call[] = []
    await prismaLessonRepository(stubPrisma(calls)).saveLessonProgress({
      userId: USER,
      slug: 'superposition',
      stepIndex: 6,
      completed: true,
    })

    expect(calls[0]?.args).toMatchObject({
      update: { stepIndex: 6, completed: true },
    })
  })
})
