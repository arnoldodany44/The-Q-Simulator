// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { resolveSupabaseConfig } from './config.js'

/**
 * The rule under test is the asymmetry: *both* variables absent is a
 * deployment without accounts and must keep working, while *one* absent is a
 * typo and must fail loudly. Getting that backwards in either direction is
 * expensive — a throw takes the public landing page down for a Phase 0
 * deployment, and a silent `null` turns a misspelt Vercel variable into "no
 * user can ever sign in", discovered by a user rather than by a build.
 */

const URL_ = 'https://project.supabase.co'
const KEY = 'sb_publishable_abc123'

describe('resolveSupabaseConfig', () => {
  it('reads both variables', () => {
    expect(
      resolveSupabaseConfig({
        VITE_SUPABASE_URL: URL_,
        VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      })
    ).toEqual({ url: URL_, publishableKey: KEY })
  })

  it('answers null when neither is set, so a build without auth still runs', () => {
    expect(resolveSupabaseConfig({})).toBeNull()
    expect(
      resolveSupabaseConfig({
        VITE_SUPABASE_URL: '   ',
        VITE_SUPABASE_PUBLISHABLE_KEY: '',
      })
    ).toBeNull()
  })

  it('throws when only the key is set, naming the missing variable', () => {
    expect(() =>
      resolveSupabaseConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: KEY })
    ).toThrow(/VITE_SUPABASE_URL/)
  })

  it('throws when only the URL is set, naming the missing variable', () => {
    expect(() => resolveSupabaseConfig({ VITE_SUPABASE_URL: URL_ })).toThrow(
      /VITE_SUPABASE_PUBLISHABLE_KEY/
    )
  })

  it('never puts a value in the message, only the variable name', () => {
    /*
     * These messages reach a console and, once Sentry is wired in M1.8, an
     * error report. The publishable key is not a secret, but the habit is:
     * the same helper shape will one day be copied for something that is.
     */
    try {
      resolveSupabaseConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: KEY })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain(KEY)
    }
  })

  it('strips a trailing slash so paths do not double up', () => {
    // `https://x/` + `/auth/v1/settings` is a URL some proxies 404 and none
    // document.
    expect(
      resolveSupabaseConfig({
        VITE_SUPABASE_URL: `${URL_}//`,
        VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      })?.url
    ).toBe(URL_)
  })

  it('refuses plain HTTP on a remote host', () => {
    // Every refresh sends the refresh token to this origin.
    expect(() =>
      resolveSupabaseConfig({
        VITE_SUPABASE_URL: 'http://project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      })
    ).toThrow(/https/)
  })

  it('allows plain HTTP on loopback, for a local supabase', () => {
    expect(
      resolveSupabaseConfig({
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      })?.url
    ).toBe('http://127.0.0.1:54321')
  })

  it('rejects a value that is not a URL at all', () => {
    expect(() =>
      resolveSupabaseConfig({
        VITE_SUPABASE_URL: 'project.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
      })
    ).toThrow(/VITE_SUPABASE_URL/)
  })
})
