// @vitest-environment node
import {
  createCheckpoints,
  probabilities,
  type CheckpointCache,
} from '@qsim/core'
import { MAX_COLUMNS, parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { runJob, type Job } from './job'
import {
  decodeState,
  type AnalyticResponse,
  type SimulateRequest,
  type SimulationFailure,
  type TrajectoriesResponse,
} from './protocol'

/**
 * The worker's work, against the real engine and without a worker.
 *
 * Two things are worth proving here and nowhere else: that a resumed run and a
 * full run agree to the last bit — a checkpoint cache that silently drifts is
 * the worst bug this milestone can ship — and that every way a circuit can
 * fail comes back as a coded response rather than an exception, because an
 * exception inside a worker reaches the user as silence.
 */

/**
 * D6's tolerance, not an exact comparison: `(1/√2)²` is 0.5000000000000001 in
 * Float64, and a test that demanded 0.5 exactly would be testing the IEEE
 * rounding of the H gate rather than the physics.
 */
function expectProbabilities(
  state: { readonly re: Float64Array; readonly im: Float64Array },
  expected: readonly number[]
): void {
  const actual = probabilities({
    qubits: Math.log2(expected.length),
    size: expected.length,
    re: state.re,
    im: state.im,
  })
  expect([...actual]).toHaveLength(expected.length)
  expected.forEach((probability, index) => {
    expect(actual[index]).toBeCloseTo(probability, 12)
  })
}

function simulate(
  circuit: Circuit,
  fromColumn = 0,
  sharedMemory = false
): SimulateRequest {
  return {
    kind: 'simulate',
    id: 1,
    circuit,
    fromColumn,
    sharedMemory,
    mode: 'analytic',
  }
}

function sampled(
  circuit: Circuit,
  shots: number,
  seed: number
): SimulateRequest {
  return {
    kind: 'simulate',
    id: 1,
    circuit,
    fromColumn: 0,
    sharedMemory: false,
    mode: 'trajectories',
    shots,
    seed,
  }
}

function analytic(job: Job): AnalyticResponse {
  const { response } = job
  if (response.kind !== 'result' || response.mode !== 'analytic') {
    throw new Error(`expected an analytic result, got ${response.kind}`)
  }
  return response
}

function counts(job: Job): TrajectoriesResponse {
  const { response } = job
  if (response.kind !== 'result' || response.mode !== 'trajectories') {
    throw new Error(`expected counts, got ${response.kind}`)
  }
  return response
}

function failure(job: Job): SimulationFailure {
  const { response } = job
  if (response.kind !== 'error') {
    throw new Error(`expected a failure, got a ${response.mode} result`)
  }
  return response.failure
}

const BELL = parseCircuit({
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
})

/** Twenty columns of alternating H and T, so the state carries phase. */
function longCircuit(lastGate: string): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    operations: Array.from({ length: 20 }, (_, column) => ({
      id: `g${column}`,
      gate: column === 19 ? lastGate : column % 2 === 0 ? 'h' : 't',
      targets: [column % 3],
      column,
    })),
  })
}

/**
 * The column the sampling test edits. Before the engine's checkpoint at
 * column 15 on purpose: an edit *after* the last checkpoint would be replayed
 * correctly even by a run that invalidated nothing, and would prove nothing.
 */
const EDITED_COLUMN = 3

/**
 * The same twenty columns, with one gate at `EDITED_COLUMN` under the test's
 * control. `clbits: 1` and no measurement, so the one circuit can be run both
 * analytically and as trajectories — which is the whole point of the case.
 */
function editableCircuit(gateAtEditedColumn: string): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    clbits: 1,
    operations: Array.from({ length: 20 }, (_, column) => ({
      id: `g${column}`,
      gate:
        column === EDITED_COLUMN
          ? gateAtEditedColumn
          : column % 2 === 0
            ? 'h'
            : 't',
      targets: [column % 3],
      column,
    })),
  })
}

/** The largest amplitude-by-amplitude distance between two states. */
function largestGap(
  left: { readonly re: Float64Array; readonly im: Float64Array },
  right: { readonly re: Float64Array; readonly im: Float64Array }
): number {
  let worst = 0
  for (let index = 0; index < left.re.length; index++) {
    worst = Math.max(
      worst,
      Math.abs(left.re[index]! - right.re[index]!),
      Math.abs(left.im[index]! - right.im[index]!)
    )
  }
  return worst
}

describe('an analytic run', () => {
  it('answers with the state the circuit produces', () => {
    const response = analytic(
      runJob(createCheckpoints(), simulate(BELL), false)
    )
    const state = decodeState(response.state)

    // |00⟩ and |11⟩ at one half each — and under D1 those are indices 0 and 3,
    // which is what makes this a Bell pair rather than an endianness bug.
    expectProbabilities(state, [0.5, 0, 0, 0.5])
    expect(response.resumedFromColumn).toBe(0)
    expect(response.durationMs).toBeGreaterThanOrEqual(0)
  })

  it.each([true, false])(
    'produces the same amplitudes with sharedMemory=%s',
    (shared) => {
      const response = analytic(
        runJob(createCheckpoints(), simulate(BELL, 0, shared), shared)
      )

      expect(response.state.transport).toBe(shared ? 'shared' : 'transfer')
      expectProbabilities(decodeState(response.state), [0.5, 0, 0, 0.5])
    }
  )
})

describe('the checkpoint cache', () => {
  it('resumes an edit at the last column instead of restarting', () => {
    const cache: CheckpointCache = createCheckpoints()
    const first = analytic(runJob(cache, simulate(longCircuit('t')), false))
    expect(first.resumedFromColumn).toBe(0)

    // Editing column 19 of 20 must replay column 19 and nothing else.
    const edited = longCircuit('x')
    const second = analytic(runJob(cache, simulate(edited, 19), false))

    expect(second.resumedFromColumn).toBe(19)
  })

  it('resumes to the same state a full run would reach', () => {
    const warm: CheckpointCache = createCheckpoints()
    runJob(warm, simulate(longCircuit('t')), false)
    const edited = longCircuit('x')

    const resumed = decodeState(
      analytic(runJob(warm, simulate(edited, 19), false)).state
    )
    const scratch = decodeState(
      analytic(runJob(createCheckpoints(), simulate(edited), false)).state
    )

    expect(resumed.size).toBe(scratch.size)
    for (let index = 0; index < scratch.size; index++) {
      expect(resumed.re[index]).toBeCloseTo(scratch.re[index]!, 12)
      expect(resumed.im[index]).toBeCloseTo(scratch.im[index]!, 12)
    }
  })

  /*
   * The physics behind the scheduler's bookkeeping rule, pinned here so that
   * `fromColumn` is not merely a number a unit test compares.
   *
   * A sampling run leaves the cache exactly as it found it — that is the
   * engine's rule and it is correct — so an edit made around one is still
   * owed to the cache afterwards. Naming it costs four replayed columns;
   * forgetting it costs the user a normalised statevector for a circuit they
   * have already changed, with nothing on screen to say so.
   */
  it('still owes an edit made around a sampling run', () => {
    const cache: CheckpointCache = createCheckpoints()
    const before = editableCircuit('t')
    const after = editableCircuit('x')

    runJob(cache, simulate(before), false)
    const sampledJob = counts(runJob(cache, sampled(after, 16, 3), false))
    expect(sampledJob.shots).toBe(16)

    // What a correct scheduler asks for: the edit at column 3 is still the
    // earliest column the cache has not seen.
    const resumed = decodeState(
      analytic(runJob(cache, simulate(after, EDITED_COLUMN), false)).state
    )
    const scratch = decodeState(
      analytic(runJob(createCheckpoints(), simulate(after), false)).state
    )
    expect(largestGap(resumed, scratch)).toBeLessThan(1e-12)

    // And what "the sampling run cleared the debt" produced instead: a run
    // resumed from the checkpoint at column 15, which still describes the
    // circuit as it was before column 3 changed.
    const misled: CheckpointCache = createCheckpoints()
    runJob(misled, simulate(before), false)
    runJob(misled, sampled(after, 16, 3), false)
    const wrong = decodeState(
      analytic(runJob(misled, simulate(after, MAX_COLUMNS), false)).state
    )
    expect(largestGap(wrong, scratch)).toBeGreaterThan(1e-6)
  })

  it('starts over when the register size changes under it', () => {
    const cache: CheckpointCache = createCheckpoints()
    runJob(cache, simulate(longCircuit('t')), false)

    const response = analytic(runJob(cache, simulate(BELL, 19), false))

    expect(response.resumedFromColumn).toBe(0)
    expectProbabilities(decodeState(response.state), [0.5, 0, 0, 0.5])
  })
})

describe('sampled runs', () => {
  const measured = parseCircuit({
    schemaVersion: 1,
    qubits: 1,
    clbits: 1,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    ],
  })

  it('tallies the classical register', () => {
    const response = counts(
      runJob(createCheckpoints(), sampled(measured, 200, 7), false)
    )

    expect(response.shots).toBe(200)
    const total = Object.values(response.counts).reduce(
      (sum, count) => sum + count,
      0
    )
    expect(total).toBe(200)
    expect(Object.keys(response.counts).sort()).toEqual(['0', '1'])
  })

  it('repeats exactly for the same seed', () => {
    const first = counts(
      runJob(createCheckpoints(), sampled(measured, 200, 7), false)
    )
    const second = counts(
      runJob(createCheckpoints(), sampled(measured, 200, 7), false)
    )

    expect(second.counts).toEqual(first.counts)
  })

  it('refuses a circuit with nothing to tally', () => {
    expect(
      failure(runJob(createCheckpoints(), sampled(BELL, 10, 7), false))
    ).toMatchObject({ code: 'no-classical-bits' })
  })
})

describe('failures come back as answers', () => {
  it('refuses a register the browser cannot hold', () => {
    const huge = parseCircuit({ schemaVersion: 1, qubits: 21, operations: [] })

    expect(
      failure(runJob(createCheckpoints(), simulate(huge), false))
    ).toMatchObject({ code: 'too-many-qubits', qubits: 21, limit: 20 })
  })

  it('refuses a circuit the contract rejects', () => {
    // Past the shape check, caught by the contract's own validation: qubit 5
    // does not exist in a two-qubit circuit.
    const broken = {
      schemaVersion: 1,
      qubits: 2,
      operations: [{ id: 'a', gate: 'h', targets: [5], column: 0 }],
    } as unknown as Circuit

    const reported = failure(
      runJob(createCheckpoints(), simulate(broken), false)
    )
    expect(reported.code).toBe('invalid-circuit')
    expect(reported.operationId).toBe('a')
  })

  it('explains that a measuring circuit has no single final state', () => {
    const measured = parseCircuit({
      schemaVersion: 1,
      qubits: 1,
      clbits: 1,
      operations: [
        {
          id: 'a',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
      ],
    })

    expect(
      failure(runJob(createCheckpoints(), simulate(measured), false))
    ).toMatchObject({ code: 'measurement-in-analytic-mode' })
  })

  it('names the gate the engine cannot run', () => {
    const custom = parseCircuit({
      schemaVersion: 1,
      qubits: 2,
      operations: [{ id: 'a', gate: 'block', targets: [0, 1], column: 0 }],
      customGates: {
        block: {
          qubits: 2,
          operations: [{ id: 'inner', gate: 'h', targets: [0], column: 0 }],
        },
      },
    })

    const reported = failure(
      runJob(createCheckpoints(), simulate(custom), false)
    )
    expect(reported.code).toBe('unsupported-operation')
    // The canvas highlights the gate, so the id has to survive the trip.
    expect(reported.operationId).toBe('a')
  })
})
