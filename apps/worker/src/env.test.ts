import { DEFAULT_JOB_TIMEOUT_MS, DEFAULT_SERVER_QUBITS } from '@qsim/jobs'
import { describe, expect, it } from 'vitest'
import { EnvValidationError, loadEnv } from './env.js'
import type { EnvSource } from './env.js'

const COMPLETE: EnvSource = {
  NODE_ENV: 'test',
  REDIS_URL: 'redis://localhost:6379',
  DATABASE_URL: 'postgresql://postgres@localhost:5432/qsim_test',
}

function source(overrides: EnvSource = {}): EnvSource {
  return { ...COMPLETE, ...overrides }
}

describe('what this process cannot start without', () => {
  it('accepts a complete environment', () => {
    expect(loadEnv(source())).toMatchObject({
      redisUrl: 'redis://localhost:6379',
      concurrency: 2,
    })
  })

  it('requires REDIS_URL, unlike the API', () => {
    /*
     * Not an inconsistency with `apps/api`, where it is optional — it is what
     * each process is for. The API serves twelve routes of which one needs a
     * queue, so it degrades. This process is *only* a queue consumer: without
     * Redis it would start successfully and sit idle, green on every dashboard
     * while jobs accumulate.
     */
    expect(() => loadEnv(source({ REDIS_URL: undefined }))).toThrow(
      EnvValidationError
    )
  })

  it('requires DATABASE_URL, because a run it cannot store is a run wasted', () => {
    expect(() => loadEnv(source({ DATABASE_URL: undefined }))).toThrow(
      EnvValidationError
    )
  })

  it('refuses a URL that is not the protocol it is for', () => {
    // Otherwise the mistake surfaces as a connection error three layers down,
    // at the first job rather than at boot.
    expect(() =>
      loadEnv(source({ REDIS_URL: 'http://localhost:6379' }))
    ).toThrow(EnvValidationError)
    expect(() =>
      loadEnv(source({ DATABASE_URL: 'mysql://localhost/qsim' }))
    ).toThrow(EnvValidationError)
  })

  it('treats a blank variable as an unset one', () => {
    // `.env.example` ships blanks deliberately, and a Railway variable cleared
    // through the dashboard becomes '' rather than disappearing.
    expect(() => loadEnv(source({ REDIS_URL: '   ' }))).toThrow(
      EnvValidationError
    )
  })

  it('names every offending variable at once', () => {
    // Reporting them one per restart is how a deploy takes five rounds.
    try {
      loadEnv({ NODE_ENV: 'test' })
      expect.unreachable()
    } catch (error) {
      const failure = error as EnvValidationError
      expect(failure.variables).toContain('REDIS_URL')
      expect(failure.variables).toContain('DATABASE_URL')
    }
  })

  it('never echoes a value', () => {
    // A connection string is a credential and a validation error is the classic
    // way one ends up in a crash report.
    const secret = 'redis://user:hunter2@example.invalid:6379'
    try {
      loadEnv(source({ REDIS_URL: secret, DATABASE_URL: undefined }))
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).message).not.toContain('hunter2')
      expect((error as EnvValidationError).message).not.toContain(secret)
    }
  })
})

describe('the ceilings', () => {
  it('defaults to the same numbers the API defaults to', () => {
    // They must match or the API accepts work this process refuses — not
    // unsafe, since the worker checks again, but a confusing 202 followed by a
    // FAILED run instead of an immediate 413.
    const env = loadEnv(source())
    expect(env.maxQubits).toBe(DEFAULT_SERVER_QUBITS)
    expect(env.timeoutMs).toBe(DEFAULT_JOB_TIMEOUT_MS)
  })

  it('cannot be configured past the engine', () => {
    expect(() => loadEnv(source({ SIMULATION_MAX_QUBITS: '64' }))).toThrow(
      EnvValidationError
    )
  })

  it('bounds concurrency, because each unit is a process that may hold 256 MB', () => {
    expect(loadEnv(source({ WORKER_CONCURRENCY: '4' })).concurrency).toBe(4)
    expect(() => loadEnv(source({ WORKER_CONCURRENCY: '1000' }))).toThrow(
      EnvValidationError
    )
  })

  it('namespaces the queue and never silently falls back to BullMQ default', () => {
    expect(loadEnv(source()).queuePrefix).toBe('qsim')
    expect(loadEnv(source({ QUEUE_PREFIX: 'qsim-dev' })).queuePrefix).toBe(
      'qsim-dev'
    )
  })

  it('allows longer for a graceful shutdown than the API does', () => {
    // A shutdown here can be holding a job forty seconds into a sixty-second
    // bound; the API's in-flight requests are milliseconds.
    expect(loadEnv(source()).shutdownTimeoutMs).toBeGreaterThan(10_000)
  })
})
