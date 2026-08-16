/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — EVERY ROUTE INTO THE DENSITY MODE.
 *
 * Lens: limits and refusals. A ρ is 4ⁿ complex numbers, so §3.3's exact method
 * has a hard ceiling, and the requirement is not that *a* guard exists — it is
 * that **no route reaches the allocation without passing one**. A guard on the
 * panel is worth nothing if a circuit can arrive from somewhere the panel never
 * saw.
 *
 * So the routes are enumerated here rather than assumed, and each is exercised
 * against the code that would actually run for it:
 *
 *   the panel        a reader ticks the box            → `specOf`
 *   a preset         a circuit object replaces the one on screen  → `specOf`
 *   a shared URL     a circuit parsed from a payload   → `specOf` + `runJob`
 *   the API          a saved circuit loaded by id      → `specOf` + `runJob`
 *   the scrubber     the same request at a column      → `runJob`
 *   a foreign client a request nobody's panel built    → `runNoiseJob`
 *
 * The last one is the important one and it is the one a panel test cannot
 * reach. `specOf` is a *main-thread* judgement about what to offer; the worker
 * is the side that would call `new Float64Array(4 ** 13)`, and it has to refuse
 * a request that arrived with `method: 'density'` and thirteen qubits on it
 * whatever the sender believed. This file builds those requests by hand.
 *
 * WHAT IS CHECKED BEYOND "IT REFUSES":
 *
 *  - **Nothing is reserved.** The global `Float64Array` is replaced by a
 *    counting subclass for the duration of the refused run, and the largest
 *    allocation is required to stay at statevector scale (2ⁿ) — a ρ would be
 *    2ⁿ × 2ⁿ, which is four thousand times larger at thirteen qubits and could
 *    not hide inside that bound.
 *  - **A refusal is carried, never thrown.** The ideal half of the same answer
 *    is still good, so the response must be a `result` with a refusal payload
 *    and a state on it — not an `error`, and not an exception.
 *  - **The numbers travel.** A refusal without `qubits` and `limit` renders as
 *    "past the 0-qubit ceiling", which is the failure a catalog check cannot
 *    see because the string is perfectly translated.
 *  - **The boundary is exact.** Twelve is asked for and answered; thirteen is
 *    refused. Both sides of the edge, on every route.
 */

import { createCheckpoints, run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  INITIAL_NOISE,
  densityFits,
  methodFits,
  specOf,
  type NoiseSettings,
} from '../../features/analysis/noiseSettings'
import { runJob } from '../../features/simulation/job'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import {
  MAX_CLIENT_QUBITS,
  MAX_DENSITY_CLIENT_QUBITS,
  MIN_TRAJECTORY_SHOTS,
  NOISE_REFUSAL_CODES,
  maxTrajectoryShots,
  type AnalyticRequest,
  type NoiseSpec,
} from '../../features/simulation/protocol'
import enSimulation from '../../i18n/locales/en/simulation.json'
import esSimulation from '../../i18n/locales/es/simulation.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'

/** The first register size §3.3 refuses to build a ρ for. */
const OVER = MAX_DENSITY_CLIENT_QUBITS + 1

const SIMULATION = { en: enSimulation, es: esSimulation, fr: frSimulation }
const ANALYSIS = { en: enAnalysis, es: esAnalysis, fr: frAnalysis }

/** A circuit with something in it: an H wall and one entangling pair. */
function circuitOf(qubits: number): Circuit {
  const operations = [
    { id: 'h0', gate: 'h', targets: [0], column: 0 },
    ...(qubits > 1
      ? [{ id: 'cx0', gate: 'cx', targets: [1], controls: [0], column: 1 }]
      : []),
  ]
  return parseCircuit({ schemaVersion: 1, qubits, operations })
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/**
 * A circuit with `gates` operations on `qubits` wires — what the sampled
 * method's ceiling is a function of, since its cost is shots × operations × 2ⁿ.
 *
 * Hadamards, so nothing here depends on the gate: the guard is arithmetic on
 * two integers and must not consult the circuit's contents.
 */
function ladder(qubits: number, gates: number): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: gates }, (_, index) => ({
      id: `h${index}`,
      gate: 'h',
      targets: [index % qubits],
      column: index,
    })),
  })
}

/** Settings a reader would have after ticking the box and leaving the default. */
function enabled(overrides: Partial<NoiseSettings> = {}): NoiseSettings {
  return { ...INITIAL_NOISE, enabled: true, ...overrides }
}

/** A spec built by hand — the shape a client this app did not write would send. */
function foreignSpec(overrides: Partial<NoiseSpec> = {}): NoiseSpec {
  const spec = specOf(enabled(), 2, 2)
  if (spec === null) throw new Error('the default settings ask for nothing')
  return { ...spec, ...overrides }
}

function analyticRequest(
  circuit: Circuit,
  noise: NoiseSpec | null,
  throughColumn: number | null = null
): AnalyticRequest {
  return {
    kind: 'simulate',
    id: 1,
    circuit,
    fromColumn: 0,
    sharedMemory: false,
    mode: 'analytic',
    throughColumn,
    sample: null,
    noise,
  }
}

/**
 * What a `Float64Array` can be constructed from, as one parameter.
 *
 * The subclasses below take this rather than `ConstructorParameters<…>`,
 * because that resolves to the no-argument overload and would not let the
 * length through — and the length is the whole measurement.
 */
type BufferSource_ = number | ArrayBufferLike | ArrayLike<number> | undefined

/** The largest `Float64Array` anything in `body` asked the allocator for. */
function largestAllocationDuring(body: () => void): number {
  const scope = globalThis as { Float64Array: Float64ArrayConstructor }
  const original = scope.Float64Array
  let largest = 0

  class Counting extends original {
    constructor(source?: BufferSource_) {
      super(source as number)
      largest = Math.max(largest, this.length)
    }
  }

  scope.Float64Array = Counting as unknown as Float64ArrayConstructor
  try {
    body()
  } finally {
    scope.Float64Array = original
  }
  return largest
}

describe('the ceiling is the same number wherever it is asked', () => {
  it('answers identically on both sides of the thread boundary', () => {
    /*
     * The panel's copy and the worker's copy are two implementations of one
     * ruling, and the failure mode of a double check is that the two drift: a
     * panel that offers what the worker refuses turns a clear limit into a
     * round trip ending in "the noisy run did not finish".
     *
     * The worker is asked only where the panel refuses, and that restraint is
     * the same argument this file is about: calling it at eleven or twelve
     * would evolve a real 64 MB or 256 MB ρ inside a correctness suite running
     * beside three other workspaces. The accepting side is exercised further
     * down at four qubits, where the whole matrix is 4 KB.
     */
    for (let qubits = 1; qubits <= MAX_CLIENT_QUBITS; qubits++) {
      const panel = densityFits(qubits)
      expect(panel, `n=${qubits}`).toBe(qubits <= MAX_DENSITY_CLIENT_QUBITS)
      if (panel) continue

      const worker = runNoiseJob(
        // A one-qubit circuit's state stands in for any: the worker's guard is
        // arithmetic on `circuit.qubits` and must not consult the amplitudes.
        circuitOf(qubits),
        stateOf(circuitOf(1)),
        foreignSpec({ method: 'density' })
      )
      expect(worker.ok, `n=${qubits}`).toBe(false)
      if (worker.ok) continue
      expect(worker.refusal.code, `n=${qubits}`).toBe('density-too-large')
    }
  })

  it('puts the edge between twelve and thirteen, and §3.3 says so', () => {
    expect(MAX_DENSITY_CLIENT_QUBITS).toBe(12)
    expect(densityFits(MAX_DENSITY_CLIENT_QUBITS)).toBe(true)
    expect(densityFits(OVER)).toBe(false)
    // The client ceiling can only ever be stricter than the engine's, never
    // looser — that is the whole reason it is a `Math.min`.
    expect(MAX_DENSITY_CLIENT_QUBITS).toBeLessThanOrEqual(MAX_CLIENT_QUBITS)
  })
})

describe('every route asks the same question', () => {
  /*
   * A preset, a shared URL and a saved circuit differ only in where the circuit
   * object came from — so what has to be true is that the guard is a function
   * of the circuit currently on screen and is re-evaluated when it changes.
   * The dangerous shape is a panel that decided once, while the reader had a
   * four-qubit circuit open, and kept its answer when a sixteen-qubit one
   * arrived.
   */
  it.each([
    ['a preset', 4, 16],
    ['a shared URL', 3, OVER],
    ['a saved circuit from the API', 12, 13],
    ['a circuit that shrank back under the ceiling', 16, 12],
  ])('re-decides when %s replaces the circuit', (_route, before, after) => {
    const settings = enabled({ method: 'density' })
    // Whatever the answer was for the circuit that was open…
    const first = specOf(settings, before, 2)
    expect(first === null).toBe(before > MAX_DENSITY_CLIENT_QUBITS)
    // …the new circuit gets its own, from the same settings object.
    const second = specOf(settings, after, 2)
    expect(second === null).toBe(after > MAX_DENSITY_CLIENT_QUBITS)
  })

  it('offers nothing for a register past the ceiling, at any profile', () => {
    for (const profileId of [
      'teaching',
      'superconducting',
      'trappedIon',
      'custom',
    ] as const) {
      const settings = enabled({ profileId, method: 'density' })
      expect(specOf(settings, OVER, 2), profileId).toBeNull()
      expect(methodFits(settings, OVER, 2), profileId).toBe(false)
    }
  })

  it('does ask once the register fits, so the refusals are not vacuous', () => {
    const settings = enabled({ method: 'density' })
    const spec = specOf(settings, MAX_DENSITY_CLIENT_QUBITS, 2)
    expect(spec).not.toBeNull()
    expect(spec?.method).toBe('density')
  })
})

describe('the worker refuses a request no panel built', () => {
  it.each([13, 14, 16, 20])(
    'returns a refusal rather than throwing at %i qubits',
    (qubits) => {
      const circuit = circuitOf(qubits)
      const payload = runNoiseJob(
        circuit,
        stateOf(circuit),
        foreignSpec({ method: 'density' })
      )
      expect(payload.ok).toBe(false)
      if (payload.ok) return
      expect(payload.refusal.code).toBe('density-too-large')
      // The numbers a translated sentence interpolates. Without them the
      // message renders as "past the 0-qubit ceiling" and is still translated.
      expect(payload.refusal.qubits).toBe(qubits)
      expect(payload.refusal.limit).toBe(MAX_DENSITY_CLIENT_QUBITS)
    }
  )

  it('carries a failed allocation instead of throwing it', () => {
    /*
     * The case the ceiling does *not* cover: a register inside the limit on a
     * device that cannot honour it anyway. Twelve qubits is 256 MB in one
     * contiguous reservation, and a tab with other things in it — or a phone —
     * can refuse that. What must not happen is a `RangeError` escaping from
     * inside a typed-array constructor into the worker's generic failure path
     * and reaching the reader as raw English.
     *
     * The allocator is starved here rather than the register enlarged, so the
     * refusal being exercised is the one memory pressure really produces.
     */
    // Eight qubits: ρ is 65 536 entries and the statevector is 256, so the
    // threshold below starves the matrix and nothing else.
    const circuit = circuitOf(8)
    const state = stateOf(circuit)
    const spec = foreignSpec({ method: 'density' })

    const scope = globalThis as { Float64Array: Float64ArrayConstructor }
    const original = scope.Float64Array
    class Starved extends original {
      constructor(source?: BufferSource_) {
        if (typeof source === 'number' && source > 10_000) {
          throw new RangeError('Array buffer allocation failed')
        }
        super(source as number)
      }
    }

    scope.Float64Array = Starved as unknown as Float64ArrayConstructor
    let payload
    try {
      payload = runNoiseJob(circuit, state, spec)
    } finally {
      scope.Float64Array = original
    }

    // Carried, not thrown — the ideal half of the answer survives.
    expect(payload.ok).toBe(false)
    if (payload.ok) return
    // And the code is one the catalog has a sentence for, in all three
    // languages, so nothing raw reaches the reader.
    expect(NOISE_REFUSAL_CODES).toContain(payload.refusal.code)
    for (const [language, catalog] of Object.entries(SIMULATION)) {
      expect(catalog.errors[payload.refusal.code], language).toBeTruthy()
    }
    /*
     * THIS ASSERTION USED TO PIN `noise-failed`, and pinning it was the point:
     * the code said "the noisy run did not finish", named neither cause nor
     * alternative, and was the one memory refusal in the milestone that carried
     * no numbers. What starved the allocator here is not a bug in this app — it
     * is a device that cannot hold 256 MB in one piece, which twelve qubits
     * really is — so the refusal now says that, carries the register and the
     * ceiling like `density-too-large` does, and points at the method that
     * reserves 2ⁿ instead of 4ⁿ.
     *
     * The hard requirement is unchanged and still asserted above: carried
     * rather than thrown, and no raw typed-array message on screen.
     */
    expect(payload.refusal.code).toBe('noise-out-of-memory')
    expect(payload.refusal.qubits).toBe(8)
    expect(payload.refusal.limit).toBe(MAX_DENSITY_CLIENT_QUBITS)
    // The allocator's own English is kept for the console and nowhere else.
    expect(payload.refusal.detail).toContain('allocation failed')
  })

  it.each([
    ['the widest register the editor offers', MAX_CLIENT_QUBITS, 39],
    ['a long circuit at a middling register', 17, 60],
  ])(
    'refuses a sampled run it could not finish: %s',
    (_case, qubits, gates) => {
      /*
       * The sampled method's own ceiling, from the side that would spend the
       * minutes. It is the *alternative* the density refusal offers, so an
       * unbounded one turned a memory limit into a fifty-minute freeze one click
       * away — in a worker that cannot be pre-empted, so not one histogram, scrub
       * step or later edit would have come back in the meantime.
       */
      const circuit = ladder(qubits, gates)
      const payload = runNoiseJob(
        circuit,
        stateOf(circuitOf(1)),
        foreignSpec({ method: 'trajectories' })
      )
      expect(payload.ok).toBe(false)
      if (payload.ok) return
      expect(payload.refusal.code).toBe('trajectories-too-large')
      // The numbers the sentence interpolates — all four of them, because a
      // refusal that says "too slow" and nothing else is a refusal nobody can act
      // on.
      expect(payload.refusal.qubits).toBe(qubits)
      expect(payload.refusal.operations).toBe(gates)
      expect(payload.refusal.limit).toBe(MIN_TRAJECTORY_SHOTS)
      expect(payload.refusal.shots).toBeLessThan(MIN_TRAJECTORY_SHOTS)
    }
  )

  it('still runs the sampled method where the density ceiling sends people', () => {
    /*
     * The refusals above are worth nothing unless the alternative still works
     * at the size the refusal button actually sends a reader to — a guard that
     * refused everything would satisfy every negative in this file.
     *
     * Thirteen qubits, and a shot count chosen small so this stays a
     * *correctness* test. The budget's own arithmetic is asserted without a
     * clock two lines down; the claim that a real run of the capped size
     * finishes inside thirty seconds is a claim about the world and lives in
     * `@qsim/core`'s `offered-alternative.perf.test.ts`, for the reason
     * `performance.perf.test.ts` argues at length.
     */
    const circuit = ladder(OVER, 25)
    const payload = runNoiseJob(
      circuit,
      stateOf(circuit),
      foreignSpec({ method: 'trajectories', shots: 20 })
    )
    expect(payload.ok).toBe(true)
    if (!payload.ok) return
    expect(payload.reading.method).toBe('trajectories')
    expect(payload.reading.shots).toBe(20)

    // And the budget it would have been held to is real: the panel's default
    // two thousand does not survive this register, so what a reader is sent to
    // is a bounded run rather than the one they were already holding.
    const affordable = maxTrajectoryShots(OVER, 25)
    expect(affordable).toBeGreaterThanOrEqual(MIN_TRAJECTORY_SHOTS)
    expect(affordable).toBeLessThan(2000)
  })

  it('reserves nothing while refusing', () => {
    /*
     * The claim that matters. A ρ at thirteen qubits is 2²⁶ doubles per array;
     * a statevector is 2¹³. Bounding the largest allocation at statevector
     * scale is a bound a density matrix cannot hide under.
     */
    const circuit = circuitOf(OVER)
    const state = stateOf(circuit)
    const spec = foreignSpec({ method: 'density' })

    const largest = largestAllocationDuring(() => {
      const payload = runNoiseJob(circuit, state, spec)
      expect(payload.ok).toBe(false)
    })
    expect(largest, `largest allocation was ${largest} doubles`).toBeLessThan(
      2 ** OVER
    )
  })
})

describe('a refusal costs the reader nothing but the noisy half', () => {
  it('answers with a result, a state and a carried refusal', () => {
    const circuit = circuitOf(OVER)
    const job = runJob(
      createCheckpoints(),
      analyticRequest(circuit, foreignSpec({ method: 'density' })),
      false
    )

    // Not an error response: the ideal run succeeded and its answer is here.
    expect(job.response.kind).toBe('result')
    if (job.response.kind !== 'result') return
    if (job.response.mode !== 'analytic') throw new Error('expected analytic')
    expect(job.response.state.qubits).toBe(OVER)
    expect(job.response.state.re.length).toBe(2 ** OVER)

    const noise = job.response.noise
    expect(noise).not.toBeNull()
    expect(noise?.ok).toBe(false)
    if (noise?.ok === false) {
      expect(noise.refusal.code).toBe('density-too-large')
    }
  })

  it.each([null, -1, 0, 1])(
    'refuses the same way at scrub position %s',
    (throughColumn) => {
      /*
       * The scrubber is the one route that changes the circuit *between* the
       * panel's judgement and the worker's: `job.ts` truncates to the column
       * before handing the circuit to the noisy half. Truncation drops
       * operations and must never drop wires — a cut that rewrote `qubits`
       * would slip a thirteen-qubit register past the ceiling at column −1 and
       * fail at the end of the timeline.
       */
      const circuit = circuitOf(OVER)
      const job = runJob(
        createCheckpoints(),
        analyticRequest(
          circuit,
          foreignSpec({ method: 'density' }),
          throughColumn
        ),
        false
      )
      expect(job.response.kind).toBe('result')
      if (job.response.kind !== 'result') return
      if (job.response.mode !== 'analytic') throw new Error('expected analytic')
      const noise = job.response.noise
      expect(noise?.ok).toBe(false)
      if (noise?.ok === false) {
        expect(noise.refusal.code).toBe('density-too-large')
        expect(noise.refusal.qubits).toBe(OVER)
      }
    }
  )

  it('runs the noisy half at the last size that fits, on every scrub position', () => {
    /*
     * The boundary from the other side, at a size this suite can afford to
     * evolve for real: four qubits is a 4 KB ρ. What is being checked is that
     * the scrub route reaches the *reading* rather than only the refusal —
     * a guard that refused everything would satisfy every test above.
     */
    for (const throughColumn of [null, 0, 1]) {
      const circuit = circuitOf(4)
      const job = runJob(
        createCheckpoints(),
        analyticRequest(
          circuit,
          foreignSpec({ method: 'density' }),
          throughColumn
        ),
        false
      )
      if (job.response.kind !== 'result') throw new Error('expected a result')
      if (job.response.mode !== 'analytic') throw new Error('expected analytic')
      const noise = job.response.noise
      expect(noise?.ok, `column ${String(throughColumn)}`).toBe(true)
      if (noise?.ok === true) {
        expect(noise.reading.method).toBe('density')
        expect(noise.reading.density).not.toBeNull()
      }
    }
  })
})

describe('every refusal a route can produce has a sentence', () => {
  it.each(NOISE_REFUSAL_CODES)('says %s in all three languages', (code) => {
    for (const [language, catalog] of Object.entries(SIMULATION)) {
      const sentence = catalog.errors[code]
      expect(sentence, `${language}/${code}`).toBeTruthy()
      // A catalog whose value is the key is a catalog that was never written.
      expect(sentence, `${language}/${code}`).not.toBe(code)
      expect(sentence.length, `${language}/${code}`).toBeGreaterThan(20)
    }
  })

  it('interpolates the register and the limit in all three', () => {
    for (const [language, catalog] of Object.entries(SIMULATION)) {
      const sentence = catalog.errors['density-too-large']
      expect(sentence, language).toContain('{{qubits}}')
      expect(sentence, language).toContain('{{limit}}')
    }
    for (const [language, catalog] of Object.entries(ANALYSIS)) {
      const sentence = catalog.noise.refusal.tooLarge
      expect(sentence, language).toContain('{{qubits}}')
      expect(sentence, language).toContain('{{limit}}')
      // And the way out is a control with a label, not advice inside a
      // paragraph — so the label has to exist in every catalog too.
      expect(catalog.noise.refusal.switch.length, language).toBeGreaterThan(3)
    }
  })

  it('never hard-codes the ceiling into a translated sentence', () => {
    /*
     * `MAX_DENSITY_CLIENT_QUBITS` is a constant a WASM core or a server would
     * raise (§5.6 phase 2). A catalog that spelled "12" into its prose would
     * keep saying twelve in two of the three languages for a year after that.
     */
    for (const [language, catalog] of Object.entries(ANALYSIS)) {
      expect(catalog.noise.refusal.tooLarge, language).not.toMatch(/\b12\b/u)
    }
    for (const [language, catalog] of Object.entries(SIMULATION)) {
      expect(catalog.errors['density-too-large'], language).not.toMatch(
        /\b12\b/u
      )
    }
  })
})
