import { describe, expect, it } from 'vitest'
import {
  HARDWARE_JOB_STATUSES,
  IBM_JOB_STATUSES,
  JobDocumentSchema,
  hardwareStatusOf,
  isTerminal,
  submitJobBody,
  toJobReading,
} from './jobs.js'

describe('submitJobBody', () => {
  it('always writes a three-element pub', () => {
    const body = submitJobBody({ backend: 'b', qasm: 'q', shots: 1 })
    // A two-element pub means "use the default shot count", and the shot count
    // is the one number in this request that must never be defaulted: it is
    // what the Open Plan's ten minutes are spent on.
    expect(body.params.pubs[0]).toHaveLength(3)
    expect(body.params.pubs[0]?.[1]).toBeNull()
  })

  it('carries no free parameters, because a submitted circuit has none', () => {
    const body = submitJobBody({ backend: 'b', qasm: 'q', shots: 100 })
    expect(body.params.pubs[0]?.[1]).toBeNull()
  })
})

describe('hardwareStatusOf', () => {
  it('maps every status the service reports', () => {
    for (const status of IBM_JOB_STATUSES) {
      expect(hardwareStatusOf(status)).not.toBeNull()
    }
  })

  it('is case-insensitive, because the spelling has changed across versions', () => {
    expect(hardwareStatusOf('queued')).toBe('QUEUED')
    expect(hardwareStatusOf('COMPLETED')).toBe('DONE')
  })

  /*
   * The important one. A word this build has never seen must not move a row:
   * guessing FAILED for a service that added `Validating` would mark a wave of
   * perfectly healthy jobs as failed.
   */
  it('answers null for a word it does not know, rather than guessing', () => {
    expect(hardwareStatusOf('Validating')).toBeNull()
    expect(hardwareStatusOf('')).toBeNull()
  })

  it('has SUBMITTED with no IBM counterpart, on purpose', () => {
    const mapped = new Set(
      IBM_JOB_STATUSES.map((status) => hardwareStatusOf(status))
    )
    expect(mapped.has('SUBMITTED')).toBe(false)
    expect(HARDWARE_JOB_STATUSES).toContain('SUBMITTED')
  })

  it('treats the three end states as terminal and nothing else', () => {
    expect(HARDWARE_JOB_STATUSES.filter(isTerminal)).toEqual([
      'DONE',
      'FAILED',
      'CANCELLED',
    ])
  })
})

describe('toJobReading', () => {
  it('prefers state.status, which the service updates first', () => {
    const document = JobDocumentSchema.parse({
      id: 'j',
      status: 'Queued',
      state: { status: 'Running' },
    })
    expect(toJobReading(document).status).toBe('RUNNING')
  })

  it('falls back to the flat status when there is no state block', () => {
    const document = JobDocumentSchema.parse({ id: 'j', status: 'Completed' })
    expect(toJobReading(document).status).toBe('DONE')
  })

  it('reads a queue position under either spelling, and null when neither', () => {
    expect(
      toJobReading(JobDocumentSchema.parse({ id: 'j', position: 7 }))
        .queuePosition
    ).toBe(7)
    expect(
      toJobReading(JobDocumentSchema.parse({ id: 'j', queue_position: 9 }))
        .queuePosition
    ).toBe(9)
    expect(
      toJobReading(JobDocumentSchema.parse({ id: 'j' })).queuePosition
    ).toBeNull()
  })

  /* The submitted program is echoed back and is deliberately not read. */
  it('drops the echoed program rather than carrying a circuit per poll', () => {
    const document = JobDocumentSchema.parse({
      id: 'j',
      status: 'Queued',
      params: { pubs: [['OPENQASM 3.0; …', null, 100]] },
    })
    expect(JSON.stringify(document)).not.toContain('OPENQASM')
  })
})
