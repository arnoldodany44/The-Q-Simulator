/**
 * Comments anchored to specific gates — §3.4, §11, milestone M5.4.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 *
 * A comment channel is a write path with strangers on it. Every PUBLIC circuit
 * in the gallery accepts comments from anybody with an account, which makes
 * these routes the widest write surface in the API — so most of what is
 * asserted below is made from a STRANGER's or an anonymous point of view, in
 * the manner of `gallery.test.ts` and `collections.test.ts`. That the owner can
 * do things on their own circuit proves nothing.
 *
 * The four questions:
 *
 *   1. Can somebody read a conversation on a circuit they cannot read? (No —
 *      `findReadable`, so a PRIVATE circuit's threads are its owner's alone and
 *      the refusal is a 404 rather than a 403.)
 *   2. Can somebody write into one they cannot read? (No, same door.)
 *   3. Can a stranger resolve or delete somebody else's thread? (No — and the
 *      `where` decides, not the handler.)
 *   4. Does an author's email ever ride out beside their name? (No —
 *      `publicUserSelect` does not select the column.)
 *
 * The anchor's *durability* is not tested here, because it is not a property of
 * these routes: it is a property of the editor's store never rewriting an
 * operation id, and it is tested where that happens —
 * `features/circuit-editor/commentAnchors.test.ts`.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
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

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'
const THIRD_ID = '33333333-3333-4333-8333-333333333333'

interface CommentBody {
  id: string
  body: string
  anchorOpId: string | null
  createdAt: string
  author: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
  }
  viewerCanDelete: boolean
}

interface ThreadBody {
  root: CommentBody
  replies: CommentBody[]
  resolvedAt: string | null
  resolvedBy: { id: string; username: string } | null
  viewerCanResolve: boolean
  viewerCanReply: boolean
}

interface PageBody {
  threads: ThreadBody[]
  page: number
  limit: number
  total: number
  openCount: number
  resolvedCount: number
  anchors: Record<string, { open: number; resolved: number }>
  viewerCanComment: boolean
}

interface ErrorBody {
  error: { code: string; details?: { path: string; code: string }[] }
}

function bell(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  }
}

interface Harness {
  app: ApiInstance
  repository: MemoryCircuitRepository
  owner: Record<string, string>
  stranger: Record<string, string>
  third: Record<string, string>
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

  repository.addUser({ id: OWNER_ID, username: 'ada', displayName: 'Ada L.' })
  repository.addUser({ id: STRANGER_ID, username: 'grace' })
  repository.addUser({ id: THIRD_ID, username: 'alan' })

  const bearer = async (subject: string, email: string) => ({
    authorization: `Bearer ${await signToken(key, { subject, email })}`,
  })

  harness = {
    app,
    repository,
    owner: await bearer(OWNER_ID, 'ada@example.com'),
    stranger: await bearer(STRANGER_ID, 'grace@example.com'),
    third: await bearer(THIRD_ID, 'alan@example.com'),
  }
})

afterEach(async () => {
  await harness.app.close()
})

type Visibility = 'PRIVATE' | 'UNLISTED' | 'PUBLIC'

async function seedCircuit(
  options: { visibility?: Visibility; ownerId?: string } = {}
): Promise<{ id: string; slug: string }> {
  const created = await harness.repository.create({
    ownerId: options.ownerId ?? OWNER_ID,
    title: 'A circuit',
    description: null,
    visibility: options.visibility ?? 'PUBLIC',
    data: bell(),
    message: null,
    forkedFromId: null,
  })
  return { id: created.circuit.id, slug: created.circuit.slug }
}

async function inject(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  options: { headers?: Record<string, string>; body?: object } = {}
) {
  return harness.app.inject({
    method,
    url,
    headers: options.headers ?? {},
    payload: options.body,
  })
}

const commentsUrl = (handle: string, query = ''): string =>
  `/api/v1/circuits/${handle}/comments${query}`

/** Posts a thread and returns it, failing loudly rather than returning null. */
async function post(
  handle: string,
  headers: Record<string, string>,
  body: object
): Promise<CommentBody> {
  const response = await inject('POST', commentsUrl(handle), { headers, body })
  expect(response.statusCode, response.body).toBe(201)
  return response.json<{ comment: CommentBody }>().comment
}

describe('GET /api/v1/circuits/:id/comments', () => {
  it('shows an anonymous reader the threads on a PUBLIC circuit', async () => {
    const circuit = await seedCircuit({ visibility: 'PUBLIC' })
    await post(circuit.slug, harness.stranger, {
      body: 'This H should probably be an Ry.',
      anchorOpId: 'op_1',
    })

    const response = await inject('GET', commentsUrl(circuit.slug))
    expect(response.statusCode).toBe(200)
    const page = response.json<PageBody>()
    expect(page.threads).toHaveLength(1)
    expect(page.threads[0]?.root.anchorOpId).toBe('op_1')
    expect(page.openCount).toBe(1)
    expect(page.resolvedCount).toBe(0)
    /*
     * An anonymous reader may look and may not act, and every capability flag
     * says so. This is the half of read-only that a hidden button does not
     * provide — see the note on `viewerCan*` in the contract.
     */
    expect(page.viewerCanComment).toBe(false)
    expect(page.threads[0]?.viewerCanReply).toBe(false)
    expect(page.threads[0]?.viewerCanResolve).toBe(false)
    expect(page.threads[0]?.root.viewerCanDelete).toBe(false)
  })

  it('never carries the author’s email beside their name', async () => {
    const circuit = await seedCircuit({ visibility: 'PUBLIC' })
    await post(circuit.slug, harness.stranger, { body: 'Nice circuit.' })

    const response = await inject('GET', commentsUrl(circuit.slug))
    /*
     * Asserted against the raw body rather than the parsed author, because the
     * hazard is a field nobody declared riding along — `publicUserSelect` is
     * what keeps the column out of the query, and the response schema is what
     * keeps an undeclared field off the wire. The double writes a real address
     * into the user row precisely so this can fail.
     */
    expect(response.body).not.toContain('example.com')
    expect(response.body).not.toContain('@')
  })

  it('answers 404 on somebody else’s PRIVATE circuit', async () => {
    const circuit = await seedCircuit({ visibility: 'PRIVATE' })

    const anonymous = await inject('GET', commentsUrl(circuit.id))
    expect(anonymous.statusCode).toBe(404)

    const stranger = await inject('GET', commentsUrl(circuit.id), {
      headers: harness.stranger,
    })
    /*
     * 404 and not 403: a 403 would confirm the id names something, which is
     * exactly what §11 refuses to say about a circuit somebody may not read.
     */
    expect(stranger.statusCode).toBe(404)
    expect(stranger.json<ErrorBody>().error.code).toBe('NOT_FOUND')
  })

  it('tallies every anchor in the circuit, not just the page’s', async () => {
    const circuit = await seedCircuit()
    const first = await post(circuit.slug, harness.stranger, {
      body: 'About the H.',
      anchorOpId: 'op_1',
    })
    await post(circuit.slug, harness.third, {
      body: 'About the CNOT.',
      anchorOpId: 'op_2',
    })
    await post(circuit.slug, harness.stranger, { body: 'About the circuit.' })
    await inject('PUT', `${commentsUrl(circuit.slug)}/${first.id}/resolution`, {
      headers: harness.owner,
    })

    // One thread per page, so the tally cannot be a by-product of the page.
    const response = await inject('GET', commentsUrl(circuit.slug, '?limit=1'))
    const page = response.json<PageBody>()
    expect(page.threads).toHaveLength(1)
    /*
     * `op_1`'s only thread is resolved and it still has a marker, which is the
     * decision: a resolved conversation stays findable. The unanchored thread
     * contributes to no anchor at all.
     */
    expect(page.anchors).toEqual({
      op_1: { open: 0, resolved: 1 },
      op_2: { open: 1, resolved: 0 },
    })
  })

  it('filters by anchor and by state without hiding the way back', async () => {
    const circuit = await seedCircuit()
    await post(circuit.slug, harness.stranger, {
      body: 'About the H.',
      anchorOpId: 'op_1',
    })
    const other = await post(circuit.slug, harness.stranger, {
      body: 'About the CNOT.',
      anchorOpId: 'op_2',
    })
    await inject('PUT', `${commentsUrl(circuit.slug)}/${other.id}/resolution`, {
      headers: harness.owner,
    })

    const anchored = await inject(
      'GET',
      commentsUrl(circuit.slug, '?anchorOpId=op_1')
    )
    const page = anchored.json<PageBody>()
    expect(page.threads).toHaveLength(1)
    expect(page.threads[0]?.root.body).toBe('About the H.')
    // Narrowed counts describe the filter; the tally still describes the whole
    // circuit, so the marker on op_2 does not disappear while op_1 is selected.
    expect(page.openCount).toBe(1)
    expect(page.anchors.op_2).toEqual({ open: 0, resolved: 1 })

    const resolved = await inject(
      'GET',
      commentsUrl(circuit.slug, '?state=resolved')
    )
    expect(resolved.json<PageBody>().threads[0]?.root.id).toBe(other.id)

    // And `open` is the default, which is what makes the panel show work first.
    const byDefault = await inject('GET', commentsUrl(circuit.slug))
    expect(byDefault.json<PageBody>().threads).toHaveLength(1)
    expect(byDefault.json<PageBody>().threads[0]?.root.body).toBe(
      'About the H.'
    )
  })
})

describe('POST /api/v1/circuits/:id/comments', () => {
  it('lets a stranger comment on a PUBLIC circuit they do not own', async () => {
    const circuit = await seedCircuit({ visibility: 'PUBLIC' })
    const comment = await post(circuit.slug, harness.stranger, {
      body: 'Why `cx` and not `cz` here?',
      anchorOpId: 'op_2',
    })
    expect(comment.author.username).toBe('grace')
    expect(comment.anchorOpId).toBe('op_2')
    // Their own comment is theirs to remove, and the flag says so.
    expect(comment.viewerCanDelete).toBe(true)
  })

  it('refuses an anonymous poster', async () => {
    const circuit = await seedCircuit()
    const response = await inject('POST', commentsUrl(circuit.slug), {
      body: { body: 'Hello.' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a comment on somebody else’s PRIVATE circuit with 404', async () => {
    const circuit = await seedCircuit({ visibility: 'PRIVATE' })
    const response = await inject('POST', commentsUrl(circuit.id), {
      headers: harness.stranger,
      body: { body: 'Let me in.' },
    })
    expect(response.statusCode).toBe(404)
    expect(harness.repository.allComments()).toHaveLength(0)
  })

  it('accepts an anchor naming an operation that does not exist', async () => {
    /*
     * Deliberate, and the whole reason there is no validation against the
     * document: the server would have to pick *which* document — the head
     * version, an older one, the live session, an unsaved buffer — and those
     * disagree. An anchor that names nothing is the orphan case, which is
     * handled by showing the thread against the circuit and saying so.
     */
    const circuit = await seedCircuit()
    const comment = await post(circuit.slug, harness.stranger, {
      body: 'About a gate that was deleted before I pressed send.',
      anchorOpId: 'op_999',
    })
    expect(comment.anchorOpId).toBe('op_999')
  })

  it('stores a reply under its root, carrying the root’s anchor', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, {
      body: 'This H looks wrong.',
      anchorOpId: 'op_1',
    })
    const reply = await post(circuit.slug, harness.owner, {
      body: 'It is deliberate — see the description.',
      parentId: root.id,
    })

    // The anchor was never sent and is the root's, read from the parent.
    expect(reply.anchorOpId).toBe('op_1')

    const page = (
      await inject('GET', commentsUrl(circuit.slug))
    ).json<PageBody>()
    expect(page.threads).toHaveLength(1)
    expect(page.threads[0]?.replies.map((entry) => entry.body)).toEqual([
      'It is deliberate — see the description.',
    ])
  })

  it('refuses a reply that carries its own anchor', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, {
      body: 'Root.',
      anchorOpId: 'op_1',
    })
    const response = await inject('POST', commentsUrl(circuit.slug), {
      headers: harness.owner,
      body: { body: 'Reply.', parentId: root.id, anchorOpId: 'op_2' },
    })
    /*
     * Refused rather than ignored. A client that sent both believes something
     * about where its comment landed, and dropping the field silently would let
     * it keep believing it.
     */
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
  })

  it('refuses a reply to a reply, naming the field', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, { body: 'Root.' })
    const reply = await post(circuit.slug, harness.owner, {
      body: 'Reply.',
      parentId: root.id,
    })

    const response = await inject('POST', commentsUrl(circuit.slug), {
      headers: harness.third,
      body: { body: 'Reply to a reply.', parentId: reply.id },
    })
    expect(response.statusCode).toBe(400)
    const error = response.json<ErrorBody>().error
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.details?.[0]).toEqual({
      path: 'body.parentId',
      code: 'reply_depth',
    })
  })

  it('refuses a parentId from another circuit as a bad field, not a 404', async () => {
    const first = await seedCircuit()
    const second = await seedCircuit()
    const root = await post(first.slug, harness.stranger, { body: 'Root.' })

    const response = await inject('POST', commentsUrl(second.slug), {
      headers: harness.stranger,
      body: { body: 'Reply.', parentId: root.id },
    })
    /*
     * A 400 naming `body.parentId`, because a 404 on this route reads as "no
     * such circuit" and would send the caller to check the wrong thing.
     */
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.details?.[0]?.path).toBe(
      'body.parentId'
    )
  })

  it('refuses an empty body and one past the length bound', async () => {
    const circuit = await seedCircuit()
    for (const body of ['', '   ', 'x'.repeat(2001)]) {
      const response = await inject('POST', commentsUrl(circuit.slug), {
        headers: harness.stranger,
        body: { body },
      })
      expect(response.statusCode, JSON.stringify(body.length)).toBe(400)
    }
  })

  it('refuses a body carrying a NUL, rather than answering 500', async () => {
    /*
     * One character anybody can type must not be a server fault: Postgres
     * refuses U+0000 in a text column with SQLSTATE 22021, which arrives as a
     * 500. `storableProse` catches it at the edge — and allows `\n`, which a
     * comment genuinely needs.
     */
    const circuit = await seedCircuit()
    const bad = await inject('POST', commentsUrl(circuit.slug), {
      headers: harness.stranger,
      body: { body: 'before\u0000after' },
    })
    expect(bad.statusCode).toBe(400)

    const good = await post(circuit.slug, harness.stranger, {
      body: 'first line\nsecond line',
    })
    expect(good.body).toBe('first line\nsecond line')
  })
})

describe('resolution', () => {
  it('lets the circuit’s owner resolve a stranger’s thread, and reopen it', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, {
      body: 'Is this right?',
      anchorOpId: 'op_1',
    })
    const url = `${commentsUrl(circuit.slug)}/${root.id}/resolution`

    const resolved = await inject('PUT', url, { headers: harness.owner })
    expect(resolved.statusCode).toBe(200)
    const thread = resolved.json<{ thread: ThreadBody }>().thread
    expect(thread.resolvedAt).not.toBeNull()
    expect(thread.resolvedBy?.username).toBe('ada')

    /*
     * A resolved thread stays findable rather than vanishing: it is absent from
     * the default listing and present with `?state=all`, and both counts travel
     * either way so the filter has a number on it.
     */
    const open = (
      await inject('GET', commentsUrl(circuit.slug))
    ).json<PageBody>()
    expect(open.threads).toHaveLength(0)
    expect(open.resolvedCount).toBe(1)
    const all = (
      await inject('GET', commentsUrl(circuit.slug, '?state=all'))
    ).json<PageBody>()
    expect(all.threads).toHaveLength(1)

    const reopened = await inject('DELETE', url, { headers: harness.owner })
    expect(reopened.statusCode).toBe(200)
    const after = reopened.json<{ thread: ThreadBody }>().thread
    expect(after.resolvedAt).toBeNull()
    // Reopening clears the attribution too: "resolved by Ada" beside an open
    // question is a sentence about a state the thread is not in.
    expect(after.resolvedBy).toBeNull()
  })

  it('lets the thread’s author resolve their own thread', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, {
      body: 'Never mind, I misread it.',
    })
    const response = await inject(
      'PUT',
      `${commentsUrl(circuit.slug)}/${root.id}/resolution`,
      { headers: harness.stranger }
    )
    expect(response.statusCode).toBe(200)
  })

  it('refuses a third party who is neither author nor owner', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, {
      body: 'An open question.',
    })
    const response = await inject(
      'PUT',
      `${commentsUrl(circuit.slug)}/${root.id}/resolution`,
      { headers: harness.third }
    )
    expect(response.statusCode).toBe(403)
    /*
     * And the row is untouched — the `where` in `canResolveThreadFilter` is
     * what makes that true, so a route that skipped its check still could not
     * close somebody else's question.
     */
    expect(harness.repository.allComments()[0]?.resolvedAt).toBeNull()
  })

  it('is idempotent, so a retried request does not toggle it back', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.owner, { body: 'Mine.' })
    const url = `${commentsUrl(circuit.slug)}/${root.id}/resolution`

    await inject('PUT', url, { headers: harness.owner })
    const again = await inject('PUT', url, { headers: harness.owner })
    expect(again.statusCode).toBe(200)
    expect(
      again.json<{ thread: ThreadBody }>().thread.resolvedAt
    ).not.toBeNull()
  })

  it('answers 404 for a reply, which has no resolution to set', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.owner, { body: 'Root.' })
    const reply = await post(circuit.slug, harness.owner, {
      body: 'Reply.',
      parentId: root.id,
    })
    const response = await inject(
      'PUT',
      `${commentsUrl(circuit.slug)}/${reply.id}/resolution`,
      { headers: harness.owner }
    )
    // 404 rather than 403: a thread with this id does not exist.
    expect(response.statusCode).toBe(404)
  })
})

describe('DELETE /api/v1/circuits/:id/comments/:commentId', () => {
  it('lets an author remove their own comment', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, { body: 'Oops.' })
    const response = await inject(
      'DELETE',
      `${commentsUrl(circuit.slug)}/${root.id}`,
      { headers: harness.stranger }
    )
    expect(response.statusCode).toBe(204)
    expect(harness.repository.allComments()).toHaveLength(0)
  })

  it('lets the circuit’s owner moderate a stranger’s comment', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, { body: 'Spam.' })
    const response = await inject(
      'DELETE',
      `${commentsUrl(circuit.slug)}/${root.id}`,
      { headers: harness.owner }
    )
    expect(response.statusCode).toBe(204)
  })

  it('refuses a third party, and leaves the row alone', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.stranger, { body: 'Mine.' })
    const response = await inject(
      'DELETE',
      `${commentsUrl(circuit.slug)}/${root.id}`,
      { headers: harness.third }
    )
    expect(response.statusCode).toBe(403)
    expect(harness.repository.allComments()).toHaveLength(1)
  })

  it('takes a thread’s replies with its root', async () => {
    const circuit = await seedCircuit()
    const root = await post(circuit.slug, harness.owner, { body: 'Root.' })
    await post(circuit.slug, harness.stranger, {
      body: 'A reply by somebody else.',
      parentId: root.id,
    })
    expect(harness.repository.allComments()).toHaveLength(2)

    await inject('DELETE', `${commentsUrl(circuit.slug)}/${root.id}`, {
      headers: harness.owner,
    })
    /*
     * By `ON DELETE CASCADE` on `Comment.parentId`, added in M5.4 — which is
     * what retired the hand-written reply sweep in `@qsim/db`'s `accounts.ts`.
     * A reply left pointing at a root that no longer exists would be a comment
     * nobody can read and nobody can delete.
     */
    expect(harness.repository.allComments()).toHaveLength(0)
  })

  it('answers 404 for a comment on another circuit', async () => {
    const first = await seedCircuit()
    const second = await seedCircuit()
    const root = await post(first.slug, harness.owner, { body: 'Root.' })

    const response = await inject(
      'DELETE',
      `${commentsUrl(second.slug)}/${root.id}`,
      { headers: harness.owner }
    )
    expect(response.statusCode).toBe(404)
    expect(harness.repository.allComments()).toHaveLength(1)
  })
})

describe('UNLISTED circuits', () => {
  it('are commentable by slug and unreachable by id', async () => {
    const circuit = await seedCircuit({ visibility: 'UNLISTED' })

    const bySlug = await inject('GET', commentsUrl(circuit.slug))
    expect(bySlug.statusCode).toBe(200)

    /*
     * The slug is the credential (§11) and the id is not — `idAddressable`
     * refuses UNLISTED, which is what keeps a leaked id from opening a circuit
     * that was never published. The comment routes inherit that for free by
     * going through `findReadable`, and this is the assertion that they do.
     */
    const byId = await inject('GET', commentsUrl(circuit.id))
    expect(byId.statusCode).toBe(404)
  })
})
