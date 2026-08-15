import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@qsim/db'
import { createTestApp } from '../testing/app.js'

describe('the database plugin', () => {
  it('does not build a client at boot', async () => {
    /*
     * The assertion looks odd and is the point. `DATABASE_URL` is absent from
     * this process's environment (the vitest config clears it), so
     * `getPrismaClient()` throws — and the app still started, answered
     * `/health/live`, and closed. If anything in the boot path had touched
     * `app.db`, the boot would have thrown instead.
     *
     * That laziness is not tidiness: `DATABASE_URL` carries
     * `connection_limit=1`, so a client built at boot means a deploy that
     * overlaps the previous instance has two processes contending for one
     * connection.
     */
    const app = await createTestApp()

    expect(await app.inject({ method: 'GET', url: '/health/live' })).toEqual(
      expect.objectContaining({ statusCode: 200 })
    )
    expect(() => app.db).toThrow(/DATABASE_URL/)

    await app.close()
  })

  it('reports latency when the probe answers', async () => {
    const app = await createTestApp({
      database: { probe: () => Promise.resolve() },
    })

    const health = await app.checkDatabase()

    expect(health.reachable).toBe(true)
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
    await app.close()
  })

  it('reports a failure without rethrowing it', async () => {
    // The health route must answer, not propagate. A probe that throws out
    // of the endpoint becomes a 500 with no useful body.
    const app = await createTestApp({
      database: { probe: () => Promise.reject(new Error('down')) },
    })

    await expect(app.checkDatabase()).resolves.toEqual({
      reachable: false,
      latencyMs: null,
    })
    await app.close()
  })

  it('leaves an injected client alone on shutdown', async () => {
    /*
     * A client somebody handed us belongs to them. Disconnecting it here
     * would close a pool the caller is still using — which is exactly what
     * would happen to a test harness that shares one client across cases.
     */
    const disconnect = vi.fn()
    const client = { $disconnect: disconnect } as unknown as PrismaClient
    const app = await createTestApp({
      database: { client, probe: () => Promise.resolve() },
    })

    await app.close()

    expect(disconnect).not.toHaveBeenCalled()
  })

  it('exposes an injected client through app.db', async () => {
    const client = {} as PrismaClient
    const app = await createTestApp({
      database: { client, probe: () => Promise.resolve() },
    })

    expect(app.db).toBe(client)
    await app.close()
  })
})
