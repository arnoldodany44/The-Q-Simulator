import { describe, expect, it } from 'vitest'
import {
  PROGRESS_MIN_INTERVAL_MS,
  SHOT_CHUNK,
  initialProgress,
  parseProgress,
  progressFraction,
  shouldReport,
} from './progress.js'
import type { JobProgress } from './progress.js'

const simulating = (completed: number, total: number | null): JobProgress => ({
  phase: 'simulating',
  completed,
  total,
})

describe('progressFraction', () => {
  it('divides where there is something to divide', () => {
    expect(progressFraction(simulating(50, 200))).toBe(0.25)
  })

  it('refuses to invent a number for an indivisible phase', () => {
    // A statevector run is one walk of the circuit with no subdivision the
    // engine exposes. A fabricated percentage that stalls at 90 % teaches a
    // reader that this application's progress bars lie.
    expect(progressFraction(simulating(0, null))).toBeNull()
    expect(
      progressFraction({ phase: 'simulating', completed: null, total: 200 })
    ).toBeNull()
  })

  it('clamps, so a rounding overshoot is not 1.0001', () => {
    expect(progressFraction(simulating(300, 200))).toBe(1)
  })
})

describe('shouldReport', () => {
  it('always reports the first thing a job says', () => {
    expect(shouldReport(null, initialProgress(), 0)).toBe(true)
  })

  it('always reports a phase change, however soon it arrives', () => {
    // There are four phases in the life of a job and a client reacts to each.
    expect(
      shouldReport(
        { phase: 'validating', completed: null, total: null },
        simulating(0, 10),
        1
      )
    ).toBe(true)
  })

  it('suppresses a second report inside the interval', () => {
    expect(
      shouldReport(
        simulating(10, 100),
        simulating(90, 100),
        PROGRESS_MIN_INTERVAL_MS - 1
      )
    ).toBe(false)
  })

  it('suppresses a change too small to see, even after the interval', () => {
    // Two per cent is half a pixel on a hundred-pixel bar. Below that the write
    // buys the reader nothing and costs the metered tier a round trip.
    expect(
      shouldReport(simulating(100, 10_000), simulating(101, 10_000), 5_000)
    ).toBe(false)
  })

  it('reports a change worth seeing once the interval has passed', () => {
    expect(
      shouldReport(simulating(100, 1_000), simulating(300, 1_000), 5_000)
    ).toBe(true)
  })

  it('keeps an indivisible phase visibly alive on the interval alone', () => {
    expect(
      shouldReport(
        simulating(0, null),
        simulating(0, null),
        PROGRESS_MIN_INTERVAL_MS
      )
    ).toBe(true)
  })
})

describe('parseProgress', () => {
  it('reads back what a worker wrote', () => {
    expect(
      parseProgress({ phase: 'sampling', completed: 3, total: 10 })
    ).toEqual({ phase: 'sampling', completed: 3, total: 10 })
  })

  it('answers null rather than throwing on anything else', () => {
    // A malformed progress field must never be able to fail a read of a run
    // that is otherwise perfectly fine.
    expect(parseProgress({ phase: 'thinking' })).toBeNull()
    expect(parseProgress(42)).toBeNull()
    expect(parseProgress(undefined)).toBeNull()
    expect(
      parseProgress({ phase: 'simulating', completed: 1, total: 0 })
    ).toBeNull()
  })
})

describe('SHOT_CHUNK', () => {
  it('is a constant, because it is part of what makes a seeded run repeatable', () => {
    // Threading one generator through fixed chunks is what makes the same seed
    // give the same draws. A chunk size tuned per job would make a
    // "reproducible" run reproducible only on a machine in the same mood.
    expect(SHOT_CHUNK).toBe(128)
  })
})
