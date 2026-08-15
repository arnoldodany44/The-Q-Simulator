/**
 * What changed between two versions of a circuit — §3.4, milestone M1.4b.
 *
 * ── Why this is not a text diff ───────────────────────────────────────────
 *
 * A circuit is a grid of operations, not a sequence of lines, and the two
 * facts that make a line diff work are both false here. Lines have an order
 * that carries meaning; operations do not — `operations` is a bag, and §6 says
 * a column is one instant, so two documents whose columns hold the same gates
 * in a different array order are *the same circuit* and any honest diff reports
 * nothing. And a line is identified by its content; an operation is identified
 * by where it stands, which is exactly what a move changes.
 *
 * So the comparison is by identity and position, and the whole file is pure:
 * no React, no i18next, no SVG. `CircuitDiffView` renders the result and
 * `circuitDiff.test.ts` checks it against expectations written by hand,
 * including the reorder-within-a-column case that a naive implementation gets
 * wrong and that nothing else in the system would catch.
 *
 * ── How two operations are recognised as the same operation ───────────────
 *
 * Five matchers, tried in order, each greedy and each deterministic. Every
 * pass takes the `before` operations in document order and, among the `after`
 * operations still unclaimed, takes the nearest candidate it accepts.
 *
 *   1. **The same operation, standing in the same cells.** Same place, same
 *      gate, same tuning — nothing about it differs except possibly its id.
 *      This pass has to come first, and the reason is narrow and real: two
 *      identical gates in one column whose ids were exchanged would otherwise
 *      be paired by id across the two wires and reported as two moves nobody
 *      made, for documents that draw the same picture. Anything this pass
 *      claims is `unchanged` by construction, so it can never take a pairing
 *      away from a matcher that would have said something truer.
 *   2. **Same id, same gate.** Every editor action preserves an operation's id
 *      across a move, a retune and a control change, and mints a fresh one for
 *      anything new — so a shared id is the strongest evidence available that
 *      two operations are one operation. The gate has to agree as well: ids are
 *      only unique *within* a document, two versions can descend from
 *      unrelated lineages (a document loaded over another one brings its own
 *      ids), and pairing an `H` with a `SWAP` because both happen to be `op_1`
 *      would report a fiction.
 *   3. **Same place.** The same column and the same cells, which is the one
 *      thing a circuit cannot have twice: a cell holds one operation. Whatever
 *      differs about a pair matched here — the gate itself, its angles, its
 *      controls — is a change in place rather than a removal and an addition.
 *   4. **Same gate, same tuning, sharing an axis.** A gate dragged along a wire
 *      or across a column, with nothing else about it touched.
 *   5. **Same gate, sharing an axis.** The same drag, on a gate that was also
 *      retuned.
 *
 * "Sharing an axis" — the same column, or the same targets — is a deliberate
 * brake on the last two passes. Without it, an `H` added in column 9 and an
 * unrelated `H` removed from column 0 would be paired and reported as a long
 * diagonal move that nobody made. A genuine diagonal drag keeps its id and is
 * caught by pass 2; the fallbacks only run for documents whose ids share
 * nothing, and there the conservative answer — an addition and a removal — is
 * the one that misleads least.
 *
 * ── Moved versus changed ──────────────────────────────────────────────────
 *
 * `moved` means the operation stands somewhere else: a different column, or
 * different wires. Everything else it carries — the gate symbol, its controls,
 * its angles, its classical wiring — is what it *is* rather than where it is,
 * and produces `changed`. Adding a control therefore does not read as a move,
 * even though it makes the operation reach one wire further.
 *
 * "Somewhere else" is the set of cells, not the order of `targets`. A CNOT
 * whose targets went from `[0, 1]` to `[1, 0]` occupies exactly the cells it
 * did, and calling that a move produced the sentence "SWAP moved from q0 and
 * q1, moment 1, to q0 and q1, moment 1" — a move from a place to that same
 * place, with no arrow drawn because the distance was zero. The reordering is
 * real and it is reported, as the `order` aspect, which is what actually
 * differs.
 *
 * A pair that both moved and was retuned is reported once, as `moved`, with
 * every difference listed in `aspects`; the headline is the thing you can see
 * on the diagram from across the room, and the aspects are the detail.
 *
 * ── What is compared besides the operations ───────────────────────────────
 *
 * The register widths, the wire names, the circuit's named `parameters` and
 * its `customGates`. The last two are not decoration: a version saved because
 * θ was retuned from 0 to π simulates differently from its predecessor, and
 * reporting "these two versions hold the same circuit" about it is the one
 * kind of wrong a diff must never be. Today's editor authors neither, but the
 * URL codec packs and unpacks both and the API stores both, so an imported or
 * hand-built document reaches here.
 */

import {
  controlsOf,
  type Circuit,
  type Condition,
  type ControlSpec,
  type Operation,
  type ParamValue,
} from '@qsim/schema'

/**
 * What happened to one operation.
 *
 * `unchanged` entries are kept rather than filtered out: the view draws the
 * whole circuit and needs to know which parts of it are the unremarkable ones,
 * and a caller that only wants the news can filter on this field.
 */
export const DIFF_KINDS = [
  'added',
  'removed',
  'moved',
  'changed',
  'unchanged',
] as const

export type DiffKind = (typeof DIFF_KINDS)[number]

/**
 * The ways two matched operations can differ. Listed in this order in every
 * entry, so an expectation can be written down and stay written down.
 */
export const DIFF_ASPECTS = [
  /** A different gate stands here. */
  'gate',
  /** It runs at a different moment. */
  'column',
  /** It stands on different wires. */
  'qubits',
  /**
   * The same wires, listed in a different order. For a two-target gate that
   * order is part of the document — `CNOT(0,1)` is not `CNOT(1,0)` — so it is
   * a difference, and it is not a move: the operation occupies the same cells.
   */
  'order',
  /** Its controls differ — which wires, or whether one fires on zero. */
  'controls',
  /** Its angles differ. */
  'params',
  /** Its classical write or the condition it reads differ. */
  'classical',
] as const

export type DiffAspect = (typeof DIFF_ASPECTS)[number]

export interface DiffEntry {
  readonly kind: DiffKind
  /** The operation as the older version had it; `null` for an addition. */
  readonly before: Operation | null
  /** The operation as the newer version has it; `null` for a removal. */
  readonly after: Operation | null
  /** Every way the two differ, in `DIFF_ASPECTS` order. Empty when identical. */
  readonly aspects: readonly DiffAspect[]
}

/** A register that grew or shrank. */
export interface RegisterChange {
  readonly before: number
  readonly after: number
}

export interface CircuitDiff {
  /** Every operation of both versions, once each, in reading order. */
  readonly entries: readonly DiffEntry[]
  readonly counts: Readonly<Record<DiffKind, number>>
  /** `null` when the register is the same width in both. */
  readonly qubits: RegisterChange | null
  readonly clbits: RegisterChange | null
  /** Whether a wire *present in both versions* is named differently. */
  readonly labelsChanged: boolean
  /** Whether the circuit's named parameters differ, by name or by value. */
  readonly parametersChanged: boolean
  /** Whether any reusable subcircuit was added, removed or redefined. */
  readonly customGatesChanged: boolean
  /**
   * The two versions say the same thing. Not "the two JSON documents are
   * equal": a reordered `operations` array is identical by this measure, and
   * so it should be.
   */
  readonly identical: boolean
}

/* ── The public entry point ─────────────────────────────────────────────── */

export function diffCircuits(before: Circuit, after: Circuit): CircuitDiff {
  const pairs = matchOperations(before.operations, after.operations)

  const entries: DiffEntry[] = []
  const matchedBefore = new Set<Operation>()
  const matchedAfter = new Set<Operation>()

  for (const [left, right] of pairs) {
    matchedBefore.add(left)
    matchedAfter.add(right)
    const aspects = aspectsOf(left, right)
    entries.push({
      kind:
        aspects.length === 0
          ? 'unchanged'
          : movedBetween(left, right)
            ? 'moved'
            : 'changed',
      before: left,
      after: right,
      aspects,
    })
  }

  for (const operation of before.operations) {
    if (matchedBefore.has(operation)) continue
    entries.push({
      kind: 'removed',
      before: operation,
      after: null,
      aspects: [],
    })
  }

  for (const operation of after.operations) {
    if (matchedAfter.has(operation)) continue
    entries.push({ kind: 'added', before: null, after: operation, aspects: [] })
  }

  entries.sort(byReadingOrder)

  const counts = tally(entries)
  const qubits = registerChange(before.qubits, after.qubits)
  const clbits = registerChange(before.clbits, after.clbits)
  const labelsChanged = !sameLabels(before, after)
  const parametersChanged = !sameParameters(before, after)
  const customGatesChanged = !sameJson(
    before.customGates ?? {},
    after.customGates ?? {}
  )

  return {
    entries,
    counts,
    qubits,
    clbits,
    labelsChanged,
    parametersChanged,
    customGatesChanged,
    identical:
      qubits === null &&
      clbits === null &&
      !labelsChanged &&
      !parametersChanged &&
      !customGatesChanged &&
      counts.added === 0 &&
      counts.removed === 0 &&
      counts.moved === 0 &&
      counts.changed === 0,
  }
}

/** The entries worth reading: everything but the parts that stayed put. */
export function changedEntries(diff: CircuitDiff): DiffEntry[] {
  return diff.entries.filter((entry) => entry.kind !== 'unchanged')
}

/**
 * The cells an operation occupies: one per wire it touches, all in its column.
 * The view outlines exactly these, so the outline is the operation's footprint
 * rather than a box guessed from its targets.
 */
export function operationCells(
  operation: Operation
): { readonly qubit: number; readonly column: number }[] {
  const qubits = new Set<number>(operation.targets)
  for (const control of controlsOf(operation)) qubits.add(control.qubit)
  return [...qubits]
    .sort((left, right) => left - right)
    .map((qubit) => ({ qubit, column: operation.column }))
}

/* ── Matching ───────────────────────────────────────────────────────────── */

type Matcher = (left: Operation, right: Operation) => boolean

/**
 * The four passes of the header, in order. Each is a predicate; the driver
 * below supplies the greed and the determinism, so a pass is a statement about
 * *when* two operations may be paired and nothing else.
 */
const MATCHERS: readonly Matcher[] = [
  (left, right) =>
    samePlace(left, right) &&
    left.gate === right.gate &&
    sameTuning(left, right) &&
    sameNumbers(left.targets, right.targets),
  (left, right) => left.id === right.id && left.gate === right.gate,
  (left, right) => samePlace(left, right),
  (left, right) =>
    left.gate === right.gate &&
    sameTuning(left, right) &&
    sharesAxis(left, right),
  (left, right) => left.gate === right.gate && sharesAxis(left, right),
]

function matchOperations(
  before: readonly Operation[],
  after: readonly Operation[]
): [Operation, Operation][] {
  const pending = [...before].sort(byPlace)
  const available = [...after].sort(byPlace)
  const claimed = new Set<Operation>()
  const pairs: [Operation, Operation][] = []

  for (const matcher of MATCHERS) {
    for (let index = 0; index < pending.length; index += 1) {
      const left = pending[index]
      if (left === undefined) continue

      let best: Operation | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const right of available) {
        if (claimed.has(right)) continue
        if (!matcher(left, right)) continue
        /*
         * The nearest candidate wins, and ties go to the earlier one in
         * document order — which `available` is already sorted into. Without
         * a rule here the result would depend on array order, and array order
         * is precisely the thing this module refuses to treat as meaningful.
         */
        const distance = placeDistance(left, right)
        if (distance < bestDistance) {
          best = right
          bestDistance = distance
        }
      }

      if (best === null) continue
      claimed.add(best)
      pairs.push([left, best])
      pending.splice(index, 1)
      index -= 1
    }
  }

  return pairs
}

/**
 * Same column and the same target wires: the operation did not move.
 *
 * The targets as a *set*, not as a sequence — a two-target gate whose wires
 * were listed the other way round stands exactly where it stood, and calling
 * that a move produced "SWAP moved from q0 and q1, moment 1, to q0 and q1,
 * moment 1". The reordering is reported as the `order` aspect instead.
 *
 * Controls are deliberately not part of "where": adding one makes the
 * operation reach a wire further and does not move it. See the header.
 */
function samePlace(left: Operation, right: Operation): boolean {
  if (left.column !== right.column) return false
  return sameNumbers(targetSet(left), targetSet(right))
}

/** The wires an operation acts on, sorted and without repeats. */
function targetSet(operation: Operation): number[] {
  return [...new Set(operation.targets)].sort((a, b) => a - b)
}

/** Same column *or* the same targets: it moved along one axis at most. */
function sharesAxis(left: Operation, right: Operation): boolean {
  return (
    left.column === right.column || sameNumbers(left.targets, right.targets)
  )
}

/** Everything about an operation except the gate and where it stands. */
function sameTuning(left: Operation, right: Operation): boolean {
  return (
    sameControls(left, right) &&
    sameParams(left, right) &&
    sameClassical(left, right)
  )
}

/**
 * How far apart two operations stand. Columns dominate wires because the
 * horizontal axis is time and the vertical one is the register: a gate found
 * one column away is far more likely to be the same gate than one found on a
 * wire eight rows down in another moment.
 */
function placeDistance(left: Operation, right: Operation): number {
  const columns = Math.abs(left.column - right.column)
  const wires = Math.abs(lowestQubit(left) - lowestQubit(right))
  return columns * 1024 + wires
}

/* ── Classification ─────────────────────────────────────────────────────── */

function aspectsOf(left: Operation, right: Operation): DiffAspect[] {
  const aspects: DiffAspect[] = []
  if (left.gate !== right.gate) aspects.push('gate')
  if (left.column !== right.column) aspects.push('column')
  /*
   * Different wires and the same wires in a different order are two different
   * pieces of news, and only the first is a move. Collapsing them produced a
   * "moved from q0 and q1 to q0 and q1" line that said nothing true.
   */
  if (!sameNumbers(targetSet(left), targetSet(right))) {
    aspects.push('qubits')
  } else if (!sameNumbers(left.targets, right.targets)) {
    aspects.push('order')
  }
  if (!sameControls(left, right)) aspects.push('controls')
  if (!sameParams(left, right)) aspects.push('params')
  if (!sameClassical(left, right)) aspects.push('classical')
  return aspects
}

/** It stands somewhere else. See the header on why controls do not count. */
function movedBetween(left: Operation, right: Operation): boolean {
  return !samePlace(left, right)
}

/* ── Field comparisons ──────────────────────────────────────────────────── */

/**
 * Targets are compared as a *sequence*. For a two-target gate the order is
 * part of the document, and a document that differs is a document that
 * differs — the reordering this module forgives is the one §6 declares
 * meaningless, which is the order of operations inside a column, not the order
 * of wires inside an operation.
 */
function sameNumbers(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

/**
 * Controls are compared as a *set*, sorted by wire first. Nothing reads them
 * positionally — a control is a wire and a polarity — so listing q2 before q0
 * is a spelling difference and reporting it would be noise in every entry that
 * carried it.
 */
function sameControls(left: Operation, right: Operation): boolean {
  const ordered = (operation: Operation): ControlSpec[] =>
    controlsOf(operation).sort((a, b) => a.qubit - b.qubit)
  const a = ordered(left)
  const b = ordered(right)
  return (
    a.length === b.length &&
    a.every((control, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        control.qubit === other.qubit &&
        control.state === other.state
      )
    })
  )
}

/** Angles, positionally: `Rz(θ)` and `U(θ, φ, λ)` read their slots by index. */
function sameParams(left: Operation, right: Operation): boolean {
  const a: readonly ParamValue[] = left.params ?? []
  const b: readonly ParamValue[] = right.params ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameClassical(left: Operation, right: Operation): boolean {
  return (
    sameNumbers(left.clbitTargets ?? [], right.clbitTargets ?? []) &&
    sameCondition(left.condition, right.condition)
  )
}

function sameCondition(
  left: Condition | undefined,
  right: Condition | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.clbit === right.clbit && left.equals === right.equals
}

/**
 * Whether a wire *that exists in both versions* carries a different name.
 *
 * The width is the narrower register, not the wider one. Walking to the wider
 * one compared a wire that exists on one side against a `null` on the other,
 * so every register that grew or shrank was reported as "at least one wire was
 * renamed" — a change the reader did not make, printed next to the line that
 * already explained what did happen. A wire that exists in only one version is
 * a register change, and the register change is already reported.
 */
function sameLabels(before: Circuit, after: Circuit): boolean {
  const width = Math.min(before.qubits, after.qubits)
  for (let qubit = 0; qubit < width; qubit += 1) {
    // An absent list means every wire carries its default name, and a document
    // that named its wires `q0, q1, …` by hand says the same thing as one that
    // named none of them. Comparing the resolved name is what keeps that from
    // being reported as a change nobody made.
    if (labelOf(before, qubit) !== labelOf(after, qubit)) return false
  }
  return true
}

function labelOf(circuit: Circuit, qubit: number): string {
  return circuit.qubitLabels?.[qubit] ?? `q${qubit}`
}

/**
 * The circuit's named parameters, compared by name rather than by position.
 *
 * `params: ['theta']` on an operation is a *reference*; nothing in the
 * operation comparison resolves it, so two versions differing only in what θ
 * is set to matched on every operation and came back identical. Declaration
 * order carries no meaning — a parameter is found by name — so reordering the
 * list is not a change.
 */
function sameParameters(before: Circuit, after: Circuit): boolean {
  const named = (circuit: Circuit): Record<string, number> => {
    const values: Record<string, number> = {}
    for (const parameter of circuit.parameters ?? []) {
      values[parameter.name] = parameter.value
    }
    return values
  }
  return sameJson(named(before), named(after))
}

/**
 * Structural equality over the JSON a circuit is made of.
 *
 * Local rather than imported from the store: this module is pure by design —
 * no React, no i18next, no Zustand — and the one function it would borrow is
 * eight lines.
 */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  }
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  ) {
    return false
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/* ── Small helpers ──────────────────────────────────────────────────────── */

function registerChange(before: number, after: number): RegisterChange | null {
  return before === after ? null : { before, after }
}

function lowestQubit(operation: Operation): number {
  let lowest = operation.targets[0] ?? 0
  for (const target of operation.targets) lowest = Math.min(lowest, target)
  for (const control of controlsOf(operation)) {
    lowest = Math.min(lowest, control.qubit)
  }
  return lowest
}

/** Reading order for operations: left to right, then top to bottom. */
function byPlace(left: Operation, right: Operation): number {
  return (
    left.column - right.column ||
    lowestQubit(left) - lowestQubit(right) ||
    compareIds(left.id, right.id)
  )
}

/**
 * Reading order for entries, anchored on where the operation ends up — or,
 * for a removal, where it used to be. A stable total order matters more than
 * which one it is: the change list and the test expectations both read from
 * it, and `Array.prototype.sort` being stable is not enough when two entries
 * genuinely tie.
 */
function byReadingOrder(left: DiffEntry, right: DiffEntry): number {
  const a = left.after ?? left.before
  const b = right.after ?? right.before
  if (a === null || b === null) return 0
  return byPlace(a, b)
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function tally(entries: readonly DiffEntry[]): Record<DiffKind, number> {
  const counts: Record<DiffKind, number> = {
    added: 0,
    removed: 0,
    moved: 0,
    changed: 0,
    unchanged: 0,
  }
  for (const entry of entries) counts[entry.kind] += 1
  return counts
}
