import { describe, expect, it } from 'vitest'
import {
  COMPLETED_RETENTION,
  MAX_QUEUE_DEPTH,
  DEFAULT_QUEUE_PREFIX,
  FAILED_RETENTION,
  JOB_ATTEMPTS,
  JOB_BACKOFF,
  LOCK_DURATION_MS,
  MAX_STALLED_COUNT,
  STALLED_CHECK_INTERVAL_MS,
  queuePrefix,
} from './queue.js'

describe('queuePrefix', () => {
  it('namespaces every key, because the instance is shared with production', () => {
    expect(queuePrefix(undefined)).toBe(DEFAULT_QUEUE_PREFIX)
    expect(queuePrefix('')).toBe(DEFAULT_QUEUE_PREFIX)
    expect(queuePrefix('   ')).toBe(DEFAULT_QUEUE_PREFIX)
  })

  it('takes a configured prefix so a test never writes into the live queue', () => {
    expect(queuePrefix('qsim-test-abc')).toBe('qsim-test-abc')
    expect(queuePrefix('  qsim-dev  ')).toBe('qsim-dev')
  })
})

describe('the three retry policies', () => {
  it('retries a job, because the only thing that throws is the storage', () => {
    /*
     * A deterministic failure never reaches BullMQ: the processor writes a
     * FAILED row and reports the job done, because writing that row *was* the
     * job. What does reach it is a repository call that could not be made — the
     * row is untouched, the work has genuinely not happened, and one attempt
     * meant such a job was filed as failed with nobody listening and its run
     * left QUEUED for ever.
     */
    expect(JOB_ATTEMPTS).toBeGreaterThan(1)
  })

  it('spaces those retries, because a pooler needs a moment', () => {
    expect(JOB_BACKOFF.type).toBe('exponential')
    expect(JOB_BACKOFF.delay).toBeGreaterThanOrEqual(1_000)
  })

  it('does recover a job whose worker stopped renewing its lock', () => {
    // A stall is not about the job: the work was never done, so it must be.
    expect(MAX_STALLED_COUNT).toBeGreaterThanOrEqual(1)
  })

  it('checks for expired locks several times inside one lock lifetime', () => {
    // Otherwise a dead worker's job waits a whole extra lock duration before
    // anyone notices it, on top of the duration itself.
    expect(STALLED_CHECK_INTERVAL_MS).toBeLessThan(LOCK_DURATION_MS)
  })
})

describe('retention', () => {
  it('keeps a completed job only as long as somebody might look at it', () => {
    /*
     * This used to be justified by deduplication, which was simply wrong:
     * deduplication is the separate `dedupe:` key with its own TTL, and the job
     * id is the run id, so nothing reads a completed job's hash once the run is
     * terminal. What is left is an operator with a dashboard — minutes, not
     * quarters of an hour, on an instance where every job hash is a whole
     * circuit document.
     */
    expect(COMPLETED_RETENTION.age).toBeGreaterThanOrEqual(60)
    expect(COMPLETED_RETENTION.age).toBeLessThanOrEqual(900)
  })

  it('bounds what can be waiting, not only what has finished', () => {
    /*
     * The instance is 256 MB with `noeviction`. Retention bounds the tail;
     * without a depth bound the *head* is unbounded, and a queue that fills
     * that instance does not degrade — every write in the system fails at once,
     * including the ones that would report it.
     */
    expect(MAX_QUEUE_DEPTH).toBeGreaterThan(0)
    expect(MAX_QUEUE_DEPTH).toBeLessThanOrEqual(64)
  })

  it('keeps a failure longer than a success, because nobody debugs in fifteen minutes', () => {
    expect(FAILED_RETENTION.age).toBeGreaterThan(COMPLETED_RETENTION.age)
  })

  it('bounds both by count as well as by age, on a 256 MB instance', () => {
    expect(COMPLETED_RETENTION.count).toBeLessThanOrEqual(200)
    expect(FAILED_RETENTION.count).toBeLessThanOrEqual(200)
  })
})
