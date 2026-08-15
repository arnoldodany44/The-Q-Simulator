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
  type AnalyticRequest,
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
): AnalyticRequest {
  return {
    kind: 'simulate',
    id: 1,
    circuit,
    fromColumn,
    sharedMemory,
    mode: 'analytic',
    throughColumn: null,
    sample: null,
  }
}

/** The same run, stopped after `column` — one step of the M0.8 scrubber. */
function scrubbed(
  circuit: Circuit,
  column: number,
  fromColumn = 0
): AnalyticRequest {
  return { ...simulate(circuit, fromColumn), throughColumn: column }
}

/** An analytic run that also draws shots from the state it produces. */
function withSample(
  circuit: Circuit,
  shots: number,
  seed: number
): AnalyticRequest {
  return { ...simulate(circuit), sample: { shots, seed } }
}

function sampled(
  circuit: Circuit,
  shots: number,
  seed: number,
  throughColumn: number | null = null
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
    throughColumn,
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

describe('shots drawn from an analytic run', () => {
  /** The counts of `response`, or a failure loud enough to read. */
  function sampleOf(job: Job): Record<string, number> {
    const { sampling } = analytic(job)
    if (sampling === null) throw new Error('expected the response to sample')
    return { ...sampling.counts }
  }

  it('answers with the state and the counts in one message', () => {
    const response = analytic(
      runJob(createCheckpoints(), withSample(BELL, 1000, 7), false)
    )

    // The exact distribution and the sample of it travel together, which is
    // what makes them comparable: an edit cannot land between the two.
    expectProbabilities(decodeState(response.state), [0.5, 0, 0, 0.5])
    expect(response.sampling?.shots).toBe(1000)
    expect(response.sampling?.seed).toBe(7)
  })

  it('says so explicitly when nothing was sampled', () => {
    // Not `undefined`: an absent field is indistinguishable from a field the
    // sender forgot, and the panel would draw an empty comparison for it.
    expect(
      analytic(runJob(createCheckpoints(), simulate(BELL), false)).sampling
    ).toBeNull()
  })

  it('repeats exactly for the same seed', () => {
    const first = sampleOf(
      runJob(createCheckpoints(), withSample(BELL, 500, 3), false)
    )
    const second = sampleOf(
      runJob(createCheckpoints(), withSample(BELL, 500, 3), false)
    )

    expect(second).toEqual(first)
  })

  it('draws a different sample from a different seed', () => {
    // What the "draw again" control does. Same circuit, same state, same shot
    // count: only the seed moves, and the counts have to move with it or the
    // control is a lie about what sampling is.
    const first = sampleOf(
      runJob(createCheckpoints(), withSample(BELL, 500, 3), false)
    )
    const second = sampleOf(
      runJob(createCheckpoints(), withSample(BELL, 500, 4), false)
    )

    expect(second).not.toEqual(first)
  })

  it('converges on the theoretical distribution as the shots grow', () => {
    /*
     * The teaching claim of §3.2's control, asserted rather than assumed. The
     * error of an observed frequency has standard deviation √(p(1−p)/N),
     * which at p = ½ is 1/(2√N) — so the bound below is four standard
     * deviations, tight enough to fail a sampler that ignored the amplitudes
     * and loose enough that no seed can make it flaky.
     *
     * The *shrinking* is averaged over seeds rather than read off one, because
     * a single sample is not evidence about a distribution in either
     * direction: a hundred shots that happen to split exactly fifty-fifty
     * would make the larger sample look worse.
     */
    const gapAt = (shots: number, seed: number): number => {
      const counts = sampleOf(
        runJob(createCheckpoints(), withSample(BELL, shots, seed), false)
      )
      return Math.abs((counts['00'] ?? 0) / shots - 0.5)
    }
    const meanGap = (shots: number): number =>
      [1, 2, 3, 4, 5, 6, 7, 8].reduce(
        (sum, seed) => sum + gapAt(shots, seed) / 8,
        0
      )

    for (const shots of [100, 10_000]) {
      expect(gapAt(shots, 11)).toBeLessThan(4 / (2 * Math.sqrt(shots)))
    }
    expect(meanGap(10_000)).toBeLessThan(meanGap(100))
  })

  it('never lands on a basis state the circuit cannot reach', () => {
    // |01⟩ and |10⟩ have amplitude zero in a Bell pair. A sampler that could
    // reach them would be sampling a distribution that is not this state's.
    const counts = sampleOf(
      runJob(createCheckpoints(), withSample(BELL, 5000, 2), false)
    )

    expect(Object.keys(counts).sort()).toEqual(['00', '11'])
  })

  it('clamps a shot count outside the range the control can express', () => {
    // §3.2 stops at 100 000. A request from a URL or a future API is not the
    // control, and `sampleShots` answers a fractional count with a RangeError
    // — which would reach the user as "the simulator stopped unexpectedly".
    const response = analytic(
      runJob(createCheckpoints(), withSample(BELL, 10.5, 1), false)
    )

    expect(response.sampling?.shots).toBe(11)
    expect(
      Object.values(response.sampling?.counts ?? {}).reduce((a, b) => a + b, 0)
    ).toBe(11)
  })
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

/**
 * The seam M0.8 adds: one field on the request turns a run into a step of the
 * timeline. Everything else about the job — the cache, the invalidation, the
 * encoding — is unchanged, and these tests exist to prove exactly that, because
 * the failure mode of getting it wrong is a perfectly normalised state under a
 * caption naming a column it does not belong to.
 */
describe('the timeline scrubber', () => {
  /** The same circuit with everything past `column` removed. */
  function truncated(circuit: Circuit, column: number): Circuit {
    return parseCircuit({
      ...circuit,
      operations: circuit.operations.filter(
        (operation) => operation.column <= column
      ),
    })
  }

  function stateOf(job: Job) {
    return decodeState(analytic(job).state)
  }

  it('answers the last column with the state a full run reaches, exactly', () => {
    const circuit = longCircuit('t')

    const end = stateOf(
      runJob(createCheckpoints(), scrubbed(circuit, 19), false)
    )
    const whole = stateOf(runJob(createCheckpoints(), simulate(circuit), false))

    // Not `toBeCloseTo`: from a cold cache both walk the same plan from
    // |0…0⟩ in the same order, so this is the same arithmetic and the answer
    // is the same bits. The claim the milestone makes about its last stop is
    // that it *is* the circuit's answer, not that it rounds to it.
    expect(largestGap(end, whole)).toBe(0)
  })

  it('agrees with a full run when the cache is already warm', () => {
    // The path a reader actually takes: the panel has run this circuit, and
    // only then does the bar get dragged to the end. The run now resumes from
    // a checkpoint rather than from |0…0⟩, so the renormalisation points
    // differ by a few gates and the agreement is D6's, not bit-for-bit.
    const cache: CheckpointCache = createCheckpoints()
    const circuit = longCircuit('t')
    runJob(cache, simulate(circuit), false)

    const end = stateOf(runJob(cache, scrubbed(circuit, 19), false))
    const whole = stateOf(runJob(createCheckpoints(), simulate(circuit), false))

    expect(largestGap(end, whole)).toBeLessThan(1e-12)
  })

  it('answers every column with the run of a circuit cut there', () => {
    const cache: CheckpointCache = createCheckpoints()
    const circuit = longCircuit('t')
    runJob(cache, simulate(circuit), false)

    for (let column = 0; column < 20; column++) {
      const step = stateOf(runJob(cache, scrubbed(circuit, column), false))
      const cut = stateOf(
        runJob(createCheckpoints(), simulate(truncated(circuit, column)), false)
      )
      expect(largestGap(step, cut), `after column ${column}`).toBeLessThan(
        1e-12
      )
    }
  })

  it('answers the position before column 0 with the ground state', () => {
    // −1 is a real position and the one playback starts from: the state the
    // circuit departs from, which is the only way to *see* what the first
    // gate did. Nothing on the way in may clamp it up to 0.
    const state = stateOf(
      runJob(createCheckpoints(), scrubbed(longCircuit('t'), -1), false)
    )

    expect(state.re[0]).toBe(1)
    expect([...state.re.slice(1)].every((value) => value === 0)).toBe(true)
    expect([...state.im].every((value) => value === 0)).toBe(true)
  })

  it('leaves the cache fit for the ordinary run that follows', () => {
    // The scrubber writes checkpoints as it walks, into the very cache the
    // live panel resumes from. A step that recorded a state under the wrong
    // column would not fail here — it would make the *next* full run answer
    // with a state belonging to no circuit at all.
    const cache: CheckpointCache = createCheckpoints()
    const circuit = longCircuit('t')
    runJob(cache, simulate(circuit), false)
    for (const column of [4, 11, 2, 17, 9]) {
      runJob(cache, scrubbed(circuit, column), false)
    }

    const after = stateOf(runJob(cache, simulate(circuit, MAX_COLUMNS), false))
    const scratch = stateOf(
      runJob(createCheckpoints(), simulate(circuit), false)
    )

    expect(largestGap(after, scratch)).toBeLessThan(1e-12)
  })

  it('honours an edit made while the timeline is parked mid-circuit', () => {
    // The case the whole feature exists for: park on a column, change a gate
    // before it, and the state at that column has to change with it. The
    // request carries both numbers — the edit's column to invalidate from,
    // and the position to stop at — and they are not the same number.
    const cache: CheckpointCache = createCheckpoints()
    const before = editableCircuit('t')
    const after = editableCircuit('x')
    runJob(cache, simulate(before), false)

    const parked = 10
    const step = stateOf(
      runJob(cache, scrubbed(after, parked, EDITED_COLUMN), false)
    )
    const cut = stateOf(
      runJob(createCheckpoints(), simulate(truncated(after, parked)), false)
    )

    expect(largestGap(step, cut)).toBeLessThan(1e-12)
  })

  it('echoes the position it answered for', () => {
    // Echoed rather than assumed by the panel: the bar moves on the main
    // thread while the worker runs, so a caption read off the control would
    // name one column over a picture of another.
    const cache: CheckpointCache = createCheckpoints()
    expect(
      analytic(runJob(cache, scrubbed(BELL, 0), false)).throughColumn
    ).toBe(0)
    expect(
      analytic(runJob(cache, simulate(BELL), false)).throughColumn
    ).toBeNull()
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

  /*
   * The scrubber on a measuring circuit. It used to be ignored here entirely:
   * the bar moved, the canvas painted a playhead, and the tally went on
   * describing the whole circuit while the panel said it described what was on
   * screen.
   */
  describe('the scrubber', () => {
    it('answers for the register as it stood at that column', () => {
      // Before the measurement in column 1, nothing has been written: every
      // shot reads 0, whatever the qubit is doing.
      const early = counts(
        runJob(createCheckpoints(), sampled(measured, 200, 7, 0), false)
      )
      expect(early.counts).toEqual({ '0': 200 })
      expect(early.throughColumn).toBe(0)

      // After it, the register is the coin the H prepared.
      const late = counts(
        runJob(createCheckpoints(), sampled(measured, 200, 7, 1), false)
      )
      expect(Object.keys(late.counts).sort()).toEqual(['0', '1'])
      expect(late.throughColumn).toBe(1)
    })

    it('answers the position before column 0 with an untouched register', () => {
      const response = counts(
        runJob(createCheckpoints(), sampled(measured, 200, 7, -1), false)
      )

      expect(response.counts).toEqual({ '0': 200 })
      expect(response.throughColumn).toBe(-1)
    })

    it('gives the last column exactly what the whole circuit gives', () => {
      // The same guarantee the analytic side makes: "the state at the last
      // column" and "the final state" must be one answer written two ways.
      const whole = counts(
        runJob(createCheckpoints(), sampled(measured, 200, 7), false)
      )
      const last = counts(
        runJob(createCheckpoints(), sampled(measured, 200, 7, 1), false)
      )

      expect(last.counts).toEqual(whole.counts)
      expect(whole.throughColumn).toBeNull()
    })

    it('keeps the register width, so the table does not change shape', () => {
      // Truncating drops operations, never classical bits: a two-bit register
      // reads `00` before anything is written, not `0`.
      const teleport = parseCircuit({
        schemaVersion: 1,
        qubits: 2,
        clbits: 2,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          {
            id: 'b',
            gate: 'measure',
            targets: [0],
            clbitTargets: [0],
            column: 1,
          },
          {
            id: 'c',
            gate: 'measure',
            targets: [1],
            clbitTargets: [1],
            column: 2,
          },
        ],
      })

      const response = counts(
        runJob(createCheckpoints(), sampled(teleport, 50, 3, 0), false)
      )
      expect(response.counts).toEqual({ '00': 50 })
    })
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
