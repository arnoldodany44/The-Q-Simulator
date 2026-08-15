/**
 * Adversarial verification — the store under arguments no caller should send.
 *
 * Independent of `useCircuitStore.test.ts` and of the walk in
 * `../store-integrity/`: those drive the store with values a competent caller
 * produces (integers, ids that exist, step counts of 1). This file drives it
 * with the values a *broken* caller produces — NaN, ±Infinity, fractions,
 * negatives, indices past every register — and it does so while a gesture is
 * open, because `beginTransaction` is the one place the store deliberately
 * suspends its own history recording.
 *
 * The invariants are derived from the specification and from the store's own
 * header, never from its implementation:
 *
 *  - §6 / rule 1: the circuit is always one `validateCircuit` accepts. The
 *    contract is the only judge, so this file re-parses rather than trusting
 *    any editor-side check.
 *  - rule 2: a refused edit changes nothing — same circuit reference, same
 *    selection reference, same history depth on both stacks.
 *  - the history may only ever hand back circuits that are themselves valid,
 *    so every snapshot on both stacks is checked, not just the live one. A
 *    corrupt snapshot is invisible until someone presses undo.
 *  - the store must survive: `getState()` keeps returning a usable
 *    `CircuitState` with its actions attached. zundo reaches `set()` without
 *    passing through `commit()`, which is the one hole the rules above cannot
 *    cover by themselves.
 */

import {
  GATE_IDS,
  emptyCircuit,
  safeParseCircuit,
  validateCircuit,
  type Circuit,
  type Control,
  type ParamValue,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  createCircuitStore,
  type CircuitStore,
  type EditResult,
} from '../../features/circuit-editor/useCircuitStore'

/** Mulberry32 — deterministic, so a failure names a seed that reproduces it. */
function rngOf(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = ReturnType<typeof rngOf>

const pickOne = <T>(rng: Rng, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)] as T

const intIn = (rng: Rng, low: number, high: number): number =>
  low + Math.floor(rng() * (high - low + 1))

/**
 * Numbers a caller can produce by accident. `Number('')` is 0, a failed
 * `parseFloat` is NaN, a division by zero is Infinity, and a slider bound to
 * a mis-scaled range yields fractions — none of them are hypothetical.
 */
const HOSTILE = [
  NaN,
  Infinity,
  -Infinity,
  -1,
  -0,
  0.5,
  -7.25,
  1e9,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
]

/** Mirrors the store's own ceiling; a breach means the limit stopped working. */
const HISTORY_LIMIT = 100

function historyOf(store: CircuitStore) {
  return store.temporal.getState()
}

interface Depths {
  readonly circuit: Circuit
  readonly selection: readonly string[]
  readonly past: number
  readonly future: number
}

function depthsOf(store: CircuitStore): Depths {
  const state = store.getState()
  const history = historyOf(store)
  return {
    circuit: state.circuit,
    selection: state.selection,
    past: history.pastStates.length,
    future: history.futureStates.length,
  }
}

/** Everything that must hold after every single call, whatever it returned. */
function expectSound(store: CircuitStore, where: string): void {
  const state: unknown = store.getState()
  expect(typeof state, `${where}: the store still holds an object`).toBe(
    'object'
  )
  expect(state, `${where}: the store still holds a state`).not.toBeNull()

  const usable = store.getState()
  expect(typeof usable.placeGate, `${where}: actions survived`).toBe('function')

  expect(
    validateCircuit(usable.circuit),
    `${where}: semantic validity`
  ).toEqual([])
  expect(safeParseCircuit(usable.circuit).ok, `${where}: shape validity`).toBe(
    true
  )

  const ids = usable.circuit.operations.map((operation) => operation.id)
  expect(new Set(ids).size, `${where}: ids are unique`).toBe(ids.length)

  const live = new Set(ids)
  expect(
    usable.selection.filter((id) => !live.has(id)),
    `${where}: selection names only live operations`
  ).toEqual([])
  expect(
    new Set(usable.selection).size,
    `${where}: selection has no duplicates`
  ).toBe(usable.selection.length)

  // A snapshot nobody can restore is a bug that only surfaces on the undo
  // press that reaches it, possibly minutes later.
  const history = historyOf(store)
  for (const [stack, name] of [
    [history.pastStates, 'past'],
    [history.futureStates, 'future'],
  ] as const) {
    stack.forEach((entry, index) => {
      const circuit = entry.circuit
      expect(
        circuit,
        `${where}: ${name}[${index}] holds a circuit`
      ).toBeDefined()
      expect(
        circuit === undefined ? [] : validateCircuit(circuit),
        `${where}: ${name}[${index}] is restorable`
      ).toEqual([])
    })
  }
  expect(
    history.pastStates.length,
    `${where}: history stays under its ceiling`
  ).toBeLessThanOrEqual(HISTORY_LIMIT)
}

/* ------------------------------------------------------------------ *
 * The one defect this file was written for
 * ------------------------------------------------------------------ */

const UNUSABLE_STEPS: readonly (readonly [string, number])[] = [
  ['0', 0],
  ['-0', -0],
  ['0.5', 0.5],
  ['0.999', 0.999],
  ['-1', -1],
  ['-2', -2],
  ['NaN', NaN],
  ['-Infinity', -Infinity],
]

function seeded(): CircuitStore {
  const store = createCircuitStore(emptyCircuit(3, 3))
  store.getState().placeGate('h', [0], 0)
  store.getState().placeGate('x', [1], 1)
  return store
}

describe('undo and redo under a step count that consumes nothing', () => {
  it.each(UNUSABLE_STEPS)('undo(%s) is a true no-op', (_name, steps) => {
    const store = seeded()
    const before = depthsOf(store)

    const result = store.getState().undo(steps)

    expect(result.ok).toBe(false)
    expect(depthsOf(store)).toEqual(before)
    expectSound(store, `undo(${String(steps)})`)
  })

  it.each(UNUSABLE_STEPS)('redo(%s) is a true no-op', (_name, steps) => {
    const store = seeded()
    store.getState().undo()
    const before = depthsOf(store)
    expect(before.future).toBeGreaterThan(0)

    const result = store.getState().redo(steps)

    expect(result.ok).toBe(false)
    expect(depthsOf(store)).toEqual(before)
    expectSound(store, `redo(${String(steps)})`)
  })

  it('still rewinds and replays exactly what a good count asks for', () => {
    const store = createCircuitStore(emptyCircuit(3, 3))
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 1)
    store.getState().placeGate('y', [2], 2)

    store.getState().undo(2)
    expect(store.getState().circuit.operations).toHaveLength(1)
    store.getState().redo(2)
    expect(store.getState().circuit.operations).toHaveLength(3)

    // More steps than exist rewinds to the oldest snapshot rather than past it.
    store.getState().undo(Infinity)
    expect(store.getState().circuit.operations).toHaveLength(0)
    store.getState().redo(999)
    expect(store.getState().circuit.operations).toHaveLength(3)

    // A fraction truncates toward zero, so this is undo(1).
    store.getState().undo(1.5)
    expect(store.getState().circuit.operations).toHaveLength(2)
    expectSound(store, 'good step counts')
  })

  it('is still a working document after every nonsense count', () => {
    const store = seeded()
    for (const [, steps] of UNUSABLE_STEPS) {
      store.getState().undo(steps)
      store.getState().redo(steps)
    }
    expect(store.getState().loadCircuit(emptyCircuit(2, 2)).ok).toBe(true)
    store.getState().reset()
    expect(store.getState().circuit.qubits).toBe(3)
    expect(store.getState().placeGate('h', [0], 0).ok).toBe(true)
    expectSound(store, 'recovery')
  })
})

/* ------------------------------------------------------------------ *
 * Gestures — the other path that reaches set() outside commit()
 * ------------------------------------------------------------------ */

describe('a gesture never leaves history recording nothing', () => {
  it('costs no history at all when it ends where it began', () => {
    const store = createCircuitStore(emptyCircuit(3, 3))
    store.getState().placeGate('rz', [0], 0)
    const id = store.getState().circuit.operations[0]?.id ?? ''
    const before = depthsOf(store)

    store.getState().beginTransaction()
    store.getState().setParam(id, 0, 1)
    store.getState().setParam(id, 0, 2)
    store.getState().setParam(id, 0, 0)
    store.getState().endTransaction()

    expect(depthsOf(store)).toEqual(before)
    expect(historyOf(store).isTracking).toBe(true)
  })

  it('costs exactly one step however many values it passed through', () => {
    const store = createCircuitStore(emptyCircuit(3, 3))
    store.getState().placeGate('rz', [0], 0)
    const id = store.getState().circuit.operations[0]?.id ?? ''
    const before = depthsOf(store)

    store.getState().beginTransaction()
    for (let step = 1; step <= 20; step++) {
      store.getState().setParam(id, 0, step / 10)
    }
    store.getState().endTransaction()

    expect(depthsOf(store).past).toBe(before.past + 1)
    store.getState().undo()
    expect(store.getState().circuit.operations[0]?.params).toEqual([0])
  })

  it.each(['load', 'reset', 'clearHistory'] as const)(
    'resumes recording when %s interrupts it',
    (interrupt) => {
      const store = createCircuitStore(emptyCircuit(3, 3))
      store.getState().placeGate('rz', [0], 0)
      const id = store.getState().circuit.operations[0]?.id ?? ''

      store.getState().beginTransaction()
      store.getState().setParam(id, 0, 1)
      if (interrupt === 'load') {
        store.getState().loadCircuit(emptyCircuit(2, 2))
      } else if (interrupt === 'reset') {
        store.getState().reset()
      } else {
        store.getState().clearHistory()
      }
      store.getState().endTransaction()

      // The next edit must be undoable. A gesture abandoned with tracking
      // still paused would silently cost the user every step from here on.
      const before = depthsOf(store)
      expect(store.getState().placeGate('x', [0], 5).ok).toBe(true)
      expect(depthsOf(store).past).toBe(before.past + 1)
      expect(historyOf(store).isTracking).toBe(true)
      expectSound(store, `interrupted by ${interrupt}`)
    }
  )

  it('ignores an unopened end and a nested begin', () => {
    const store = createCircuitStore(emptyCircuit(3, 3))
    store.getState().endTransaction()
    store.getState().placeGate('rz', [0], 0)
    const id = store.getState().circuit.operations[0]?.id ?? ''
    const before = depthsOf(store)

    store.getState().beginTransaction()
    store.getState().beginTransaction()
    store.getState().setParam(id, 0, 1)
    store.getState().setParam(id, 0, 2)
    store.getState().endTransaction()
    store.getState().endTransaction()

    expect(depthsOf(store).past).toBe(before.past + 1)
    expect(historyOf(store).isTracking).toBe(true)
    expectSound(store, 'mismatched transaction boundaries')
  })
})

/* ------------------------------------------------------------------ *
 * The randomised sweep
 * ------------------------------------------------------------------ */

function someNumber(rng: Rng, circuit: Circuit): number {
  const roll = rng()
  if (roll < 0.6) return intIn(rng, 0, Math.max(0, circuit.qubits - 1))
  if (roll < 0.8) return intIn(rng, -2, circuit.qubits + 2)
  return pickOne(rng, HOSTILE)
}

function someColumn(rng: Rng): number {
  const roll = rng()
  if (roll < 0.7) return intIn(rng, 0, 6)
  if (roll < 0.85) return intIn(rng, -2, 4200)
  return pickOne(rng, HOSTILE)
}

function someSteps(rng: Rng): number | undefined {
  const roll = rng()
  if (roll < 0.5) return undefined
  if (roll < 0.75) return intIn(rng, 1, 4)
  return pickOne(rng, HOSTILE)
}

const ACTIONS = [
  'place',
  'placeFree',
  'placeMeasure',
  'placeBarrier',
  'move',
  'remove',
  'removeMany',
  'addControl',
  'removeControl',
  'setParam',
  'addQubit',
  'removeQubit',
  'reorderQubits',
  'setQubitLabel',
  'addClbit',
  'removeClbit',
  'copy',
  'paste',
  'compactColumns',
  'setSelection',
  'toggleSelection',
  'clearSelection',
  'undo',
  'redo',
  'beginTransaction',
  'endTransaction',
  'clearHistory',
  'loadCircuit',
] as const

function anyId(rng: Rng, circuit: Circuit): string {
  return circuit.operations.length === 0
    ? 'op_ghost'
    : pickOne(rng, circuit.operations).id
}

/** Runs one random action and answers what it returned, if anything. */
function runStep(rng: Rng, store: CircuitStore): EditResult | undefined {
  const state = store.getState()
  const circuit = state.circuit

  switch (pickOne(rng, ACTIONS)) {
    case 'place': {
      const targets = [someNumber(rng, circuit)]
      if (rng() < 0.4) targets.push(someNumber(rng, circuit))
      const controls: Control[] = []
      if (rng() < 0.4) {
        const qubit = someNumber(rng, circuit)
        controls.push(rng() < 0.5 ? qubit : { qubit, state: 0 })
      }
      return state.placeGate(pickOne(rng, GATE_IDS), targets, someColumn(rng), {
        controls,
      })
    }
    case 'placeFree': {
      // A placement a competent editor would make, so the document actually
      // grows instead of bouncing off the validator for two hundred steps.
      const gate = pickOne(rng, ['h', 'x', 'z', 'rz'] as const)
      return state.placeGate(
        gate,
        [intIn(rng, 0, circuit.qubits - 1)],
        intIn(rng, 0, 8)
      )
    }
    case 'placeMeasure': {
      const qubit = intIn(rng, 0, circuit.qubits - 1)
      const condition =
        rng() < 0.4
          ? {
              clbit: someNumber(rng, circuit),
              equals: rng() < 0.5 ? (0 as const) : (1 as const),
            }
          : undefined
      return state.placeGate('measure', [qubit], intIn(rng, 0, 8), {
        clbitTargets: [rng() < 0.8 ? qubit : someNumber(rng, circuit)],
        ...(condition === undefined ? {} : { condition }),
      })
    }
    case 'placeBarrier': {
      const targets: number[] = []
      for (let index = 0; index < intIn(rng, 1, 3); index++) {
        targets.push(someNumber(rng, circuit))
      }
      return state.placeGate('barrier', targets, someColumn(rng))
    }
    case 'move': {
      const clbitTargets = rng() < 0.5 ? [someNumber(rng, circuit)] : []
      return state.moveOperation(
        anyId(rng, circuit),
        [someNumber(rng, circuit)],
        someColumn(rng),
        rng() < 0.5 ? {} : { clbitTargets }
      )
    }
    case 'remove':
      return state.removeOperation(anyId(rng, circuit))
    case 'removeMany':
      return state.removeOperations(
        circuit.operations
          .filter(() => rng() < 0.4)
          .map((operation) => operation.id)
      )
    case 'addControl':
      return state.addControl(
        anyId(rng, circuit),
        someNumber(rng, circuit),
        rng() < 0.5 ? 0 : 1
      )
    case 'removeControl':
      return state.removeControl(anyId(rng, circuit), someNumber(rng, circuit))
    case 'setParam': {
      const value: ParamValue =
        rng() < 0.7 ? pickOne(rng, HOSTILE) : pickOne(rng, ['theta', '2bad'])
      return state.setParam(
        anyId(rng, circuit),
        rng() < 0.7 ? intIn(rng, 0, 2) : pickOne(rng, HOSTILE),
        value
      )
    }
    case 'addQubit':
      return state.addQubit(rng() < 0.4 ? undefined : someNumber(rng, circuit))
    case 'removeQubit':
      return state.removeQubit(someNumber(rng, circuit))
    case 'reorderQubits': {
      const order = Array.from({ length: circuit.qubits }, (_, i) => i)
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[order[i], order[j]] = [order[j] as number, order[i] as number]
      }
      if (rng() < 0.3 && order.length > 0) order[0] = someNumber(rng, circuit)
      if (rng() < 0.15) order.push(someNumber(rng, circuit))
      return state.reorderQubits(order)
    }
    case 'setQubitLabel':
      return state.setQubitLabel(
        someNumber(rng, circuit),
        pickOne(rng, ['', 'q9', 'a'.repeat(40), 'wire'])
      )
    case 'addClbit':
      return state.addClbit()
    case 'removeClbit':
      return state.removeClbit(someNumber(rng, circuit))
    case 'copy':
      return state.copy()
    case 'paste':
      return state.paste(someNumber(rng, circuit), someColumn(rng))
    case 'compactColumns':
      return state.compactColumns()
    case 'setSelection': {
      const ids = circuit.operations
        .filter(() => rng() < 0.5)
        .map((operation) => operation.id)
      if (rng() < 0.3) ids.push('op_ghost')
      if (rng() < 0.2 && ids.length > 0) ids.push(ids[0] as string)
      state.setSelection(ids)
      return undefined
    }
    case 'toggleSelection':
      state.toggleSelection(anyId(rng, circuit))
      return undefined
    case 'clearSelection':
      state.clearSelection()
      return undefined
    case 'undo': {
      const steps = someSteps(rng)
      return steps === undefined ? state.undo() : state.undo(steps)
    }
    case 'redo': {
      const steps = someSteps(rng)
      return steps === undefined ? state.redo() : state.redo(steps)
    }
    case 'beginTransaction':
      state.beginTransaction()
      return undefined
    case 'endTransaction':
      state.endTransaction()
      return undefined
    case 'clearHistory':
      state.clearHistory()
      return undefined
    case 'loadCircuit': {
      const qubits = intIn(rng, 1, 4)
      return state.loadCircuit(
        rng() < 0.25
          ? { schemaVersion: 1, qubits: 0, operations: [] }
          : {
              schemaVersion: 1,
              qubits,
              clbits: 2,
              parameters: rng() < 0.6 ? [{ name: 'theta', value: 0.5 }] : [],
              operations: [
                {
                  id: 'loaded_1',
                  gate: 'rz',
                  targets: [0],
                  column: 0,
                  params: [rng() < 0.5 ? 'theta' : 1.25],
                },
              ],
            }
      )
    }
  }
}

describe('the store under long randomised hostile sequences', () => {
  const seeds = Array.from({ length: 24 }, (_, index) => index + 1)

  it.each(seeds)('survives seed %i', (seed) => {
    const rng = rngOf(seed)
    const store = createCircuitStore(emptyCircuit(3, 3))
    expectSound(store, `seed ${seed} start`)

    for (let step = 0; step < 200; step++) {
      const before = depthsOf(store)
      const result = runStep(rng, store)
      const where = `seed ${seed} step ${step}`

      expectSound(store, where)

      // Rule 2 of the store's header, checked on every refusal there is.
      if (result !== undefined && !result.ok) {
        expect(
          depthsOf(store),
          `${where}: ${result.reason} spent nothing`
        ).toEqual(before)
      }
    }
  })
})
