/**
 * The logging tests are leak tests.
 *
 * Each one takes a value that would be a genuine incident if it reached a log
 * aggregator — a connection string, a bearer token, a password in a query
 * parameter — and asserts it does not survive. They are written against the
 * pure functions rather than against captured output, so a regression names
 * the exact rule that broke.
 */

import { describe, expect, it } from 'vitest'
import { pino } from 'pino'
import { mintApiKey } from './api-keys/secret.js'
import {
  buildLoggerOptions,
  sanitizeUrl,
  scrubSecrets,
  serializeError,
  serializeRequest,
} from './logging.js'
import { testEnv } from './testing/app.js'

describe('scrubSecrets', () => {
  it('removes a PostgreSQL connection string', () => {
    // The realistic path: `pg` puts the datasource URL into the message of a
    // connection error, and error messages get logged.
    const message =
      'connect ECONNREFUSED for ' +
      'postgresql://postgres:hunter2@aws-0.pooler.supabase.com:6543/postgres?pgbouncer=true'

    const scrubbed = scrubSecrets(message)

    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('pooler.supabase.com')
    expect(scrubbed).toContain('[REDACTED]')
  })

  it('removes credentials from any URI, not just Postgres ones', () => {
    // Generic on purpose: Redis arrives in Phase 2 and nobody will remember
    // to add a rule for it.
    const scrubbed = scrubSecrets('redis://default:s3cret@redis.internal:6379')

    expect(scrubbed).not.toContain('s3cret')
    expect(scrubbed).toBe('redis://[REDACTED]')
  })

  it('removes a compact JWS wherever it appears', () => {
    const token =
      'eyJhbGciOiJFUzI1NiIsImtpZCI6ImtleS0xIn0.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl'

    expect(scrubSecrets(`Bearer ${token}`)).not.toContain(token)
    expect(scrubSecrets(`token was ${token} here`)).toContain('[REDACTED]')
  })

  it('removes a Supabase secret key', () => {
    expect(scrubSecrets('key sb_secret_abc123XYZ used')).not.toContain(
      'abc123XYZ'
    )
  })

  /*
   * This product's own API keys (§3.5). The whole point of giving the format
   * a fixed prefix and a fixed length is that one rule can find every one of
   * them, and a log is where an `Authorization` header goes to be read by
   * more people than can read the database.
   *
   * Minted rather than hand-written, so this exercises the real format: a
   * literal in a test is a literal that keeps passing after the format
   * changes.
   */
  it('removes one of this API’s own keys, wherever it appears', () => {
    const key = mintApiKey().key

    expect(scrubSecrets(`Bearer ${key}`)).not.toContain(key)
    expect(scrubSecrets(`rejected key ${key} from 10.0.0.1`)).toContain(
      '[REDACTED]'
    )
    // Inside a JSON fragment, which is the shape a serialised body arrives in.
    expect(scrubSecrets(`{"key":"${key}"}`)).not.toContain(key)
  })

  it('redacts the whole key and not a prefix of it', () => {
    const key = mintApiKey().key
    const scrubbed = scrubSecrets(`used ${key} here`)
    // A rule whose length was one short would leave the final character —
    // harmless on its own, and evidence that the rule is not what it claims.
    expect(scrubbed).toBe('used [REDACTED] here')
    expect(scrubbed).not.toContain(key.slice(-8))
  })

  it('leaves ordinary text alone', () => {
    const message = 'circuit 42 has 3 qubits and https://example.com/gallery'

    expect(scrubSecrets(message)).toBe(message)
  })
})

describe('sanitizeUrl', () => {
  it('keeps a plain path unchanged', () => {
    expect(sanitizeUrl('/api/v1/circuits')).toBe('/api/v1/circuits')
  })

  it('redacts the value of a credential parameter and keeps its name', () => {
    // Knowing that `?access_token=` was present is exactly the diagnostic
    // that matters, and the value is exactly the part that must not survive.
    expect(sanitizeUrl('/api/v1/me?access_token=abc.def.ghi&page=2')).toBe(
      '/api/v1/me?access_token=[REDACTED]&page=2'
    )
  })

  it('matches parameter names case-insensitively', () => {
    expect(sanitizeUrl('/x?Refresh_Token=abc')).toBe(
      '/x?Refresh_Token=[REDACTED]'
    )
  })

  it('keeps ordinary query parameters readable', () => {
    expect(sanitizeUrl('/api/v1/gallery?sort=stars&tag=bell')).toBe(
      '/api/v1/gallery?sort=stars&tag=bell'
    )
  })

  it('still scrubs a token that arrived under an innocuous name', () => {
    const url = '/x?note=eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln&page=1'

    expect(sanitizeUrl(url)).not.toContain('eyJhbGciOiJFUzI1NiJ9')
  })

  it('survives a malformed percent escape', () => {
    // A log line must not be the thing that throws.
    expect(() => sanitizeUrl('/x?%E0%A4%A=1')).not.toThrow()
  })
})

describe('serializeRequest', () => {
  it('emits four fields and no headers', () => {
    /*
     * The Authorization header is not omitted by policy here — it is
     * structurally absent from what is handed to pino. That is the layer
     * that survives somebody changing the redaction list.
     */
    const logged = serializeRequest({
      id: 'req-1',
      method: 'GET',
      url: '/api/v1/me?token=secret',
      ip: '203.0.113.7',
    })

    expect(logged).toEqual({
      id: 'req-1',
      method: 'GET',
      url: '/api/v1/me?token=[REDACTED]',
      remoteAddress: '203.0.113.7',
    })
  })
})

describe('serializeError', () => {
  it('scrubs the message and the stack', () => {
    const error = new Error(
      'FATAL: password authentication failed for ' +
        'postgresql://postgres:hunter2@db.example.com:5432/postgres'
    )

    const logged = serializeError(error)

    expect(logged.message).not.toContain('hunter2')
    expect(logged.stack ?? '').not.toContain('hunter2')
  })

  it('keeps the error code, which is what classification uses', () => {
    const error = Object.assign(new Error('nope'), { code: 'P1001' })

    expect(serializeError(error).code).toBe('P1001')
  })

  it('handles a thrown non-error', () => {
    expect(serializeError('just a string')).toEqual({
      type: 'NonError',
      message: 'just a string',
    })
  })

  it('reads an object-shaped throwable instead of writing [object Object]', () => {
    /*
     * Not hypothetical. Prisma's driver adapter rejects with something that
     * is not an `Error` instance, and the first smoke test of `/health`
     * against an unreachable database logged nothing but `[object Object]` —
     * a line that says a failure happened and nothing about which one.
     */
    const thrown = {
      message:
        'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string',
      stack: 'Error: SASL\n    at pg-pool',
      code: 'P1000',
    }

    expect(serializeError(thrown)).toEqual({
      type: 'NonError',
      message: thrown.message,
      code: 'P1000',
      stack: thrown.stack,
    })
  })

  it('scrubs an object-shaped throwable too', () => {
    const thrown = {
      message:
        'failed for postgresql://postgres:hunter2@db.example.com/postgres',
    }

    expect(serializeError(thrown).message).not.toContain('hunter2')
  })

  it('scrubs the database host out of prose, not only out of a URL', () => {
    /*
     * Prisma does not put the connection string in a connection failure, it
     * puts the host in a sentence. The URL rule never matched that shape, so
     * the one value the URL rule exists to hide walked into the log in clear
     * text — while the module comment claimed the host was covered.
     */
    const thrown = {
      message:
        "\nInvalid `prisma.circuit.findFirst()` invocation:\n\nCan't reach " +
        'database server at aws-0-us-west-2.pooler.supabase.com',
      code: 'P1001',
    }

    const logged = serializeError(thrown)
    expect(logged.message).not.toContain('pooler.supabase.com')
    expect(logged.message).toContain('[REDACTED]')
  })

  it('summarises an object with no message', () => {
    expect(serializeError({ detail: 'connection reset' }).message).toBe(
      '{"detail":"connection reset"}'
    )
  })

  it('survives a circular throwable', () => {
    const thrown: Record<string, unknown> = {}
    thrown.self = thrown

    expect(() => serializeError(thrown)).not.toThrow()
  })
})

describe('buildLoggerOptions', () => {
  it('produces options pino accepts', () => {
    // pino throws on an invalid redaction path, and the throw would happen at
    // boot in production. Constructing a real logger here is the check.
    expect(() => pino(buildLoggerOptions(testEnv()))).not.toThrow()
  })

  it('redacts an authorization header logged by hand', () => {
    const lines: string[] = []
    const logger = pino(buildLoggerOptions(testEnv()), {
      write: (line: string) => lines.push(line),
    })

    logger.info({ headers: { authorization: 'Bearer abc' } }, 'manual log')

    expect(lines.join('')).not.toContain('Bearer abc')
    expect(lines.join('')).toContain('[REDACTED]')
  })

  it('redacts a request body logged by hand', () => {
    /*
     * "Log the payload when it fails" is the first thing anyone reaches for,
     * and the bodies of the auth and hardware-credential routes are exactly
     * the ones that carry secrets (§11).
     */
    const lines: string[] = []
    const logger = pino(buildLoggerOptions(testEnv()), {
      write: (line: string) => lines.push(line),
    })

    logger.warn({ body: { password: 'hunter2' } }, 'validation failed')

    expect(lines.join('')).not.toContain('hunter2')
  })

  it('redacts a credential at every depth, and inside an array', () => {
    /*
     * The guarantee the module docblock states — "for anything logged by
     * hand, at any depth" — and the one `redact` alone could not deliver.
     * Every `'*.token'` path matches a key named `token` at depth two and
     * nowhere else: fast-redact's wildcard is one level, not a descent. So a
     * top-level `token`, anything at depth three, and anything inside an
     * array went to the log in clear text, and the two tests above happened
     * to pick the only two shapes that worked.
     */
    const lines: string[] = []
    const logger = pino(buildLoggerOptions(testEnv()), {
      write: (line: string) => lines.push(line),
    })

    logger.info(
      {
        token: 'DEPTH1_TOKEN',
        password: 'DEPTH1_PASSWORD',
        DATABASE_URL: 'DEPTH1_DATABASE_URL',
        connectionString: 'DEPTH1_CONNECTIONSTRING',
        a: { token: 'DEPTH2_TOKEN' },
        b: { c: { access_token: 'DEPTH3_TOKEN' } },
        arr: [{ token: 'ARRAY_TOKEN' }],
        ctx: { user: { profile: { secret: 'DEPTH4_SECRET' } } },
      },
      'depth map'
    )

    const written = lines.join('')
    for (const value of [
      'DEPTH1_TOKEN',
      'DEPTH1_PASSWORD',
      'DEPTH1_DATABASE_URL',
      'DEPTH1_CONNECTIONSTRING',
      'DEPTH2_TOKEN',
      'DEPTH3_TOKEN',
      'ARRAY_TOKEN',
      'DEPTH4_SECRET',
    ]) {
      expect(written, value).not.toContain(value)
    }
    expect(written).toContain('[REDACTED]')
  })

  it('leaves an error alone for its own serialiser to handle', () => {
    // `redactDeep` descends into plain objects only, so an Error keeps its
    // class — which is what `serializeError` needs to read `name` off.
    const lines: string[] = []
    const logger = pino(buildLoggerOptions(testEnv()), {
      write: (line: string) => lines.push(line),
    })

    logger.error({ err: new TypeError('boom') }, 'request failed')

    expect(lines.join('')).toContain('"type":"TypeError"')
  })
})
