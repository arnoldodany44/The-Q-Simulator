import { describe, expect, it } from 'vitest'
import { EnvValidationError, configurationWarnings, loadEnv } from './env.js'
import { testEnvSource } from './testing/app.js'

/**
 * Two things are asserted here over and over, and they are the reasons this
 * module exists: the process refuses to start on a bad environment, and the
 * complaint it makes never contains a value.
 */
function expectRejection(source: Record<string, string | undefined>) {
  try {
    loadEnv(source)
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError)
    return error as EnvValidationError
  }
  throw new Error('expected loadEnv to reject')
}

describe('loadEnv', () => {
  it('accepts a complete environment', () => {
    const env = loadEnv(testEnvSource())

    expect(env.nodeEnv).toBe('test')
    expect(env.port).toBe(8080)
    expect(env.webOrigins).toEqual(['https://the-q-simulator.vercel.app'])
  })

  it('names every missing variable at once', () => {
    // One per restart is how a deploy takes five rounds instead of one.
    const error = expectRejection({ NODE_ENV: 'production' })

    expect(error.variables).toContain('WEB_URL')
    expect(error.variables).toContain('DATABASE_URL')
    expect(error.variables).toContain('SUPABASE_URL')
    expect(error.variables).toContain('SUPABASE_JWKS_URL')
    expect(error.message).toMatch(/WEB_URL — missing/)
  })

  it('says "missing" rather than "expected string, received undefined"', () => {
    const error = expectRejection(testEnvSource({ DATABASE_URL: undefined }))

    expect(error.message).toContain('DATABASE_URL — missing')
    expect(error.message).not.toMatch(/received undefined/)
  })

  it('treats a blank variable as absent', () => {
    /*
     * `.env.example` ships `SUPABASE_JWT_SECRET=` deliberately blank, and a
     * Railway variable cleared in the dashboard becomes `''`. Without this,
     * `z.coerce.number()` would read `PORT=` as 0 and bind a random port.
     */
    const error = expectRejection(testEnvSource({ WEB_URL: '   ' }))

    expect(error.message).toContain('WEB_URL — missing')
  })

  it('applies defaults for optional variables', () => {
    const env = loadEnv(testEnvSource({ PORT: undefined }))

    expect(env.port).toBe(8080)
    expect(env.jwtAudience).toBe('authenticated')
    expect(env.rateLimit.max).toBe(300)
    expect(env.rateLimit.strictMax).toBe(20)
  })

  it('never puts a value in the error message', () => {
    // The classic way a connection string ends up in a crash report.
    const error = expectRejection(
      // Missing the `:` after the scheme, so it is not a URL at all — but it
      // still carries a password and a host.
      testEnvSource({
        DATABASE_URL:
          'postgresql//postgres:hunter2@db.example.com:6543/postgres',
      })
    )

    expect(error.message).not.toContain('hunter2')
    expect(error.message).not.toContain('db.example.com')
    expect(error.message).toContain('DATABASE_URL')
  })

  it('rejects a DATABASE_URL that is not a postgres URL', () => {
    const error = expectRejection(
      testEnvSource({ DATABASE_URL: 'mysql://localhost:3306/qsim' })
    )

    expect(error.variables).toEqual(['DATABASE_URL'])
  })

  it('refuses a JWKS URL that is not on a scheme worth trusting', () => {
    /*
     * The most security-critical URL this service holds: whatever that
     * document says is a signing key becomes a signing key. `z.url()` alone
     * accepted every one of these, so the service would boot with its trust
     * anchor on plaintext HTTP — where an on-path attacker substitutes the
     * key set and mints a token for any user — or on a `data:` URL, where the
     * anchor is a literal in the environment.
     */
    for (const url of [
      'http://attacker.example/jwks.json',
      'file:///etc/jwks.json',
      'ftp://example.com/jwks.json',
      'data:application/json,{"keys":[]}',
      'javascript:alert(1)',
    ]) {
      const error = expectRejection(testEnvSource({ SUPABASE_JWKS_URL: url }))
      expect(error.variables, url).toEqual(['SUPABASE_JWKS_URL'])
    }
  })

  it('applies the same rule to SUPABASE_URL and the issuer', () => {
    expect(
      expectRejection(testEnvSource({ SUPABASE_URL: 'http://x.example' }))
        .variables
    ).toEqual(['SUPABASE_URL'])
    expect(
      expectRejection(
        testEnvSource({ SUPABASE_JWT_ISSUER: 'http://x.example/auth/v1' })
      ).variables
    ).toEqual(['SUPABASE_JWT_ISSUER'])
  })

  it('allows plain http on loopback, where there is no wire to be on', () => {
    // `supabase start` serves http://127.0.0.1:54321, and loopback traffic
    // never crosses a network — the same reasoning browsers use to treat
    // http://localhost as a secure context.
    const env = loadEnv(
      testEnvSource({
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_JWKS_URL:
          'http://localhost:54321/auth/v1/.well-known/jwks.json',
        SUPABASE_JWT_ISSUER: 'http://127.0.0.1:54321/auth/v1',
      })
    )

    expect(env.jwksUrl).toBe(
      'http://localhost:54321/auth/v1/.well-known/jwks.json'
    )
  })

  it('derives the expected issuer from SUPABASE_URL', () => {
    /*
     * This is what makes "a token from another project" fail closed. An
     * operator who pastes the wrong project's JWKS URL gets a mismatch
     * rather than a service that quietly accepts both.
     */
    const env = loadEnv(
      testEnvSource({ SUPABASE_URL: 'https://abcdef.supabase.co/' })
    )

    expect(env.jwtIssuer).toBe('https://abcdef.supabase.co/auth/v1')
  })

  it('honours an explicit issuer override', () => {
    const env = loadEnv(
      testEnvSource({ SUPABASE_JWT_ISSUER: 'https://auth.example.com/v1' })
    )

    expect(env.jwtIssuer).toBe('https://auth.example.com/v1')
  })

  it('normalises CORS origins and accepts several', () => {
    // `https://example.com/` never appears in an Origin header, and the
    // comparison is a string equality.
    const env = loadEnv(
      testEnvSource({
        WEB_URL: 'https://one.example.com/, https://two.example.com',
      })
    )

    expect(env.webOrigins).toEqual([
      'https://one.example.com',
      'https://two.example.com',
    ])
  })

  it('rejects a WEB_URL that is not an absolute URL', () => {
    const error = expectRejection(testEnvSource({ WEB_URL: 'localhost:5173' }))

    expect(error.variables).toEqual(['WEB_URL'])
  })

  it('refuses TRUST_PROXY=true', () => {
    /*
     * `true` believes the entire X-Forwarded-For chain, so a client can
     * prepend any address and be rate limited as somebody else. A hop count
     * is always what was meant.
     */
    const error = expectRejection(testEnvSource({ TRUST_PROXY: 'true' }))

    expect(error.variables).toEqual(['TRUST_PROXY'])
    expect(error.message).toMatch(/hop count/)
  })

  it('reads TRUST_PROXY as a hop count or an address list', () => {
    expect(loadEnv(testEnvSource({ TRUST_PROXY: '1' })).trustProxy).toBe(1)
    expect(loadEnv(testEnvSource({ TRUST_PROXY: 'false' })).trustProxy).toBe(
      false
    )
    expect(
      loadEnv(testEnvSource({ TRUST_PROXY: '10.0.0.1, 10.0.0.2' })).trustProxy
    ).toEqual(['10.0.0.1', '10.0.0.2'])
  })

  it('defaults trustProxy by environment', () => {
    // Off where there is no proxy (anyone could spoof the header), one hop
    // behind Railway's edge (or every anonymous caller shares one IP).
    expect(loadEnv(testEnvSource({ NODE_ENV: 'development' })).trustProxy).toBe(
      false
    )
    expect(loadEnv(testEnvSource({ NODE_ENV: 'production' })).trustProxy).toBe(
      1
    )
  })

  it('defaults the log level by environment', () => {
    expect(loadEnv(testEnvSource({ NODE_ENV: 'production' })).logLevel).toBe(
      'info'
    )
    expect(loadEnv(testEnvSource({ NODE_ENV: 'development' })).logLevel).toBe(
      'debug'
    )
  })
})

describe('configurationWarnings', () => {
  it('is silent about the database for a correctly configured pooler URL', () => {
    const env = loadEnv(
      testEnvSource({
        DATABASE_URL:
          'postgresql://postgres@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1',
        REDIS_URL: 'redis://localhost:6379',
      })
    )

    expect(configurationWarnings(env)).toEqual([])
  })

  it('warns that server simulation is off when no REDIS_URL is set', () => {
    /*
     * A warning and not a refusal to boot: Redis backs exactly one route, and
     * an API that would not start without it would take the gallery, the
     * editor's persistence and every sign-in down with a queue outage.
     */
    const env = loadEnv(testEnvSource({ REDIS_URL: undefined }))
    const warnings = configurationWarnings(env)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('REDIS_URL')
    expect(warnings[0]).toContain('SIMULATION_UNAVAILABLE')
  })

  it('warns about the missing pgbouncer and connection_limit parameters', () => {
    // Without them Prisma issues prepared statements the transaction pooler
    // rejects, and `pg` opens ten connections against a budget of one.
    const env = loadEnv(
      testEnvSource({
        DATABASE_URL:
          'postgresql://postgres@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
      })
    )

    const warnings = configurationWarnings(env)
    expect(warnings.some((line) => line.includes('pgbouncer=true'))).toBe(true)
    expect(warnings.some((line) => line.includes('connection_limit'))).toBe(
      true
    )
  })

  it('warns when DATABASE_URL points at the session pooler', () => {
    // Port 5432 is DIRECT_URL, for migrations only.
    const env = loadEnv(
      testEnvSource({
        DATABASE_URL:
          'postgresql://postgres@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      })
    )

    expect(
      configurationWarnings(env).some((line) => line.includes('6543'))
    ).toBe(true)
  })

  it('never repeats any part of the URL', () => {
    const env = loadEnv(
      testEnvSource({
        DATABASE_URL:
          'postgresql://postgres:hunter2@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      })
    )

    for (const warning of configurationWarnings(env)) {
      expect(warning).not.toContain('hunter2')
      expect(warning).not.toContain('pooler.supabase.com')
    }
  })

  it('says nothing about a local Postgres', () => {
    // A developer pointed at localhost needs neither parameter.
    const env = loadEnv(
      testEnvSource({
        DATABASE_URL: 'postgresql://postgres@localhost:5432/qsim',
        REDIS_URL: 'redis://localhost:6379',
      })
    )

    expect(configurationWarnings(env)).toEqual([])
  })
})
