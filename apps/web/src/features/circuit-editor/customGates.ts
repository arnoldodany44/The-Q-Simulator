/**
 * Packaging a fragment into a block, and the rules that make it safe — §3.1,
 * milestone M2.3.
 *
 * The store owns the transitions; this file owns the arithmetic, so the
 * interesting questions can be asked of a function instead of a component.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PACKAGING MUST NOT CHANGE THE CIRCUIT
 *
 * That sounds obvious and it is the one thing that is easy to get wrong. A
 * block occupies **one column** on the canvas and expands to as many columns as
 * its body takes (`expand.ts`), so wrapping a three-column selection collapses
 * three columns into one and pushes everything after it back by two. Any
 * operation that was living inside those three columns — even on a wire the
 * selection never touched — would move relative to the block, which is a
 * different circuit.
 *
 * So the selection has to be a **rectangle in time**: every operation between
 * the first and last column of the selection must be part of it. That is one
 * sentence a user can act on ("select the whole column range"), and it buys an
 * exact property, pinned in the tests: expanding the packaged document
 * reproduces the original operations, on the same wires, in the same columns.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A SELECTION THAT USES AN ANGLE BECOMES A GATE THAT TAKES ONE
 *
 * Every circuit-level parameter the fragment reads becomes a formal parameter
 * of the new definition, in first-appearance order, and the placed instance
 * passes those same names straight back. So packaging a fragment that used
 * `theta` gives a block whose slider is still `theta` in *this* document, and a
 * block that can be given a different angle in the next one. Doing anything
 * else would either freeze the current value into the definition — a macro,
 * not a gate — or leave a definition that reads a name it does not declare,
 * which the contract refuses on purpose.
 */

import {
  isGateId,
  qubitsOf,
  type Circuit,
  type CustomGate,
  type Operation,
  type ParamValue,
} from '@qsim/schema'

/**
 * Names a definition may take. The contract enforces the same shape on the
 * record key, so this exists to turn "the document does not parse" into a
 * sentence about the box the user typed in.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_NAME_LENGTH = 64

/** Longest icon a block may carry — the contract's own `symbol` bound. */
export const MAX_SYMBOL_LENGTH = 8

export type PackagingRefusal =
  | 'empty-selection'
  | 'custom-gate-name'
  | 'custom-gate-exists'
  | 'fragment-not-rectangular'

export interface PackagedFragment {
  readonly definition: CustomGate
  readonly instance: Operation
}

export type PackagingResult =
  | { readonly ok: true; readonly packaged: PackagedFragment }
  | { readonly ok: false; readonly reason: PackagingRefusal }

/**
 * Whether `name` may be used for a new definition in `circuit`.
 *
 * Catalog gates are refused by name rather than by shadowing: a document with
 * a custom gate called `h` would resolve to the built-in everywhere the
 * resolver looks it up first, so the definition would exist and never run.
 */
export function customGateNameIssue(
  circuit: Circuit,
  name: string
): 'custom-gate-name' | 'custom-gate-exists' | null {
  if (!IDENTIFIER.test(name) || name.length > MAX_NAME_LENGTH) {
    return 'custom-gate-name'
  }
  if (isGateId(name)) return 'custom-gate-name'
  if (Object.hasOwn(circuit.customGates ?? {}, name)) {
    return 'custom-gate-exists'
  }
  return null
}

/**
 * Turn the selected operations into a definition and the one operation that
 * stands for them.
 *
 * Returns the pieces rather than a circuit: the store owns id minting and
 * validation, and a function that both computed *and* committed would be a
 * second path to `set()` (rule 2 of the store's header).
 */
export function packageFragment(
  circuit: Circuit,
  selection: readonly string[],
  name: string,
  options: { readonly symbol?: string; readonly instanceId: string }
): PackagingResult {
  const nameIssue = customGateNameIssue(circuit, name)
  if (nameIssue !== null) return { ok: false, reason: nameIssue }

  const wanted = new Set(selection)
  const selected = circuit.operations.filter((operation) =>
    wanted.has(operation.id)
  )
  if (selected.length === 0) return { ok: false, reason: 'empty-selection' }

  const columns = selected.map((operation) => operation.column)
  const firstColumn = Math.min(...columns)
  const lastColumn = Math.max(...columns)

  const trespasser = circuit.operations.some(
    (operation) =>
      !wanted.has(operation.id) &&
      operation.column >= firstColumn &&
      operation.column <= lastColumn
  )
  if (trespasser) return { ok: false, reason: 'fragment-not-rectangular' }

  const qubits = selected.flatMap(qubitsOf)
  const firstQubit = Math.min(...qubits)
  const lastQubit = Math.max(...qubits)

  const params = formalsOf(selected)
  const operations = selected.map((operation) =>
    rebase(operation, firstQubit, firstColumn)
  )

  const definition: CustomGate = {
    qubits: lastQubit - firstQubit + 1,
    ...(params.length === 0 ? {} : { params }),
    operations,
    ...(options.symbol === undefined || options.symbol.length === 0
      ? {}
      : { symbol: options.symbol }),
  }

  const instance: Operation = {
    id: options.instanceId,
    gate: name,
    // Every wire from the topmost to the bottommost, including any the
    // selection skipped: a block is a rectangle on the canvas, and a wire
    // running under one is a wire the block has claimed.
    targets: Array.from(
      { length: definition.qubits },
      (_, index) => firstQubit + index
    ),
    column: firstColumn,
    ...(params.length === 0 ? {} : { params: [...params] }),
  }

  return { ok: true, packaged: { definition, instance } }
}

/**
 * The circuit with the selection replaced by the block that stands for it.
 *
 * Everything after the fragment moves back by the columns the fragment
 * occupied minus the one the block now takes, which is what keeps the expanded
 * circuit identical to the one that was packaged.
 */
export function withFragmentPackaged(
  circuit: Circuit,
  selection: readonly string[],
  name: string,
  packaged: PackagedFragment
): Circuit {
  const wanted = new Set(selection)
  const selected = circuit.operations.filter((operation) =>
    wanted.has(operation.id)
  )
  const columns = selected.map((operation) => operation.column)
  const firstColumn = Math.min(...columns)
  const lastColumn = Math.max(...columns)
  const collapsed = lastColumn - firstColumn

  const operations = circuit.operations
    .filter((operation) => !wanted.has(operation.id))
    .map((operation) =>
      operation.column > lastColumn
        ? { ...operation, column: operation.column - collapsed }
        : operation
    )

  return {
    ...circuit,
    operations: [...operations, packaged.instance],
    customGates: {
      ...circuit.customGates,
      [name]: packaged.definition,
    },
  }
}

/**
 * The first column at which a block of `height` wires starting at `qubit`
 * fits with nothing already on those wires — where the panel's "place" button
 * puts it.
 *
 * Scanning for a free column rather than appending at the end: a document
 * whose last gate sits in column 40 with the first ten columns half empty
 * would otherwise place every block forty columns off screen.
 */
export function firstFreeColumn(
  circuit: Circuit,
  qubit: number,
  height: number
): number {
  const wires = new Set(
    Array.from({ length: height }, (_, index) => qubit + index)
  )
  const occupied = new Set<number>()
  for (const operation of circuit.operations) {
    if (qubitsOf(operation).some((used) => wires.has(used))) {
      occupied.add(operation.column)
    }
  }
  let column = 0
  while (occupied.has(column)) column += 1
  return column
}

/**
 * Every circuit parameter the fragment reads, in first-appearance order.
 *
 * Order is the definition's calling convention, so it has to be stable and it
 * has to be something a reader can predict. "The order they appear as you read
 * the fragment left to right" is that; alphabetical would put `beta` before
 * `alpha` in a rotation the user thinks of as (α, β).
 */
function formalsOf(operations: readonly Operation[]): string[] {
  const names: string[] = []
  const ordered = [...operations].sort(
    (left, right) => left.column - right.column
  )
  for (const operation of ordered) {
    for (const param of operation.params ?? []) {
      if (typeof param !== 'string') continue
      if (!names.includes(param)) names.push(param)
    }
  }
  return names
}

/** One operation, moved into the definition's own coordinate system. */
function rebase(
  operation: Operation,
  firstQubit: number,
  firstColumn: number
): Operation {
  const moved: Operation = {
    ...operation,
    targets: operation.targets.map((qubit) => qubit - firstQubit),
    column: operation.column - firstColumn,
  }
  if (operation.controls !== undefined) {
    moved.controls = operation.controls.map((control) =>
      typeof control === 'number'
        ? control - firstQubit
        : { ...control, qubit: control.qubit - firstQubit }
    )
  }
  return moved
}

/**
 * A definition changed in ways its existing uses cannot survive.
 *
 * The register width and the parameter count are the calling convention: a
 * block that grew a wire cannot be applied to the targets already written down
 * for it, and there is no honest guess about *which* wire the new one should
 * be. So the editor refuses rather than repairing, and the panel says how many
 * uses are in the way — which is also the moment the user learns that editing a
 * definition changes all of them.
 */
export function reshapesUses(
  before: CustomGate,
  after: CustomGate
): 'qubits' | 'params' | null {
  if (before.qubits !== after.qubits) return 'qubits'
  if ((before.params?.length ?? 0) !== (after.params?.length ?? 0)) {
    return 'params'
  }
  return null
}

/**
 * A definition's body as a document, for editing it on the ordinary canvas.
 *
 * Formal parameters become circuit parameters so the sliders work: inside the
 * definition editor `theta` *is* a value, and it is the value the reader drags
 * to see what the block does. `parameterValues` carries whatever the host
 * document had for a name that matches, so opening a definition does not reset
 * the angle the user was looking at.
 */
export function definitionAsDocument(
  definition: CustomGate,
  parameterValues: ReadonlyMap<string, number>
): Circuit {
  const params = definition.params ?? []
  return {
    schemaVersion: 1,
    qubits: definition.qubits,
    clbits: 0,
    operations: definition.operations.map((operation) => ({ ...operation })),
    ...(params.length === 0
      ? {}
      : {
          parameters: params.map((name) => ({
            name,
            value: parameterValues.get(name) ?? 0,
          })),
        }),
  }
}

/** The inverse: a document edited on the canvas, back as a definition. */
export function documentAsDefinition(
  document: Circuit,
  symbol: string | undefined
): CustomGate {
  const params = (document.parameters ?? []).map(
    (parameter: { name: string }) => parameter.name
  )
  return {
    qubits: document.qubits,
    ...(params.length === 0 ? {} : { params }),
    operations: document.operations.map((operation) => ({ ...operation })),
    ...(symbol === undefined ? {} : { symbol }),
  }
}

/** Whether a value would be accepted as a block's icon. */
export function isUsableSymbol(symbol: string): boolean {
  return symbol.length > 0 && symbol.length <= MAX_SYMBOL_LENGTH
}

/** Every parameter of the circuit, by name — what a definition editor seeds from. */
export function parameterValues(circuit: Circuit): Map<string, number> {
  return new Map(
    (circuit.parameters ?? []).map((parameter) => [
      parameter.name,
      parameter.value,
    ])
  )
}

/** Every declared definition, name first, in a stable order for the panel. */
export function definitionsOf(circuit: Circuit): [string, CustomGate][] {
  return Object.entries(circuit.customGates ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )
}

/** A definition's parameter list as the panel prints it: `name(a, b)`. */
export function signatureOf(name: string, definition: CustomGate): string {
  const params = definition.params ?? []
  return params.length === 0 ? name : `${name}(${params.join(', ')})`
}

/** The arguments a fresh placement passes: zero for every formal. */
export function defaultArguments(definition: CustomGate): ParamValue[] {
  return Array.from({ length: definition.params?.length ?? 0 }, () => 0)
}
