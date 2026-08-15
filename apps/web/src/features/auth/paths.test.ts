// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SIGNED_IN_PATH,
  INTENDED_PATH_STATE_KEY,
  absoluteAppUrl,
  intendedPathFrom,
  isSafeRedirectPath,
  safeRedirectPath,
} from './paths.js'

/**
 * The redirect target is read back out of history state, and history state is
 * as attacker-influenceable as a URL: a crafted link can push an entry
 * carrying any string. Navigating to it unchecked is an open redirect —
 * a phishing page reached from the real domain, immediately after a real
 * sign-in, which is the most convincing possible framing for one.
 */

describe('isSafeRedirectPath', () => {
  it('accepts a path inside this app', () => {
    expect(isSafeRedirectPath('/c/abc123')).toBe(true)
    expect(isSafeRedirectPath('/new?example=bell')).toBe(true)
  })

  it('rejects an absolute URL', () => {
    expect(isSafeRedirectPath('https://evil.example')).toBe(false)
    expect(isSafeRedirectPath('javascript:alert(1)')).toBe(false)
  })

  it('rejects a protocol-relative URL', () => {
    // Starts with a slash and is a *host*. The one a naive check lets through.
    expect(isSafeRedirectPath('//evil.example/phish')).toBe(false)
  })

  it('rejects backslashes, which browsers normalise into slashes', () => {
    expect(isSafeRedirectPath('/\\evil.example')).toBe(false)
    expect(isSafeRedirectPath('\\\\evil.example')).toBe(false)
  })
})

describe('safeRedirectPath', () => {
  it('falls back rather than throwing on a hostile value', () => {
    expect(safeRedirectPath('https://evil.example')).toBe(
      DEFAULT_SIGNED_IN_PATH
    )
  })

  it('falls back on anything that is not a string', () => {
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_SIGNED_IN_PATH)
    expect(safeRedirectPath({ toString: () => '/x' })).toBe(
      DEFAULT_SIGNED_IN_PATH
    )
  })
})

describe('intendedPathFrom', () => {
  it('reads the destination a guard recorded', () => {
    expect(
      intendedPathFrom({ [INTENDED_PATH_STATE_KEY]: '/c/abc123?v=2' })
    ).toBe('/c/abc123?v=2')
  })

  it('answers the default when no destination was recorded', () => {
    expect(intendedPathFrom(null)).toBe(DEFAULT_SIGNED_IN_PATH)
    expect(intendedPathFrom({})).toBe(DEFAULT_SIGNED_IN_PATH)
    expect(intendedPathFrom('a string')).toBe(DEFAULT_SIGNED_IN_PATH)
  })

  it('refuses a destination that points off this origin', () => {
    expect(
      intendedPathFrom({ [INTENDED_PATH_STATE_KEY]: 'https://evil.example' })
    ).toBe(DEFAULT_SIGNED_IN_PATH)
  })
})

describe('absoluteAppUrl', () => {
  it('builds a link Supabase can put in an email', () => {
    expect(absoluteAppUrl('/update-password', 'https://qsim.test')).toBe(
      'https://qsim.test/update-password'
    )
  })

  it('never lets a hostile path escape the origin', () => {
    // This string ends up in a message somebody clicks.
    expect(absoluteAppUrl('//evil.example', 'https://qsim.test')).toBe(
      'https://qsim.test/'
    )
  })
})
