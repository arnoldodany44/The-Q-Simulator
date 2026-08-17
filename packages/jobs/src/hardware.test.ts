import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HARDWARE_SHOTS,
  HARDWARE_FAILURE_CODES,
  HARDWARE_JOB_NAME,
  HARDWARE_QUEUE,
  HARDWARE_STALE_AFTER_MS,
  HARDWARE_STATUSES,
  MAX_HARDWARE_SHOTS,
  MAX_POLL_ATTEMPTS,
  POLL_TAIL_MS,
  RESUME_IDLE_MS,
  hardwareTickId,
  isHardwareFailureCode,
  isTerminalHardwareStatus,
  parseHardwarePayload,
  parseHardwareResult,
  pollDelayMs,
} from './hardware.js'
import { SIMULATION_QUEUE } from './queue.js'

describe('the hardware queue', () => {
  it('is a queue of its own, not a job name on the simulation queue', () => {
    // The retry, retention and concurrency policies are per queue in BullMQ
    // and are opposite here — see the module header.
    expect(HARDWARE_QUEUE).not.toBe(SIMULATION_QUEUE)
    expect(HARDWARE_JOB_NAME).toBeTruthy()
  })

  /*
   * Determinism is what stops the resume sweep from being a fan-out: two
   * replicas that both decide job `abc` needs its fourth poll must produce one
   * queue job, not two.
   */
  it('names a tick deterministically from the job and the tick number', () => {
    expect(hardwareTickId('abc', 4)).toBe(hardwareTickId('abc', 4))
    expect(hardwareTickId('abc', 4)).not.toBe(hardwareTickId('abc', 5))
    expect(hardwareTickId('abc', 4)).not.toBe(hardwareTickId('abd', 4))
  })

  it('never puts a colon in a tick id, which is BullMQ s key separator', () => {
    expect(hardwareTickId('abc', 4)).not.toContain(':')
  })
})

describe('pollDelayMs', () => {
  it('asks quickly at first, because somebody just pressed the button', () => {
    expect(pollDelayMs(0)).toBeLessThanOrEqual(2_000)
    expect(pollDelayMs(1)).toBeLessThanOrEqual(5_000)
  })

  it('increases and then flattens rather than doubling for ever', () => {
    const early = pollDelayMs(0)
    const late = pollDelayMs(5)
    expect(late).toBeGreaterThan(early)
    // A doubling schedule reaches a six-hour gap on the second day, and a job
    // that finished at 3 a.m. would still read RUNNING at breakfast.
    expect(pollDelayMs(500)).toBe(POLL_TAIL_MS)
    expect(pollDelayMs(MAX_POLL_ATTEMPTS)).toBe(POLL_TAIL_MS)
  })

  it('never answers zero or a negative, whatever it is handed', () => {
    for (const tick of [-5, -1, 0, 3, 999]) {
      expect(pollDelayMs(tick)).toBeGreaterThan(0)
    }
  })

  /* The sweep must never race a schedule that is working perfectly. */
  it('leaves the resume horizon comfortably above the longest gap', () => {
    expect(RESUME_IDLE_MS).toBeGreaterThan(POLL_TAIL_MS * 2)
  })

  it('polls for long enough to outlast a real device queue', () => {
    const horizonMs = MAX_POLL_ATTEMPTS * POLL_TAIL_MS
    expect(horizonMs).toBeGreaterThan(24 * 60 * 60_000)
    // …and the reaper is a genuine last line of defence rather than a second
    // poll ceiling that fires first.
    expect(HARDWARE_STALE_AFTER_MS).toBeGreaterThan(horizonMs)
  })
})

describe('HardwareJobPayloadSchema', () => {
  const payload = { jobId: 'job-1', userId: 'user-1', tick: 0 }

  it('carries an id and not a circuit', () => {
    // Everything a tick needs is in the row, which is what makes resuming a
    // job this worker did not submit possible at all.
    expect(Object.keys(parseHardwarePayload(payload)).sort()).toEqual([
      'jobId',
      'tick',
      'userId',
    ])
  })

  it('refuses a tick past the ceiling', () => {
    expect(() =>
      parseHardwarePayload({ ...payload, tick: MAX_POLL_ATTEMPTS + 1 })
    ).toThrow()
  })

  it('refuses an identifier long enough to become a Redis key', () => {
    expect(() =>
      parseHardwarePayload({ ...payload, jobId: 'x'.repeat(200) })
    ).toThrow()
  })
})

describe('the status vocabulary', () => {
  it('treats the three end states as terminal and nothing else', () => {
    expect(HARDWARE_STATUSES.filter(isTerminalHardwareStatus)).toEqual([
      'DONE',
      'FAILED',
      'CANCELLED',
    ])
  })

  it('recognises exactly its own failure codes', () => {
    for (const code of HARDWARE_FAILURE_CODES) {
      expect(isHardwareFailureCode(code)).toBe(true)
    }
    expect(isHardwareFailureCode('ENGINE_FAILED')).toBe(false)
  })

  /*
   * The most expensive failure in this milestone: the device spent somebody's
   * allowance and the answer could not be collected. It must never hide inside
   * a generic failure, because the response to it is "go and read the job at
   * the provider" and not "run it again".
   */
  it('has a distinct code for a result that was produced and lost', () => {
    expect(HARDWARE_FAILURE_CODES).toContain('RESULT_UNREADABLE')
  })
})

describe('HardwareResultSchema', () => {
  const result = {
    backend: 'ibm_marrakesh',
    shots: 100,
    counts: { '01': 97, '11': 3 },
    layout: [154, 155],
    calibratedAt: '2026-08-14T12:44:02Z',
    quantumSeconds: 4.1,
  }

  it('accepts what a finished job stores', () => {
    expect(parseHardwareResult(result)).toEqual(result)
  })

  /*
   * The comparison of §3.7 is a join on the bitstring key, so a count keyed
   * any other way would make the three-column view silently empty rather than
   * wrong-looking.
   */
  it('refuses a count key that is not a bitstring', () => {
    expect(parseHardwareResult({ ...result, counts: { '0x1': 5 } })).toBeNull()
    expect(parseHardwareResult({ ...result, counts: { '|01>': 5 } })).toBeNull()
  })

  it('refuses more shots than the plan s allowance should ever buy', () => {
    expect(
      parseHardwareResult({ ...result, shots: MAX_HARDWARE_SHOTS + 1 })
    ).toBeNull()
    expect(DEFAULT_HARDWARE_SHOTS).toBeLessThanOrEqual(MAX_HARDWARE_SHOTS)
  })

  it('answers null rather than throwing on a row an older build wrote', () => {
    expect(parseHardwareResult({ counts: { '01': 1 } })).toBeNull()
    expect(parseHardwareResult(null)).toBeNull()
  })
})
