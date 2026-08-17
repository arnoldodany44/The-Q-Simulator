import { describe, expect, it } from 'vitest'
import { ApiError, ERROR_DEFINITIONS, toApiError } from './errors.js'

describe('ApiError', () => {
  it('carries the status its code declares', () => {
    expect(new ApiError('NOT_FOUND').statusCode).toBe(404)
    expect(new ApiError('RATE_LIMITED').statusCode).toBe(429)
  })

  it('serialises to code, message and request id', () => {
    const body = new ApiError('AUTH_REQUIRED').toResponse('req-1')

    expect(body).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: ERROR_DEFINITIONS.AUTH_REQUIRED.message,
        requestId: 'req-1',
      },
    })
  })

  it('never serialises the cause', () => {
    // The cause is for the log. A Prisma error's message is a connection
    // string, and this is the object that gets JSON-encoded to a client.
    const error = new ApiError('INTERNAL_ERROR', {
      cause: new Error('postgresql://postgres:hunter2@db.example.com/postgres'),
    })

    expect(JSON.stringify(error.toResponse('req-1'))).not.toContain('hunter2')
  })

  it('accepts an assigned statusCode', () => {
    /*
     * Fastify's validation pipeline writes `err.statusCode` and `err.code`
     * when it wraps a rejected schema. An accessor with no setter would
     * throw at exactly that point, which is why these are plain fields.
     */
    const error = new ApiError('VALIDATION_FAILED')

    expect(() => {
      error.statusCode = 400
    }).not.toThrow()
  })
})

describe('toApiError', () => {
  it('passes an ApiError through unchanged', () => {
    const original = new ApiError('FORBIDDEN')

    expect(toApiError(original)).toBe(original)
  })

  it('maps Fastify validation failures', () => {
    expect(
      toApiError({ code: 'FST_ERR_VALIDATION', statusCode: 400 }).code
    ).toBe('VALIDATION_FAILED')
  })

  it('maps an unreadable body to MALFORMED_JSON', () => {
    expect(toApiError({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY' }).code).toBe(
      'MALFORMED_JSON'
    )
  })

  it('maps an unsupported content type to 415', () => {
    const mapped = toApiError({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' })

    expect(mapped.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(mapped.statusCode).toBe(415)
  })

  it('maps an oversized body to 413', () => {
    expect(toApiError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }).code).toBe(
      'PAYLOAD_TOO_LARGE'
    )
  })

  it('maps a Prisma connection error to 503', () => {
    // P1xxx is the connection layer and is genuinely retryable.
    for (const code of ['P1000', 'P1001', 'P1002', 'P1017']) {
      expect(toApiError({ code }).code).toBe('DATABASE_UNAVAILABLE')
    }
  })

  it('maps every other Prisma error to a bare 500', () => {
    // P2002 is a unique-constraint violation: a query this server got wrong,
    // and nothing the client can be told about.
    expect(toApiError({ code: 'P2002' }).code).toBe('INTERNAL_ERROR')
  })

  it('maps a foreign-key violation to 404, not 500', () => {
    /*
     * The error a save against a circuit deleted mid-flight actually
     * produces. P2025 was mapped for that case and is unreachable on it:
     * `appendVersion` inserts the version before it touches the circuit, so
     * the FK on CircuitVersion.circuitId fires first. The result was a 500 —
     * logged at error level, in the class clients retry — for a lost race
     * against a circuit that will never exist again.
     */
    const mapped = toApiError({
      code: 'P2003',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23503',
            kind: 'ForeignKeyConstraintViolation',
          },
        },
      },
    })

    expect(mapped.code).toBe('NOT_FOUND')
    expect(mapped.statusCode).toBe(404)
  })

  it('maps a transaction that could not start to 503, not 500', () => {
    /*
     * P2028 under `connection_limit=1`: concurrent writes queue on a pool of
     * one and a queue longer than `maxWait` is refused. Eight concurrent
     * creates of eight *different* circuits reproduced it, so it is capacity
     * rather than contention — and 503 is the retryable answer the client
     * already knows what to do with.
     */
    const mapped = toApiError({
      code: 'P2028',
      message: 'Unable to start a transaction in the given time.',
    })

    expect(mapped.code).toBe('DATABASE_UNAVAILABLE')
    expect(mapped.statusCode).toBe(503)
  })

  it('maps the domain errors that mean “gone”, not “broken”', () => {
    // A circuit deleted between `findReadable` and `latestVersion` is not a
    // data-integrity failure, it is a lost race — and forking one used to be
    // a 500 on somebody else's circuit.
    expect(toApiError({ code: 'MISSING_VERSION' }).statusCode).toBe(404)
    expect(toApiError({ code: 'CIRCUIT_NOT_WRITABLE' }).statusCode).toBe(404)
  })

  it('never classifies by message text', () => {
    /*
     * The rule the whole module rests on. If a message could influence the
     * outcome, a message could also reach the response — and library and
     * driver messages are where connection strings live.
     */
    const error = new Error('not found: no such circuit')

    expect(toApiError(error).code).toBe('INTERNAL_ERROR')
  })

  it('falls back to INTERNAL_ERROR for anything unrecognised', () => {
    expect(toApiError('a string').code).toBe('INTERNAL_ERROR')
    expect(toApiError(null).code).toBe('INTERNAL_ERROR')
    expect(toApiError(undefined).code).toBe('INTERNAL_ERROR')
  })
})

describe('the error vocabulary', () => {
  it('is closed', () => {
    /*
     * Every code here needs a translation in three catalogs before it can
     * reach a user (D2). This test exists so that adding one is a visible
     * decision rather than an accident, and so the count in a review is
     * something concrete to check the catalogs against.
     */
    expect(Object.keys(ERROR_DEFINITIONS).sort()).toEqual([
      'API_KEY_LIMIT_REACHED',
      'API_KEY_NOT_ACCEPTED',
      'API_KEY_SCOPE_REQUIRED',
      'AUTH_INVALID_TOKEN',
      'AUTH_KEY_UNAVAILABLE',
      'AUTH_REQUIRED',
      'AUTH_TOKEN_EXPIRED',
      'CIRCUIT_TOO_LARGE',
      'COLLECTION_FULL',
      'COMMENT_LIMIT_REACHED',
      'DATABASE_UNAVAILABLE',
      'FORBIDDEN',
      'HARDWARE_CREDENTIAL_REJECTED',
      'HARDWARE_QUOTA_EXHAUSTED',
      'HARDWARE_UNAVAILABLE',
      'HARDWARE_UNRUNNABLE',
      'INTERNAL_ERROR',
      'MALFORMED_JSON',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'RATE_LIMITED',
      'SIMULATION_TOO_LARGE',
      'SIMULATION_UNAVAILABLE',
      'UNSUPPORTED_MEDIA_TYPE',
      'USERNAME_TAKEN',
      'USERNAME_UNAVAILABLE',
      'USER_EMAIL_ALREADY_LINKED',
      'USER_EMAIL_REQUIRED',
      'VALIDATION_FAILED',
      'VERSION_CONFLICT',
    ])
  })

  it('uses a status that matches the code', () => {
    for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
      expect(definition.status, code).toBeGreaterThanOrEqual(400)
      expect(definition.status, code).toBeLessThan(600)
    }
  })
})
