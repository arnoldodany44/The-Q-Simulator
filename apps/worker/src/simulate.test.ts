import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { MAX_RESULT_OUTCOMES, SHOT_CHUNK } from '@qsim/jobs'
import type { JobProgress } from '@qsim/jobs'
import { describe, expect, it } from 'vitest'
import { runSimulationJob } from './simulate.js'
import {
  BELL,
  MEASURED_BELL,
  jobPayload,
  wideCircuit,
} from './testing/payloads.js'

const CEILINGS = { maxQubits: 24, timeoutMs: 60_000 }

function collect(): {
  report: (progress: JobProgress) => void
  seen: JobProgress[]
} {
  const seen: JobProgress[] = []
  return { report: (progress) => seen.push(progress), seen }
}

describe('STATEVECTOR', () => {
  it('answers with the exact distribution of the circuit', () => {
    const { report } = collect()
    const result = runSimulationJob(jobPayload(), report, CEILINGS)

    expect(result.mode).toBe('STATEVECTOR')
    expect(result.qubits).toBe(2)
    expect(result.outcomes).toHaveLength(2)
    for (const outcome of result.outcomes) {
      expect(outcome.probability).toBeCloseTo(0.5, 12)
      expect(outcome.count).toBeNull()
    }
    expect(result.outcomes.map((entry) => entry.state).sort()).toEqual([
      '00',
      '11',
    ])
  })

  it('draws shots from the very state it just computed', () => {
    // §3.2's comparison, and it is only honest because both halves come out of
    // one run: the exact probability and the empirical count sit on one row.
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ shots: 1_000 }),
      report,
      CEILINGS
    )
    const total = result.outcomes.reduce(
      (sum, entry) => sum + (entry.count ?? 0),
      0
    )
    expect(total).toBe(1_000)
    for (const outcome of result.outcomes) {
      expect(outcome.probability).toBeCloseTo(0.5, 12)
    }
  })

  it('is reproducible from its seed', () => {
    const { report } = collect()
    const first = runSimulationJob(jobPayload({ shots: 500 }), report, CEILINGS)
    const second = runSimulationJob(
      jobPayload({ shots: 500 }),
      report,
      CEILINGS
    )
    expect(first.outcomes).toEqual(second.outcomes)
  })

  it('refuses a noise profile rather than ignoring one', () => {
    // An exact unitary evolution has nowhere to put a profile, and quietly
    // dropping it would answer a question nobody asked.
    const { report } = collect()
    expect(() =>
      runSimulationJob(
        jobPayload({ noiseProfileId: 'teaching' }),
        report,
        CEILINGS
      )
    ).toThrowError(/nowhere to apply a noise profile/)
  })

  it('refuses a circuit that measures before it ends', () => {
    const { report } = collect()
    expect(() =>
      runSimulationJob(jobPayload({ circuit: MEASURED_BELL }), report, CEILINGS)
    ).toThrowError()
  })
})

describe('TRAJECTORIES', () => {
  it('tallies the classical register over the shots', () => {
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ circuit: MEASURED_BELL, mode: 'TRAJECTORIES', shots: 400 }),
      report,
      CEILINGS
    )
    const total = result.outcomes.reduce(
      (sum, entry) => sum + (entry.count ?? 0),
      0
    )
    expect(total).toBe(400)
    // A measured Bell pair only ever reads 00 or 11 — the correlation is the
    // whole point, so a 01 here would be a physics bug rather than noise.
    expect(result.outcomes.map((entry) => entry.state).sort()).toEqual([
      '00',
      '11',
    ])
  })

  it('gives exactly the same answer chunked as it would unchunked', () => {
    /*
     * The chunking exists so progress has something to count, and it must not
     * change a single draw: one generator threaded through the chunks in order
     * gives the same sequence as one call. If this ever fails, every stored
     * result from before the change becomes unreproducible — which is why
     * SHOT_CHUNK is a constant and not a tuning knob.
     */
    const { report } = collect()
    const oneChunk = runSimulationJob(
      jobPayload({
        circuit: MEASURED_BELL,
        mode: 'TRAJECTORIES',
        shots: SHOT_CHUNK,
      }),
      report,
      CEILINGS
    )
    const several = runSimulationJob(
      jobPayload({
        circuit: MEASURED_BELL,
        mode: 'TRAJECTORIES',
        shots: SHOT_CHUNK * 3,
      }),
      report,
      CEILINGS
    )

    // The first chunk of the long run drew the same numbers as the short run,
    // so the long run's tally contains the short one three chunks over.
    expect(
      several.outcomes.reduce((sum, entry) => sum + (entry.count ?? 0), 0)
    ).toBe(SHOT_CHUNK * 3)
    expect(oneChunk.outcomes.map((entry) => entry.state).sort()).toEqual(
      several.outcomes.map((entry) => entry.state).sort()
    )
  })

  it('reports a real fraction, because a shot loop has one to report', () => {
    const { report, seen } = collect()
    runSimulationJob(
      jobPayload({
        circuit: MEASURED_BELL,
        mode: 'TRAJECTORIES',
        shots: SHOT_CHUNK * 2,
      }),
      report,
      CEILINGS
    )
    const simulating = seen.filter((entry) => entry.phase === 'simulating')
    expect(simulating.at(0)).toEqual({
      phase: 'simulating',
      completed: 0,
      total: SHOT_CHUNK * 2,
    })
    expect(simulating.at(-1)).toEqual({
      phase: 'simulating',
      completed: SHOT_CHUNK * 2,
      total: SHOT_CHUNK * 2,
    })
  })

  it('samples the noise channels when a profile is named', () => {
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({
        mode: 'TRAJECTORIES',
        shots: 200,
        noiseProfileId: 'teaching',
      }),
      report,
      CEILINGS
    )
    // With a profile the tally is over the *quantum* register, so a circuit
    // with no classical bits is fine — and the teaching profile is loud enough
    // that a Bell pair visibly stops being one.
    expect(result.outcomes.length).toBeGreaterThan(0)
    expect(
      result.outcomes.reduce((sum, entry) => sum + (entry.count ?? 0), 0)
    ).toBe(200)
  })

  it('refuses a shotless run, which is not a run at all', () => {
    const { report } = collect()
    expect(() =>
      runSimulationJob(
        jobPayload({ circuit: MEASURED_BELL, mode: 'TRAJECTORIES' }),
        report,
        CEILINGS
      )
    ).toThrowError(/shot count/)
  })

  it('refuses a bare tally of a register that has no classical bits', () => {
    // It would produce one bucket keyed by the empty string — a histogram of
    // nothing, which is worse than a refusal because it looks like an answer.
    const { report } = collect()
    expect(() =>
      runSimulationJob(
        jobPayload({ mode: 'TRAJECTORIES', shots: 100 }),
        report,
        CEILINGS
      )
    ).toThrowError(/no classical bits/)
  })
})

describe('DENSITY_MATRIX', () => {
  it('evolves rho exactly and reports its purity', () => {
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ mode: 'DENSITY_MATRIX' }),
      report,
      CEILINGS
    )
    // With no profile the run is the ideal one, so rho is the pure Bell state
    // written as a matrix and Tr(rho squared) is 1.
    expect(result.purity).toBeCloseTo(1, 10)
    expect(result.shots).toBeNull()
  })

  it('loses purity under a noisy device, which is the point of the mode', () => {
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ mode: 'DENSITY_MATRIX', noiseProfileId: 'teaching' }),
      report,
      CEILINGS
    )
    expect(result.purity).toBeLessThan(1)
    expect(result.purity).toBeGreaterThan(0)
  })

  it('refuses a register past the engine ceiling before allocating 4ⁿ', () => {
    const { report } = collect()
    expect(() =>
      runSimulationJob(
        jobPayload({ circuit: wideCircuit(13), mode: 'DENSITY_MATRIX' }),
        report,
        CEILINGS
      )
    ).toThrowError(/too-many-qubits/)
  })
})

describe('§11 limits, applied here and not only at the API', () => {
  it('refuses a register past this worker ceiling', () => {
    // The producer checked too. This check is the one that matters: a job in
    // Redis is a job anything holding the connection string can add.
    const { report } = collect()
    expect(() =>
      runSimulationJob(
        jobPayload({ circuit: wideCircuit(25) }),
        report,
        CEILINGS
      )
    ).toThrowError(/too-many-qubits/)
  })

  it('refuses work past the budget the wall-clock bound implies', () => {
    const { report } = collect()
    expect(() =>
      runSimulationJob(jobPayload({ circuit: wideCircuit(22, 40) }), report, {
        maxQubits: 24,
        timeoutMs: 1_000,
      })
    ).toThrowError(/work-budget-exceeded/)
  })

  it('refuses a payload that does not survive parseCircuit', () => {
    /*
     * A shape Zod accepts and the contract does not: two gates on the same
     * qubit in the same column. It would run — and produce a perfectly
     * normalised state that belongs to no circuit anybody wrote.
     */
    const collided: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'x', targets: [0], column: 0 },
      ],
    }
    const { report } = collect()
    expect(() =>
      runSimulationJob(jobPayload({ circuit: collided }), report, CEILINGS)
    ).toThrowError(/parseCircuit/)
  })
})

describe('the stored result', () => {
  it('is bounded however wide the register is', () => {
    // Ten Hadamards is a uniform distribution over 1024 states; the stored
    // reading keeps the cap and *says* what it left out.
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ circuit: wideCircuit(10) }),
      report,
      CEILINGS
    )
    expect(result.outcomes).toHaveLength(MAX_RESULT_OUTCOMES)
    expect(result.hiddenOutcomes).toBe(1024 - MAX_RESULT_OUTCOMES)
    expect(result.hiddenWeight).toBeCloseTo(
      (1024 - MAX_RESULT_OUTCOMES) / 1024,
      6
    )
  })

  it('echoes the seed, so the run can be repeated from what was stored', () => {
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ seed: 4242 }),
      report,
      CEILINGS
    )
    expect(result.seed).toBe(4242)
  })

  it('measures the engine and not the queue wait', () => {
    let clock = 1_000
    const { report } = collect()
    const result = runSimulationJob(
      jobPayload({ circuit: BELL }),
      report,
      CEILINGS,
      () => {
        clock += 25
        return clock
      }
    )
    expect(result.durationMs).toBe(25)
  })

  it('walks the phases in order', () => {
    const { report, seen } = collect()
    runSimulationJob(jobPayload({ shots: 10 }), report, CEILINGS)
    const phases = [...new Set(seen.map((entry) => entry.phase))]
    expect(phases).toEqual([
      'validating',
      'simulating',
      'sampling',
      'summarising',
    ])
  })
})
