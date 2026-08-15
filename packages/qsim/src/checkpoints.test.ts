/**
 * The incremental cache of §5.6.3 — the reason the live editor feels instant
 * and the foundation the timeline scrubber of M0.8 is built on.
 *
 * A cache is a correctness hazard before it is a speed-up: everything it can
 * do wrong (resume from a state an edit already contradicted, hand out an
 * aliased buffer a later run mutates, drop the wrong entries when it fills up)
 * produces a plausible, normalised, silently wrong state. So the central test
 * here is the one the work plan asks for — 200 random edits at random columns,
 * each re-simulated incrementally and compared against a full run — and it is
 * backed by a test that pins what happens when invalidation is *skipped*,
 * without which none of the others would prove the cache is being read at all.
 */

import { describe, expect, it } from 'vitest'

import { analyticMode } from './measure.js'
import { createRng } from './rng.js'
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  checkpointColumns,
  createCheckpoints,
  invalidateFrom,
  run,
  runFrom,
  stateAfterColumn,
  type CircuitLike,
} from './runner.js'

import {
  TOLERANCE,
  expectSameState,
  fullState,
  maxDeviation,
  randomCircuit,
  randomColumn,
} from './testing/random-circuits.js'

describe('where the checkpoints land', () => {
  const linear = (depth: number): CircuitLike => ({
    qubits: 3,
    operations: Array.from({ length: depth }, (_, column) => ({
      id: `linear${column}`,
      gate: 'h',
      targets: [column % 3],
      column,
    })),
  })

  it('takes one every interval columns, plus one before the last', () => {
    const cache = createCheckpoints({ interval: 4 })
    run(linear(12), analyticMode(), cache)
    // Columns 3, 7 and 11 are the interval marks; 10 is the end anchor that
    // makes editing the last column cost one column instead of four.
    expect(checkpointColumns(cache)).toEqual([3, 7, 10, 11])
  })

  it('defaults to an interval of 8', () => {
    const cache = createCheckpoints()
    run(linear(2 * DEFAULT_CHECKPOINT_INTERVAL), analyticMode(), cache)
    expect(checkpointColumns(cache)).toContain(DEFAULT_CHECKPOINT_INTERVAL - 1)
  })

  it('drops everything from the edited column onwards', () => {
    const cache = createCheckpoints({ interval: 2 })
    run(linear(10), analyticMode(), cache)
    expect(checkpointColumns(cache)).toEqual([1, 3, 5, 7, 8, 9])

    invalidateFrom(cache, 6)
    expect(checkpointColumns(cache)).toEqual([1, 3, 5])
    invalidateFrom(cache, 0)
    expect(checkpointColumns(cache)).toEqual([])
  })

  it('stays inside its memory ceiling, and still resumes correctly', () => {
    const cache = createCheckpoints({ interval: 1, limit: 5 })
    const circuit = linear(20)
    run(circuit, analyticMode(), cache)

    const columns = checkpointColumns(cache)
    expect(columns.length).toBeLessThanOrEqual(5)
    // The newest entry survives thinning: it is the one an edit at the end of
    // the circuit resumes from.
    expect(columns[columns.length - 1]).toBe(19)

    invalidateFrom(cache, 12)
    expectSameState(runFrom(cache, circuit, 12).state, fullState(circuit))
  })

  it('forgets everything when the register changes size', () => {
    const cache = createCheckpoints({ interval: 2 })
    run(linear(10), analyticMode(), cache)

    const wider: CircuitLike = {
      qubits: 5,
      operations: [
        { id: 'w0', gate: 'h', targets: [4], column: 0 },
        { id: 'w1', gate: 'cx', targets: [3], controls: [4], column: 1 },
      ],
    }
    // Reusing a 3-qubit checkpoint for a 5-qubit run would read a state of the
    // wrong size and produce a state of the wrong physics; the cache empties.
    expectSameState(runFrom(cache, wider, 1).state, fullState(wider))
  })

  it('forgets the previous circuit on a full run of the same register', () => {
    // The dangerous half of the same hazard, and the quiet one: a shorter
    // circuit on the *same* register records fewer checkpoints, so without a
    // reset the entries past its end survive from the circuit before it — the
    // ordinary editor move of deleting a tail. The stale state is normalised
    // and the wrong physics, so only a comparison catches it.
    const cache = createCheckpoints({ interval: 4 })
    run(linear(12), analyticMode(), cache)
    expect(checkpointColumns(cache)).toEqual([3, 7, 10, 11])

    const short = linear(6)
    run(short, analyticMode(), cache)
    for (const column of checkpointColumns(cache)) {
      expect(
        column,
        'a checkpoint past the end of the circuit just run'
      ).toBeLessThan(6)
    }
    // The scrubber asks past the end of `short`, which is its final state — not
    // whatever the longer circuit happened to be holding at that column.
    expectSameState(stateAfterColumn(cache, short, 8), fullState(short))
  })

  it('leaves the cache alone when the run is refused', () => {
    const cache = createCheckpoints({ interval: 4 })
    run(linear(12), analyticMode(), cache)
    const before = checkpointColumns(cache)

    const measuring: CircuitLike = {
      qubits: 3,
      clbits: 1,
      operations: [
        {
          id: 'm',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
      ],
    }
    expect(() => run(measuring, analyticMode(), cache)).toThrow()
    expect(checkpointColumns(cache)).toEqual(before)
  })

  it('honours a ceiling of one checkpoint, not two', () => {
    // Halving alone has a floor of two entries — index 0 always survives the
    // stride and the last index is always the end anchor — so a limit of 1 used
    // to hold double the copies it was given: 16 MB over budget at 20 qubits.
    const cache = createCheckpoints({ interval: 1, limit: 1 })
    const circuit = linear(9)
    run(circuit, analyticMode(), cache)

    const columns = checkpointColumns(cache)
    expect(columns).toHaveLength(1)
    // The survivor is the end anchor: the entry the commonest edit resumes from.
    expect(columns[0]).toBe(8)
    expectSameState(runFrom(cache, circuit, 9).state, fullState(circuit))
  })
})

describe('resuming', () => {
  const rng = createRng(918273)
  const source = randomCircuit(rng, 5, 24)
  const circuit = source.build()

  it('reaches the same state as a full run, from any column', () => {
    const cache = createCheckpoints()
    run(circuit, analyticMode(), cache)
    expect(checkpointColumns(cache).length).toBeGreaterThan(0)

    const expected = fullState(circuit)
    for (let column = 0; column <= 24; column++) {
      invalidateFrom(cache, column)
      expectSameState(
        runFrom(cache, circuit, column).state,
        expected,
        `resumed at column ${column}`
      )
    }
  })

  it('runs from scratch when the cache holds nothing', () => {
    const empty = createCheckpoints()
    expectSameState(runFrom(empty, circuit, 20).state, fullState(circuit))
  })

  it('never hands out a state that aliases a cached one', () => {
    const cache = createCheckpoints({ interval: 2 })
    run(circuit, analyticMode(), cache)
    const first = runFrom(cache, circuit, 10).state
    // Corrupting a returned state must not poison the cache behind it.
    first.re.fill(0)
    first.im.fill(0)
    expectSameState(runFrom(cache, circuit, 10).state, fullState(circuit))
  })

  it('is wrong without invalidation — which is what invalidation is for', () => {
    const cache = createCheckpoints()
    run(circuit, analyticMode(), cache)

    // Edit column 12. The checkpoint at column 15 was computed from the old
    // circuit, so a later edit that resumes from it inherits the old physics.
    const columns = source.columns.map((operations, column) =>
      column === 12
        ? [{ id: 'edit', gate: 'h', targets: [0], column: 12 }]
        : operations
    )
    const next: CircuitLike = {
      qubits: 5,
      parameters: source.parameters,
      operations: columns.flat(),
    }

    const stale = runFrom(cache, next, 20).state
    expect(maxDeviation(stale, fullState(next))).toBeGreaterThan(TOLERANCE)

    invalidateFrom(cache, 12)
    expectSameState(runFrom(cache, next, 20).state, fullState(next))
  })
})

describe('200 random edits (work plan M0.4)', () => {
  it('re-simulates incrementally to within 1e-12 of a full run', () => {
    const qubits = 5
    const depth = 24
    const rng = createRng(20250814)
    const source = randomCircuit(rng, qubits, depth)
    const cache = createCheckpoints()
    run(source.build(), analyticMode(), cache)

    for (let edit = 0; edit < 200; edit++) {
      const column = Math.floor(rng.next() * depth)
      source.columns[column] = randomColumn(rng, column, qubits)

      // Every seventh edit is a parameter change instead of a gate change.
      // A parameter is read all over the circuit, so it invalidates from the
      // first column that uses it — here, conservatively, from the start.
      let from = column
      if (edit % 7 === 6) {
        source.parameters[0].value = (rng.next() - 0.5) * 6
        from = 0
      }

      const circuit = source.build()
      invalidateFrom(cache, from)
      const incremental = runFrom(cache, circuit, from)
      expectSameState(
        incremental.state,
        fullState(circuit),
        `edit ${edit} at column ${from}`
      )
    }

    expect(checkpointColumns(cache).length).toBeGreaterThan(0)
  })
})

describe('the scrubber primitive (M0.8)', () => {
  it('gives the state after every column, matching a truncated run', () => {
    const rng = createRng(5150)
    const source = randomCircuit(rng, 4, 16)
    const circuit = source.build()
    const cache = createCheckpoints({ interval: 3 })

    for (let column = 0; column < 16; column++) {
      const truncated: CircuitLike = {
        ...circuit,
        operations: circuit.operations.filter((op) => op.column <= column),
      }
      expectSameState(
        stateAfterColumn(cache, circuit, column),
        fullState(truncated),
        `after column ${column}`
      )
    }

    // Scrubbing forwards warms the cache instead of just reading it, which is
    // what keeps a step cheap once the timeline has been walked once.
    expect(checkpointColumns(cache).length).toBeGreaterThan(0)
    expectSameState(stateAfterColumn(cache, circuit, 15), fullState(circuit))
  })
})
