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
import { createRng, type Rng } from './rng.js'
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  checkpointColumns,
  createCheckpoints,
  invalidateFrom,
  run,
  runFrom,
  stateAfterColumn,
  type CircuitLike,
  type OperationLike,
} from './runner.js'
import type { Statevector } from './statevector.js'

/**
 * The work plan's budget for incremental re-simulation: an incremental result
 * must match a full one to 1e-12. Two orders of magnitude tighter than D6's
 * 1e-10, because the two runs do the same arithmetic in the same order — only
 * the renormalisation points differ, and those move the last bits of the
 * mantissa, nothing more.
 */
const TOLERANCE = 1e-12

let nextId = 0

function id(): string {
  nextId++
  return `op${nextId}`
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng.next() * values.length)]
}

const FIXED_1Q = ['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'sx', 'i']
const ANGLED_1Q = ['rx', 'ry', 'rz', 'p']
const CONTROLLED_1Q = ['x', 'z', 'h', 'ry']

/**
 * One random operation over the qubits still free in this column, or
 * `undefined` when too few are left for the shape it drew.
 *
 * The pool deliberately spans every dispatch path in the runner — fixed and
 * parametrised one-qubit gates, symbolic parameters, positive and negative
 * controls, both swap families, the three-qubit gates and barriers — because
 * an edit that only ever produced Hadamards would exercise one branch of the
 * runner and none of the interesting ones.
 */
function randomOperation(
  rng: Rng,
  free: number[],
  column: number
): OperationLike | undefined {
  const angle = (): number => (rng.next() - 0.5) * 6
  const take = (): number =>
    free.splice(Math.floor(rng.next() * free.length), 1)[0]

  switch (Math.floor(rng.next() * 10)) {
    case 0:
    case 1:
      return { id: id(), gate: pick(rng, FIXED_1Q), targets: [take()], column }
    case 2:
      return {
        id: id(),
        gate: pick(rng, ANGLED_1Q),
        targets: [take()],
        column,
        params: [angle()],
      }
    case 3:
      // Symbolic, so a parameter edit has somewhere to land.
      return {
        id: id(),
        gate: 'rz',
        targets: [take()],
        column,
        params: ['theta'],
      }
    case 4:
      return {
        id: id(),
        gate: 'u',
        targets: [take()],
        column,
        params: [angle(), angle(), angle()],
      }
    case 5: {
      // A one-qubit gate the user added a control to, negative two times in
      // five — the shape `applyControlled` exists for.
      if (free.length < 2) return undefined
      const gate = pick(rng, CONTROLLED_1Q)
      const target = take()
      return {
        id: id(),
        gate,
        targets: [target],
        column,
        controls: [{ qubit: take(), state: rng.next() < 0.4 ? 0 : 1 }],
        ...(gate === 'ry' ? { params: [angle()] } : {}),
      }
    }
    case 6: {
      if (free.length < 2) return undefined
      const gate = pick(rng, ['cx', 'cz', 'crz', 'cp'])
      const target = take()
      return {
        id: id(),
        gate,
        targets: [target],
        column,
        controls: [take()],
        ...(gate === 'crz' || gate === 'cp' ? { params: [angle()] } : {}),
      }
    }
    case 7: {
      if (free.length < 2) return undefined
      return {
        id: id(),
        gate: pick(rng, ['swap', 'iswap']),
        targets: [take(), take()],
        column,
      }
    }
    case 8: {
      if (free.length < 3) return undefined
      if (rng.next() < 0.5) {
        return {
          id: id(),
          gate: 'ccx',
          targets: [take()],
          column,
          controls: [take(), take()],
        }
      }
      return {
        id: id(),
        gate: 'cswap',
        targets: [take(), take()],
        column,
        controls: [take()],
      }
    }
    default:
      return { id: id(), gate: 'barrier', targets: [take()], column }
  }
}

/** A whole column: random operations over disjoint qubits, some left idle. */
function randomColumn(
  rng: Rng,
  column: number,
  qubits: number
): OperationLike[] {
  const free: number[] = []
  for (let qubit = 0; qubit < qubits; qubit++) free.push(qubit)

  const operations: OperationLike[] = []
  while (free.length > 0) {
    if (rng.next() < 0.15) {
      // An idle wire, so columns are not uniformly packed.
      free.pop()
      continue
    }
    const operation = randomOperation(rng, free, column)
    if (operation === undefined) {
      operations.push({
        id: id(),
        gate: 'h',
        targets: [free.pop() ?? 0],
        column,
      })
      continue
    }
    operations.push(operation)
  }
  return operations
}

/** Largest difference between two states, over every real and imaginary part. */
function maxDeviation(actual: Statevector, expected: Statevector): number {
  let worst = 0
  for (let i = 0; i < expected.size; i++) {
    const dre = Math.abs(actual.re[i] - expected.re[i])
    const dim = Math.abs(actual.im[i] - expected.im[i])
    if (dre > worst) worst = dre
    if (dim > worst) worst = dim
  }
  return worst
}

function expectSameState(
  actual: Statevector,
  expected: Statevector,
  label = 'largest amplitude difference'
): void {
  expect(actual.size).toBe(expected.size)
  expect(maxDeviation(actual, expected), label).toBeLessThan(TOLERANCE)
}

/** The final state of an analytic run, without a cache. */
function fullState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') expect.unreachable('expected analytic mode')
  return result.state
}

interface RandomCircuit {
  readonly columns: OperationLike[][]
  readonly parameters: { name: string; value: number }[]
  readonly build: () => CircuitLike
}

function randomCircuit(rng: Rng, qubits: number, depth: number): RandomCircuit {
  const columns: OperationLike[][] = []
  for (let column = 0; column < depth; column++) {
    columns.push(randomColumn(rng, column, qubits))
  }
  const parameters = [{ name: 'theta', value: 0.7 }]
  return {
    columns,
    parameters,
    build: (): CircuitLike => ({
      qubits,
      parameters,
      operations: columns.flat(),
    }),
  }
}

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

describe('the incremental budget (work plan M0.4)', () => {
  it(
    'edits the last column of 40 for under 15% of a full simulation',
    { timeout: 60_000 },
    () => {
      const qubits = 14
      const depth = 40
      const last = depth - 1
      const rounds = 8
      const rng = createRng(31415)
      const source = randomCircuit(rng, qubits, depth)
      const cache = createCheckpoints()

      // The same eight edits are replayed by both sides, so the comparison is
      // between two ways of computing identical results.
      const edits = Array.from({ length: rounds }, () =>
        randomColumn(rng, last, qubits)
      )

      // Warm the JIT and fill the cache. Without this the first measurement
      // would mostly be the compiler, which is real but is not the budget.
      run(source.build(), analyticMode(), cache)
      run(source.build())

      // Each phase is timed as a batch rather than per round: `Date.now()` has
      // millisecond resolution, and a single resumed edit is below it — timing
      // one would round the incremental side down to zero and prove nothing.
      const incremental: Statevector[] = []
      const editStarted = Date.now()
      for (const edited of edits) {
        source.columns[last] = edited
        invalidateFrom(cache, last)
        incremental.push(runFrom(cache, source.build(), last).state)
      }
      const editTime = Date.now() - editStarted

      const complete: Statevector[] = []
      const fullStarted = Date.now()
      for (const edited of edits) {
        source.columns[last] = edited
        complete.push(fullState(source.build()))
      }
      const fullTime = Date.now() - fullStarted

      // Comparing the two also makes the work unremovable: with nothing
      // observing the results, nothing stops an engine from eliminating it.
      for (let round = 0; round < rounds; round++) {
        expectSameState(incremental[round], complete[round], `round ${round}`)
      }

      const budget = `${rounds} edits took ${editTime} ms, ${rounds} full runs took ${fullTime} ms`
      expect(
        fullTime,
        `the full runs must be measurable — ${budget}`
      ).toBeGreaterThan(10)
      expect(editTime, budget).toBeLessThan(fullTime * 0.15)
    }
  )
})
