/**
 * The noisy half of a job — §3.3, run on the worker beside the ideal one.
 *
 * `job.ts` produces the statevector §3.2 draws; this produces the second
 * distribution §3.3 draws against it, plus the fidelity between them and, when
 * ρ was formed, the block of it the heat map paints. It is a separate file for
 * the same reason `job.ts` is separate from the worker: it is a function from a
 * circuit and a spec to a payload, with no `postMessage` and no globals, so the
 * whole of it can be tested against the real engine in a plain Vitest process.
 *
 * ────────────────────────────────────────────────────────────────────────
 * MEMORY IS THE LIMIT, AND IT IS CHECKED BEFORE ANYTHING IS RESERVED.
 *
 * ρ is 4ⁿ complex numbers: 64 KB at four qubits, 256 MB at twelve, 4 GB at
 * fourteen. §3.3 tops the mode out around ten to twelve and says that is fine
 * because it is a study mode rather than a scale mode — so the ceiling is not
 * an embarrassment to be hidden behind a spinner. It is checked here on one
 * integer, before the circuit is walked and before a byte is allocated, and it
 * comes back as a *refusal carrying its numbers* so the panel can name the
 * register, name the limit and offer the method that has no ceiling.
 *
 * The check happens twice on purpose, here and on the main thread
 * (`noiseSettings.ts`), and both are wanted for the reason the qubit ceiling is
 * checked twice: the panel's copy decides what to offer a reader, and this one
 * is the side that would do the allocating and must never be talked into it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * A REFUSAL IS RETURNED, NEVER THROWN.
 *
 * The ideal run this rides along with is perfectly good, and a thirteen-qubit
 * circuit still has a histogram, an amplitude table, Bloch spheres and a
 * Q-sphere. Throwing would take all of them away in order to report a ceiling
 * on one panel — the "tab that freezes" of §3.3 wearing the opposite mask. So
 * every path out of this module is a `NoisePayload`, and the one `catch` at the
 * bottom is what makes that true for the failures nobody foresaw.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT CROSSES THE THREAD BOUNDARY, AND WHAT DOES NOT.
 *
 * Not ρ. At the ceiling it is 256 MB and the heat map draws a few hundred
 * cells, so what travels is `DensityBlock`: the states with the largest
 * populations, their sub-matrix, and an honest count of what was left out. Not
 * a 2²⁰ distribution either — the trajectories method answers with its counts,
 * which have at most one entry per distinct outcome observed. The one array
 * that does travel whole is the density method's distribution, and it may
 * because that method's own ceiling bounds it at 4096 doubles.
 */

import {
  DensityTooLargeError,
  createRng,
  densityProbabilities,
  densityPurity,
  densityStateFidelity,
  distributionFidelity,
  formatKet,
  probabilities,
  runNoisy,
  runNoisyDensity,
  validateProfile,
  type DensityMatrix,
  type ShotCounts,
  type Statevector,
} from '@qsim/core'
import type { Circuit } from '@qsim/schema'

import {
  MAX_DENSITY_CLIENT_QUBITS,
  MIN_TRAJECTORY_SHOTS,
  clampShots,
  maxTrajectoryShots,
  trajectoriesFit,
  type DensityBlock,
  type NoisePayload,
  type NoiseReading,
  type NoiseSpec,
} from './protocol'

/**
 * How many basis states the heat map's block is built from: 16, so at most
 * 256 cells are drawn.
 *
 * The histogram's cap is 32 and this is deliberately not the same number, for a
 * reason that is arithmetic rather than taste: a chart of k states is k marks
 * and a matrix of k states is k² of them, so the histogram's 32 would be 1024
 * cells — past the point where a grid is a picture and well past the point
 * where the table beside it is readable. Sixteen keeps the same *spirit* as
 * §3.2's rule, which is that every circuit small enough to be a teaching
 * example is drawn whole: 16 is the complete spectrum of a four-qubit register,
 * so a Bell pair, a GHZ triple and a four-qubit lesson all get their entire ρ,
 * and the cap only ever bites where drawing the whole thing was never possible.
 */
export const DENSITY_BLOCK_LIMIT = 16

/**
 * Below this a population is Float64 residue rather than a state the circuit
 * can reach — the same floor and the same reasoning as `PROBABILITY_FLOOR` in
 * `analysis/histogram.ts`, repeated here rather than imported because this
 * module runs on the worker and must not pull a chart's module across with it.
 */
const POPULATION_FLOOR = 1e-12

/**
 * Run the noisy half and answer with a payload — a reading, or a refusal.
 *
 * `circuit` is the circuit the ideal `state` describes, already truncated to
 * the scrub position by the caller. That is not a detail: a panel comparing the
 * noisy answer for the whole circuit against the ideal state at column 3 would
 * attribute every difference between them to noise, and the differences would
 * mostly be the four columns the ideal half had not run yet.
 */
export function runNoiseJob(
  circuit: Circuit,
  state: Statevector,
  spec: NoiseSpec
): NoisePayload {
  // Before the plan, before the allocation, before the circuit is walked: the
  // answer to "is this register too large" is arithmetic on one integer.
  if (spec.method === 'density' && circuit.qubits > MAX_DENSITY_CLIENT_QUBITS) {
    return {
      ok: false,
      refusal: {
        code: 'density-too-large',
        qubits: circuit.qubits,
        limit: MAX_DENSITY_CLIENT_QUBITS,
        detail:
          `A density matrix for ${circuit.qubits} qubits is 4^${circuit.qubits}` +
          ` complex numbers, past the ${MAX_DENSITY_CLIENT_QUBITS}-qubit ` +
          `ceiling of the noise mode. Run Monte Carlo trajectories instead: ` +
          `they carry a statevector of 2^n and pay in shots rather than memory.`,
      },
    }
  }

  /*
   * And the same question for the other method, whose limit is time rather than
   * memory — checked here for the reason the one above is: this is the side
   * that would spend it, and it must never be talked into it by a request built
   * somewhere new. A trajectories run costs shots × operations × 2ⁿ and cannot
   * be interrupted once it starts (`simulation.worker.ts`), so a request this
   * guard let through would hold the whole editor for as long as it takes: no
   * histogram, no scrub step, no answer to any later edit.
   */
  const operations = circuit.operations.length
  if (
    spec.method === 'trajectories' &&
    !trajectoriesFit(circuit.qubits, operations)
  ) {
    const affordable = maxTrajectoryShots(circuit.qubits, operations)
    return {
      ok: false,
      refusal: {
        code: 'trajectories-too-large',
        qubits: circuit.qubits,
        operations,
        shots: affordable,
        limit: MIN_TRAJECTORY_SHOTS,
        detail:
          `A sampled noisy run restarts from |0...0> on every shot, so it ` +
          `costs shots x operations x 2^n. At ${circuit.qubits} qubits and ` +
          `${operations} operations this browser can afford ${affordable} ` +
          `shots inside its time budget, below the ${MIN_TRAJECTORY_SHOTS} a ` +
          `sampled distribution needs to say anything: the standard error of ` +
          `a frequency is 1/(2*sqrt(N)). Shorten the circuit or narrow the ` +
          `register.`,
      },
    }
  }

  try {
    // An impossible profile is cheap to detect and expensive to discover
    // mid-run, and `customProfile` is not the only way one can reach here — a
    // restored URL or a future API could carry any eight numbers.
    validateProfile(spec.profile)
    const ideal = probabilities(state)
    const reading =
      spec.method === 'density'
        ? densityReading(circuit, state, spec, ideal)
        : trajectoriesReading(circuit, spec, ideal)
    return { ok: true, reading }
  } catch (cause) {
    if (cause instanceof DensityTooLargeError) {
      // Unreachable through the guard above, and kept because the guard is a
      // *client* ceiling: if the engine's own budget is ever tightened below
      // it, this is the path that keeps the panel showing a refusal it can
      // translate instead of a `worker-failed` about a bug in this app.
      return {
        ok: false,
        refusal: {
          code: 'density-too-large',
          qubits: cause.qubits,
          limit: cause.maxQubits,
          detail: cause.message,
        },
      }
    }
    if (isAllocationFailure(cause)) {
      /*
       * A register the ceiling accepted, on a device that could not honour it
       * anyway. Twelve qubits is one contiguous 256 MB reservation, and a phone
       * or a tab with other things in it can refuse that while
       * `assertDensityFits` happily passes — so this is not a bug and the
       * reader is not out of options.
       *
       * Reported as its own code rather than as `noise-failed`, which says the
       * run did not finish and offers nothing. This one carries the register
       * and the ceiling, exactly as `density-too-large` does, so the sentence
       * can name the numbers and point at the method that reserves 2ⁿ instead
       * of 4ⁿ. The requirement that nothing raw reaches the screen is met
       * either way — `detail` stays in the payload for the console.
       */
      return {
        ok: false,
        refusal: {
          code: 'noise-out-of-memory',
          qubits: circuit.qubits,
          limit: MAX_DENSITY_CLIENT_QUBITS,
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      }
    }
    return {
      ok: false,
      refusal: {
        code: 'noise-failed',
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    }
  }
}

/**
 * Whether a failure is the allocator refusing, rather than a bug.
 *
 * MATCHED ON THE MESSAGE, WHICH IS UGLY AND IS THE ONLY OPTION. There is no
 * typed exception for "this reservation is too large": V8 throws
 * `RangeError: Array buffer allocation failed`, JavaScriptCore
 * `RangeError: Out of memory`, and SpiderMonkey a plain `Error: out of memory`.
 * The alternative — probing the allocation before the run — would reserve the
 * very 256 MB the probe exists to avoid committing to twice.
 *
 * The pattern is deliberately broad because the cost of the two mistakes is not
 * symmetric. A genuine bug misread as an allocation failure shows a reader a
 * memory sentence with the right register on it, and its `detail` still reaches
 * the console; an allocation failure misread as a bug is the case this finding
 * was filed about. It is only ever consulted for a failure that escaped a
 * validated profile and a ceiling-checked register, so the remaining population
 * is small.
 */
function isAllocationFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  return /allocat|out of memory|array (buffer|length)|invalid array/iu.test(
    cause.message
  )
}

/* ─────────────────────────── the exact method ───────────────────────── */

/**
 * ρ → UρU† for every gate and ρ → Σ Kₖ ρ Kₖ† for every channel — §3.3's
 * reference answer, with no shot noise in it and no seed in its arguments.
 *
 * Three numbers come out of it and they answer three different questions,
 * which is why all three travel rather than one standing in for the others:
 *
 *   `distributionFidelity`  do the two histograms agree? This is the number
 *                           beside the chart, and it is the *weakest* of the
 *                           three: a channel can leave the diagonal untouched
 *                           and destroy every coherence in the matrix.
 *   `stateFidelity`         ⟨ψ|ρ|ψ⟩ — how much of the ideal state survived.
 *                           Phase damping shows up here and nowhere else.
 *   `purity`                Tr(ρ²) — how mixed the answer is at all, whether
 *                           or not it is the state anyone wanted.
 */
function densityReading(
  circuit: Circuit,
  state: Statevector,
  spec: NoiseSpec,
  ideal: Float64Array
): NoiseReading {
  const result = runNoisyDensity(circuit, {
    profile: spec.profile,
    readout: spec.readout,
  })

  return {
    method: 'density',
    distribution: result.distribution,
    counts: null,
    shots: null,
    distributionFidelity: distributionFidelity(ideal, result.distribution),
    totalVariation: totalVariation(ideal, result.distribution),
    // Against ρ itself rather than against the reported distribution: readout
    // error is a classifier misreading a voltage after the qubit is gone
    // (`noise.ts`), so it belongs to the histogram and not to the state. A
    // state fidelity that included it would blame the state for the wiring.
    stateFidelity: densityStateFidelity(result.rho, state),
    purity: densityPurity(result.rho),
    density: blockOf(result.rho),
  }
}

/**
 * The block of ρ the heat map draws: the `DENSITY_BLOCK_LIMIT` basis states
 * with the largest populations, and every entry among them.
 *
 * SELECTED BY POPULATION, DRAWN IN BASIS-STATE ORDER — the histogram's rule
 * (§3.2), for the histogram's reason: ranking picks the states worth the space,
 * and a grid whose rows swapped places on every edit would be unreadable for
 * the one thing this picture exists to show, which is a coherence fading out of
 * an off-diagonal cell.
 *
 * The selection reads the *raw diagonal* of ρ and not the reported
 * distribution. They differ by the readout error, which is not in ρ, and a grid
 * whose rows were chosen by one quantity while its cells came from another
 * would be a picture of neither.
 */
function blockOf(rho: DensityMatrix): DensityBlock {
  const population = densityProbabilities(rho)
  const populationAt = (index: number): number => population[index] ?? 0

  const occupiedIndices: number[] = []
  let occupiedPopulation = 0
  for (let index = 0; index < population.length; index++) {
    const value = populationAt(index)
    if (value <= POPULATION_FLOOR) continue
    occupiedIndices.push(index)
    occupiedPopulation += value
  }

  const indices = [...occupiedIndices]
    // Ties go to the lower index, so a maximally mixed state — where every
    // population is identical — draws the same block on every run instead of
    // one that depends on the sort's stability.
    .sort((a, b) => populationAt(b) - populationAt(a) || a - b)
    .slice(0, DENSITY_BLOCK_LIMIT)
    .sort((a, b) => a - b)

  const kept = indices.length
  const re = new Float64Array(kept * kept)
  const im = new Float64Array(kept * kept)
  let drawnPopulation = 0
  for (let row = 0; row < kept; row++) {
    const rowIndex = indices[row] ?? 0
    const source = rowIndex * rho.dim
    drawnPopulation += populationAt(rowIndex)
    for (let column = 0; column < kept; column++) {
      const columnIndex = indices[column] ?? 0
      re[row * kept + column] = rho.re[source + columnIndex] ?? 0
      im[row * kept + column] = rho.im[source + columnIndex] ?? 0
    }
  }

  return {
    indices,
    labels: indices.map((index) => formatKet(index, rho.qubits)),
    re,
    im,
    hidden: occupiedIndices.length - kept,
    // Subtracted rather than assumed to be `1 - drawn`, for the reason
    // `buildHistogram` gives: a ρ half way through a renormalisation interval
    // does not trace to exactly one, and a notice that inherited that error
    // would report hidden population where there is none.
    hiddenPopulation: Math.max(0, occupiedPopulation - drawnPopulation),
    limit: DENSITY_BLOCK_LIMIT,
  }
}

/* ────────────────────────── the sampled method ──────────────────────── */

/**
 * The same channels, sampled one operator at a time on a statevector — §5.4's
 * escape from the 4ⁿ ceiling, and the only way a noisy eighteen-qubit circuit
 * runs at all.
 *
 * There is no ρ here and therefore no state fidelity and no purity: those are
 * questions about a matrix this method deliberately never forms. What it can
 * still answer is the one §3.3 puts beside the chart, the fidelity of the two
 * histograms — and it answers it with an error of about 1/(2√shots), which is
 * why the panel prints which method ran.
 */
function trajectoriesReading(
  circuit: Circuit,
  spec: NoiseSpec,
  ideal: Float64Array
): NoiseReading {
  /*
   * Bounded by the register as well as by §3.2's range. `clampShots` alone
   * never looked at the circuit, so a spec carrying the panel's default two
   * thousand could ask for an hour of work at a wide register; the second term
   * is the time ceiling `trajectoriesFit` has already agreed is affordable.
   * What actually ran travels back on the reading, so the panel prints the shot
   * count the fidelity was computed from rather than the one that was asked for.
   */
  const shots = Math.min(
    clampShots(spec.shots),
    maxTrajectoryShots(circuit.qubits, circuit.operations.length)
  )
  const result = runNoisy(circuit, {
    profile: spec.profile,
    readout: spec.readout,
    shots,
    rng: createRng(spec.seed),
  })
  const noisy = spread(result.counts, result.shots, circuit.qubits)

  return {
    method: 'trajectories',
    distribution: null,
    counts: result.counts,
    shots: result.shots,
    /*
     * The distribution is materialised here and never sent: at the client
     * ceiling it is 2²⁰ doubles, eight megabytes, and the panel draws thirty-two
     * bars off the counts. It exists for exactly one statement — the fidelity —
     * and `distributionFidelity` is the engine's own, so the number a browser
     * prints and the number a server would validate against come out of one
     * function (which is the point of the monorepo).
     */
    distributionFidelity: distributionFidelity(ideal, noisy),
    totalVariation: totalVariation(ideal, noisy),
    stateFidelity: null,
    purity: null,
    density: null,
  }
}

/**
 * ½ Σ |pᵢ − qᵢ| — how much of the probability moved, in one number.
 *
 * This is arithmetic on two distributions the engine produced, not a second
 * implementation of anything it does: there is no partial trace here, no
 * eigenvalue and no channel. It is here rather than in a component because
 * §3.3's headline is "how far apart are these two histograms" and the whole of
 * both histograms exists on this side of the thread boundary and nowhere else —
 * the panel receives at most a few dozen rows.
 *
 * The half is what makes it a *share*: every unit of probability that leaves
 * one outcome arrives at another, so the unhalved sum counts each move twice
 * and a total-variation of 1 would read as 200 %.
 */
function totalVariation(p: Float64Array, q: Float64Array): number {
  let sum = 0
  for (let index = 0; index < p.length; index++) {
    sum += Math.abs((p[index] ?? 0) - (q[index] ?? 0))
  }
  return sum / 2
}

/**
 * A tally as a distribution over all 2ⁿ basis states.
 *
 * The counts are keyed by ket label, so this is the inverse of `formatKet` —
 * which prints the register highest-qubit-first, i.e. as a plain binary
 * numeral, so the inverse is `parseInt(label, 2)`. That coupling is stated in
 * one place and pinned by a round-trip test rather than assumed: `formatKet` is
 * the engine's, D1 is what makes it the *reading* order it is, and a change to
 * either would otherwise turn every noisy fidelity into a plausible wrong
 * number.
 *
 * Built by walking the counts rather than the 2ⁿ indices. A tally has at most
 * one entry per outcome observed — a thousand shots cannot produce more than a
 * thousand — where building a label per basis state would be a million string
 * allocations at the twenty-qubit ceiling, to look up entries that are almost
 * all absent.
 */
function spread(
  counts: ShotCounts,
  shots: number,
  qubits: number
): Float64Array {
  const distribution = new Float64Array(1 << qubits)
  if (shots <= 0) return distribution
  for (const [label, count] of Object.entries(counts)) {
    distribution[Number.parseInt(label, 2)] = count / shots
  }
  return distribution
}
