import { describe, expect, it } from 'vitest'
import {
  MAX_RUN_EVENT_BYTES,
  RUN_EVENT_TYPES,
  encodeRunEvent,
  parseRunEvent,
  runEventChannel,
} from './events.js'
import type { RunEvent } from './events.js'

const progress: RunEvent = {
  type: 'run:progress',
  runId: 'run_0000000000000000001',
  at: 1_700_000_000_000,
  progress: { phase: 'simulating', completed: 40, total: 100 },
}

describe('runEventChannel', () => {
  it('namespaces every channel under the configured prefix', () => {
    expect(runEventChannel('qsim-test', 'run_1')).toBe('qsim-test:events:run_1')
  })

  it('gives two runs two channels, so a replica receives only what it asked for', () => {
    expect(runEventChannel('qsim', 'a')).not.toBe(runEventChannel('qsim', 'b'))
  })
})

describe('parseRunEvent', () => {
  it('round-trips every event type', () => {
    const events: RunEvent[] = [
      progress,
      {
        type: 'job:status',
        runId: 'run_1',
        at: 1,
        status: 'RUNNING',
      },
      {
        type: 'run:complete',
        runId: 'run_1',
        at: 2,
        status: 'DONE',
        durationMs: 12,
        error: null,
      },
      {
        type: 'run:complete',
        runId: 'run_1',
        at: 3,
        status: 'FAILED',
        durationMs: null,
        error: 'TIMED_OUT',
      },
    ]
    for (const event of events) {
      expect(parseRunEvent(encodeRunEvent(event))).toEqual(event)
    }
  })

  it('covers every name §8 lists', () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual([
      'job:status',
      'run:complete',
      'run:progress',
    ])
  })

  it('answers null rather than throwing on anything unparseable', () => {
    // Each of these is something a channel can genuinely carry: a truncated
    // publish, an unrelated producer, a shape from a future version. None of
    // them may take down the process holding the subscription.
    expect(parseRunEvent('not json')).toBeNull()
    expect(parseRunEvent('{}')).toBeNull()
    expect(parseRunEvent('[]')).toBeNull()
    expect(parseRunEvent('null')).toBeNull()
    expect(parseRunEvent(JSON.stringify({ type: 'run:unknown' }))).toBeNull()
  })

  it('refuses a completion whose status is not terminal', () => {
    // The point of the narrower enum: `run:complete` that says RUNNING would
    // make a client stop waiting for an answer that is still coming.
    const raw = JSON.stringify({
      ...progress,
      type: 'run:complete',
      status: 'RUNNING',
      durationMs: 1,
      error: null,
    })
    expect(parseRunEvent(raw)).toBeNull()
  })

  it('refuses a run id that is not one', () => {
    const raw = JSON.stringify({ ...progress, runId: '../../etc/passwd' })
    expect(parseRunEvent(raw)).toBeNull()
  })

  it('refuses an oversized payload before parsing it', () => {
    const oversized = JSON.stringify({
      ...progress,
      runId: 'a'.repeat(MAX_RUN_EVENT_BYTES),
    })
    expect(oversized.length).toBeGreaterThan(MAX_RUN_EVENT_BYTES)
    expect(parseRunEvent(oversized)).toBeNull()
  })

  it('keeps a legitimate event far inside the byte ceiling', () => {
    expect(encodeRunEvent(progress).length).toBeLessThan(
      MAX_RUN_EVENT_BYTES / 4
    )
  })
})
