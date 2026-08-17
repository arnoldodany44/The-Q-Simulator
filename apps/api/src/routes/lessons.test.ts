/**
 * Lesson bookmarks — §3.6, §8, Phase 3.
 *
 * Three properties, and the first is the one that matters most because it is
 * the one an authorisation bug would break silently:
 *
 *   1. **A bookmark belongs to the token, not to a parameter.** There is no
 *      route for reading somebody else's, and two accounts writing the same
 *      slug must not see one another's number.
 *   2. **`PUT` is idempotent and moves in both directions**, because going
 *      back to re-read a step is a real thing to do — while `completed` only
 *      goes forward, so re-reading page one of a finished lesson does not
 *      un-finish it.
 *   3. **The slug is validated, not resolved.** The API has no lesson table on
 *      purpose (see the route header), so an unknown-but-well-formed slug is
 *      stored and a malformed one is refused.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type { MemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'

const READER_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_ID = '44444444-4444-4444-8444-444444444444'
const PROGRESS = '/api/v1/lessons/progress'

const lessonPath = (slug: string): string =>
  `/api/v1/lessons/${encodeURIComponent(slug)}/progress`

interface ProgressBody {
  progress: { slug: string; stepIndex: number; completed: boolean }
}

interface ListBody {
  items: { slug: string; stepIndex: number; completed: boolean }[]
}

interface Harness {
  app: ApiInstance
  repository: MemoryCircuitRepository
  reader: Record<string, string>
  other: Record<string, string>
}

let harness: Harness

beforeEach(async () => {
  const key = await createSigningKey('key-1')
  const repository = createMemoryCircuitRepository()
  const app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
    circuits: { repository },
  })
  await app.ready()

  harness = {
    app,
    repository,
    reader: {
      authorization: `Bearer ${await signToken(key, {
        subject: READER_ID,
        email: 'reader@example.com',
        userMetadata: {},
      })}`,
    },
    other: {
      authorization: `Bearer ${await signToken(key, {
        subject: OTHER_ID,
        email: 'other@example.com',
        userMetadata: {},
      })}`,
    },
  }
})

afterEach(async () => {
  await harness.app.close()
})

/**
 * A body, as Fastify's injector types one.
 *
 * Deliberately not `unknown`: the deliberately-invalid payloads below are
 * still *objects*, and typing this as `unknown` would hide a call that passed
 * something `inject` cannot serialise at all.
 */
type Payload = Record<string, unknown>

function save(
  headers: Record<string, string>,
  slug: string,
  payload: Payload
): Promise<{ statusCode: number; body: string }> {
  return harness.app.inject({
    method: 'PUT',
    url: lessonPath(slug),
    headers,
    payload,
  })
}

function list(
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return harness.app.inject({ method: 'GET', url: PROGRESS, headers })
}

describe('lesson progress', () => {
  it('refuses both routes without a session', async () => {
    expect(
      (await harness.app.inject({ method: 'GET', url: PROGRESS })).statusCode
    ).toBe(401)
    expect(
      (
        await harness.app.inject({
          method: 'PUT',
          url: lessonPath('superposition'),
          payload: { stepIndex: 1, completed: false },
        })
      ).statusCode
    ).toBe(401)
  })

  it('answers an empty list for a reader who has never opened one', async () => {
    const response = await list(harness.reader)
    expect(response.statusCode).toBe(200)
    expect((JSON.parse(response.body) as ListBody).items).toEqual([])
  })

  it('records where a reader stopped and reads it back', async () => {
    const written = await save(harness.reader, 'superposition', {
      stepIndex: 3,
      completed: false,
    })
    expect(written.statusCode).toBe(200)
    expect((JSON.parse(written.body) as ProgressBody).progress).toMatchObject({
      slug: 'superposition',
      stepIndex: 3,
      completed: false,
    })

    const read = await list(harness.reader)
    expect((JSON.parse(read.body) as ListBody).items).toMatchObject([
      { slug: 'superposition', stepIndex: 3, completed: false },
    ])
  })

  it('is idempotent, and moves backwards as well as forwards', async () => {
    await save(harness.reader, 'superposition', {
      stepIndex: 6,
      completed: true,
    })
    await save(harness.reader, 'superposition', {
      stepIndex: 6,
      completed: true,
    })
    // Going back to re-read step 2: the bookmark follows the reader.
    const back = await save(harness.reader, 'superposition', {
      stepIndex: 2,
      completed: false,
    })

    const progress = (JSON.parse(back.body) as ProgressBody).progress
    expect(progress.stepIndex).toBe(2)
    // …and re-reading does not un-finish it. This is the assertion that keeps
    // `completed` an OR rather than an assignment.
    expect(progress.completed).toBe(true)

    const read = await list(harness.reader)
    expect((JSON.parse(read.body) as ListBody).items).toHaveLength(1)
  })

  it('keeps two readers of the same lesson apart', async () => {
    await save(harness.reader, 'superposition', {
      stepIndex: 5,
      completed: true,
    })
    await save(harness.other, 'superposition', {
      stepIndex: 1,
      completed: false,
    })

    const mine = (JSON.parse((await list(harness.reader)).body) as ListBody)
      .items
    const theirs = (JSON.parse((await list(harness.other)).body) as ListBody)
      .items

    expect(mine).toMatchObject([{ stepIndex: 5, completed: true }])
    expect(theirs).toMatchObject([{ stepIndex: 1, completed: false }])
  })

  it('stores a slug it cannot resolve, and refuses one that is malformed', async () => {
    // No lesson table exists, deliberately — a lesson is a file in apps/web.
    const unknown = await save(harness.reader, 'not-a-lesson-yet', {
      stepIndex: 0,
      completed: false,
    })
    expect(unknown.statusCode).toBe(200)

    for (const slug of ['Superposition', 'a lesson', '../etc', '-leading']) {
      expect(
        (await save(harness.reader, slug, { stepIndex: 0, completed: false }))
          .statusCode,
        `"${slug}" should not be a lesson slug`
      ).toBe(400)
    }
  })

  it('refuses a step index that is negative or absurd', async () => {
    expect(
      (
        await save(harness.reader, 'superposition', {
          stepIndex: -1,
          completed: false,
        })
      ).statusCode
    ).toBe(400)
    expect(
      (
        await save(harness.reader, 'superposition', {
          stepIndex: 100_000,
          completed: false,
        })
      ).statusCode
    ).toBe(400)
  })

  it('never returns a bookmark to somebody who did not write it', async () => {
    await save(harness.reader, 'superposition', {
      stepIndex: 4,
      completed: false,
    })
    const theirs = (JSON.parse((await list(harness.other)).body) as ListBody)
      .items
    expect(theirs).toEqual([])
  })
})
