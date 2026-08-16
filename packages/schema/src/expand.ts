/**
 * Custom gates, flattened into primitives — §3.1, milestone M2.3.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EXPANSION AND NOT RECURSIVE EXECUTION
 *
 * A custom gate could be run two ways: expand every use into the primitives it
 * stands for and hand the engine an ordinary circuit, or teach the runner to
 * descend into a definition when it meets one. The second is less code in this
 * file and more code everywhere else, and it breaks two things that are load
 * bearing.
 *
 *  1. **A column is one instant, and the timeline is indexed by columns.** The
 *     scrubber stops *between* columns (§3.1, decision 1) and the checkpoint
 *     cache is a list keyed by "the last column already applied" (§5.6.3), so
 *     `invalidateFrom` is a comparison of two integers. A block executed
 *     recursively would be several instants inside one column: either the
 *     scrubber cannot stop inside it — and a five-gate teleportation block
 *     becomes one unreadable jump, which is exactly the lesson the feature
 *     exists to show — or the cache needs a second coordinate and every
 *     comparison in `runner.ts` becomes a comparison of pairs.
 *  2. **Noise is charged per real gate.** `runNoisy` applies the profile's
 *     channels after every unitary, on each wire it touched. A block executed
 *     as one operation would be charged once, which is the wrong physics by
 *     however many gates it contains; charging it correctly means expanding it
 *     anyway, inside the noise path, where nothing else can see the result.
 *
 * Expansion pays one price and pays it here: the editor's columns and the
 * engine's columns stop being the same axis, because a block three columns
 * wide pushes everything after it along. So this module hands back a **column
 * map** and the seam that runs a circuit translates through it
 * (`expandedThroughColumn` for a scrub position, `expandedFromColumn` for an
 * invalidation point). That is arithmetic in one file, against a change to the
 * cache, the scrubber, the noise model and the leaderboard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEANS FOR `depth()` AND `gateCount()`
 *
 * They count the expanded circuit, and `helpers.ts` says so. A leaderboard
 * that ranks on fewest gates (§3.6) would otherwise be won by packaging: wrap
 * forty gates in a block and the document reports one. The numbers a gallery
 * card shows and the numbers a challenge ranks on have to be the number of
 * operations the *hardware* would run, and that is the expanded count.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EXPANSION IS A RESOURCE LIMIT (§11)
 *
 * The cycle check in `validate.ts` proves the definition graph terminates. It
 * does **not** prove the expansion is small: definitions form a DAG, and a DAG
 * doubles. Twenty definitions where each uses the previous one twice is forty
 * operations of JSON and a million operations of circuit — a payload well
 * under any body limit that allocates a gigabyte downstream. So the ceilings
 * below are checked *while emitting*, not afterwards, and a document that
 * exceeds them is refused by the contract (`validateCircuit` runs the same
 * check) rather than by whatever runs out of memory first.
 */

import {
  MAX_COLUMNS,
  MAX_CUSTOM_GATE_DEPTH,
  type Circuit,
  type Control,
  type CustomGate,
  type Operation,
  type ParamValue,
} from './circuit.js'
import { lookupGate } from './gates.js'

/**
 * Most operations an expansion may emit.
 *
 * The same number `@qsim/jobs` refuses a flat circuit at (`MAX_SERVER_OPERATIONS`
 * is `4 * MAX_COLUMNS` for the same reason), restated here because the refusal
 * has to happen in the contract: a document that expands past this cannot be
 * simulated anywhere, so it should be a 400 from the validator and not a 413
 * from a queue that already accepted the job.
 */
export const MAX_EXPANDED_OPERATIONS = 4 * MAX_COLUMNS

/**
 * Most columns an expansion may occupy. The output has to be a legal circuit,
 * and `column` is bounded by `MAX_COLUMNS` in the shape.
 */
export const MAX_EXPANDED_COLUMNS = MAX_COLUMNS

/** Why an expansion was refused. */
export type ExpansionCode =
  | 'unknown-gate'
  | 'arity-mismatch'
  | 'controlled-definition'
  | 'param-count-mismatch'
  | 'unknown-parameter'
  | 'too-many-operations'
  | 'too-many-columns'
  | 'too-deep'

/**
 * A circuit whose custom gates cannot be flattened.
 *
 * Everything this can report is also reported by `validateCircuit`, which runs
 * first everywhere untrusted input enters. It is still a typed error rather
 * than an assertion, because "the validator already checked" is a claim about
 * call order and this module allocates memory proportional to its input.
 */
export class CircuitExpansionError extends Error {
  readonly code: ExpansionCode
  /** The *top-level* operation the failure is under, when there is one. */
  readonly operationId: string | undefined

  constructor(code: ExpansionCode, message: string, operationId?: string) {
    super(message)
    this.name = 'CircuitExpansionError'
    this.code = code
    this.operationId = operationId
  }
}

/**
 * Where one source column ended up. `end` is `start + width - 1`, so a source
 * column holding nothing but an empty definition has `end === start - 1` — the
 * honest answer that the state after it is the state before it.
 */
export interface ColumnSpan {
  readonly source: number
  readonly start: number
  readonly end: number
}

/** A circuit with no `customGates` left in it, and the map back. */
export interface ExpandedCircuit {
  /** The flat circuit. Identical to the input when nothing was expanded. */
  readonly circuit: Circuit
  /** False when the input used no custom gate; then the maps are identities. */
  readonly changed: boolean
  /** Ascending by `source`, one entry per occupied source column. Empty when `changed` is false. */
  readonly columns: readonly ColumnSpan[]
  /** Emitted operation id → the id of the top-level operation it came from. */
  readonly originOf: ReadonlyMap<string, string>
}

/**
 * Whether any operation — at the top level or inside a definition — names a
 * custom gate. The cheap question every caller asks before paying for the
 * expensive one.
 */
export function usesCustomGates(circuit: Circuit): boolean {
  const definitions = circuit.customGates
  if (definitions === undefined) return false
  for (const operation of circuit.operations) {
    if (Object.hasOwn(definitions, operation.gate)) return true
  }
  return false
}

/*
 * Memoised on the circuit object.
 *
 * Circuits are immutable and every edit produces a new object (the store's
 * rule 2), so identity is a sound cache key and a `WeakMap` releases the entry
 * with the circuit. It is worth having because the callers are not one: a
 * single render asks `gateCount`, `depth` and — through the worker — the
 * expansion itself, and an expansion is up to `MAX_EXPANDED_OPERATIONS`
 * allocations. Nothing observable changes if the cache is dropped; the values
 * inside are frozen-by-convention like every other value in this package.
 */
const memo = new WeakMap<Circuit, ExpandedCircuit>()

/**
 * Flatten every custom gate into the primitives it stands for.
 *
 * Returns the input untouched when there is nothing to expand, so a circuit
 * without custom gates costs one property read and keeps its object identity —
 * which the worker's checkpoint cache and React's memoisation both care about.
 *
 * Throws `CircuitExpansionError`. `safeExpandCircuit` is the non-throwing form.
 */
export function expandCircuit(circuit: Circuit): ExpandedCircuit {
  const cached = memo.get(circuit)
  if (cached !== undefined) return cached
  const result = expandUncached(circuit)
  memo.set(circuit, result)
  return result
}

/** `expandCircuit`, answering `null` instead of throwing. */
export function safeExpandCircuit(circuit: Circuit): ExpandedCircuit | null {
  try {
    return expandCircuit(circuit)
  } catch (cause) {
    if (cause instanceof CircuitExpansionError) return null
    throw cause
  }
}

/**
 * The id of the top-level operation an expanded operation came from — itself,
 * for one that was never inside a definition.
 *
 * This is what turns an engine error into a highlighted gate: the runner
 * reports the id of the operation it refused, and the canvas can only
 * highlight blocks the user actually placed.
 */
export function sourceOperationId(
  expansion: ExpandedCircuit,
  operationId: string
): string {
  return expansion.originOf.get(operationId) ?? operationId
}

/**
 * The earliest expanded column an edit at `sourceColumn` can have touched —
 * what `invalidateFrom` takes.
 *
 * Rounds *down* to the start of the first span at or after the edit, because
 * the cost of naming a column too early is replayed work and the cost of
 * naming one too late is a wrong answer (`invalidation.ts` in apps/web makes
 * the same trade for the same reason).
 */
export function expandedFromColumn(
  expansion: ExpandedCircuit,
  sourceColumn: number
): number {
  if (!expansion.changed) return sourceColumn
  for (const span of expansion.columns) {
    if (span.source >= sourceColumn) return span.start
  }
  // Past the end of the circuit: nothing to invalidate.
  const last = expansion.columns[expansion.columns.length - 1]
  return last === undefined ? sourceColumn : last.end + 1
}

/**
 * The expanded column a scrub position points at — "the state once every
 * source column up to and including `sourceColumn` has run".
 *
 * `-1` in, `-1` out: the position before anything runs is the same position in
 * both circuits, and it is a legitimate one (§3.1, decision 1).
 */
export function expandedThroughColumn(
  expansion: ExpandedCircuit,
  sourceColumn: number
): number {
  if (!expansion.changed) return sourceColumn
  let through = -1
  for (const span of expansion.columns) {
    if (span.source > sourceColumn) break
    through = span.end
  }
  return through
}

/**
 * The source column an expanded column belongs to — the inverse used to report
 * an engine-side column back in the vocabulary the editor draws.
 */
export function sourceColumnOf(
  expansion: ExpandedCircuit,
  expandedColumn: number
): number {
  if (!expansion.changed) return expandedColumn
  for (const span of expansion.columns) {
    if (span.end >= expandedColumn) return span.source
  }
  const last = expansion.columns[expansion.columns.length - 1]
  return last === undefined ? expandedColumn : last.source + 1
}

/* ─────────────────────────── using a definition ─────────────────────── */

/**
 * Where a definition is used: the ids of the top-level operations that call
 * it, and the names of the other definitions whose bodies do.
 *
 * This is what makes the editor's central decision visible. A definition is
 * shared *by reference* inside its document, so editing it changes every use —
 * and the only way a user can consent to that is to be shown the number before
 * they commit. It is also what makes "delete this definition" answerable:
 * a definition something still calls cannot simply disappear.
 */
export interface CustomGateUsage {
  readonly operationIds: readonly string[]
  readonly definitions: readonly string[]
  readonly total: number
}

export function customGateUsage(
  circuit: Circuit,
  name: string
): CustomGateUsage {
  const operationIds = circuit.operations
    .filter((operation) => operation.gate === name)
    .map((operation) => operation.id)

  const definitions: string[] = []
  for (const [other, definition] of Object.entries(circuit.customGates ?? {})) {
    if (other === name) continue
    if (definition.operations.some((operation) => operation.gate === name)) {
      definitions.push(other)
    }
  }

  return {
    operationIds,
    definitions,
    total: operationIds.length + definitions.length,
  }
}

/**
 * Replace one use of a custom gate with the operations it stands for — the
 * editor's "expand it back", and the inverse of packaging a fragment.
 *
 * **One level only.** A block whose body uses another block yields that other
 * block, still packaged. Peeling one layer at a time is what makes the command
 * predictable: the alternative turns one click into a flat list of forty
 * primitives with no way back, and the user who wanted to see what a block
 * contains has lost every other block inside it in the same gesture.
 *
 * Everything after the instance's column moves along by the width the body
 * takes, so the operations that used to run after the block still do. `mintId`
 * supplies ids for the operations the body contributes; the caller owns id
 * minting because the editor's ids are its own (`op_7`, and the undo stack
 * depends on never reusing one).
 *
 * Answers `null` when `operationId` does not name a use of a custom gate,
 * which is the only failure that is not a bug.
 */
export function inlineOperation(
  circuit: Circuit,
  operationId: string,
  mintId: () => string
): Circuit | null {
  const instance = circuit.operations.find(
    (operation) => operation.id === operationId
  )
  if (instance === undefined) return null
  const definitions = circuit.customGates ?? {}
  if (!Object.hasOwn(definitions, instance.gate)) return null
  const definition = definitions[instance.gate]
  if (definition === undefined) return null

  const formals = new Map(
    (definition.params ?? []).map((name, index) => [name, index])
  )
  const frame: Frame = {
    qubitOf: instance.targets,
    args: instance.params ?? [],
    formals,
    rootId: instance.id,
    condition: instance.condition,
    depth: 1,
  }

  const body: Operation[] = []
  let offset = 0
  for (const [, group] of groupByColumn(definition.operations)) {
    for (const child of group) {
      const emitted: Operation = {
        ...child,
        id: mintId(),
        targets: mapQubits(child.targets, frame.qubitOf),
        column: instance.column + offset,
      }
      setOptional(emitted, 'params', bindParams(child, frame))
      setOptional(emitted, 'controls', mapControls(child.controls, frame))
      if (frame.condition !== undefined) emitted.condition = frame.condition
      body.push(emitted)
    }
    offset += 1
  }

  // Never negative, even for an empty definition that leaves a hole behind.
  // Closing that hole would mean pulling later columns *back*, and a column
  // that moves backwards can land on top of an operation that was already
  // there — on a wire the block never touched. `compactColumns` is the command
  // that closes gaps, and a gap costs nothing but pixels (`depth` ignores it).
  const shift = Math.max(0, offset - 1)
  const operations = circuit.operations.flatMap((operation) => {
    if (operation.id === operationId) return body
    if (operation.column <= instance.column) return [operation]
    return [{ ...operation, column: operation.column + shift }]
  })

  return { ...circuit, operations }
}

/* ────────────────────────────── the walk ────────────────────────────── */

interface Emitter {
  readonly definitions: Readonly<Record<string, CustomGate>>
  readonly operations: Operation[]
  readonly originOf: Map<string, string>
  /** Ids already spoken for, so a minted one cannot collide with a real one. */
  readonly taken: Set<string>
  /** Expanded width per definition, memoised across every use of it. */
  readonly widths: Map<string, number>
  counter: number
}

interface Frame {
  /** Qubit index inside the definition → qubit index in the circuit. */
  readonly qubitOf: readonly number[]
  /** Formal parameter index → the argument bound to it. */
  readonly args: readonly ParamValue[]
  /** Formal name → its index, or `undefined` at the top level. */
  readonly formals: ReadonlyMap<string, number> | undefined
  /** The top-level operation everything emitted under this frame belongs to. */
  readonly rootId: string | undefined
  /** A condition inherited from the instance, applied to everything inside. */
  readonly condition: Operation['condition']
  readonly depth: number
}

function expandUncached(circuit: Circuit): ExpandedCircuit {
  if (!usesCustomGates(circuit)) {
    return { circuit, changed: false, columns: [], originOf: EMPTY_ORIGINS }
  }

  const emitter: Emitter = {
    definitions: circuit.customGates ?? {},
    operations: [],
    originOf: new Map(),
    taken: new Set(circuit.operations.map((operation) => operation.id)),
    widths: new Map(),
    counter: 0,
  }

  const columns: ColumnSpan[] = []
  let base = 0

  for (const [source, group] of groupByColumn(circuit.operations)) {
    let width = 0
    for (const operation of group) {
      width = Math.max(width, widthOf(emitter, operation, 0))
    }
    columns.push({ source, start: base, end: base + width - 1 })
    for (const operation of group) {
      emit(emitter, operation, base, TOP_LEVEL)
    }
    base += width
    if (base > MAX_EXPANDED_COLUMNS) {
      throw new CircuitExpansionError(
        'too-many-columns',
        `Expanding this circuit's custom gates would need more than ` +
          `${MAX_EXPANDED_COLUMNS} columns. Simplify a definition or use ` +
          `fewer of them.`
      )
    }
  }

  const expanded: Circuit = {
    ...circuit,
    operations: emitter.operations,
  }
  // `delete` rather than `customGates: undefined`: the contract's objects are
  // strict, and an explicit `undefined` survives into JSON as a key.
  delete expanded.customGates

  return {
    circuit: expanded,
    changed: true,
    columns,
    originOf: emitter.originOf,
  }
}

const EMPTY_ORIGINS: ReadonlyMap<string, string> = new Map()

const TOP_LEVEL: Frame = {
  qubitOf: [],
  args: [],
  formals: undefined,
  rootId: undefined,
  condition: undefined,
  depth: 0,
}

/**
 * Emit one operation — either as itself, or as the body of the definition it
 * names, laid out from `base`.
 *
 * Recursion depth is bounded by `MAX_CUSTOM_GATE_DEPTH`, which is why this may
 * recurse at all; see the constant for the payload arithmetic behind it.
 */
function emit(
  emitter: Emitter,
  operation: Operation,
  base: number,
  frame: Frame
): void {
  const inside = frame.rootId !== undefined
  const targets = inside
    ? mapQubits(operation.targets, frame.qubitOf)
    : [...operation.targets]
  const definition = Object.hasOwn(emitter.definitions, operation.gate)
    ? emitter.definitions[operation.gate]
    : undefined

  const params = bindParams(operation, frame)

  if (definition === undefined) {
    if (lookupGate(operation.gate) === undefined) {
      throw new CircuitExpansionError(
        'unknown-gate',
        `Operation "${operation.id}" uses gate "${operation.gate}", which is ` +
          `neither in the gate catalog nor declared in "customGates".`,
        frame.rootId ?? operation.id
      )
    }
    const emitted: Operation = { ...operation, targets, column: base }
    setOptional(emitted, 'params', params)
    setOptional(emitted, 'controls', mapControls(operation.controls, frame))
    if (frame.condition !== undefined) emitted.condition = frame.condition
    push(emitter, emitted, frame)
    return
  }

  if (frame.depth >= MAX_CUSTOM_GATE_DEPTH) {
    throw new CircuitExpansionError(
      'too-deep',
      `Custom gate "${operation.gate}" is nested more than ` +
        `${MAX_CUSTOM_GATE_DEPTH} levels deep.`,
      frame.rootId ?? operation.id
    )
  }
  if ((operation.controls ?? []).length > 0) {
    /*
     * A control on a block. §3.1 decision 1 and `CustomGateSchema` refuse one
     * deliberately, and `validateCircuit` reports `control-count-mismatch` for
     * it — but this function is reached with circuits nobody promised had been
     * validated (`helpers.ts` says so in as many words), and it used to read
     * `controls` on the primitive branch only. The body was then emitted
     * unconditionally: a controlled block silently became an uncontrolled one,
     * and `gateCount`/`depth` counted the rewritten circuit. The sharpest
     * possible case of looking right and counting wrong, so it is an error
     * rather than an assertion about call order.
     */
    throw new CircuitExpansionError(
      'controlled-definition',
      `Operation "${operation.id}" puts a control on custom gate ` +
        `"${operation.gate}". A block cannot be controlled: control the ` +
        `operations inside it, or expand it first.`,
      frame.rootId ?? operation.id
    )
  }
  if (targets.length !== definition.qubits) {
    throw new CircuitExpansionError(
      'arity-mismatch',
      `Operation "${operation.id}" applies custom gate "${operation.gate}" ` +
        `to ${targets.length} qubit(s), but that gate is defined on ` +
        `${definition.qubits}.`,
      frame.rootId ?? operation.id
    )
  }
  const formals = definition.params ?? []
  const args = params ?? []
  if (args.length !== formals.length) {
    throw new CircuitExpansionError(
      'param-count-mismatch',
      `Operation "${operation.id}" passes ${args.length} argument(s) to ` +
        `custom gate "${operation.gate}", which declares ${formals.length}.`,
      frame.rootId ?? operation.id
    )
  }

  const inner: Frame = {
    qubitOf: targets,
    args,
    formals: new Map(formals.map((name, index) => [name, index])),
    rootId: frame.rootId ?? operation.id,
    // A condition on the instance governs the whole block. Nothing inside can
    // write to the classical register (a body has no clbits), so the register
    // cannot change mid-block and copying the read onto every operation means
    // exactly what conditioning the block means.
    condition: operation.condition ?? frame.condition,
    depth: frame.depth + 1,
  }

  let offset = 0
  for (const [, group] of groupByColumn(definition.operations)) {
    let width = 0
    for (const child of group) {
      width = Math.max(width, widthOf(emitter, child, inner.depth))
    }
    for (const child of group) emit(emitter, child, base + offset, inner)
    offset += width
  }
}

/**
 * Assign an optional field, or leave the key off entirely.
 *
 * The contract's objects are `strictObject` and an explicit `undefined` is a
 * present key: `{ controls: undefined }` round-trips through JSON as a missing
 * field but compares as a different object on the way there, and the editor
 * compares circuits structurally (`sameCircuit`).
 */
function setOptional<K extends keyof Operation>(
  operation: Operation,
  key: K,
  value: Operation[K] | undefined
): void {
  if (value === undefined) delete operation[key]
  else operation[key] = value
}

/** Record one emitted operation, minting a fresh id when it came from a body. */
function push(emitter: Emitter, emitted: Operation, frame: Frame): void {
  if (emitter.operations.length >= MAX_EXPANDED_OPERATIONS) {
    throw new CircuitExpansionError(
      'too-many-operations',
      `Expanding this circuit's custom gates would produce more than ` +
        `${MAX_EXPANDED_OPERATIONS} operations. Definitions that use other ` +
        `definitions multiply, so this can happen with very few gates on the ` +
        `canvas.`,
      frame.rootId
    )
  }

  if (frame.rootId === undefined) {
    // A top-level primitive keeps its own id, so an engine error about it
    // names the gate the user placed, with no lookup at all.
    emitter.operations.push(emitted)
    return
  }

  const id = mintId(emitter)
  emitter.originOf.set(id, frame.rootId)
  emitter.operations.push({ ...emitted, id })
}

/**
 * A short, unique id for an operation that came out of a definition.
 *
 * Deliberately not `${rootId}/${bodyId}`: ids are capped at 64 characters and
 * nesting concatenates, so the composed form would overflow on exactly the
 * documents this feature is for. The mapping a reader needs is kept in
 * `originOf` instead, which is where a diagnostic looks anyway.
 */
function mintId(emitter: Emitter): string {
  let id = `~${emitter.counter}`
  while (emitter.taken.has(id)) {
    emitter.counter += 1
    id = `~${emitter.counter}`
  }
  emitter.taken.add(id)
  emitter.counter += 1
  return id
}

/**
 * How many columns an operation occupies once expanded: one for a primitive,
 * the definition's own width for a block.
 *
 * `emitter.widths` memoises per definition, across every use of it, so a block
 * used ten times is measured once. The depth argument is the same bound `emit`
 * applies and for the same reason — this walk descends a chain of definitions
 * before a single operation has been emitted, so the operation ceiling cannot
 * be what stops it.
 */
function widthOf(
  emitter: Emitter,
  operation: Operation,
  depth: number
): number {
  if (!Object.hasOwn(emitter.definitions, operation.gate)) return 1
  return definitionWidth(emitter, operation.gate, depth)
}

function definitionWidth(
  emitter: Emitter,
  name: string,
  depth: number
): number {
  const known = emitter.widths.get(name)
  if (known !== undefined) return known
  if (depth >= MAX_CUSTOM_GATE_DEPTH) {
    throw new CircuitExpansionError(
      'too-deep',
      `Custom gate "${name}" is nested more than ${MAX_CUSTOM_GATE_DEPTH} ` +
        `levels deep.`
    )
  }
  // Claim the entry before descending: a cyclic document would otherwise
  // recurse forever here, and this function is reached from `gateCount`, which
  // is called on circuits nobody promised had been validated.
  emitter.widths.set(name, 0)

  let width = 0
  for (const [, group] of groupByColumn(
    emitter.definitions[name]?.operations ?? EMPTY_OPERATIONS
  )) {
    let column = 0
    for (const child of group) {
      column = Math.max(column, widthOf(emitter, child, depth + 1))
    }
    width += column
  }
  emitter.widths.set(name, width)
  return width
}

const EMPTY_OPERATIONS: readonly Operation[] = []

/**
 * Resolve an operation's parameters against the frame it is being emitted in.
 *
 * At the top level the parameters are already circuit-level and pass through.
 * Inside a definition each name is a *formal* of that definition and is
 * replaced by the argument bound to it — which may itself be a number or the
 * name of a circuit-level parameter, so a sweep still reaches a gate three
 * blocks deep.
 */
function bindParams(
  operation: Operation,
  frame: Frame
): ParamValue[] | undefined {
  const params = operation.params
  if (params === undefined) return undefined
  const formals = frame.formals
  if (formals === undefined) return [...params]
  return params.map((param) => {
    if (typeof param === 'number') return param
    const index = formals.get(param)
    if (index === undefined) {
      throw new CircuitExpansionError(
        'unknown-parameter',
        `Operation "${operation.id}" reads parameter "${param}", which the ` +
          `custom gate containing it does not declare in "params".`,
        frame.rootId
      )
    }
    return frame.args[index] ?? 0
  })
}

function mapQubits(
  qubits: readonly number[],
  qubitOf: readonly number[]
): number[] {
  return qubits.map((qubit) => qubitOf[qubit] ?? qubit)
}

/**
 * Controls, remapped through the frame.
 *
 * THE SPELLING IS PRESERVED, NOT NORMALISED. A body control written
 * `{ qubit: 0, state: 1 }` comes out as `{ qubit: 2, state: 1 }` and never as
 * the bare number `2`, because rewriting a document's own spelling is a change
 * this function has no reason to make — `normalizeControl` exists for readers
 * that need one form. So an expanded circuit and a hand-built one may differ
 * byte for byte while being the same circuit, and anything comparing them
 * structurally (a canonical-JSON key, a diff) has to normalise first.
 * `earliestChangedColumn` does; `canonicalWork` never sees an expanded circuit,
 * because it hashes the payload as it was submitted.
 */
function mapControls(
  controls: readonly Control[] | undefined,
  frame: Frame
): Control[] | undefined {
  if (controls === undefined || controls.length === 0) return undefined
  if (frame.formals === undefined) return [...controls]
  return controls.map((control) => {
    if (typeof control === 'number') return frame.qubitOf[control] ?? control
    return { ...control, qubit: frame.qubitOf[control.qubit] ?? control.qubit }
  })
}

/** Operations grouped by column, ascending. Gaps are skipped, as they are in the engine. */
function groupByColumn(
  operations: readonly Operation[]
): [number, Operation[]][] {
  const byColumn = new Map<number, Operation[]>()
  for (const operation of operations) {
    const bucket = byColumn.get(operation.column)
    if (bucket === undefined) byColumn.set(operation.column, [operation])
    else bucket.push(operation)
  }
  return [...byColumn.entries()].sort((left, right) => left[0] - right[0])
}
