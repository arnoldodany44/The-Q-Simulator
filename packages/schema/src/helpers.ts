/**
 * Pure helpers over the circuit contract.
 *
 * Every function here is total and side-effect free: it takes a circuit and
 * returns a number or a new circuit, never a mutated one. The editor keeps
 * circuits in React state, so mutating one in place would be invisible to
 * rendering and painful to undo.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  MAX_CLBITS,
  MAX_QUBITS,
  type Circuit,
  type Control,
  type ControlSpec,
  type Operation,
  type Parameter,
} from './circuit.js'
import { safeExpandCircuit } from './expand.js'
import { lookupGate } from './gates.js'

/** A bare number means a positive control: fires when the qubit reads |1⟩. */
export function normalizeControl(control: Control): ControlSpec {
  return typeof control === 'number' ? { qubit: control, state: 1 } : control
}

/** Every control of an operation in its explicit `{ qubit, state }` form. */
export function controlsOf(operation: Operation): ControlSpec[] {
  return (operation.controls ?? []).map(normalizeControl)
}

/**
 * Every qubit an operation occupies, targets and controls alike. Both kinds
 * block the column: a control wire crossing a qubit still reserves it.
 */
export function qubitsOf(operation: Operation): number[] {
  const qubits = [...operation.targets]
  for (const control of controlsOf(operation)) qubits.push(control.qubit)
  return qubits
}

/**
 * Number of gates in the circuit, in the sense a challenge leaderboard means
 * it: barriers, resets and measurements are not gates, they are structure.
 * Use `circuit.operations.length` when you want the raw count instead.
 *
 * ── A custom gate counts as its body, not as one gate (reversed in M2.3) ──
 *
 * It used to count as one, on the reasoning that counting as one is the whole
 * point of packaging a subcircuit. That reasoning is right about the *canvas*
 * and wrong about the *number*, and the number is what §3.6 ranks on: "menor
 * número de compuertas, menor profundidad". If a block counted as one gate,
 * every leaderboard would be won by wrapping the answer in a definition —
 * forty gates in, one gate reported — and the ranking would measure packaging
 * rather than circuits. The same figure is on every gallery card, where it is
 * read as "how much circuit is this".
 *
 * So this is the count of primitives the hardware would actually run, which is
 * the count of the expanded circuit (`expand.ts`), and `depth` below is the
 * matching statement about time. A circuit too large to expand falls back to
 * its unexpanded count: the counter is not the place that reports a refusal,
 * and a card that cannot be drawn must not be a 500.
 */
export function gateCount(circuit: Circuit): number {
  let count = 0
  for (const operation of flatten(circuit).operations) {
    if (lookupGate(operation.gate)?.category === 'structural') continue
    count++
  }
  return count
}

/**
 * Circuit depth: how many time steps the circuit really takes.
 *
 * The longest chain of operations that have to happen one after another — the
 * critical path of the expanded circuit's dependency graph, which is what
 * Qiskit's `depth()` measures and what a hardware scheduler would need. Two
 * operations are on the same chain when they share a wire: a qubit either one
 * touches, or a classical bit one writes and the other reads.
 *
 * ── WHY NOT SIMPLY COUNT THE OCCUPIED COLUMNS ────────────────────────────
 *
 * That is what this used to do, and it made depth a statement about the
 * *document's layout* rather than about the circuit — which broke the one
 * property §3.1 decision 3 exists to guarantee: that packaging a fragment as a
 * block cannot change what the circuit is reported to cost.
 *
 * The layout is where a block's body is laid out from. Expansion gives each
 * source column the width of the widest block in it and starts the next column
 * after that, so a two-instant block sharing a column with a three-instant one
 * runs "inside" the wider column and costs nothing extra. Expand that block
 * back into its gates — `inlineOperation`, the editor's "expand this block" —
 * and its second gate now needs a source column of its own, which lands *after*
 * the wider sibling. Same gates, same wires, same order, same state: one more
 * occupied column. Depth went up because the drawing changed, so depth rewarded
 * leaving gates packaged.
 *
 * Counting the critical path removes the whole class: the chains depend only on
 * the per-wire order of the operations, and neither packaging, inlining, a gap
 * in the numbering nor a half-finished drag changes that. `depth(c) ===
 * depth(normalizeColumns(c))` still holds, and now so does
 * `depth(c) === depth(inlineOperation(c, …))`.
 *
 * Two rules are unchanged and worth restating:
 *
 *  - Barriers do not count. A barrier is an instruction to the optimiser, not
 *    an operation on the state; Qiskit ignores them too. `reset` and `measure`
 *    do count: they are real work on real hardware.
 *  - Everything in one column happens at once, so operations sharing a column
 *    are on the same rung of the chain — including a condition and the
 *    measurement that fills its bit, because the engine reads a condition
 *    against the register as it entered the column (`runner.ts`).
 */
export function depth(circuit: Circuit): number {
  /** The rung the last operation on each wire sits on. */
  const level = new Map<string, number>()
  let deepest = 0

  const byColumn = [...flatten(circuit).operations].sort(
    (a, b) => a.column - b.column
  )
  let index = 0
  while (index < byColumn.length) {
    const column = (byColumn[index] as Operation).column
    const reached: [string, number][] = []
    while (
      index < byColumn.length &&
      (byColumn[index] as Operation).column === column
    ) {
      const operation = byColumn[index] as Operation
      index += 1
      if (operation.gate === 'barrier') continue
      const wires = wiresOf(operation)
      let after = 0
      // Read against the levels as they were when the column began, which is
      // the same rule the engine applies to a classical condition.
      for (const wire of wires) after = Math.max(after, level.get(wire) ?? 0)
      const rung = after + 1
      deepest = Math.max(deepest, rung)
      for (const wire of wires) reached.push([wire, rung])
    }
    for (const [wire, rung] of reached) {
      level.set(wire, Math.max(level.get(wire) ?? 0, rung))
    }
  }
  return deepest
}

/**
 * Every wire this operation is on: its qubits, its controls' qubits, the
 * classical bits it writes, and the one its condition reads.
 *
 * Prefixed rather than numbered, because qubit 0 and classical bit 0 are
 * different wires and a shared key would chain operations that never meet.
 */
function wiresOf(operation: Operation): string[] {
  const wires = operation.targets.map((qubit) => `q${String(qubit)}`)
  for (const control of controlsOf(operation)) {
    wires.push(`q${String(control.qubit)}`)
  }
  for (const clbit of operation.clbitTargets ?? []) {
    wires.push(`c${String(clbit)}`)
  }
  if (operation.condition !== undefined) {
    wires.push(`c${String(operation.condition.clbit)}`)
  }
  return wires
}

/**
 * The circuit as the engine will actually run it.
 *
 * One call site's worth of duplication avoided, and one guarantee bought: the
 * two numbers a gallery card shows come from the same document the simulator
 * evolves, so "18 gates" and an eighteen-gate run cannot disagree. The
 * expansion is memoised on the circuit object, so asking twice in one render
 * costs one walk.
 */
function flatten(circuit: Circuit): Circuit {
  return safeExpandCircuit(circuit)?.circuit ?? circuit
}

/**
 * Every gate identifier the circuit actually runs, sorted, without repeats.
 *
 * ── Why it is the *expanded* circuit, like `gateCount` and `depth` ────────
 *
 * A §3.6 challenge may restrict which gates a solution is allowed to use, and
 * the server enforces that (risk 5). If this read `circuit.operations`, a
 * submission could hide a forbidden gate inside a custom-gate definition and
 * the check would see one operation named `myBlock` and be satisfied — while
 * the engine ran the very gate the challenge excluded. Expanding first is the
 * same decision M2.3 made for the two counters, for the same reason: the
 * numbers and the names a challenge is judged on are about the primitives the
 * hardware would run, not about how the document is packaged.
 *
 * ── `barrier` is excluded, and nothing else is ────────────────────────────
 *
 * A barrier applies no matrix, moves no amplitude and is not counted by
 * `gateCount`; it is an annotation about scheduling. Refusing a submission for
 * carrying one would be refusing it for a comment. `measure` and `reset` are
 * *not* excluded, because both change the state — so a challenge whose allowed
 * list does not name them is a challenge where they are genuinely not allowed.
 */
export function gatesUsed(circuit: Circuit): string[] {
  const used = new Set<string>()
  for (const operation of flatten(circuit).operations) {
    if (operation.gate === 'barrier') continue
    used.add(operation.gate)
  }
  return [...used].sort()
}

/**
 * The same document with every custom-gate definition nothing reaches removed.
 *
 * A definition is *data* rather than an operation (§3.1, decision 2), so an
 * unreferenced one costs the expansion budget nothing, changes no count, no
 * depth and no state — and is carried verbatim into whatever stores the
 * document. That asymmetry is a storage amplifier: a two-gate answer with two
 * thousand definitions nobody invokes is still a two-gate answer and is a
 * quarter of a megabyte of permanent row.
 *
 * Reachability is transitive, because a definition may invoke another, and it
 * is computed from the operations rather than from the keys: what a document
 * *does* is the only thing that decides what it needs.
 *
 * Returns the input unchanged when there is nothing to drop, so a caller can
 * store the result without wondering whether it is a different document.
 */
export function pruneUnusedDefinitions(circuit: Circuit): Circuit {
  const definitions = circuit.customGates
  if (definitions === undefined) return circuit

  const reachable = new Set<string>()
  const pending = circuit.operations.map((operation) => operation.gate)
  while (pending.length > 0) {
    const name = pending.pop() as string
    if (reachable.has(name)) continue
    const definition = definitions[name]
    if (definition === undefined) continue
    reachable.add(name)
    for (const operation of definition.operations) pending.push(operation.gate)
  }

  const names = Object.keys(definitions)
  if (names.length === reachable.size) return circuit

  const kept: Record<string, (typeof definitions)[string]> = {}
  for (const name of names) {
    const definition = definitions[name]
    if (reachable.has(name) && definition !== undefined) kept[name] = definition
  }
  // An empty record is dropped rather than stored: `customGates` is optional,
  // and `{}` is a key that says nothing.
  if (Object.keys(kept).length === 0) {
    const { customGates: _dropped, ...rest } = circuit
    return rest
  }
  return { ...circuit, customGates: kept }
}

/**
 * Close the gaps in the column numbering, so occupied columns become
 * `0, 1, 2, …` in their original order.
 *
 * Editing leaves holes — delete every gate in column 3 and the circuit
 * still claims a column 3. This is what the editor's document store calls
 * after a delete (`useCircuitStore.ts`), and it is the only caller.
 *
 * The exporters deliberately do *not* call it, which the comment here used to
 * claim they did. They read the operations through `orderedOperations`, which
 * sorts by column and is indifferent to gaps — and keeping the original
 * numbering is what lets the emitted note "in the source document both are in
 * column N" name the column the reader can see on screen rather than a
 * renumbered one.
 *
 * Operation order within the array is preserved, because the editor's undo
 * stack and React keys both depend on it.
 */
export function normalizeColumns(circuit: Circuit): Circuit {
  const used = [...new Set(circuit.operations.map((op) => op.column))].sort(
    (a, b) => a - b
  )
  const remapped = new Map(used.map((column, index) => [column, index]))
  return {
    ...circuit,
    operations: circuit.operations.map((operation) => ({
      ...operation,
      // The lookup always hits; `??` avoids a non-null assertion.
      column: remapped.get(operation.column) ?? operation.column,
    })),
  }
}

/** A valid, empty circuit — the starting point of every new document. */
export function emptyCircuit(qubits: number, clbits = 0): Circuit {
  if (!Number.isInteger(qubits) || qubits < 1 || qubits > MAX_QUBITS) {
    throw new RangeError(
      `A circuit needs between 1 and ${MAX_QUBITS} qubits, got ${qubits}.`
    )
  }
  if (!Number.isInteger(clbits) || clbits < 0 || clbits > MAX_CLBITS) {
    throw new RangeError(
      `A circuit needs between 0 and ${MAX_CLBITS} classical bits, ` +
        `got ${clbits}.`
    )
  }
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits,
    operations: [],
  }
}

/**
 * An operation's parameters as plain numbers, resolving symbolic references
 * against the circuit's `parameters`. This is the last step before the
 * engine builds a gate matrix, which is why it returns radians and not a
 * union type.
 *
 * Throws on an unknown name. A circuit that passed `validateCircuit()`
 * cannot reach that throw, so it signals a bug rather than bad user input.
 */
export function resolveParams(
  operation: Operation,
  parameters: readonly Parameter[] = []
): number[] {
  return (operation.params ?? []).map((param) => {
    if (typeof param === 'number') return param
    const declared = parameters.find((candidate) => candidate.name === param)
    if (declared === undefined) {
      throw new Error(
        `Operation "${operation.id}" references parameter "${param}", ` +
          `which is not declared in the circuit.`
      )
    }
    return declared.value
  })
}
