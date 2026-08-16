import { describe, expect, it, vi } from 'vitest'
import { assertReachable } from './queue.js'

describe('Redis unreachable at startup', () => {
  it('passes when Redis answers', async () => {
    const ping = vi.fn<() => Promise<unknown>>().mockResolvedValue('PONG')
    await expect(assertReachable({ ping })).resolves.toBeUndefined()
  })

  it('refuses to start rather than idling silently', async () => {
    /*
     * The failure this exists to prevent is not a crash — it is a *success*.
     * ioredis retries a connection in the background forever, so without this
     * check the process starts, reports healthy, consumes nothing, and the
     * queue fills with nobody being told. §12.5 makes REDIS_URL required here
     * precisely so this can be a boot failure, and this is where that becomes
     * true.
     */
    const ping = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(assertReachable({ ping })).rejects.toThrow('ECONNREFUSED')
  })

  it('gives up on a Redis that accepts a connection and never answers', async () => {
    // The nastier variant: the socket opens, the PING is written, and nothing
    // comes back. An unbounded await here would hang the boot forever, which
    // looks exactly like a slow deploy.
    const ping = vi
      .fn<() => Promise<unknown>>()
      .mockImplementation(() => new Promise<unknown>(() => undefined))
    await expect(assertReachable({ ping }, 50)).rejects.toThrow(
      /did not answer a PING/
    )
  })
})
