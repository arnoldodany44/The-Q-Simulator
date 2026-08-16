// @vitest-environment node
/**
 * The ceiling §4 talks about is not only a register, and now the scheduler
 * agrees.
 *
 * `protocol.ts` argues, at length and correctly, that a sampled run's ceiling is
 * *time* rather than memory: every shot restarts from |0…0⟩, so the cost is
 * `shots × operations × 2ⁿ`, and about fifteen seconds of the reference machine
 * is the most a live editor may spend. That was enforced on the noisy path and
 * nowhere else — so the *plain* trajectories mode of §5.3, which has exactly
 * the same cost produced by exactly the same loop, had no gate at all.
 * `needsServer` was `qubits > MAX_CLIENT_QUBITS` and `runJob`'s admission check
 * was the same comparison, so a twenty-qubit circuit carrying one `measure` —
 * which `executionModeFor` switches to this mode on its own, without the reader
 * choosing anything — was handed to a worker that cannot be interrupted, for
 * two and three quarter minutes, at a work figure this same file calls
 * unaffordable.
 *
 * No wall clock is asserted here (that belongs in a `*.perf.test.ts`); the
 * assertion is the cost model the app already publishes, against the budget the
 * app already publishes.
 */

import { createCheckpoints } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_CLIENT_QUBITS,
  TRAJECTORY_WORK_BUDGET,
  trajectoryWork,
  type ServerRequest,
  type SimulationRequest,
} from '../../features/simulation/protocol'
import { executionModeFor } from '../../features/simulation/mode'
import { runJob } from '../../features/simulation/job'
import { DEFAULT_SAMPLE_SHOTS } from '../../features/analysis/sampling'
import {
  SIMULATION_DEBOUNCE_MS,
  createSimulationScheduler,
  type SimulationScheduler,
} from '../../features/simulation/scheduler'

/** Twenty qubits, a layer of H, two layers of CX, and one measure. */
function measuringAtTheCeiling(): Circuit {
  const operations: unknown[] = []
  let id = 0
  let column = 0
  for (let q = 0; q < MAX_CLIENT_QUBITS; q++) {
    operations.push({ id: `o${String(id++)}`, gate: 'h', targets: [q], column })
  }
  column++
  for (let layer = 0; layer < 2; layer++) {
    for (let q = 0; q + 1 < MAX_CLIENT_QUBITS; q++) {
      operations.push({
        id: `o${String(id++)}`,
        gate: 'cx',
        controls: [q],
        targets: [q + 1],
        column,
      })
      column++
    }
  }
  operations.push({
    id: `o${String(id)}`,
    gate: 'measure',
    targets: [0],
    clbitTargets: [0],
    column,
  })
  return parseCircuit({
    schemaVersion: 1,
    qubits: MAX_CLIENT_QUBITS,
    clbits: 1,
    operations,
  })
}

let toWorker: SimulationRequest[]
let toServer: ServerRequest[]
let scheduler: SimulationScheduler

beforeEach(() => {
  vi.useFakeTimers()
  toWorker = []
  toServer = []
  scheduler = createSimulationScheduler()
  scheduler.connect((request) => toWorker.push(request))
  scheduler.connectServer((request) => toServer.push(request))
})

afterEach(() => {
  scheduler.dispose()
  vi.useRealTimers()
})

describe('a measuring circuit at the register ceiling', () => {
  it('is switched into trajectories mode by the document alone', () => {
    expect(executionModeFor(measuringAtTheCeiling())).toBe('trajectories')
  })

  it('costs far more than the budget this app declares affordable', () => {
    const circuit = measuringAtTheCeiling()
    const work =
      DEFAULT_SAMPLE_SHOTS *
      trajectoryWork(circuit.qubits, circuit.operations.length)
    expect(work).toBeGreaterThan(TRAJECTORY_WORK_BUDGET * 100)
  })

  it('is refused rather than handed to a worker nobody can interrupt', () => {
    const circuit = measuringAtTheCeiling()
    scheduler.schedule(circuit, {
      mode: 'trajectories',
      shots: DEFAULT_SAMPLE_SHOTS,
    })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    const dispatched = toWorker.filter((request) => request.kind === 'simulate')
    expect(dispatched).toHaveLength(0)
    expect(toServer).toHaveLength(0)
    const failure = scheduler.getSnapshot().failure
    expect(failure?.code).toBe('sampling-too-large')
    // The three numbers the sentence needs, so the reader is told which of them
    // is the large one rather than being handed a generic ceiling.
    expect(failure?.qubits).toBe(circuit.qubits)
    expect(failure?.operations).toBe(circuit.operations.length)
    expect(failure?.shots).toBe(DEFAULT_SAMPLE_SHOTS)
  })

  it('refuses it again on the side that would spend the minutes', () => {
    // Both checks are wanted, for the same reason the qubit ceiling has two:
    // a request can also arrive from a URL payload or a future caller.
    const circuit = measuringAtTheCeiling()
    const { response } = runJob(
      createCheckpoints(),
      {
        kind: 'simulate',
        id: 1,
        circuit,
        fromColumn: 0,
        mode: 'trajectories',
        shots: DEFAULT_SAMPLE_SHOTS,
        seed: 1,
        sharedMemory: false,
        throughColumn: null,
      },
      false
    )
    expect(response.kind).toBe('error')
    if (response.kind !== 'error') return
    expect(response.failure.code).toBe('sampling-too-large')
  })

  it('still admits a sampled run a tab can afford', () => {
    /*
     * The bound has to leave the mode usable: §5.3's whole point is that a
     * measuring circuit is run this way. Ten qubits and a thousand shots is
     * about ten million units — three orders inside the budget.
     */
    const circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 4,
      clbits: 1,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        {
          id: 'b',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
      ],
    })
    scheduler.schedule(circuit, { mode: 'trajectories', shots: 1024 })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    expect(
      toWorker.filter((request) => request.kind === 'simulate')
    ).toHaveLength(1)
    expect(scheduler.getSnapshot().failure).toBeNull()
  })
})
