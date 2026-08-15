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
 * THE TIMELINE SHARES THAT CACHE (M0.8). A scrub step is not a different kind
 * of job — it is the same run told to stop after a given column, which is what
 * `stateAfterColumn` is. Sharing the cache is the whole point: the checkpoints
 * an edit leaves behind are the ones a step resumes from, and a forward walk
 * writes the ones the next walk will read.
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
  sampleShots,
  stateAfterColumn,
  trajectoriesMode,
  type CheckpointCache,
  type Statevector,
} from '@qsim/core'
import { formatIssues, safeParseCircuit, type Circuit } from '@qsim/schema'

import {
  MAX_CLIENT_QUBITS,
  clampShots,
  encodeState,
  type RequestId,
  type SampleSpec,
  type SamplePayload,
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
      //
      // The scrubber therefore cannot be honoured the way it is on the
      // analytic side — there is no cached state to stop at — so it is
      // honoured the way this mode can: every shot runs the circuit as far as
      // the bar and stops, and the tally describes the register at that
      // instant. `clbits` is untouched, so the table keeps its width and the
      // reader watches bits arrive rather than the columns change shape.
      const result = run(
        through(circuit, request.throughColumn),
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
          throughColumn: request.throughColumn,
          durationMs: performance.now() - started,
        },
        transfer: [],
      }
    }

    const fromColumn = Math.max(0, request.fromColumn)
    invalidateFrom(cache, fromColumn)
    const resumedFromColumn = resumePoint(cache, circuit.qubits)
    /*
     * The scrubber's step (M0.8) and the ordinary run are the same run asked
     * to stop in different places, and they share the one cache deliberately:
     * `stateAfterColumn` resumes from the checkpoints an edit just left behind
     * and writes new ones as it passes, so walking the timeline warms exactly
     * what the next step needs.
     *
     * `throughColumn` is *not* clamped up to 0: −1 is the position before the
     * first column, and the engine answers it with the ground state. The
     * invalidation above is what makes either branch safe — it is the request's
     * `fromColumn` that decides which checkpoints still describe this circuit,
     * and that is settled before either branch is chosen.
     */
    const state =
      request.throughColumn === null
        ? runFrom(cache, circuit, fromColumn).state
        : stateAfterColumn(cache, circuit, request.throughColumn)
    /*
     * Sampled before the state is encoded, and that order is not incidental.
     * On the transfer path `encodeState` hands the engine's own buffers to
     * `postMessage`, which detaches them; anything reading the amplitudes
     * afterwards would find a zero-length array and sample an empty
     * distribution. Sampling first also means the counts belong to exactly the
     * state in the same message, which is what makes the comparison honest.
     */
    const sampling = drawSample(state, request.sample)
    const encoded = encodeState(state, sharedMemory)
    return {
      response: {
        kind: 'result',
        id,
        mode: 'analytic',
        state: encoded.payload,
        resumedFromColumn,
        throughColumn: request.throughColumn,
        sampling,
        durationMs: performance.now() - started,
      },
      transfer: encoded.transfer,
    }
  } catch (cause) {
    return failed(id, describe(cause))
  }
}

/**
 * The circuit as far as a scrub position, for a trajectories run.
 *
 * `null` is the whole circuit and the object is returned untouched, so an
 * editor nobody has scrubbed sends the engine exactly what it always sent it.
 * `-1` keeps no operations at all: every shot runs nothing and the register
 * reads all zeros, which is the truth about the instant before column 0.
 *
 * A prefix of a valid circuit is a valid circuit — dropping operations cannot
 * create a column conflict or an out-of-range index — so nothing here needs
 * re-validating. A gate whose `condition` names a bit no surviving measurement
 * writes simply reads the 0 the register was initialised with, which is what
 * the engine does for an unwritten bit anywhere else.
 */
function through(circuit: Circuit, throughColumn: number | null): Circuit {
  if (throughColumn === null) return circuit
  return {
    ...circuit,
    operations: circuit.operations.filter(
      (operation) => operation.column <= throughColumn
    ),
  }
}

/**
 * The shots of §3.2, drawn from a state the engine has already produced.
 *
 * `sampleShots` is the engine's own implementation — cumulative distribution
 * built once, binary searched per draw — and calling it here rather than
 * re-deriving anything is the point of the monorepo: the counts a browser shows
 * and the counts a server would validate against come from the same function.
 * It reads the state and never writes to it, so the amplitudes below are still
 * the ones the panel draws its exact distribution from.
 */
function drawSample(
  state: Statevector,
  spec: SampleSpec | null
): SamplePayload | null {
  if (spec === null) return null
  const shots = clampShots(spec.shots)
  return {
    shots,
    seed: spec.seed,
    counts: sampleShots(state, shots, createRng(spec.seed)),
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
