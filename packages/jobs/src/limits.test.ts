import { MAX_DENSITY_QUBITS, MAX_QUBITS } from '@qsim/core'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_DENSITY_QUBITS,
  CLIENT_STATEVECTOR_QUBITS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_SERVER_QUBITS,
  DEFAULT_SYNC_WAIT_MS,
  MAX_SERVER_OPERATIONS,
  MAX_SHOTS,
  checkLimits,
  clampShots,
  clientCeilingFor,
  clientCeilingsAgree,
  routeOf,
  serverCeilingFor,
  simulationWork,
  workBudgetFor,
} from './limits.js'

describe('the client ceilings', () => {
  it('restate what the browser already does', () => {
    expect(CLIENT_STATEVECTOR_QUBITS).toBe(20)
    expect(CLIENT_DENSITY_QUBITS).toBe(12)
  })

  it('can only ever be stricter than the engine, never looser', () => {
    expect(CLIENT_STATEVECTOR_QUBITS).toBeLessThanOrEqual(MAX_QUBITS)
    expect(CLIENT_DENSITY_QUBITS).toBeLessThanOrEqual(MAX_DENSITY_QUBITS)
  })

  it('are per mode, exactly as the browser ceilings are', () => {
    expect(clientCeilingFor('STATEVECTOR')).toBe(20)
    expect(clientCeilingFor('TRAJECTORIES')).toBe(20)
    expect(clientCeilingFor('DENSITY_MATRIX')).toBe(12)
  })

  it('lets a consumer holding both copies prove they agree', () => {
    expect(clientCeilingsAgree(20, 12)).toBe(true)
    expect(clientCeilingsAgree(21, 12)).toBe(false)
    expect(clientCeilingsAgree(20, 10)).toBe(false)
  })
})

describe('the server ceiling', () => {
  it('defaults to the largest state that fits the 256 MB budget', () => {
    // §5.1's table: 24 qubits is 256 MB of amplitudes, 28 is 4 GB.
    expect(DEFAULT_SERVER_QUBITS).toBe(24)
    expect(serverCeilingFor('STATEVECTOR')).toBe(24)
  })

  it('cannot be configured past the engine', () => {
    expect(serverCeilingFor('STATEVECTOR', 64)).toBe(MAX_QUBITS)
  })

  it('ignores configuration entirely for ρ, because 4ⁿ does not negotiate', () => {
    expect(serverCeilingFor('DENSITY_MATRIX', 28)).toBe(MAX_DENSITY_QUBITS)
  })
})

describe('the cost model', () => {
  it('is 2ⁿ per operation for one exact statevector pass', () => {
    expect(
      simulationWork({
        mode: 'STATEVECTOR',
        qubits: 10,
        operations: 3,
        shots: null,
      })
    ).toBe(3 * 1024)
  })

  it('does not multiply a statevector run by its shots', () => {
    // Sampling draws from a state that already exists (§5.3); it is a pass over
    // the distribution, not a second run of the circuit.
    const withShots = simulationWork({
      mode: 'STATEVECTOR',
      qubits: 10,
      operations: 3,
      shots: 100_000,
    })
    expect(withShots).toBe(3 * 1024)
  })

  it('multiplies a trajectories run by its shots, because every shot restarts', () => {
    expect(
      simulationWork({
        mode: 'TRAJECTORIES',
        qubits: 8,
        operations: 5,
        shots: 200,
      })
    ).toBe(200 * 5 * 256)
  })

  it('is 4ⁿ per operation for ρ', () => {
    expect(
      simulationWork({
        mode: 'DENSITY_MATRIX',
        qubits: 6,
        operations: 2,
        shots: null,
      })
    ).toBe(2 * 4096)
  })

  it('charges an empty circuit for its allocation rather than for nothing', () => {
    // Otherwise the budget divides by zero and the one circuit whose cost is
    // easiest to under-estimate is admitted unbounded.
    expect(
      simulationWork({
        mode: 'STATEVECTOR',
        qubits: 4,
        operations: 0,
        shots: null,
      })
    ).toBe(16)
  })
})

describe('the routing threshold', () => {
  const small = { mode: 'STATEVECTOR', operations: 20, shots: null } as const

  it('answers immediately for a register the browser could have handled', () => {
    expect(routeOf({ ...small, qubits: 12 })).toBe('immediate')
    expect(routeOf({ ...small, qubits: CLIENT_STATEVECTOR_QUBITS })).toBe(
      'immediate'
    )
  })

  it('queues the first register past the client ceiling', () => {
    // 21 qubits is where the server's reason for existing starts (§4), and it
    // is already 32 MB and hundreds of millions of operations.
    expect(routeOf({ ...small, qubits: CLIENT_STATEVECTOR_QUBITS + 1 })).toBe(
      'queued'
    )
  })

  it('uses the rho ceiling for a density run', () => {
    expect(
      routeOf({ mode: 'DENSITY_MATRIX', qubits: 8, operations: 5, shots: null })
    ).toBe('immediate')
    // Thirteen is past the browser's ρ ceiling and is refused outright
    // elsewhere; what matters here is that it is never offered synchronously.
    expect(
      routeOf({
        mode: 'DENSITY_MATRIX',
        qubits: CLIENT_DENSITY_QUBITS + 1,
        operations: 5,
        shots: null,
      })
    ).toBe('queued')
  })

  it('queues a small register whose shots make it long', () => {
    // The half of the threshold that is time rather than size: twelve qubits
    // is small by every register measure and a hundred thousand trajectories
    // of it is minutes.
    expect(
      routeOf({
        mode: 'TRAJECTORIES',
        qubits: 12,
        operations: 40,
        shots: MAX_SHOTS,
      })
    ).toBe('queued')
    expect(
      routeOf({ mode: 'TRAJECTORIES', qubits: 4, operations: 10, shots: 200 })
    ).toBe('immediate')
  })

  it('widens what is immediate when the caller is willing to wait longer', () => {
    const heavy = {
      mode: 'TRAJECTORIES',
      qubits: 10,
      operations: 30,
      shots: 2_000,
    } as const
    expect(routeOf(heavy, DEFAULT_SYNC_WAIT_MS)).toBe('queued')
    expect(routeOf(heavy, 120_000)).toBe('immediate')
  })
})

describe('§11 admission control', () => {
  const base = {
    mode: 'STATEVECTOR',
    qubits: 4,
    operations: 10,
    shots: null,
  } as const

  it('admits ordinary work', () => {
    expect(checkLimits(base)).toBeNull()
  })

  it('refuses a register past the ceiling, naming both numbers', () => {
    expect(checkLimits({ ...base, qubits: 25 })).toEqual({
      code: 'too-many-qubits',
      value: 25,
      limit: DEFAULT_SERVER_QUBITS,
    })
  })

  it('refuses a thirteen-qubit ρ whatever the configuration says', () => {
    expect(
      checkLimits(
        { mode: 'DENSITY_MATRIX', qubits: 13, operations: 1, shots: null },
        { maxQubits: 28 }
      )
    ).toMatchObject({ code: 'too-many-qubits', limit: MAX_DENSITY_QUBITS })
  })

  it('refuses a pathological operation count before it multiplies by 2ⁿ', () => {
    // Order matters: `simulationWork` on a refused register would overflow to
    // Infinity, and an Infinity compared against a budget is not a diagnosis.
    expect(
      checkLimits({ ...base, operations: MAX_SERVER_OPERATIONS + 1 })
    ).toMatchObject({ code: 'too-many-operations' })
  })

  it('refuses more shots than §3.2 allows', () => {
    expect(
      checkLimits({ ...base, mode: 'TRAJECTORIES', shots: MAX_SHOTS + 1 })
    ).toMatchObject({ code: 'too-many-shots', limit: MAX_SHOTS })
  })

  it('refuses work that cannot finish inside the wall-clock bound', () => {
    const refusal = checkLimits({
      mode: 'TRAJECTORIES',
      qubits: 20,
      operations: 200,
      shots: MAX_SHOTS,
    })
    expect(refusal).toMatchObject({ code: 'work-budget-exceeded' })
  })

  it('lets a longer timeout admit work a shorter one refuses', () => {
    const work = {
      mode: 'STATEVECTOR',
      qubits: 22,
      operations: 400,
      shots: null,
    } as const
    expect(checkLimits(work, { timeoutMs: 1_000 })).toMatchObject({
      code: 'work-budget-exceeded',
    })
    expect(checkLimits(work, { timeoutMs: DEFAULT_JOB_TIMEOUT_MS })).toBeNull()
  })

  it('leaves headroom for a machine twice as slow as the reference', () => {
    // The budget is half the window, not all of it — the same discipline the
    // browser's TRAJECTORY_WORK_BUDGET uses.
    expect(workBudgetFor(1_000, 'STATEVECTOR')).toBe(500 / 5e-6)
  })
})

describe('clampShots', () => {
  it('holds a request inside the shot range whatever it was handed', () => {
    expect(clampShots(0)).toBe(1)
    expect(clampShots(MAX_SHOTS * 10)).toBe(MAX_SHOTS)
    expect(clampShots(12.6)).toBe(13)
    expect(clampShots(Number.NaN)).toBe(1)
  })
})
