/**
 * The scrubber's one claim, checked against arithmetic that shares none of its
 * machinery: the state shown at a cut is the state a circuit truncated at that
 * cut would end in.
 *
 * WHY THIS IS NOT THE ENGINE'S OWN TEST. `stateAfterColumn` resumes from the
 * checkpoint cache and writes new checkpoints as it walks, so every answer it
 * gives depends on what earlier answers left behind. A test that computed the
 * expected value the same way would agree with a cache that had gone wrong. So
 * the expectation here is produced by the slowest correct method available:
 * take the operations in columns `0..k`, hand them to `run()` as a whole
 * circuit with no cache at all, and compare amplitudes at D6's 1e-10.
 *
 * The requests go through `runJob` rather than through the engine directly,
 * because that is the function the worker calls and it is where `throughColumn`
 * meets `invalidateFrom` — the seam an editor bug would live in.
 *
 * The circuits are chosen for what they do to a *partial* run: a barrier
 * occupies a column without touching the state, a gap is a column that does not
 * exist, a deterministic reset collapses without needing randomness, the
 * multi-qubit gates each reach the kernel by a different path, and the long one
 * is long enough that the cache thins itself (interval 8, limit 8) while the
 * bar walks it.
 */

import {
  analyticMode,
  createCheckpoints,
  run,
  type CheckpointCache,
  type Statevector,
} from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, MAX_COLUMNS, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { runJob } from '../../features/simulation/job'
import type { SimulateRequest } from '../../features/simulation/protocol'

/** D6's tolerance: a resumed run renormalises at different points. */
const TOLERANCE = 1e-10

let nextId = 1

function truncate(circuit: Circuit, through: number): Circuit {
  return {
    ...circuit,
    operations: circuit.operations.filter((op) => op.column <= through),
  }
}

/** The slow, obviously correct answer: a whole circuit, run from |0…0⟩. */
function expected(circuit: Circuit, through: number): Statevector {
  const result = run(truncate(circuit, through), analyticMode())
  if (result.mode !== 'analytic') throw new Error('analytic mode asked for')
  return result.state
}

/** What the worker would answer, cache and all. */
function ask(
  cache: CheckpointCache,
  circuit: Circuit,
  throughColumn: number | null,
  fromColumn: number
): { re: Float64Array; im: Float64Array } {
  const request: SimulateRequest = {
    kind: 'simulate',
    id: nextId++,
    circuit,
    fromColumn,
    sharedMemory: false,
    mode: 'analytic',
    throughColumn,
    sample: null,
    noise: null,
  }
  const { response } = runJob(cache, request, false)
  if (response.kind !== 'result' || response.mode !== 'analytic') {
    throw new Error(`expected an analytic result, got ${response.kind}`)
  }
  return { re: response.state.re, im: response.state.im }
}

function compare(
  label: string,
  got: { re: Float64Array; im: Float64Array },
  want: Statevector
): void {
  expect(got.re.length, `${label}: size`).toBe(want.size)
  for (let index = 0; index < want.size; index++) {
    // Read through `?? 0` rather than asserted: an index past the end is a
    // failure this function should report, not one it should throw on.
    const gotRe = got.re[index] ?? 0
    const gotIm = got.im[index] ?? 0
    const wantRe = want.re[index] ?? 0
    const wantIm = want.im[index] ?? 0
    if (
      Math.abs(gotRe - wantRe) > TOLERANCE ||
      Math.abs(gotIm - wantIm) > TOLERANCE
    ) {
      throw new Error(
        `${label}: amplitude ${index} is ${gotRe}+${gotIm}i, ` +
          `expected ${wantRe}+${wantIm}i`
      )
    }
  }
}

/** A gate per column, cycled, so a long circuit is not a long copy-paste. */
const CYCLE = ['h', 't', 's', 'x', 'y', 'z', 'sx'] as const

function cycled(index: number): string {
  return CYCLE[index % CYCLE.length] ?? 'h'
}

function columnCount(circuit: Circuit): number {
  let last = -1
  for (const op of circuit.operations) if (op.column > last) last = op.column
  return last + 1
}

/* ───────────────────────────── the circuits ─────────────────────────── */

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** Barriers, a gap, and resets that are deterministic where they stand. */
const structural: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 0,
  operations: [
    { id: 'a', gate: 'x', targets: [0], column: 0 },
    { id: 'b', gate: 'barrier', targets: [0, 1, 2], column: 1 },
    { id: 'c', gate: 'reset', targets: [0], column: 2 },
    { id: 'd', gate: 'h', targets: [1], column: 3 },
    // column 4 is empty on purpose: a gap is an instant with nothing in it
    { id: 'e', gate: 'cx', targets: [2], controls: [1], column: 5 },
    { id: 'f', gate: 'barrier', targets: [0, 1, 2], column: 6 },
    { id: 'g', gate: 'x', targets: [0], column: 7 },
    { id: 'h', gate: 'reset', targets: [0], column: 8 },
    { id: 'i', gate: 't', targets: [1], column: 9 },
  ],
}

/** Every multi-qubit shape the kernel knows, plus a negative control. */
const multi: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 4,
  clbits: 0,
  parameters: [{ name: 'theta', value: 0.7 }],
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'h', targets: [1], column: 0 },
    { id: 'c', gate: 'rx', targets: [2], params: ['theta'], column: 1 },
    { id: 'd', gate: 'swap', targets: [0, 3], column: 2 },
    { id: 'e', gate: 'iswap', targets: [1, 2], column: 3 },
    { id: 'f', gate: 'ccx', targets: [3], controls: [0, 1], column: 4 },
    { id: 'g', gate: 'cswap', targets: [1, 2], controls: [3], column: 5 },
    {
      id: 'h',
      gate: 'crz',
      targets: [2],
      controls: [0],
      params: [1.1],
      column: 6,
    },
    {
      id: 'i',
      gate: 'cp',
      targets: [3],
      controls: [2],
      params: [0.4],
      column: 7,
    },
    {
      id: 'j',
      gate: 'x',
      targets: [0],
      controls: [{ qubit: 1, state: 0 }],
      column: 8,
    },
    { id: 'k', gate: 'cz', targets: [3], controls: [1], column: 9 },
    { id: 'l', gate: 'u', targets: [2], params: [0.3, 0.4, 0.5], column: 10 },
  ],
}

/** Long enough that the cache thins itself while the bar walks it. */
const long: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 0,
  operations: Array.from({ length: 90 }, (_, index) => ({
    id: `op${index}`,
    gate: cycled(index),
    targets: [index % 3],
    column: index,
  })),
}

const circuits: ReadonlyArray<readonly [string, Circuit]> = [
  ['bell', bell],
  ['structural', structural],
  ['multi', multi],
  ['long', long],
]

/**
 * What the scheduler sends when nothing about the circuit changed: a column no
 * circuit can reach, meaning "invalidate nothing".
 */
const NOTHING_INVALIDATED = MAX_COLUMNS

/* ───────────────────────────── the checks ───────────────────────────── */

describe('every cut is the circuit truncated at it', () => {
  for (const [name, circuit] of circuits) {
    const columns = columnCount(circuit)

    it(`${name}: walking forward from a cold cache`, () => {
      const cache = createCheckpoints()
      for (let cut = -1; cut < columns; cut++) {
        compare(
          `${name} at ${cut}`,
          ask(cache, circuit, cut, NOTHING_INVALIDATED),
          expected(circuit, cut)
        )
      }
    })

    it(`${name}: the end is the whole circuit, and so is the last cut`, () => {
      const cache = createCheckpoints()
      const whole = expected(circuit, columns - 1)
      // `null` is how the app spells the end (M0.8): nothing held back.
      compare(`${name} end`, ask(cache, circuit, null, 0), whole)
      // And the same vector reached the other way, through the scrubber's
      // own primitive with a cache the run above just warmed.
      compare(
        `${name} last cut`,
        ask(cache, circuit, columns - 1, NOTHING_INVALIDATED),
        whole
      )
    })

    it(`${name}: walking backward through a warm cache`, () => {
      const cache = createCheckpoints()
      ask(cache, circuit, null, 0)
      for (let cut = columns - 1; cut >= -1; cut--) {
        compare(
          `${name} at ${cut}`,
          ask(cache, circuit, cut, NOTHING_INVALIDATED),
          expected(circuit, cut)
        )
      }
    })

    it(`${name}: jumping about`, () => {
      const cache = createCheckpoints()
      // Deterministic pseudo-random order: a dragged bar does not step.
      let seed = 12_345
      const next = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
        return seed / 2_147_483_648
      }
      ask(cache, circuit, null, 0)
      for (let step = 0; step < 60; step++) {
        const cut = Math.floor(next() * (columns + 1)) - 1
        compare(
          `${name} at ${cut}`,
          ask(cache, circuit, cut, NOTHING_INVALIDATED),
          expected(circuit, cut)
        )
      }
    })
  }
})

describe('editing while the bar is parked', () => {
  it('shows the edit at the parked column, not the state before it', () => {
    const cache = createCheckpoints()
    ask(cache, multi, null, 0)
    ask(cache, multi, 5, NOTHING_INVALIDATED)

    const edited: Circuit = {
      ...multi,
      operations: multi.operations.map((op) =>
        op.id === 'g' ? { ...op, gate: 'swap', controls: undefined } : op
      ),
    }
    compare(
      'edited under the bar',
      ask(cache, edited, 5, 5),
      expected(edited, 5)
    )
  })

  it('does not resume past an edit that lands before the parked column', () => {
    const cache = createCheckpoints()
    ask(cache, long, null, 0)
    ask(cache, long, 60, NOTHING_INVALIDATED)

    const edited: Circuit = {
      ...long,
      operations: long.operations.map((op) =>
        op.column === 3 ? { ...op, gate: 'y' } : op
      ),
    }
    compare(
      'edit at 3, read at 60',
      ask(cache, edited, 60, 3),
      expected(edited, 60)
    )
  })

  it('follows a parameter drag under a parked bar', () => {
    const cache = createCheckpoints()
    ask(cache, multi, 8, 0)
    for (const value of [0.7, 0.9, 1.4, 2.2]) {
      const edited: Circuit = {
        ...multi,
        parameters: [{ name: 'theta', value }],
      }
      compare(`theta ${value}`, ask(cache, edited, 8, 1), expected(edited, 8))
    }
  })

  it('answers honestly when the circuit shrinks past the parked cut', () => {
    const cache = createCheckpoints()
    ask(cache, long, null, 0)
    ask(cache, long, 70, NOTHING_INVALIDATED)
    const shorter: Circuit = {
      ...long,
      operations: long.operations.filter((op) => op.column < 20),
    }
    // The bar clamps before it ever asks this, but the engine must not invent
    // an answer either: a cut past the end is the end.
    compare('shortened', ask(cache, shorter, 70, 20), expected(shorter, 70))
  })
})
