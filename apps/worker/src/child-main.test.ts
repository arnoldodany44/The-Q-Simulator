import { describe, expect, it } from 'vitest'
import { childMain } from './child-main.js'
import type { ChildMessage } from './child-protocol.js'
import { jobPayload } from './testing/payloads.js'

const CEILINGS = { maxQubits: 24, timeoutMs: 60_000 }

/**
 * A stand-in for `process`.
 *
 * The whole reason `childMain` takes a host: importing the real entry point to
 * test it would install handlers on the test runner's own process, and forking
 * a child to observe it would replace assertions with timeouts.
 */
function fakeHost() {
  const sent: ChildMessage[] = []
  let listener: ((value: unknown) => void) | null = null
  return {
    sent,
    deliver: (value: unknown) => listener?.(value),
    host: {
      send: (message: ChildMessage) => sent.push(message),
      on: (_event: 'message', handler: (value: unknown) => void) => {
        listener = handler
      },
    },
  }
}

describe('childMain', () => {
  it('announces itself before any job, so the pool knows it started', () => {
    const { host, sent } = fakeHost()
    childMain(host)
    expect(sent).toEqual([{ type: 'ready' }])
  })

  it('runs a command and answers with a bounded result', () => {
    const { host, sent, deliver } = fakeHost()
    childMain(host)
    deliver({ type: 'run', payload: jobPayload(), ceilings: CEILINGS })

    const done = sent.find((message) => message.type === 'done')
    expect(done).toBeDefined()
    expect(done?.type === 'done' && done.result.qubits).toBe(2)
  })

  it('forwards progress as it goes', () => {
    const { host, sent, deliver } = fakeHost()
    childMain(host)
    deliver({ type: 'run', payload: jobPayload(), ceilings: CEILINGS })
    expect(
      sent.filter((message) => message.type === 'progress').length
    ).toBeGreaterThan(0)
  })

  it('turns a failure into a message rather than an uncaught throw', () => {
    /*
     * An uncaught throw would kill the child, and the pool would report
     * WORKER_CRASHED — losing the one thing that was known about the failure,
     * which is what it was.
     */
    const { host, sent, deliver } = fakeHost()
    childMain(host)
    deliver({
      type: 'run',
      payload: jobPayload({ noiseProfileId: 'teaching' }),
      ceilings: CEILINGS,
    })

    const failed = sent.find((message) => message.type === 'failed')
    expect(failed?.type === 'failed' && failed.code).toBe('INVALID_CIRCUIT')
  })

  it('reports a limit refusal with its own code', () => {
    const { host, sent, deliver } = fakeHost()
    childMain(host)
    deliver({
      type: 'run',
      payload: jobPayload(),
      ceilings: { maxQubits: 1, timeoutMs: 60_000 },
    })

    const failed = sent.find((message) => message.type === 'failed')
    expect(failed?.type === 'failed' && failed.code).toBe('LIMIT_EXCEEDED')
  })

  it('ignores anything that is not a run command', () => {
    const { host, sent, deliver } = fakeHost()
    childMain(host)
    deliver({ type: 'done', result: null })
    deliver('hello')
    deliver(null)
    expect(sent).toEqual([{ type: 'ready' }])
  })
})
