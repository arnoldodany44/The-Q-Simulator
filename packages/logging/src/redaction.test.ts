import { describe, expect, it } from 'vitest'

import {
  CENSOR,
  REDACT_PATHS,
  redactDeep,
  scrubSecrets,
  serializeError,
} from './redaction.js'

/*
 * The sentinels are obviously fake and are asserted on by *identity*: a test
 * that checked for the word "REDACTED" would pass on a line that also carried
 * the secret, which is the assertion mistake this whole module is about.
 */
const PASSWORD = 'p4ssw0rd-SENTINEL-not-a-real-secret'
const POOLER_HOST = 'aws-1-us-east-2.pooler.example.invalid'

describe('scrubSecrets', () => {
  it('removes the credentials from any URI carrying user:password@', () => {
    const text = `connect ECONNREFUSED postgresql://postgres:${PASSWORD}@${POOLER_HOST}:6543/postgres`
    const scrubbed = scrubSecrets(text)
    expect(scrubbed).not.toContain(PASSWORD)
    expect(scrubbed).not.toContain(POOLER_HOST)
    expect(scrubbed).toContain(CENSOR)
  })

  it('removes a datasource URL that has no userinfo at all', () => {
    const scrubbed = scrubSecrets(`postgres://${POOLER_HOST}:6543/postgres`)
    expect(scrubbed).not.toContain(POOLER_HOST)
  })

  it('removes the host from the sentence Prisma actually writes', () => {
    // P1001 does not carry the URL — it carries the host in prose, which is
    // the shape the URL rules above cannot match.
    const scrubbed = scrubSecrets(
      `Can't reach database server at ${POOLER_HOST}:6543`
    )
    expect(scrubbed).not.toContain(POOLER_HOST)
    expect(scrubbed).toContain('database server at')
  })

  it('removes a compact JWS, which is what an IAM bearer token is', () => {
    const token = 'eyJraWQiOiIyMDI2' + '.eyJpYW1faWQiOiJJQk1p' + '.c2lnbmF0dXJl'
    expect(scrubSecrets(`Authorization: Bearer ${token}`)).not.toContain(token)
  })

  it("removes this product's own API keys from inside a sentence", () => {
    const key = `qsk_${'A'.repeat(43)}`
    expect(scrubSecrets(`presented ${key} on /simulate`)).not.toContain(key)
  })
})

describe('serializeError', () => {
  it('does not walk a cause chain', () => {
    /*
     * THE DEFECT THIS PACKAGE EXISTS FOR. `pino-std-serializers` folds every
     * cause into `message` and `stack` and copies every own property; the
     * worker wraps each repository call in an error whose cause is the driver's
     * failure and logs it verbatim on `worker.on('failed')`. Here the cause is
     * not walked at all, so the driver's message cannot arrive by that route.
     */
    const driver = new Error(
      `Can't reach database server at ${POOLER_HOST}:6543`
    )
    const wrapper = new Error(
      'the hardware repository failed during ' + 'poll',
      {
        cause: driver,
      }
    )

    const line = JSON.stringify(serializeError(wrapper))
    expect(line).not.toContain(POOLER_HOST)
    expect(line).toContain('the hardware repository failed')
  })

  it('scrubs a secret the wrapper copied into its own message', () => {
    // The other half: a wrapper that *did* interpolate the cause's text. The
    // cause is not walked, so this is the only way the host can arrive — and
    // it is scrubbed on the way through.
    const error = new Error(
      `the hardware repository failed during findPollable: Can't reach ` +
        `database server at ${POOLER_HOST}:6543`
    )
    const serialised = serializeError(error)
    expect(serialised.message).not.toContain(POOLER_HOST)
    expect(serialised.message).toContain(CENSOR)
  })

  it('scrubs the stack as well as the message', () => {
    const error = new Error('boom')
    error.stack = `Error: boom\n    at postgresql://user:${PASSWORD}@${POOLER_HOST}/db`
    expect(serializeError(error).stack).not.toContain(PASSWORD)
  })

  it('keeps a string `code` and drops everything else the error carries', () => {
    const error = Object.assign(new Error('nope'), {
      code: 'P1001',
      // The kind of property a driver hangs on an error and pino would copy.
      clientVersion: '7.0.0',
      apiKey: 'SENTINEL-should-never-be-logged',
    })
    const serialised = serializeError(error)
    expect(serialised.code).toBe('P1001')
    expect(JSON.stringify(serialised)).not.toContain('SENTINEL')
    expect(JSON.stringify(serialised)).not.toContain('clientVersion')
  })

  it('describes a rejection that is not an Error at all', () => {
    const serialised = serializeError({ message: 'adapter failed', code: 'X' })
    expect(serialised.type).toBe('NonError')
    expect(serialised.message).toBe('adapter failed')
    expect(serialised.code).toBe('X')
  })
})

describe('redactDeep', () => {
  it('censors a sensitive field at the top level and inside an array', () => {
    const redacted = redactDeep({
      token: 'SENTINEL',
      jobs: [{ nested: { apiKey: 'SENTINEL' } }],
    })
    expect(JSON.stringify(redacted)).not.toContain('SENTINEL')
  })

  it('leaves class instances alone, so pino serialisers still see them', () => {
    const error = new Error('boom')
    const redacted = redactDeep({ err: error }) as { err: unknown }
    expect(redacted.err).toBe(error)
  })
})

describe('REDACT_PATHS', () => {
  it('covers the circuit and the payload, which only the worker logs', () => {
    expect(REDACT_PATHS).toContain('*.circuit')
    expect(REDACT_PATHS).toContain('*.payload')
  })
})
