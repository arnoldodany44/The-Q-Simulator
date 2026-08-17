import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BAR_LIMIT,
  buildHistogram,
  histogramLayout,
  ket,
  occupiedStates,
  rowCentreY,
  unwrapRotation,
} from './histogram'

/**
 * The model, with no renderer anywhere near it.
 *
 * Every state here is produced by running a real circuit through the engine
 * rather than by hand-assembling amplitudes. That is the point: the chart
 * has to be right about what the simulator says, and a test that built its
 * own statevector would only prove the chart is right about itself.
 *
 * D6's tolerance is 1e-10, so that is the number of digits the
 * probabilities are compared to — 1/√2 squared is not exactly 0.5 in
 * Float64.
 */

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** H then CNOT: (|00⟩ + |11⟩)/√2. Two amplitudes out of four. */
const BELL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** Ry at this angle leaves a qubit at 3/4 and 1/4 — a lopsided, exact split. */
const angle = Math.PI / 3

/** H on every wire of an `n`-qubit register: 2ⁿ equal amplitudes. */
function uniform(qubits: number): CircuitInput {
  return {
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_, qubit) => ({
      id: `h${qubit}`,
      gate: 'h',
      targets: [qubit],
      column: 0,
    })),
  }
}

describe('what carries probability', () => {
  it('draws a Bell pair as exactly two bars at one half', () => {
    const model = buildHistogram(stateOf(BELL))

    expect(model.bars).toHaveLength(2)
    expect(model.occupied).toBe(2)
    expect(model.size).toBe(4)
    expect(model.hidden).toBe(0)

    // |00⟩ and |11⟩ — and nothing between them, which is the whole content
    // of "entangled" as far as this chart is concerned.
    expect(model.bars.map((bar) => bar.label)).toEqual(['00', '11'])
    for (const bar of model.bars) {
      expect(bar.probability).toBeCloseTo(0.5, 10)
      expect(bar.phase).toBeCloseTo(0, 10)
    }
  })

  it('leaves out states that are only Float64 residue', () => {
    // An untouched register is |000⟩ and nothing else, however many indices
    // the vector has room for.
    const model = buildHistogram(
      stateOf({ schemaVersion: 1, qubits: 3, operations: [] })
    )

    expect(model.bars).toHaveLength(1)
    expect(model.bars[0]?.label).toBe('000')
    expect(model.occupied).toBe(1)
    expect(model.size).toBe(8)
  })

  it('counts occupied states without building the chart', () => {
    expect(occupiedStates(stateOf(BELL))).toBe(2)
    expect(occupiedStates(stateOf(uniform(4)))).toBe(16)
  })

  it('reads the phase of each amplitude', () => {
    // H then S: (|0⟩ + i|1⟩)/√2. The second amplitude is a quarter turn on.
    const model = buildHistogram(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 's', targets: [0], column: 1 },
        ],
      })
    )

    expect(model.bars[0]?.phase).toBeCloseTo(0, 10)
    expect(model.bars[1]?.phase).toBeCloseTo(Math.PI / 2, 10)
  })

  it('folds a negative phase into a positive turn', () => {
    // H then S†: (|0⟩ − i|1⟩)/√2. The argument is −π/2; the chart wants 3π/2,
    // because a phasor at −90° and one at 270° are the same arrow.
    const model = buildHistogram(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'sdg', targets: [0], column: 1 },
        ],
      })
    )

    expect(model.bars[1]?.phase).toBeCloseTo((3 * Math.PI) / 2, 10)
  })

  it('sees two opposite phases where two paths cancel', () => {
    // H, Z, H on one wire: the two paths through the middle arrive with
    // opposite phase and |1⟩ is emptied. Before the Z the phases are equal;
    // this is the state that says why the bar went away.
    const interfering = buildHistogram(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'z', targets: [0], column: 1 },
        ],
      })
    )

    expect(interfering.bars).toHaveLength(2)
    const [first, second] = interfering.bars
    expect(Math.abs((second?.phase ?? 0) - (first?.phase ?? 0))).toBeCloseTo(
      Math.PI,
      10
    )
  })
})

describe('the bar cap', () => {
  it('draws everything when the state fits under the limit', () => {
    const model = buildHistogram(stateOf(uniform(5)), {
      limit: DEFAULT_BAR_LIMIT,
    })

    // 2⁵ is exactly the default cap: every register a lesson uses is drawn
    // whole, which is the reason the number is 32.
    expect(model.bars).toHaveLength(32)
    expect(model.hidden).toBe(0)
    expect(model.hiddenProbability).toBe(0)
  })

  it('keeps the most probable states and reports the rest', () => {
    // Ry(π/3) on q0 leaves |0⟩ at 3/4 and |1⟩ at 1/4; H on q1 halves both.
    // So the four amplitudes are 0.375, 0.125, 0.375, 0.125 — the two big
    // ones are indices 0 and 2, which are *not* the first two.
    const model = buildHistogram(
      stateOf({
        schemaVersion: 1,
        qubits: 2,
        operations: [
          {
            id: 'a',
            gate: 'ry',
            targets: [0],
            column: 0,
            params: [Math.PI / 3],
          },
          { id: 'b', gate: 'h', targets: [1], column: 0 },
        ],
      }),
      { limit: 2 }
    )

    expect(model.bars.map((bar) => bar.index)).toEqual([0, 2])
    expect(model.occupied).toBe(4)
    expect(model.hidden).toBe(2)
    expect(model.hiddenProbability).toBeCloseTo(0.25, 10)
  })

  it('orders the bars it kept by basis state, not by probability', () => {
    const model = buildHistogram(stateOf(uniform(4)), { limit: 3 })
    const indices = model.bars.map((bar) => bar.index)

    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('breaks ties towards the lower index, every time', () => {
    // Sixteen equal amplitudes and room for three. Any tie-break would be
    // defensible; only a deterministic one keeps the chart from reshuffling
    // itself between two runs of the same circuit.
    const first = buildHistogram(stateOf(uniform(4)), { limit: 3 })
    const again = buildHistogram(stateOf(uniform(4)), { limit: 3 })

    expect(first.bars.map((bar) => bar.index)).toEqual([0, 1, 2])
    expect(again.bars.map((bar) => bar.index)).toEqual([0, 1, 2])
  })

  it('breaks a tie at the cap boundary towards the lower index too', () => {
    /*
     * The case the test above cannot see. With every amplitude equal, nothing
     * is ever evicted and any tie-break gives the same three bars — so the
     * rule was only exercised where it could not fail. This distribution has
     * three levels and puts the cap *inside* the middle one, which is where
     * the eviction actually chooses between equals.
     *
     * Ry(π/3) on q0 and on q1 gives each of them 3/4 and 1/4; H on q2 halves
     * everything. With D1's index = q0 + 2·q1 + 4·q2 that is
     *
     *   0.28125 at {0, 4}      0.09375 at {1, 2, 5, 6}     0.03125 at {3, 7}
     *
     * and a cap of 3 keeps both of the first level plus exactly one of the
     * four tied at the second. "Ties go to the lower index" names which one:
     * |001⟩, index 1. The eviction used to take the lowest index of the tied
     * group rather than leave it, and drew index 2 instead.
     */
    const model = buildHistogram(
      stateOf({
        schemaVersion: 1,
        qubits: 3,
        operations: [
          { id: 'a', gate: 'ry', targets: [0], column: 0, params: [angle] },
          { id: 'b', gate: 'ry', targets: [1], column: 0, params: [angle] },
          { id: 'c', gate: 'h', targets: [2], column: 0 },
        ],
      }),
      { limit: 3 }
    )

    expect(model.bars.map((bar) => bar.index)).toEqual([0, 1, 4])
    // Nothing about the accounting changes: the remainder is still exact.
    expect(model.occupied).toBe(8)
    expect(model.hidden).toBe(5)
    const drawn = model.bars.reduce((sum, bar) => sum + bar.probability, 0)
    expect(drawn + model.hiddenProbability).toBeCloseTo(1, 10)
  })

  it('draws states carrying nothing when asked for a fixed basis', () => {
    // The landing page's four charts are of one register, and a row that
    // vanishes turns "two outcomes are gone" into a re-layout where every row
    // moves. Counting is unaffected: two states carry probability either way.
    const model = buildHistogram(stateOf(BELL), { fullBasis: true })

    expect(model.bars.map((bar) => bar.label)).toEqual(['00', '01', '10', '11'])
    expect(model.bars[1]?.probability).toBe(0)
    expect(model.occupied).toBe(2)
    expect(model.hidden).toBe(0)
    expect(model.hiddenProbability).toBe(0)
  })

  it('still honours the cap when drawing a fixed basis', () => {
    const model = buildHistogram(stateOf(uniform(4)), {
      fullBasis: true,
      limit: 3,
    })

    expect(model.bars).toHaveLength(3)
    expect(model.occupied).toBe(16)
    expect(model.hidden).toBe(13)
  })

  it('accounts for every unit of probability it does not draw', () => {
    const model = buildHistogram(stateOf(uniform(5)), { limit: 4 })
    const drawn = model.bars.reduce((sum, bar) => sum + bar.probability, 0)

    expect(model.bars).toHaveLength(4)
    expect(model.hidden).toBe(28)
    expect(drawn + model.hiddenProbability).toBeCloseTo(1, 10)
    expect(model.hiddenProbability).toBeCloseTo(28 / 32, 10)
  })

  it('survives a cap of zero without inventing a bar', () => {
    const model = buildHistogram(stateOf(BELL), { limit: 0 })

    expect(model.bars).toHaveLength(0)
    expect(model.hidden).toBe(2)
    expect(model.hiddenProbability).toBeCloseTo(1, 10)
  })

  it('never reports negative hidden probability', () => {
    // The subtraction that produces it works on floats; a state that is a
    // hair off normal must not turn into a remainder bar of −1e-17.
    const model = buildHistogram(stateOf(uniform(3)))

    expect(model.hiddenProbability).toBeGreaterThanOrEqual(0)
  })
})

describe('notation and layout', () => {
  it('writes a ket the way formatKet prints it', () => {
    expect(ket('101')).toBe('|101⟩')
  })

  it('gives a wider register a wider label column', () => {
    const narrow = histogramLayout(2, 4)
    const wide = histogramLayout(20, 4)

    expect(wide.trackX).toBeGreaterThan(narrow.trackX)
    expect(wide.trackWidth).toBe(narrow.trackWidth)
  })

  it('only reserves the angle column when the phasors are frozen', () => {
    const turning = histogramLayout(3, 4)
    const frozen = histogramLayout(3, 4, { angles: true })

    expect(frozen.width).toBeGreaterThan(turning.width)
    expect(frozen.angleX).toBeGreaterThan(frozen.hubX)
  })

  it('stacks rows without overlapping them', () => {
    const layout = histogramLayout(3, 5)

    expect(rowCentreY(layout, 1) - rowCentreY(layout, 0)).toBe(layout.rowHeight)
    expect(rowCentreY(layout, 4) + layout.barHeight / 2).toBeLessThan(
      layout.height
    )
  })
})

/**
 * §3.7 puts three distributions on one track, which is two overlay readings.
 * The geometry has to keep them apart — see `HistogramOverlay` for why colour
 * cannot do it — and it has to leave §3.3's single-overlay chart alone.
 */
describe('lanes, when a chart carries more than one further reading', () => {
  it('leaves a chart with no overlay exactly as it was', () => {
    const plain = histogramLayout(3, 4)

    expect(plain.lanes).toBe(0)
    expect(plain.deltaX).toEqual([])
    expect(plain.barHeight).toBe(12)
    expect(plain.rowHeight).toBe(24)
  })

  it('leaves a single reading undivided, on the geometry §3.3 had', () => {
    const one = histogramLayout(3, 4, { comparisons: 1 })
    const plain = histogramLayout(3, 4)

    expect(one.barHeight).toBe(plain.barHeight)
    expect(one.rowHeight).toBe(plain.rowHeight)
    // The lane is the whole bar, so the sliver is drawn where it always was.
    expect(one.laneHeight).toBe(one.barHeight)
    expect(one.deltaX).toHaveLength(1)
  })

  it('divides the bar into a band per reading, and grows it to fit', () => {
    const two = histogramLayout(3, 4, { comparisons: 2 })

    expect(two.lanes).toBe(2)
    expect(two.laneHeight * 2).toBe(two.barHeight)
    // Grown rather than split: two six-pixel bands are thinner than the tick
    // that marks each reading, and would read as one striped bar.
    expect(two.barHeight).toBeGreaterThan(12)
    expect(two.laneHeight).toBeGreaterThanOrEqual(8)
  })

  it('keeps the rows apart once the bars are taller', () => {
    const two = histogramLayout(3, 4, { comparisons: 2 })

    expect(two.rowHeight).toBeGreaterThan(two.barHeight)
    expect(rowCentreY(two, 1) - rowCentreY(two, 0)).toBe(two.rowHeight)
    expect(rowCentreY(two, 3) + two.barHeight / 2).toBeLessThan(two.height)
  })

  it('gives each reading a difference column of its own, left to right', () => {
    const two = histogramLayout(3, 4, { comparisons: 2 })
    const [first, second] = two.deltaX

    expect(two.deltaX).toHaveLength(2)
    expect(second as number).toBeGreaterThan(first as number)
    // The chart is wide enough to hold the second column rather than clipping
    // it: an SVG whose viewBox ends before its content simply cuts the number.
    expect(two.width).toBeGreaterThan(second as number)
  })
})

describe('unwrapping the phasor rotation', () => {
  it('takes the short way round zero', () => {
    // A phase creeping past 0 moves the arrow twenty degrees, not 340.
    expect(unwrapRotation(350, 10)).toBe(370)
    expect(unwrapRotation(10, 350)).toBe(-10)
  })

  it('leaves a rotation that has not moved alone', () => {
    expect(unwrapRotation(0, 0)).toBe(0)
    expect(unwrapRotation(123.5, 123.5)).toBe(123.5)
  })

  it('is idempotent, so rendering twice cannot double the turn', () => {
    const once = unwrapRotation(350, 10)

    expect(unwrapRotation(once, 10)).toBe(once)
  })

  it('keeps accumulating through a long drag', () => {
    let rotation = 0
    for (let step = 0; step < 8; step++) {
      rotation = unwrapRotation(rotation, (step * 90 + 90) % 360)
    }

    // Two full turns in one direction, rather than eight jumps back and
    // forth across the wrap.
    expect(rotation).toBe(720)
  })
})
