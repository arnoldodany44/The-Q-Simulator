import { describe, expect, it } from 'vitest'
import { REDACTED, describeRequest, scrub } from './redact.js'
import { TEST_CRN } from './testing/transport.js'

describe('scrub', () => {
  it('removes a bearer token whole, never partially', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl'
    const out = scrub(`Authorization: Bearer ${token}`)
    expect(out).toContain(REDACTED)
    expect(out).not.toContain(token)
    // Not even a tail. §11's credential rule is "never, not even partially".
    expect(out).not.toContain(token.slice(-6))
  })

  it('removes a CRN, which names an account', () => {
    expect(scrub(`Service-CRN: ${TEST_CRN}`)).not.toContain('crn:v1')
  })

  it('removes an apikey from a form body', () => {
    const body = 'grant_type=urn%3Aibm&apikey=AbCdEfGhIjKlMnOpQrStUvWxYz012345'
    const out = scrub(body)
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz012345')
    expect(out).toContain('grant_type=urn%3Aibm')
  })

  it('leaves ordinary text alone', () => {
    expect(scrub('the backend listing answered 503')).toBe(
      'the backend listing answered 503'
    )
  })
})

describe('describeRequest', () => {
  it('keeps the path and drops the query string', () => {
    expect(
      describeRequest(
        'get',
        'https://quantum.cloud.ibm.com/api/v1/jobs?token=x'
      )
    ).toBe('GET /api/v1/jobs')
  })

  it('says so rather than throwing on a URL it cannot parse', () => {
    expect(describeRequest('GET', 'not a url')).toContain('unparseable')
  })
})
