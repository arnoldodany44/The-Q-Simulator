// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  hrefWithoutProviderReturn,
  readProviderReturn,
} from './providerReturn.js'

/**
 * The return leg of a third-party sign-in, which nothing read at all.
 *
 * `signInWithOAuth` hands the whole window to the provider, so the promise
 * that started the flow belongs to a page that no longer exists by the time
 * there is an answer. Supabase reports the answer on the address it sends the
 * user back to — and `redirect_to` defaults to the app root, so the two most
 * common GitHub outcomes (the user cancels on the consent screen; the account
 * releases no verified address) landed a signed-out reader on the marketing
 * page with the explanation sitting unread in the URL. Measured in the running
 * app: no alert, no text matching /cancel|failed|denied|error/, parameters
 * still in the address.
 */

const CANCELLED =
  '?error=access_denied&error_description=The+user+denied+the+request'

describe('reading a provider round trip that failed', () => {
  it('is silent for an ordinary page load', () => {
    expect(readProviderReturn('', '')).toBeNull()
    expect(readProviderReturn('?page=2', '#section')).toBeNull()
  })

  it('prefers the specific code over the generic one', () => {
    /*
     * `access_denied` is the outer error for several different things. Paired
     * with a reason, the reason is the one worth a sentence: an expired
     * recovery link and a cancelled consent screen have different next steps.
     */
    expect(
      readProviderReturn('?error=access_denied&error_code=otp_expired', '')
    ).toBe('LINK_EXPIRED')
    expect(readProviderReturn(CANCELLED, '')).toBe('PROVIDER_CANCELLED')
  })

  it('names the provider-email case, which is the common GitHub one', () => {
    expect(
      readProviderReturn(
        '?error=access_denied&error_code=provider_email_needs_verification',
        ''
      )
    ).toBe('PROVIDER_EMAIL_UNVERIFIED')
  })

  it('reads the fragment, because half the flows put it there', () => {
    // The implicit flow puts these after the `#`, where a server never sees
    // them. A reader that only parsed the query was silent for those.
    expect(
      readProviderReturn('', '#error=access_denied&error_code=otp_expired')
    ).toBe('LINK_EXPIRED')
  })

  it('falls back to a sentence rather than to silence', () => {
    // A code this bundle predates still gets translated copy.
    expect(readProviderReturn('?error_code=some_future_reason', '')).toBe(
      'UNKNOWN'
    )
  })
})

describe('taking the parameters back out of the address', () => {
  it('removes all three from the query and leaves the rest alone', () => {
    expect(
      hrefWithoutProviderReturn(`https://qsim.test/circuits${CANCELLED}&page=2`)
    ).toBe('https://qsim.test/circuits?page=2')
  })

  it('removes them from the fragment too', () => {
    expect(
      hrefWithoutProviderReturn(
        'https://qsim.test/#error=access_denied&error_code=otp_expired'
      )
    ).toBe('https://qsim.test/')
  })

  it('keeps a fragment that is not a parameter list', () => {
    // A plain `#anchor` is not this file's business, and eating it would break
    // an ordinary in-page link.
    expect(hrefWithoutProviderReturn('https://qsim.test/#anchor')).toBe(
      'https://qsim.test/#anchor'
    )
  })

  it('changes nothing when there is nothing to remove', () => {
    const href = 'https://qsim.test/c/abc?v=3'
    expect(hrefWithoutProviderReturn(href)).toBe(href)
  })
})
