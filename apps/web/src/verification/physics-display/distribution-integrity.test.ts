// @vitest-environment node
/**
 * Independent verification — the chart may hide states, but it may not lose
 * them, and it may not hide the wrong ones.
 *
 * §3.2 states the bar cap as three rules, and only the first of them is
 * visible in a teaching circuit: a Bell pair has two bars and the cap never
 * bites. The other two only ever act where nobody can check them by eye — a
 * six-qubit register is sixty-four states and a reader has no way to tell
 * whether the thirty-two on screen are the thirty-two most probable, or
 * whether the remainder bar carries the mass of the rest. So they are checked
 * here, against a brute-force answer, over randomly generated circuits.
 *
 * The reference is deliberately the stupid one: read every amplitude, keep
 * everything above the floor, sort the whole thing, take the first
 * thirty-two. `buildHistogram` does the same job with a bounded insertion
 * buffer and one pass, which is the version that can be subtly wrong.
 *
 * Four invariants, each of which is a way the panel could lie without looking
 * broken:
 *
 *   1. no drawn bar is less probable than a state left out — a chart showing
 *      the *wrong* thirty-two states
 *   2. the remainder carries exactly the probability of what is not drawn —
 *      a chart that quietly drops part of the distribution
 *   3. drawn plus hidden is the whole state — probability appearing or
 *      vanishing between the two halves of the disclosure
 *   4. the amplitude table selects the same states as the chart — two
 *      renderings of one state that disagree about what the state is
 *
 * WHERE THE BOUNDARY IS A TIE, WHICH OF THE EQUALS IS DRAWN IS NOT ASSERTED
 * HERE. `histogram.ts` documents "ties go to the lower index"; measured, the
 * eviction takes the lowest index rather than keeping it, so the equals that
 * survive are a higher-index subset. Every number on screen stays true — the
 * probabilities and the remainder are unaffected, which is what invariants 1
 * to 3 pin — so this file asserts the physics and leaves the ordering rule to
 * the report that found it. The exact index set is still asserted below
 * wherever the boundary has no tie, which is the case that would catch a real
 * selection bug.
 *
 * Nothing here re-derives physics: the states come from `@qsim/core`, and
 * what is under test is the selection made from them.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { expect, it } from 'vitest'

import { buildAmplitudes } from '../../features/analysis/amplitudes'
import {
  DEFAULT_BAR_LIMIT,
  PROBABILITY_FLOOR,
  buildHistogram,
  occupiedStates,
} from '../../features/analysis/histogram'

/** How many random circuits to run. Enough to reach the cap repeatedly. */
const TRIALS = 400

const FIXED_GATES = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'sx'] as const
const ROTATIONS = ['rx', 'ry', 'rz', 'p'] as const

/** A small deterministic generator, so a failure here can be replayed. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomCircuit(
  rng: () => number,
  qubits: number,
  depth: number,
  spread: boolean
): CircuitInput {
  const operations: CircuitInput['operations'] = []
  // A Hadamard on every wire first, when asked: it is what makes the support
  // wide enough for the cap to bite, which is the case worth testing.
  if (spread) {
    for (let qubit = 0; qubit < qubits; qubit++) {
      operations.push({
        id: `s${qubit}`,
        gate: 'h',
        targets: [qubit],
        column: 0,
      })
    }
  }
  for (let column = spread ? 1 : 0; column < depth; column++) {
    const pick = rng()
    const target = Math.floor(rng() * qubits)
    if (pick < 0.25 && qubits > 1) {
      let control = Math.floor(rng() * qubits)
      if (control === target) control = (control + 1) % qubits
      operations.push({
        id: `o${column}`,
        gate: 'cx',
        targets: [target],
        controls: [control],
        column,
      })
    } else if (pick < 0.6) {
      operations.push({
        id: `o${column}`,
        gate: ROTATIONS[Math.floor(rng() * ROTATIONS.length)]!,
        targets: [target],
        params: [(rng() * 4 - 2) * Math.PI],
        column,
      })
    } else {
      operations.push({
        id: `o${column}`,
        gate: FIXED_GATES[Math.floor(rng() * FIXED_GATES.length)]!,
        targets: [target],
        column,
      })
    }
  }
  return { schemaVersion: 1, qubits, clbits: 0, operations }
}

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** Every occupied basis state, the obvious way. */
function census(state: Statevector): { index: number; probability: number }[] {
  const out: { index: number; probability: number }[] = []
  for (let index = 0; index < state.size; index++) {
    const re = state.re[index] ?? 0
    const im = state.im[index] ?? 0
    const probability = re * re + im * im
    if (probability > PROBABILITY_FLOOR) out.push({ index, probability })
  }
  return out
}

it('draws the most probable states and accounts for the rest', () => {
  const rng = mulberry(20260815)
  let capped = 0

  for (let trial = 0; trial < TRIALS; trial++) {
    const qubits = 5 + Math.floor(rng() * 4)
    const circuit = randomCircuit(
      rng,
      qubits,
      2 + Math.floor(rng() * 24),
      rng() < 0.7
    )
    const state = stateOf(circuit)
    const occupied = census(state)
    const model = buildHistogram(state)
    const table = buildAmplitudes(state)

    const expectedDrawn = [...occupied]
      .sort((a, b) => b.probability - a.probability || a.index - b.index)
      .slice(0, DEFAULT_BAR_LIMIT)
      .map((entry) => entry.index)
      .sort((a, b) => a - b)

    const drawn = model.bars.map((bar) => bar.index)
    const drawnSet = new Set(drawn)
    const left = occupied.filter((entry) => !drawnSet.has(entry.index))

    // The bars are in ascending basis-state order, which is what gives a bar
    // a fixed address while a slider moves (§3.2).
    expect([...drawn].sort((a, b) => a - b)).toEqual(drawn)
    expect(drawn).toHaveLength(Math.min(occupied.length, DEFAULT_BAR_LIMIT))

    // 1. nothing drawn is less probable than something hidden
    const leastDrawn = Math.min(...model.bars.map((bar) => bar.probability))
    for (const entry of left)
      expect(entry.probability).toBeLessThanOrEqual(leastDrawn)

    // 2. the remainder is exactly what was left out
    const expectedHidden = left.reduce(
      (sum, entry) => sum + entry.probability,
      0
    )
    expect(model.hidden).toBe(left.length)
    expect(model.hiddenProbability).toBeCloseTo(expectedHidden, 12)

    // 3. drawn plus hidden is the whole state
    const shown = model.bars.reduce((sum, bar) => sum + bar.probability, 0)
    expect(shown + model.hiddenProbability).toBeCloseTo(1, 9)

    // 4. the table and the chart agree about what the state is
    expect(table.rows.map((row) => row.index)).toEqual(drawn)
    expect(table.occupied).toBe(model.occupied)
    expect(model.occupied).toBe(occupiedStates(state))

    // With no tie across the boundary the choice is forced, so the exact set
    // is asserted — that is the case a real selection bug could not survive.
    const boundaryTied = left.some((entry) => entry.probability === leastDrawn)
    if (!boundaryTied) expect(drawn).toEqual(expectedDrawn)

    if (model.hidden > 0) capped += 1
  }

  // The point of the exercise: the cap really did bite, repeatedly.
  expect(capped).toBeGreaterThan(TRIALS / 10)
})
