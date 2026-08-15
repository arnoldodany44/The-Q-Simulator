/**
 * The service as a whole, driven through `inject()` — no port is bound and
 * no socket is opened, so these run identically on a laptop and in CI.
 *
 * The assertions cluster around two questions the milestone actually cares
 * about: does a failure leak anything, and does a limit hold.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CircuitSchema, emptyCircuit } from '@qsim/schema'
import { createTestApp, TEST_WEB_ORIGIN } from './testing/app.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from './testing/tokens.js'

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown }
}

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    /*
     * Liveness must not depend on Postgres. If it did, a database blip would
     * restart every replica, and a cold API reconnects no faster than a warm
     * one would have.
     */
    const app = await createTestApp({
      database: {
        probe: () => Promise.reject(new Error('database is down')),
      },
    })

    const response = await app.inject({ method: 'GET', url: '/health/live' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    await app.close()
  })

  it('reports a reachable database', async () => {
    const app = await createTestApp()

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      status: string
      database: { reachable: boolean; latencyMs: number | null }
    }>()
    expect(body.status).toBe('ok')
    expect(body.database.reachable).toBe(true)
    await app.close()
  })

  it('answers 503 when the database is unreachable, and leaks nothing', async () => {
    const app = await createTestApp({
      logger: false,
      database: {
        probe: () =>
          Promise.reject(
            new Error(
              'connect ECONNREFUSED ' +
                'postgresql://postgres:hunter2@db.example.com:6543/postgres'
            )
          ),
      },
    })

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(response.json<{ status: string }>().status).toBe('degraded')
    // The driver's message carries the connection string. It goes to the
    // log, scrubbed; it never goes to a client at all.
    expect(response.body).not.toContain('hunter2')
    expect(response.body).not.toContain('ECONNREFUSED')
    await app.close()
  })

  it('answers rather than hanging when the probe does not come back', async () => {
    // A health check that hangs is worse than one that fails: the platform's
    // probe times out with no answer and the log says nothing.
    const app = await createTestApp({
      database: {
        probe: () => new Promise<void>(() => undefined),
        probeTimeoutMs: 20,
      },
    })

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    await app.close()
  })

  it('is exempt from rate limiting', async () => {
    // A platform probes every few seconds from a handful of addresses;
    // counting those against the per-IP budget is how a healthy service
    // starts failing its own checks.
    const app = await createTestApp({
      envOverrides: { RATE_LIMIT_MAX: '2' },
    })

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/health/live' })
      expect(response.statusCode).toBe(200)
    }
    await app.close()
  })
})

describe('CORS', () => {
  it('allows the configured origin', async () => {
    const app = await createTestApp()

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: {
        origin: TEST_WEB_ORIGIN,
        'access-control-request-method': 'GET',
      },
    })

    expect(response.headers['access-control-allow-origin']).toBe(
      TEST_WEB_ORIGIN
    )
    await app.close()
  })

  it('refuses an origin that is not on the list', async () => {
    const app = await createTestApp()

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://evil.example.com' },
    })

    // The absence of the header is the refusal: the browser blocks the read.
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('never answers with a wildcard', async () => {
    const app = await createTestApp()

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: TEST_WEB_ORIGIN },
    })

    expect(response.headers['access-control-allow-origin']).not.toBe('*')
    await app.close()
  })
})

describe('rate limiting', () => {
  it('cuts off a caller that exceeds the budget', async () => {
    const app = await createTestApp({
      envOverrides: { RATE_LIMIT_MAX: '2' },
    })
    app.get('/test/ping', { config: { auth: 'public' } }, () => ({ ok: true }))
    await app.ready()

    const first = await app.inject({ method: 'GET', url: '/test/ping' })
    const second = await app.inject({ method: 'GET', url: '/test/ping' })
    const third = await app.inject({ method: 'GET', url: '/test/ping' })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(third.statusCode).toBe(429)
    expect(third.json<ErrorBody>().error.code).toBe('RATE_LIMITED')
    expect(third.headers['retry-after']).toBeDefined()
    await app.close()
  })

  it('advertises the remaining budget on a successful response', async () => {
    // A client that can see its remaining budget slows down; one that cannot
    // finds out by being cut off.
    const app = await createTestApp({ envOverrides: { RATE_LIMIT_MAX: '5' } })
    app.get('/test/ping', { config: { auth: 'public' } }, () => ({ ok: true }))
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/test/ping' })

    expect(response.headers['x-ratelimit-limit']).toBe('5')
    expect(response.headers['x-ratelimit-remaining']).toBe('4')
    await app.close()
  })

  it('gives each signed-in user their own budget', async () => {
    /*
     * The point of keying on `sub` rather than on the address: two users
     * behind one NAT must not spend each other's budget. Both requests come
     * from the same injected IP, so a per-IP key alone would 429 the second.
     */
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const app = await createTestApp({
      envOverrides: { RATE_LIMIT_MAX: '1' },
      jwks: createTestJwksCache(endpoint),
    })
    app.get('/test/ping', { config: { auth: 'required' } }, () => ({
      ok: true,
    }))
    await app.ready()

    const alice = await signToken(key, {
      subject: '11111111-1111-4111-8111-111111111111',
    })
    const bob = await signToken(key, {
      subject: '22222222-2222-4222-8222-222222222222',
    })

    const aliceFirst = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers: { authorization: `Bearer ${alice}` },
    })
    const aliceSecond = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers: { authorization: `Bearer ${alice}` },
    })
    const bobFirst = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers: { authorization: `Bearer ${bob}` },
    })

    expect(aliceFirst.statusCode).toBe(200)
    expect(aliceSecond.statusCode).toBe(429)
    expect(bobFirst.statusCode).toBe(200)
    await app.close()
  })

  it('counts a request whose token did not verify', async () => {
    /*
     * The reason authentication resolves before the limiter and rejects
     * after it. If a rejected token skipped the limiter, the one caller who
     * most needs limiting — someone replaying forged tokens — would be the
     * one exempt from it.
     */
    const app = await createTestApp({ envOverrides: { RATE_LIMIT_MAX: '2' } })
    app.get('/test/ping', { config: { auth: 'required' } }, () => ({
      ok: true,
    }))
    await app.ready()

    const headers = { authorization: 'Bearer not.a.jwt' }
    const first = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers,
    })
    const second = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers,
    })
    const third = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers,
    })

    expect(first.statusCode).toBe(401)
    expect(second.statusCode).toBe(401)
    expect(third.statusCode).toBe(429)
    await app.close()
  })

  it('counts a request that matched no route', async () => {
    /*
     * `@fastify/rate-limit` installs no global hook — it appends to each
     * *matched* route's own `onRequest` array — so an unknown path was never
     * counted at all. That is an unauthenticated, unlimited surface: any
     * path, any unsupported verb, as fast as a client can send them, all
     * answered 404 with the budget untouched.
     */
    const app = await createTestApp({ envOverrides: { RATE_LIMIT_MAX: '3' } })
    await app.ready()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/does-not-exist',
      })
      statuses.push(response.statusCode)
    }

    expect(statuses).toEqual([404, 404, 404, 429, 429, 429])
    await app.close()
  })

  it('counts an unsupported verb on a path that exists', async () => {
    const app = await createTestApp({ envOverrides: { RATE_LIMIT_MAX: '2' } })
    await app.ready()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/circuits',
      })
      statuses.push(response.statusCode)
    }

    expect(statuses).toEqual([404, 404, 429, 429])
    await app.close()
  })
})

describe('the error handler', () => {
  it('turns an unexpected throw into a bare 500', async () => {
    const app = await createTestApp()
    app.get('/test/boom', { config: { auth: 'public' } }, () => {
      throw new Error(
        'connection to postgresql://postgres:hunter2@db.example.com/postgres failed'
      )
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/test/boom' })

    expect(response.statusCode).toBe(500)
    const body = response.json<ErrorBody>()
    expect(body.error.code).toBe('INTERNAL_ERROR')
    // Neither the message nor the stack, whatever the exception said.
    expect(response.body).not.toContain('hunter2')
    expect(response.body).not.toContain('at ')
    expect(body.error).not.toHaveProperty('stack')
    await app.close()
  })

  it('maps a Prisma connection error to 503 without repeating it', async () => {
    const app = await createTestApp()
    app.get('/test/db', { config: { auth: 'public' } }, () => {
      throw Object.assign(
        new Error("Can't reach database server at db.example.com:6543"),
        { code: 'P1001' }
      )
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/test/db' })

    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorBody>().error.code).toBe('DATABASE_UNAVAILABLE')
    expect(response.body).not.toContain('db.example.com')
    await app.close()
  })

  it('correlates the body with the response header and the log', async () => {
    const app = await createTestApp()
    app.get('/test/boom', { config: { auth: 'public' } }, () => {
      throw new Error('nope')
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/test/boom' })

    // The request id is the only thing that joins a user's screenshot to the
    // server log line that has the real detail.
    expect(response.json<ErrorBody>().error.requestId).toBe(
      response.headers['x-request-id']
    )
    await app.close()
  })

  it('answers 400 for a body that is not JSON', async () => {
    const app = await createTestApp()
    app.post(
      '/test/echo',
      {
        config: { auth: 'public' },
        schema: { body: z.object({ a: z.string() }) },
      },
      () => ({ ok: true })
    )
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('MALFORMED_JSON')
    await app.close()
  })

  it('answers 413 for a body over the limit', async () => {
    const app = await createTestApp()
    app.post(
      '/test/echo',
      {
        config: { auth: 'public' },
        schema: { body: z.object({ a: z.string() }) },
      },
      () => ({ ok: true })
    )
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) }),
    })

    expect(response.statusCode).toBe(413)
    expect(response.json<ErrorBody>().error.code).toBe('PAYLOAD_TOO_LARGE')
    await app.close()
  })

  it('sets nosniff on every response', async () => {
    const app = await createTestApp()

    const response = await app.inject({ method: 'GET', url: '/health/live' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    await app.close()
  })

  it('answers 415 for text/plain, which Fastify parses by default', async () => {
    /*
     * Fastify ships a `text/plain` parser, so the body arrived as a string,
     * failed the Zod schema, and the caller was told their payload was the
     * wrong shape when the problem was their header. The other unsupported
     * types already answered 415; this was the most common one and did not.
     */
    const app = await createTestApp()
    app.post(
      '/test/echo',
      {
        config: { auth: 'public' },
        schema: { body: z.object({ a: z.string() }) },
      },
      () => ({ ok: true })
    )
    await app.ready()

    for (const contentType of [
      'text/plain',
      'application/xml',
      'application/x-www-form-urlencoded',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': contentType },
        body: '{"a":"ok"}',
      })
      expect(response.statusCode, contentType).toBe(415)
      expect(response.json<ErrorBody>().error.code, contentType).toBe(
        'UNSUPPORTED_MEDIA_TYPE'
      )
    }
    await app.close()
  })
})

describe('errors raised by the router itself', () => {
  /*
   * The one class of response that escaped everything: `setErrorHandler`, the
   * `onSend` hook and CORS all live behind the router, so a path parameter
   * over the limit or an undecodable percent-escape answered in Fastify's own
   * shape — `error` a string rather than the object every client parses —
   * with the caller's URL reflected into the body and no request id, no
   * nosniff and no `Access-Control-Allow-Origin`.
   */

  it('answers an over-long path parameter in the standard envelope', async () => {
    const app = await createTestApp()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/circuits/${'a'.repeat(5000)}`,
    })

    expect(response.statusCode).toBe(414)
    const body = response.json<ErrorBody>()
    expect(typeof body.error).toBe('object')
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.requestId).toEqual(expect.any(String))
    expect(response.headers['x-request-id']).toBe(body.error.requestId)
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    // And the attacker's own URL is no longer reflected back at them.
    expect(response.body).not.toContain('aaaaaaaaaa')
    await app.close()
  })

  it('answers an undecodable URL the same way', async () => {
    const app = await createTestApp()

    for (const url of ['/api/v1/circuits/%', '/api/v1/circuits/%zz%zz']) {
      const response = await app.inject({ method: 'GET', url })
      const body = response.json<ErrorBody>()
      expect(typeof body.error, url).toBe('object')
      expect(body.error.requestId, url).toEqual(expect.any(String))
      expect(response.headers['x-content-type-options'], url).toBe('nosniff')
    }
    await app.close()
  })
})

describe('Zod validation of every input', () => {
  it('rejects a body that does not match, naming the failing paths', async () => {
    const app = await createTestApp()
    app.post(
      '/test/circuits',
      {
        config: { auth: 'public' },
        schema: { body: z.object({ title: z.string().min(1) }) },
      },
      () => ({ ok: true })
    )
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/test/circuits',
      body: { title: 42 },
    })

    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.error.code).toBe('VALIDATION_FAILED')
    // Codes, not sentences: the client owns the wording in three languages.
    expect(body.error.details).toEqual([
      { path: 'body.title', code: 'invalid_type' },
    ])
    await app.close()
  })

  it('validates a circuit with @qsim/schema and nothing else', async () => {
    /*
     * The rule from the milestone brief: where the input is a circuit, the
     * validator is `@qsim/schema`. A second, API-local circuit validator
     * would drift from the one the editor and the engine share, and the
     * drift shows up as a circuit the editor accepts and the server rejects.
     */
    const app = await createTestApp()
    app.post(
      '/test/circuits',
      {
        config: { auth: 'public' },
        schema: { body: z.object({ data: CircuitSchema }) },
      },
      (request) => ({ qubits: request.body.data.qubits })
    )
    await app.ready()

    const accepted = await app.inject({
      method: 'POST',
      url: '/test/circuits',
      body: { data: emptyCircuit(3) },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json<{ qubits: number }>().qubits).toBe(3)

    const rejected = await app.inject({
      method: 'POST',
      url: '/test/circuits',
      // 999 qubits is 2^999 amplitudes; the shared contract caps it at 28.
      body: { data: { ...emptyCircuit(3), qubits: 999 } },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
    await app.close()
  })

  it('rejects a missing body on a route that declares one', async () => {
    const app = await createTestApp()
    app.post(
      '/test/circuits',
      {
        config: { auth: 'public' },
        schema: { body: z.object({ title: z.string() }) },
      },
      () => ({ ok: true })
    )
    await app.ready()

    const response = await app.inject({ method: 'POST', url: '/test/circuits' })

    expect(response.statusCode).toBe(400)
    await app.close()
  })

  it('validates and coerces the query string', async () => {
    // Query values arrive as strings; a numeric field needs `z.coerce`.
    const app = await createTestApp()
    app.get(
      '/test/gallery',
      {
        config: { auth: 'optional' },
        schema: {
          querystring: z.object({ page: z.coerce.number().int().min(1) }),
        },
      },
      (request) => ({ page: request.query.page })
    )
    await app.ready()

    const ok = await app.inject({ method: 'GET', url: '/test/gallery?page=3' })
    expect(ok.json<{ page: number }>().page).toBe(3)

    const bad = await app.inject({ method: 'GET', url: '/test/gallery?page=0' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json<ErrorBody>().error.details).toEqual([
      { path: 'querystring.page', code: 'too_small' },
    ])
    await app.close()
  })

  it('strips anything the response schema did not promise', async () => {
    /*
     * Serialising through the schema rather than stringifying the handler's
     * return value: a projection that grows a column cannot reach a client
     * through a route that never promised it.
     */
    const app = await createTestApp()
    app.get(
      '/test/me',
      {
        config: { auth: 'public' },
        schema: { response: { 200: z.object({ id: z.string() }) } },
      },
      () => ({ id: 'abc', email: 'ada@example.com' })
    )
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/test/me' })

    expect(response.json()).toEqual({ id: 'abc' })
    expect(response.body).not.toContain('ada@example.com')
    await app.close()
  })
})
