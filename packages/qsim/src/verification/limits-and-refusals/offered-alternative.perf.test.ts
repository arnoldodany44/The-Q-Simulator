/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — WHAT THE REFUSAL SENDS PEOPLE TO.
 *
 * Lens: limits and refusals. §3.3's memory ceiling is checked before anything
 * is allocated and refused in a translated sentence — that half is verified,
 * without a clock, in `ceiling-precedes-allocation.test.ts` and in
 * `apps/web/src/verification/limits-and-refusals/`. This file is about the
 * *other* half of the same sentence: the refusal names an alternative and
 * offers it as a button, so the alternative has to be one.
 *
 * "Sampled trajectories reach further" is true of memory — one statevector is
 * 16 MB at the twenty-qubit client ceiling — and it is not true of time. A
 * trajectories run costs shots × operations × 2ⁿ, because `runNoisy` restarts
 * every shot from |0…0⟩, so the price of the escape hatch rises exactly as fast
 * as the thing it is an escape from. For a while nothing bounded it: `specOf`
 * asked only whether the *density* method fit, `runNoiseJob` guarded only the
 * density method, and `clampShots` bounded the shot count without ever looking
 * at the register. At twenty qubits and the panel's default two thousand shots
 * that was on the order of an hour, in a worker that cannot be pre-empted —
 * the frozen tab §3.3 forbids, relocated one thread over.
 *
 * What is asserted here now is the fix as a *property of the world*: for every
 * register the editor offers, the run the panel would actually dispatch either
 * fits in the budget or is refused outright. There is no third outcome, and the
 * refusal is not a way of passing this test cheaply — the fitting cases are
 * measured, and they have to reach a shot count a sample can be read from.
 *
 * WHY THIS IS A `.perf.test.ts`. A wall-clock assertion beside three other
 * workspaces measures the scheduler (`performance.perf.test.ts` argues it at
 * length), so it does not belong in the suite that gates a commit. It belongs
 * here, where a number is being claimed about the world.
 *
 * WHY THE BUDGET IS THIRTY SECONDS. It is not a preference. The worker is
 * single-threaded and cannot be pre-empted — `simulation.worker.ts` says so —
 * so for as long as one noisy run is executing, no result of any kind reaches
 * the panel: not the histogram, not the amplitude table, not the scrub step the
 * reader just asked for. The whole live editor is stopped. Thirty seconds is
 * already far past what §5.6's debounce-and-cancel design is built around; it
 * is chosen as the loosest bound under which the mode is still a mode rather
 * than a hang the reader can only escape by reloading the tab. The app's own
 * shot cap targets half of it, so a machine twice as slow as this one still
 * lands inside.
 *
 * THE PROJECTION IS EXACT, NOT AN EXTRAPOLATION. `runNoisy` executes each shot
 * independently from |0…0⟩ — same circuit, same channels, one statevector reset
 * between them — so total cost is linear in the shot count by construction, not
 * by fit. Measuring a few shots and multiplying is therefore a measurement of
 * the full run, and it is done that way so this file does not itself take an
 * hour.
 */

import { describe, expect, it } from 'vitest'

import { MAX_DENSITY_QUBITS } from '../../density.js'
import { NOISE_PROFILES } from '../../noise.js'
import { createRng } from '../../rng.js'
import { runNoisy, type CircuitLike, type OperationLike } from '../../runner.js'

/** `MAX_CLIENT_QUBITS` in `apps/web` — the widest register the editor offers. */
const CLIENT_CEILING = 20

/** The loosest wait under which a live editor is still live. See the header. */
const BUDGET_MS = 30_000

/*
 * The app's shot cap, mirrored rather than imported.
 *
 * `@qsim/core` has no dependency on `apps/web` and must not grow one — these
 * three numbers live in `apps/web/src/features/simulation/protocol.ts`, and
 * copying them is what lets this file measure the run the panel would really
 * dispatch. The copy is deliberate and is the same arrangement `CLIENT_CEILING`
 * above has always had; `every-route-refuses.test.ts` on the app side asserts
 * the arithmetic against the real constants, so a drift shows up there as a
 * changed number and here as a changed measurement.
 */
const TRAJECTORY_WORK_BUDGET = 3e8
const MIN_TRAJECTORY_SHOTS = 100
const MAX_SHOTS = 100_000

function maxTrajectoryShots(qubits: number, operations: number): number {
  const work = Math.max(1, operations) * 2 ** qubits
  return Math.min(
    MAX_SHOTS,
    Math.max(1, Math.floor(TRAJECTORY_WORK_BUDGET / work))
  )
}

/** A teaching-sized circuit: an H wall and a CX ladder, 2n − 1 gates. */
function ladder(qubits: number): CircuitLike {
  const operations: OperationLike[] = []
  let column = 0
  for (let q = 0; q < qubits; q++) {
    operations.push({ id: `h${q}`, gate: 'h', targets: [q], column: column++ })
  }
  for (let q = 0; q + 1 < qubits; q++) {
    operations.push({
      id: `cx${q}`,
      gate: 'cx',
      targets: [q + 1],
      controls: [q],
      column: column++,
    })
  }
  return { qubits, clbits: 0, operations }
}

/** Milliseconds for `shots` shots of a noisy run on `qubits` wires. */
function timeShots(qubits: number, shots: number): number {
  const started = Date.now()
  const result = runNoisy(ladder(qubits), {
    profile: NOISE_PROFILES.teaching,
    readout: true,
    shots,
    rng: createRng(1),
  })
  const elapsed = Date.now() - started
  // Reading the answer keeps the work from being optimised away and asserts
  // the run really produced the tally it was timed for.
  expect(result.shots).toBe(shots)
  return elapsed
}

/** Operations in `ladder(n)`, which is what the cap is a function of. */
function gatesIn(qubits: number): number {
  return ladder(qubits).operations.length
}

describe('the way out of the density ceiling', () => {
  it(
    'answers within the budget at the first register the ceiling refuses',
    { timeout: 600_000 },
    () => {
      /*
       * Thirteen qubits: the exact size the refusal button sends a reader to,
       * at the shot count the panel would be holding when they press it. This
       * is the case the promise has to hold for at minimum, and the cap must
       * not have solved it by shrinking the run to nothing.
       */
      const qubits = MAX_DENSITY_QUBITS + 1
      const shots = maxTrajectoryShots(qubits, gatesIn(qubits))
      expect(
        shots,
        `${qubits} qubits must still afford a readable sample`
      ).toBeGreaterThanOrEqual(MIN_TRAJECTORY_SHOTS)

      timeShots(qubits, 20) // warm the kernels; the first shot compiles them
      const sample = 100
      const elapsed = timeShots(qubits, sample)
      const projected = (elapsed / sample) * shots

      expect(
        projected,
        `${qubits} qubits × ${shots} shots projects to ` +
          `${Math.round(projected)} ms (measured ${elapsed} ms for ${sample})`
      ).toBeLessThan(BUDGET_MS)
    }
  )

  it(
    'either fits or refuses, at every register the editor offers',
    { timeout: 600_000 },
    () => {
      /*
       * The whole range, one claim: there is no register between the density
       * ceiling and the client ceiling at which the sampled method quietly
       * accepts a run it cannot finish.
       *
       * Twenty qubits is what "any size this browser can simulate" used to
       * promise, and it is one click away — the editor's insert-qubit button
       * reaches it, the density method refuses at thirteen, and the refusal's
       * own button switches the method. It is now refused with its own
       * sentence, and the assertion below is what makes that refusal honest
       * rather than convenient: where the mode still runs, it is measured.
       */
      for (
        let qubits = MAX_DENSITY_QUBITS + 1;
        qubits <= CLIENT_CEILING;
        qubits++
      ) {
        const gates = gatesIn(qubits)
        const shots = maxTrajectoryShots(qubits, gates)
        if (shots < MIN_TRAJECTORY_SHOTS) {
          // Refused on the app side before anything is dispatched — nothing to
          // time, which is the point.
          continue
        }

        timeShots(qubits, 2) // warm-up, per register
        const sample = 20
        const elapsed = timeShots(qubits, sample)
        const projected = (elapsed / sample) * shots

        expect(
          projected,
          `${qubits} qubits × ${gates} gates × ${shots} shots projects to ` +
            `${Math.round(projected / 1000)} s (measured ${elapsed} ms for ` +
            `${sample} shots)`
        ).toBeLessThan(BUDGET_MS)
      }
    }
  )

  it('refuses rather than shrinking a run below what a sample can say', () => {
    /*
     * No clock: the cap and the floor are arithmetic, and this is the half of
     * the ruling that says a bounded run is not the same thing as a useful one.
     * A frequency drawn from N shots carries a standard error of 1/(2√N), so at
     * the widest register the editor offers the affordable count is a handful —
     * a histogram of its own noise, which is exactly the plausible-and-wrong
     * picture §3.3 is written against. It has to be refused, not drawn small.
     */
    const shots = maxTrajectoryShots(CLIENT_CEILING, gatesIn(CLIENT_CEILING))
    expect(shots).toBeLessThan(MIN_TRAJECTORY_SHOTS)
  })
})
