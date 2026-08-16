import { describe, expect, it } from 'vitest'
import {
  RUN_STATUSES,
  SIMULATION_FAILURE_CODES,
  SIMULATION_MODES,
  SimulationFailure,
  canTransition,
  failureCodeOf,
  isSampledMode,
  isSimulationFailureCode,
  isSimulationMode,
  isTerminalStatus,
  predecessorsOf,
} from './run.js'
import type { RunStatus } from './run.js'

describe('the mode vocabulary', () => {
  it('is the three of §5 and nothing else', () => {
    expect([...SIMULATION_MODES]).toEqual([
      'STATEVECTOR',
      'DENSITY_MATRIX',
      'TRAJECTORIES',
    ])
  })

  it('recognises its own members and refuses a lookalike', () => {
    expect(isSimulationMode('STATEVECTOR')).toBe(true)
    expect(isSimulationMode('statevector')).toBe(false)
    expect(isSimulationMode('DENSITY')).toBe(false)
  })

  it('calls only trajectories a sampled mode', () => {
    // The distinction drives the cost model: a sampled mode multiplies by
    // shots, the other two do not, and getting that backwards would admit a
    // hundred-thousand-shot run as if it cost one.
    expect(isSampledMode('TRAJECTORIES')).toBe(true)
    expect(isSampledMode('STATEVECTOR')).toBe(false)
    expect(isSampledMode('DENSITY_MATRIX')).toBe(false)
  })
})

describe('the run state machine', () => {
  it('lets a queued run start', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true)
  })

  it('lets a run finish from either non-terminal status', () => {
    // QUEUED → DONE is the path of a job whose first worker died before its
    // claim landed. Refusing it would strand a correct result.
    expect(canTransition('QUEUED', 'DONE')).toBe(true)
    expect(canTransition('RUNNING', 'DONE')).toBe(true)
    expect(canTransition('QUEUED', 'FAILED')).toBe(true)
    expect(canTransition('RUNNING', 'FAILED')).toBe(true)
  })

  it('makes a terminal status final, including against itself', () => {
    // This is the whole guard against a job running twice with visible effect:
    // the second completion is a write that matches no row.
    for (const terminal of ['DONE', 'FAILED'] as const) {
      for (const next of RUN_STATUSES) {
        expect(canTransition(terminal, next)).toBe(false)
      }
    }
  })

  it('never puts a run back in the queue', () => {
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, 'QUEUED')).toBe(false)
    }
    expect(predecessorsOf('QUEUED')).toEqual([])
  })

  it('agrees with itself about what may precede each status', () => {
    for (const to of RUN_STATUSES) {
      for (const from of RUN_STATUSES) {
        expect(canTransition(from, to)).toBe(predecessorsOf(to).includes(from))
      }
    }
  })

  it('knows which statuses are terminal', () => {
    const terminal = RUN_STATUSES.filter((status: RunStatus) =>
      isTerminalStatus(status)
    )
    expect(terminal).toEqual(['DONE', 'FAILED'])
  })
})

describe('the failure vocabulary', () => {
  it('carries a code that survives being thrown', () => {
    const failure = new SimulationFailure('TIMED_OUT', 'ran past its bound')
    expect(failure.code).toBe('TIMED_OUT')
    expect(failure.name).toBe('SimulationFailure')
    expect(failureCodeOf(failure)).toBe('TIMED_OUT')
  })

  it('classifies anything else as an engine fault, without reading a message', () => {
    // Deliberately a message that names a different code. Classification is by
    // shape; if it were by text, a circuit could choose its own failure code by
    // putting one in a label.
    expect(failureCodeOf(new Error('TIMED_OUT'))).toBe('ENGINE_FAILED')
    expect(failureCodeOf('RESULT_TOO_LARGE')).toBe('ENGINE_FAILED')
    expect(failureCodeOf(null)).toBe('ENGINE_FAILED')
  })

  it('recognises its own codes', () => {
    for (const code of SIMULATION_FAILURE_CODES) {
      expect(isSimulationFailureCode(code)).toBe(true)
    }
    expect(isSimulationFailureCode('BOOM')).toBe(false)
  })
})
