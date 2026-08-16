import { encodeRunEvent, runEventChannel } from '@qsim/jobs'
import type { RunEvent } from '@qsim/jobs'
import { describe, expect, it, vi } from 'vitest'
import { NO_PUBLISHER, createRunEventPublisher } from './events.js'

const event: RunEvent = {
  type: 'run:progress',
  runId: 'run-1',
  at: 5,
  progress: { phase: 'simulating', completed: 1, total: 4 },
}

function harness(
  publish: (channel: string, message: string) => Promise<number>
) {
  const logs: { level: string; message: string }[] = []
  const publisher = createRunEventPublisher({
    connection: { publish },
    prefix: 'qsim-test',
    log: (level, _fields, message) => logs.push({ level, message }),
  })
  return { publisher, logs }
}

describe('createRunEventPublisher', () => {
  it('publishes the encoded event on the run’s own channel', async () => {
    const calls: [string, string][] = []
    const { publisher } = harness((channel, message) => {
      calls.push([channel, message])
      return Promise.resolve(1)
    })

    publisher(event)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual([
      runEventChannel('qsim-test', 'run-1'),
      encodeRunEvent(event),
    ])
  })

  it('treats nobody listening as success, because it is', async () => {
    // `PUBLISH` answers zero when no subscriber exists, which is the normal
    // case: most runs are never watched over a socket at all.
    const { publisher, logs } = harness(() => Promise.resolve(0))
    publisher(event)
    await vi.waitFor(() => expect(logs).toEqual([]))
  })

  it('swallows a refusal, so a run can never fail over a notification', async () => {
    const { publisher, logs } = harness(() =>
      Promise.reject(new Error('connection reset'))
    )

    // Returns synchronously and throws nothing, which is the property the
    // processor depends on: it calls this on the path that writes a row.
    expect(() => publisher(event)).not.toThrow()
    await vi.waitFor(() => expect(logs).toHaveLength(1))
    expect(logs[0]?.level).toBe('warn')
  })

  it('is a no-op when there is nowhere to publish', () => {
    expect(() => NO_PUBLISHER(event)).not.toThrow()
  })
})
