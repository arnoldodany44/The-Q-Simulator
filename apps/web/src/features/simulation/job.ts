/**
 * One simulation, start to finish — everything the worker does except talk.
 *
 * Kept apart from `simulation.worker.ts` so it can be tested against the real
 * engine in a plain Vitest process: `runJob` is a function from a request and
 * a checkpoint cache to a response, with no `postMessage` and no globals in
 * sight. What is left in the worker file is the message loop, which is the
 * part that genuinely needs a worker to exercise.
 *
 * THE CACHE IS AN ARGUMENT, AND IT LIVES IN THE WORKER. §5.6.3 wants an edit
 * at column 30 of 40 to resume rather than restart, and the cached states are
 * megabytes each — sending them across the thread boundary on every edit would
 * cost more than the re-simulation they save. So the cache stays on the side
 * that owns the engine, and the main thread's only say in it is `fromColumn`.
 *
 * THE CIRCUIT IS RE-VALIDATED HERE. The editor's store already refuses to hold
 * an invalid circuit, but a circuit can also arrive from a URL payload, an
 * import or a future API, and the engine's contract is that its input is
 * valid. `safeParseCircuit` is the contract's own judgement — not a second
 * implementation of it — and it costs microseconds against a run measured in
 * hundreds of milliseconds.
 */

import {
  CircuitRunError,
  MidCircuitMeasurementError,
  checkpointColumns,
  createRng,
  invalidateFrom,
  run,
  runFrom,
  trajectoriesMode,
  type CheckpointCache,
} from '@qsim/core'
import { formatIssues, safeParseCircuit } from '@qsim/schema'

import {
  MAX_CLIENT_QUBITS,
  encodeState,
  type RequestId,
  type SimulateRequest,
  type SimulationFailure,
  type SimulationResponse,
} from './protocol'

/** A response and the buffers it wants handed over rather than copied. */
export interface Job {
  readonly response: SimulationResponse
  readonly transfer: readonly Transferable[]
}

export function runJob(
  cache: CheckpointCache,
  request: SimulateRequest,
  sharedMemory: boolean
): Job {
  const { id } = request

  if (request.circuit.qubits > MAX_CLIENT_QUBITS) {
    // The scheduler refuses this too. Both checks are wanted: this is the side
    // that would allocate the state, and it must never be talked into it.
    return failed(id, {
      code: 'too-many-qubits',
      qubits: request.circuit.qubits,
      limit: MAX_CLIENT_QUBITS,
      detail:
        `Refusing to allocate a ${request.circuit.qubits}-qubit state; the ` +
        `browser ceiling is ${MAX_CLIENT_QUBITS} qubits.`,
    })
  }

  const parsed = safeParseCircuit(request.circuit)
  if (!parsed.ok) {
    return failed(id, {
      code: 'invalid-circuit',
      operationId: parsed.issues[0]?.operationId,
      detail: formatIssues(parsed.issues),
    })
  }
  const circuit = parsed.circuit

  if (request.mode === 'trajectories' && circuit.clbits === 0) {
    return failed(id, {
      code: 'no-classical-bits',
      detail:
        'A trajectories run reports counts of the classical register, and ' +
        'this circuit declares no classical bits.',
    })
  }

  const started = performance.now()
  try {
    if (request.mode === 'trajectories') {
      // No cache: a trajectory's collapses are random, so a cached mid-circuit
      // state would freeze one roll of the dice and bias every shot resuming
      // from it. The engine documents the same rule on `CheckpointCache`.
      const result = run(
        circuit,
        trajectoriesMode(request.shots, createRng(request.seed))
      )
      if (result.mode !== 'trajectories') {
        // Unreachable — `run` answers in the mode it was given. Narrowing the
        // union is still cheaper than casting it.
        return failed(id, {
          code: 'worker-failed',
          detail: 'The engine answered a trajectories run analytically.',
        })
      }
      return {
        response: {
          kind: 'result',
          id,
          mode: 'trajectories',
          shots: result.shots,
          counts: result.counts,
          durationMs: performance.now() - started,
        },
        transfer: [],
      }
    }

    const fromColumn = Math.max(0, request.fromColumn)
    invalidateFrom(cache, fromColumn)
    const resumedFromColumn = resumePoint(cache, circuit.qubits)
    const result = runFrom(cache, circuit, fromColumn)
    const encoded = encodeState(result.state, sharedMemory)
    return {
      response: {
        kind: 'result',
        id,
        mode: 'analytic',
        state: encoded.payload,
        resumedFromColumn,
        durationMs: performance.now() - started,
      },
      transfer: encoded.transfer,
    }
  } catch (cause) {
    return failed(id, describe(cause))
  }
}

/**
 * The column a resumed run will start at: one past the last surviving
 * checkpoint, or 0 when there is none to resume from.
 *
 * Read after invalidation and before the run, because the run adds
 * checkpoints of its own. A cache built for another register size holds
 * nothing usable — the runner empties it on the way in — so it answers 0.
 */
function resumePoint(cache: CheckpointCache, qubits: number): number {
  if (cache.qubits !== qubits) return 0
  const columns = checkpointColumns(cache)
  const last = columns[columns.length - 1]
  return last === undefined ? 0 : last + 1
}

function describe(cause: unknown): SimulationFailure {
  if (cause instanceof MidCircuitMeasurementError) {
    return { code: 'measurement-in-analytic-mode', detail: cause.message }
  }
  if (cause instanceof CircuitRunError) {
    return {
      code: 'unsupported-operation',
      operationId: cause.operationId,
      detail: cause.message,
    }
  }
  return {
    code: 'worker-failed',
    detail: cause instanceof Error ? cause.message : String(cause),
  }
}

function failed(id: RequestId, failure: SimulationFailure): Job {
  return { response: { kind: 'error', id, failure }, transfer: [] }
}
