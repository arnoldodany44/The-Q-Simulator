/**
 * The four facts that make a device's counts a measurement rather than a
 * computation: which chip, how long it waited, when it ran, and how old the
 * calibration was.
 */

import { describe, expect, it } from 'vitest'

import { provenanceOf, type ProvenanceSource } from './provenance'

const HOUR = 3_600_000

function job(overrides: Partial<ProvenanceSource> = {}): ProvenanceSource {
  return {
    backend: 'ibm_marrakesh',
    providerJobId: 'd2k9v0abc',
    shots: 1024,
    submittedAt: '2026-08-15T10:00:00.000Z',
    completedAt: '2026-08-15T10:04:30.000Z',
    queuePosition: null,
    result: {
      calibratedAt: '2026-08-15T04:00:00.000Z',
      quantumSeconds: 3.2,
      layout: [53, 54],
      shots: 1024,
    },
    ...overrides,
  }
}

describe('what a stored job says about the run that produced it', () => {
  it('names the chip and the provider s own id for the job', () => {
    const provenance = provenanceOf(job())

    expect(provenance.backend).toBe('ibm_marrakesh')
    // How a person finds this job in IBM's console, which is the only place
    // that can answer "what actually happened" when the poll gave up.
    expect(provenance.providerJobId).toBe('d2k9v0abc')
  })

  it('measures the wait rather than quoting a queue depth', () => {
    // Today's depth on that device is a different measurement, taken now, and
    // would be read as the queue this job waited in.
    expect(provenanceOf(job()).waitMs).toBe(270_000)
  })

  it('leaves the wait absent while the job is still waiting', () => {
    // A duration ending "now" would change on every render and would describe
    // the reader's patience rather than the device's queue.
    expect(provenanceOf(job({ completedAt: null })).waitMs).toBeNull()
  })

  it('says how old the calibration already was when the job went in', () => {
    // The number that says how much to trust the placement: these qubits were
    // chosen from a reading six hours old.
    expect(provenanceOf(job()).calibrationAgeMs).toBe(6 * HOUR)
  })

  it('keeps a negative calibration age instead of flooring it', () => {
    // A calibration published after submission means one of the timestamps is
    // not what it claims, and a floor would hide exactly that.
    const later = job({
      result: {
        calibratedAt: '2026-08-15T11:00:00.000Z',
        quantumSeconds: null,
        layout: [53, 54],
        shots: 1024,
      },
    })

    expect(provenanceOf(later).calibrationAgeMs).toBe(-HOUR)
  })

  it('reports the shots that came back, not the shots that were asked for', () => {
    // The third column is drawn from what came back, so a header quoting the
    // request would label a histogram with a number that is not its denominator.
    const short = job({
      shots: 1024,
      result: {
        calibratedAt: null,
        quantumSeconds: null,
        layout: [53, 54],
        shots: 900,
      },
    })

    expect(provenanceOf(short).shots).toBe(900)
  })

  it('falls back to the requested shots when nothing came back yet', () => {
    expect(provenanceOf(job({ result: null })).shots).toBe(1024)
  })

  it('reads a timestamp whether it arrives as a string or a Date', () => {
    const asDates = provenanceOf(
      job({
        submittedAt: new Date('2026-08-15T10:00:00.000Z'),
        completedAt: new Date('2026-08-15T10:04:30.000Z'),
      })
    )

    // The same job arrives as ISO strings over the wire and as Dates from
    // anything holding the server's row; a panel that produced `Invalid Date`
    // in one of the two would only show it in the deployed build.
    expect(asDates.waitMs).toBe(270_000)
    expect(asDates.submittedAt.toISOString()).toBe('2026-08-15T10:00:00.000Z')
  })

  it('treats an unparseable timestamp as absent rather than invalid', () => {
    const broken = provenanceOf(job({ completedAt: 'not a date' }))

    expect(broken.completedAt).toBeNull()
    expect(broken.waitMs).toBeNull()
  })

  it('carries the QPU seconds and the layout the job ran on', () => {
    const provenance = provenanceOf(job())

    expect(provenance.quantumSeconds).toBe(3.2)
    expect(provenance.layout).toEqual([53, 54])
  })

  it('leaves the queue position null when the provider reported none', () => {
    // Null means "not reported", never "first in line" — the current Quantum
    // API's job document carries no per-job position at all.
    expect(provenanceOf(job()).queuePosition).toBeNull()
    expect(provenanceOf(job({ queuePosition: 12 })).queuePosition).toBe(12)
  })
})
