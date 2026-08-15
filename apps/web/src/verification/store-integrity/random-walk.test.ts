/**
 * Adversarial verification — store and history integrity.
 *
 * Independent of the store's own suite: the invariants here are derived from
 * the contract (`validateCircuit` is the only judge of a legal circuit) and
 * from what a user can predict about undo, not from the implementation.
 *
 * The walk drives the real store through long randomised action sequences
 * with a deterministic PRNG, so a failure names a seed that reproduces it.
 * Two things are asserted after *every* step: the circuit is one the contract
 * accepts, and the history agrees with a model kept here — a refused edit
 * spends nothing, a real edit spends exactly one step and drops the redo
 * stack, and undo hands back the very circuit object that preceded it.
 */

import {
  GATE_IDS,
  emptyCircuit,
  safeParseCircuit,
  validateCircuit,
  type Circuit,
  type Control,
  type Operation,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  createCircuitStore,
  type CircuitStore,
  type EditResult,
} from '../../features/circuit-editor/useCircuitStore'

/** Mulberry32 — small, deterministic, good enough to shake out a store. */
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

/** Mirror of the store's own history limit. */
const HISTORY_LIMIT = 100

interface Walker {
  readonly store: CircuitStore
  /** Circuits the harness believes undo should hand back, oldest first. */
  past: Circuit[]
  future: Circuit[]
}

function historyOf(store: CircuitStore) {
  return store.temporal.getState()
}

function expectSound(store: CircuitStore, where: string): void {
  const circuit = store.getState().circuit

  // The contract is the only judge. Both entry points, because the editor
  // holds a parsed circuit but a saved one goes back through the shape check.
  expect(validateCircuit(circuit), `${where}: semantic validity`).toEqual([])
  expect(safeParseCircuit(circuit).ok, `${where}: shape validity`).toBe(true)

  const ids = circuit.operations.map((operation) => operation.id)
  expect(new Set(ids).size, `${where}: unique ids`).toBe(ids.length)

  // Selection is a set of live ids in circuit order — anything else and the
  // toolbar acts on operations the user cannot see.
  const { selection } = store.getState()
  expect(
    selection.filter((id) => !ids.includes(id)),
    `${where}: selection is live`
  ).toEqual([])
  expect(
    [...selection].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)),
    `${where}: selection in circuit order`
  ).toEqual([...selection])
  expect(new Set(selection).size, `${where}: selection has no duplicates`).toBe(
    selection.length
  )
}

/* ------------------------------------------------------------------ *
 * Action generation
 * ------------------------------------------------------------------ */

const existingId = (rng: Rng, circuit: Circuit): string =>
  circuit.operations.length === 0
    ? 'op_ghost'
    : pickOne(rng, circuit.operations).id

/** Mostly in range, sometimes not: a bad index must be refused, not absorbed. */
function someQubit(rng: Rng, circuit: Circuit): number {
  return rng() < 0.85
    ? intIn(rng, 0, circuit.qubits - 1)
    : intIn(rng, -1, circuit.qubits + 1)
}

function someColumn(rng: Rng): number {
  return rng() < 0.9 ? intIn(rng, 0, 5) : intIn(rng, -1, 4200)
}

function someTargets(rng: Rng, circuit: Circuit): number[] {
  const count = intIn(rng, 1, 3)
  const targets: number[] = []
  for (let index = 0; index < count; index++) {
    targets.push(someQubit(rng, circuit))
  }
  return targets
}

function someControls(rng: Rng, circuit: Circuit): Control[] {
  const count = intIn(rng, 0, 2)
  const controls: Control[] = []
  for (let index = 0; index < count; index++) {
    const qubit = someQubit(rng, circuit)
    controls.push(rng() < 0.5 ? qubit : { qubit, state: rng() < 0.5 ? 0 : 1 })
  }
  return controls
}

/** A legal-looking document for `loadCircuit`, sometimes deliberately not. */
function someDocument(rng: Rng): unknown {
  if (rng() < 0.3) return { schemaVersion: 1, qubits: 0, operations: [] }
  const qubits = intIn(rng, 1, 4)
  const operations: Operation[] = []
  const count = intIn(rng, 0, 3)
  for (let index = 0; index < count; index++) {
    operations.push({
      id: `loaded_${index}`,
      gate: 'h',
      targets: [intIn(rng, 0, qubits - 1)],
      column: index,
    })
  }
  return { schemaVersion: 1, qubits, clbits: 2, operations }
}

interface Step {
  readonly name: string
  readonly run: () => EditResult | void
}

function nextStep(rng: Rng, walker: Walker): Step {
  const store = walker.store
  const circuit = store.getState().circuit
  const kind = pickOne(rng, [
    'place',
    'place',
    'place',
    'placeFree',
    'placeFree',
    'placeFree',
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
    'copy',
    'paste',
    'paste',
    'compact',
    'select',
    'toggle',
    'clearSelection',
    'undo',
    'undo',
    'redo',
    'redo',
    'load',
  ] as const)

  switch (kind) {
    case 'place': {
      const gate = pickOne(rng, GATE_IDS)
      const targets = someTargets(rng, circuit)
      const column = someColumn(rng)
      const controls = someControls(rng, circuit)
      return {
        name: `placeGate(${gate}, [${targets.join()}], ${column})`,
        run: () =>
          store.getState().placeGate(gate, targets, column, { controls }),
      }
    }
    case 'placeFree': {
      // A placement a competent editor would actually make, so the circuit
      // grows instead of bouncing off the validator forever.
      const gate = pickOne(rng, ['h', 'x', 'z', 'rz', 'cx', 'swap'] as const)
      const wires = Array.from({ length: circuit.qubits }, (_, i) => i)
      for (let i = wires.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[wires[i], wires[j]] = [wires[j] as number, wires[i] as number]
      }
      const column = intIn(rng, 0, 8)
      const first = wires[0] ?? 0
      const second = wires[1] ?? 0
      if (gate === 'cx') {
        return {
          name: `placeGate(cx, [${second}], ${column}, controls=[${first}])`,
          run: () =>
            store
              .getState()
              .placeGate('cx', [second], column, { controls: [first] }),
        }
      }
      if (gate === 'swap') {
        return {
          name: `placeGate(swap, [${first},${second}], ${column})`,
          run: () =>
            store.getState().placeGate('swap', [first, second], column),
        }
      }
      return {
        name: `placeGate(${gate}, [${first}], ${column})`,
        run: () => store.getState().placeGate(gate, [first], column),
      }
    }
    case 'move': {
      const id = existingId(rng, circuit)
      const targets = someTargets(rng, circuit)
      const column = someColumn(rng)
      return {
        name: `moveOperation(${id}, [${targets.join()}], ${column})`,
        run: () => store.getState().moveOperation(id, targets, column),
      }
    }
    case 'remove': {
      const id = existingId(rng, circuit)
      return {
        name: `removeOperation(${id})`,
        run: () => store.getState().removeOperation(id),
      }
    }
    case 'removeMany': {
      const ids = circuit.operations
        .filter(() => rng() < 0.4)
        .map((operation) => operation.id)
      return {
        name: `removeOperations([${ids.join()}])`,
        run: () => store.getState().removeOperations(ids),
      }
    }
    case 'addControl': {
      const id = existingId(rng, circuit)
      const qubit = someQubit(rng, circuit)
      const bit: 0 | 1 = rng() < 0.5 ? 0 : 1
      return {
        name: `addControl(${id}, ${qubit}, ${bit})`,
        run: () => store.getState().addControl(id, qubit, bit),
      }
    }
    case 'removeControl': {
      const id = existingId(rng, circuit)
      const qubit = someQubit(rng, circuit)
      return {
        name: `removeControl(${id}, ${qubit})`,
        run: () => store.getState().removeControl(id, qubit),
      }
    }
    case 'setParam': {
      const id = existingId(rng, circuit)
      const index = intIn(rng, 0, 2)
      const value =
        rng() < 0.85 ? rng() * 8 - 4 : pickOne(rng, ['theta', 'nope'])
      return {
        name: `setParam(${id}, ${index}, ${String(value)})`,
        run: () => store.getState().setParam(id, index, value),
      }
    }
    case 'addQubit': {
      const at = rng() < 0.5 ? undefined : someQubit(rng, circuit)
      return {
        name: `addQubit(${String(at)})`,
        run: () => store.getState().addQubit(at),
      }
    }
    case 'removeQubit': {
      const index = someQubit(rng, circuit)
      return {
        name: `removeQubit(${index})`,
        run: () => store.getState().removeQubit(index),
      }
    }
    case 'reorderQubits': {
      const order = Array.from({ length: circuit.qubits }, (_, i) => i)
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[order[i], order[j]] = [order[j] as number, order[i] as number]
      }
      if (rng() < 0.1) order.push(0)
      return {
        name: `reorderQubits([${order.join()}])`,
        run: () => store.getState().reorderQubits(order),
      }
    }
    case 'setQubitLabel': {
      const index = someQubit(rng, circuit)
      const label = pickOne(rng, ['alice', 'bob', '', 'q0'])
      return {
        name: `setQubitLabel(${index}, "${label}")`,
        run: () => store.getState().setQubitLabel(index, label),
      }
    }
    case 'addClbit':
      return { name: 'addClbit()', run: () => store.getState().addClbit() }
    case 'removeClbit': {
      const index = intIn(rng, -1, circuit.clbits)
      return {
        name: `removeClbit(${index})`,
        run: () => store.getState().removeClbit(index),
      }
    }
    case 'copy':
      return { name: 'copy()', run: () => store.getState().copy() }
    case 'paste': {
      const qubit = someQubit(rng, circuit)
      const column = someColumn(rng)
      return {
        name: `paste(${qubit}, ${column})`,
        run: () => store.getState().paste(qubit, column),
      }
    }
    case 'compact':
      return {
        name: 'compactColumns()',
        run: () => store.getState().compactColumns(),
      }
    case 'select': {
      const ids = circuit.operations
        .filter(() => rng() < 0.5)
        .map((operation) => operation.id)
      return {
        name: `setSelection([${ids.join()}])`,
        run: () => {
          store.getState().setSelection(ids)
        },
      }
    }
    case 'toggle': {
      const id = existingId(rng, circuit)
      return {
        name: `toggleSelection(${id})`,
        run: () => {
          store.getState().toggleSelection(id)
        },
      }
    }
    case 'clearSelection':
      return {
        name: 'clearSelection()',
        run: () => {
          store.getState().clearSelection()
        },
      }
    case 'undo':
      return {
        name: 'undo()',
        run: () => {
          store.getState().undo()
        },
      }
    case 'redo':
      return {
        name: 'redo()',
        run: () => {
          store.getState().redo()
        },
      }
    case 'load': {
      const document = someDocument(rng)
      return {
        name: `loadCircuit(${JSON.stringify(document)})`,
        run: () => store.getState().loadCircuit(document),
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

/** Coverage counters, so a green walk is not a walk that did nothing. */
const coverage = {
  accepted: 0,
  refused: 0,
  undoApplied: 0,
  redoApplied: 0,
  maxOperations: 0,
  maxHistory: 0,
  reasons: new Set<string>(),
}

function walk(seed: number, steps: number): void {
  const store = createCircuitStore(emptyCircuit(3, 3))
  const walker: Walker = { store, past: [], future: [] }
  const log: string[] = []
  const rng = rngOf(seed * 7919 + 13)

  expectSound(store, `seed ${seed} start`)

  for (let index = 0; index < steps; index++) {
    const step = nextStep(rng, walker)
    const before = store.getState().circuit
    const beforePast = historyOf(store).pastStates.length
    const beforeFuture = historyOf(store).futureStates.length

    const isUndo = step.name === 'undo()'
    const isRedo = step.name === 'redo()'
    const clearsHistory = step.name.startsWith('loadCircuit')

    const result = step.run()
    log.push(step.name)
    const where = `seed ${seed} step ${index} [${step.name}] after:\n  ${log
      .slice(-8)
      .join('\n  ')}`

    expectSound(store, where)

    const after = store.getState().circuit
    if (result !== undefined) {
      if (result.ok) coverage.accepted += 1
      else {
        coverage.refused += 1
        coverage.reasons.add(result.reason)
      }
    }
    coverage.maxOperations = Math.max(
      coverage.maxOperations,
      after.operations.length
    )
    coverage.maxHistory = Math.max(coverage.maxHistory, beforePast)

    if (isUndo) {
      const expected = walker.past.pop()
      if (expected === undefined) {
        expect(after, `${where}: undo with empty history is a no-op`).toBe(
          before
        )
      } else {
        coverage.undoApplied += 1
        walker.future.push(before)
        expect(after, `${where}: undo restores the previous circuit`).toBe(
          expected
        )
      }
      continue
    }

    if (isRedo) {
      const expected = walker.future.pop()
      if (expected === undefined) {
        expect(after, `${where}: redo with empty future is a no-op`).toBe(
          before
        )
      } else {
        coverage.redoApplied += 1
        walker.past.push(before)
        expect(after, `${where}: redo restores the undone circuit`).toBe(
          expected
        )
      }
      continue
    }

    if (clearsHistory && result !== undefined && result.ok) {
      walker.past = []
      walker.future = []
      expect(
        historyOf(store).pastStates.length,
        `${where}: loading clears the past`
      ).toBe(0)
      expect(
        historyOf(store).futureStates.length,
        `${where}: loading clears the future`
      ).toBe(0)
      continue
    }

    if (result !== undefined && !result.ok) {
      // A refused edit is a true no-op: same circuit object, same history.
      expect(after, `${where}: a refused edit changes nothing`).toBe(before)
      expect(
        historyOf(store).pastStates.length,
        `${where}: a refused edit costs no undo step`
      ).toBe(beforePast)
      expect(
        historyOf(store).futureStates.length,
        `${where}: a refused edit keeps the redo stack`
      ).toBe(beforeFuture)
      continue
    }

    if (after !== before) {
      if (walker.past.length >= HISTORY_LIMIT) walker.past.shift()
      walker.past.push(before)
      walker.future = []
      expect(
        historyOf(store).futureStates.length,
        `${where}: a real edit clears the redo stack`
      ).toBe(0)
    } else {
      expect(
        historyOf(store).pastStates.length,
        `${where}: an edit that changed nothing costs no undo step`
      ).toBe(beforePast)
    }

    expect(
      historyOf(store).pastStates.length,
      `${where}: history depth agrees with the model`
    ).toBe(walker.past.length)
  }

  // Everything unwound: back to the oldest circuit still inside the window.
  const oldest = walker.past[0] ?? store.getState().circuit
  for (let index = 0; index < HISTORY_LIMIT + 5; index++) {
    store.getState().undo()
    expectSound(store, `seed ${seed} unwinding`)
  }
  expect(store.getState().circuit, `seed ${seed}: full unwind`).toBe(oldest)
}

describe('store integrity under randomised action sequences', () => {
  for (const seed of Array.from({ length: 40 }, (_, index) => index + 1)) {
    it(`survives 300 random actions with seed ${seed}`, () => {
      walk(seed, 300)
    })
  }

  it('exercised enough of the store for the green above to mean something', () => {
    expect(coverage.accepted).toBeGreaterThan(2000)
    expect(coverage.refused).toBeGreaterThan(500)
    expect(coverage.undoApplied).toBeGreaterThan(200)
    expect(coverage.redoApplied).toBeGreaterThan(50)
    expect(coverage.maxOperations).toBeGreaterThan(10)
    // Every refusal the store can express was actually provoked, bar the two
    // that need a document the editor cannot build (`custom-gate-cycle`,
    // `duplicate-parameter`, `duplicate-operation-id`, `unknown-gate`).
    expect(coverage.reasons.size).toBeGreaterThan(12)
  })
})
