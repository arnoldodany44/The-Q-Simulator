/**
 * The job, run.
 *
 * This is the only module in the system that calls `@qsim/core` on behalf of a
 * stranger, and it is deliberately a plain function: payload in, bounded result
 * out, no Redis, no Postgres, no `process`. That is what lets the interesting
 * behaviour — every mode, every refusal, the chunked determinism — be tested
 * with nothing running, and it is what lets `simulate.child.ts` be four lines
 * of message handling around it.
 *
 * ── It re-validates everything, and that is not paranoia ──────────────────
 *
 * §11 says a circuit is validated with Zod before the engine sees it, and this
 * is where the engine is. The API validated too, and that is not the same
 * event: what arrives here came out of Redis, and a job in Redis is a job that
 * anything holding the connection string can have put there. The process that
 * spends the CPU is the one that has to be sure. The same argument covers
 * `checkLimits`, which runs here against *this* worker's ceilings rather than
 * against whatever the producer believed them to be.
 *
 * ── Which mode means what, and why a noise profile is not a flag ──────────
 *
 * §5.4 splits noise into two implementations with different prices, and this
 * function keeps that split visible instead of hiding it behind a boolean:
 *
 *   STATEVECTOR     exact, one run, no noise. A profile is refused rather than
 *                   ignored — an exact unitary evolution has nowhere to put
 *                   one, and quietly dropping it would answer a question
 *                   nobody asked.
 *   TRAJECTORIES    the circuit re-run per shot. With a profile, each shot
 *                   samples one Kraus operator per channel (2ⁿ memory, 1/√N
 *                   error); without one, it is measurement sampling and the
 *                   tally is the classical register.
 *   DENSITY_MATRIX  ρ evolved exactly through the channels. 4ⁿ memory, no
 *                   sampling error, capped at twelve qubits by the engine.
 *
 * ── Progress, and why the shot loop is chunked ────────────────────────────
 *
 * The engine exposes no progress callback, and it should not — a callback in
 * the inner loop is a branch in the hottest code in the project. What it does
 * expose is a shot count, so the sampled modes are run in fixed chunks of
 * `SHOT_CHUNK` with the one seeded generator threaded through them. That gives
 * an honest fraction to report, and it is *exactly* the same arithmetic as one
 * unchunked call, because each shot draws from the same generator in the same
 * order — which `simulate.test.ts` pins, since it would otherwise be a silent
 * change to every future seeded result.
 */

import {
  NOISE_PROFILES,
  createRng,
  densityPurity,
  probabilities,
  run,
  runNoisy,
  runNoisyDensity,
  sampleShots,
  trajectoriesMode,
} from '@qsim/core'
import type { NoiseProfile, ShotCounts } from '@qsim/core'
import {
  MAX_RESULT_OUTCOMES,
  SHOT_CHUNK,
  SimulationFailure,
  assertResultFits,
  checkLimits,
  shapeOf,
} from '@qsim/jobs'
import type {
  JobProgress,
  SimulationJobPayload,
  SimulationRunResult,
} from '@qsim/jobs'
import { expandCircuit, parseCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { selectFromCounts, selectFromDistribution } from './outcomes.js'

export interface SimulationCeilings {
  readonly maxQubits: number
  readonly timeoutMs: number
}

export type ProgressReporter = (progress: JobProgress) => void

/**
 * A clock, injected so a duration can be asserted without one.
 *
 * The same reason `shouldReport` takes its elapsed time as an argument: a test
 * that has to sleep to observe a number is a slow test that measures the test
 * runner.
 */
export type Clock = () => number

export function runSimulationJob(
  payload: SimulationJobPayload,
  report: ProgressReporter,
  ceilings: SimulationCeilings,
  now: Clock = () => Date.now()
): SimulationRunResult {
  report({ phase: 'validating', completed: null, total: null })

  const circuit = acceptCircuit(payload.circuit)
  const refusal = checkLimits(shapeOf({ ...payload, circuit }), {
    maxQubits: ceilings.maxQubits,
    timeoutMs: ceilings.timeoutMs,
  })
  if (refusal !== null) {
    throw new SimulationFailure(
      'LIMIT_EXCEEDED',
      `${refusal.code}: ${String(refusal.value)} against a limit of ${String(refusal.limit)}`
    )
  }

  const started = now()
  const outcome = evaluate(circuit, payload, report)
  const durationMs = Math.max(0, Math.round(now() - started))

  report({ phase: 'summarising', completed: null, total: null })

  const result: SimulationRunResult = {
    resultVersion: 1,
    mode: payload.mode,
    qubits: circuit.qubits,
    shots: payload.shots,
    seed: payload.seed,
    noiseProfileId: payload.noiseProfileId,
    // Copied out of the readonly tuple `boundOutcomes` returns: the stored
    // shape is the one Zod validates and Prisma writes, and neither takes a
    // readonly array.
    outcomes: [...outcome.bounded.outcomes],
    hiddenOutcomes: outcome.bounded.hiddenOutcomes,
    hiddenWeight: outcome.bounded.hiddenWeight,
    purity: outcome.purity,
    durationMs,
  }

  // The tripwire, not a policy — see `result.ts`. Reaching it means the
  // bounding above did not happen, and a run that cannot report its answer did
  // not succeed.
  assertResultFits(result)
  return result
}

interface Evaluation {
  readonly bounded: ReturnType<typeof selectFromCounts>
  readonly purity: number | null
}

function evaluate(
  circuit: Circuit,
  payload: SimulationJobPayload,
  report: ProgressReporter
): Evaluation {
  switch (payload.mode) {
    case 'STATEVECTOR':
      return evaluateStatevector(circuit, payload, report)
    case 'TRAJECTORIES':
      return evaluateTrajectories(circuit, payload, report)
    case 'DENSITY_MATRIX':
      return evaluateDensity(circuit, payload, report)
  }
}

function evaluateStatevector(
  circuit: Circuit,
  payload: SimulationJobPayload,
  report: ProgressReporter
): Evaluation {
  if (payload.noiseProfileId !== null) {
    throw new SimulationFailure(
      'INVALID_CIRCUIT',
      'an exact statevector run has nowhere to apply a noise profile; ' +
        'TRAJECTORIES or DENSITY_MATRIX is the mode that does'
    )
  }

  report({ phase: 'simulating', completed: null, total: null })
  const result = engine(() => run(circuit))
  /*
   * `run` returns a union and the analytic branch is the only one reachable
   * here — the trajectories branch needs `trajectoriesMode`. Narrowing rather
   * than casting keeps that true if the default ever changes.
   */
  if (result.mode !== 'analytic') {
    throw new SimulationFailure('ENGINE_FAILED', 'expected an analytic result')
  }

  const distribution = probabilities(result.state)
  let counts: ShotCounts | null = null
  if (payload.shots !== null) {
    report({ phase: 'sampling', completed: 0, total: payload.shots })
    counts = engine(() =>
      sampleShots(result.state, payload.shots ?? 0, createRng(payload.seed))
    )
    report({
      phase: 'sampling',
      completed: payload.shots,
      total: payload.shots,
    })
  }

  return {
    bounded: selectFromDistribution(
      distribution,
      circuit.qubits,
      counts,
      MAX_RESULT_OUTCOMES
    ),
    purity: null,
  }
}

function evaluateTrajectories(
  circuit: Circuit,
  payload: SimulationJobPayload,
  report: ProgressReporter
): Evaluation {
  const shots = payload.shots
  if (shots === null) {
    throw new SimulationFailure(
      'INVALID_CIRCUIT',
      'a trajectories run is a shot loop and needs a shot count'
    )
  }
  const profile = profileFor(payload)
  if (profile === null && circuit.clbits === 0) {
    /*
     * Without a profile the tally *is* the classical register, so a circuit
     * with no classical bits would produce one bucket keyed by the empty
     * string — a histogram of nothing, which is worse than a refusal because it
     * looks like an answer.
     */
    throw new SimulationFailure(
      'INVALID_CIRCUIT',
      'a trajectories run with no noise profile tallies the classical ' +
        'register, and this circuit has no classical bits'
    )
  }

  const rng = createRng(payload.seed)
  const merged = new Map<string, number>()
  let done = 0

  while (done < shots) {
    const chunk = Math.min(SHOT_CHUNK, shots - done)
    report({ phase: 'simulating', completed: done, total: shots })
    const counts = engine(() =>
      profile === null
        ? runTrajectoryChunk(circuit, chunk, rng)
        : runNoisy(circuit, {
            profile,
            readout: payload.readout,
            shots: chunk,
            rng,
          }).counts
    )
    for (const [state, count] of Object.entries(counts)) {
      merged.set(state, (merged.get(state) ?? 0) + count)
    }
    done += chunk
  }
  report({ phase: 'simulating', completed: shots, total: shots })

  return {
    bounded: selectFromCounts(Object.fromEntries(merged)),
    purity: null,
  }
}

function runTrajectoryChunk(
  circuit: Circuit,
  shots: number,
  rng: ReturnType<typeof createRng>
): ShotCounts {
  const result = run(circuit, trajectoriesMode(shots, rng))
  if (result.mode !== 'trajectories') {
    throw new SimulationFailure(
      'ENGINE_FAILED',
      'expected a trajectories result'
    )
  }
  return result.counts
}

function evaluateDensity(
  circuit: Circuit,
  payload: SimulationJobPayload,
  report: ProgressReporter
): Evaluation {
  // `ideal` rather than a refusal: ρ of a noiseless circuit is a perfectly
  // meaningful object — it is the pure state written as a matrix, and it is the
  // baseline §3.3's comparison is drawn against.
  const profile = profileFor(payload) ?? NOISE_PROFILES.ideal

  report({ phase: 'simulating', completed: null, total: null })
  const result = engine(() =>
    runNoisyDensity(circuit, { profile, readout: payload.readout })
  )

  return {
    bounded: selectFromDistribution(
      result.distribution,
      circuit.qubits,
      null,
      MAX_RESULT_OUTCOMES
    ),
    // Tr(ρ²): 1 for a pure state, 1/2ⁿ for a maximally mixed one. The single
    // number that says how much of the state survived the noise, and the one
    // thing this mode can report that the sampled one cannot.
    purity: densityPurity(result.rho),
  }
}

function profileFor(payload: SimulationJobPayload): NoiseProfile | null {
  if (payload.noiseProfileId === null) return null
  const profile = NOISE_PROFILES[payload.noiseProfileId]
  if (profile === undefined) {
    throw new SimulationFailure(
      'INVALID_CIRCUIT',
      `no such noise profile: ${payload.noiseProfileId}`
    )
  }
  return profile
}

/**
 * The circuit, through the whole contract, and flattened.
 *
 * `parseCircuit` and not `CircuitSchema.parse`: the shape is the easy half, and
 * the rules a shape cannot express — two gates on one qubit in one column, a
 * control on a qubit the gate also targets, a `cx` with no control — are the
 * ones that would otherwise reach the kernel and produce a perfectly normalised
 * state that means nothing.
 *
 * `expandCircuit` is the second half and it is not optional: the engine has
 * never heard of a custom gate and refuses one by name (see `runner.ts`), so a
 * document that uses one has to arrive here as the primitives it stands for.
 * The expansion happens *after* validation because the ceilings it enforces are
 * part of the contract — `parseCircuit` has already refused anything that
 * expands past them, and this call is the one that does the work.
 */
function acceptCircuit(input: unknown): Circuit {
  try {
    return expandCircuit(parseCircuit(input)).circuit
  } catch (error) {
    throw new SimulationFailure(
      'INVALID_CIRCUIT',
      'the job payload did not survive parseCircuit',
      { cause: error }
    )
  }
}

/**
 * Anything the engine throws, as a `SimulationFailure` with a code.
 *
 * The engine's refusals are genuine and specific — `DensityTooLargeError`,
 * `MidCircuitMeasurementError`, `CircuitRunError` — but they are *its*
 * vocabulary, and the row stores this system's. A `SimulationFailure` thrown
 * from inside is passed through untouched, so a refusal decided above keeps its
 * own code.
 */
function engine<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof SimulationFailure) throw error
    /*
     * `ENGINE_FAILED` covers a real bug and a circuit the engine legitimately
     * refuses alike, which is a deliberate simplification: the distinction is
     * in the log, and a client can do nothing different with the two. The one
     * case worth separating is the register ceiling, and `checkLimits` has
     * already refused that before any of this ran.
     */
    throw new SimulationFailure(
      'ENGINE_FAILED',
      error instanceof Error ? error.message : 'the engine threw',
      { cause: error }
    )
  }
}
