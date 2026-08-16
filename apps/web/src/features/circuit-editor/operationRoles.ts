/**
 * How an operation presents itself on each wire it touches.
 *
 * Two consumers need the same answer and must never disagree about it:
 * `GateNode` draws a shape on every occupied wire, and `CircuitCanvas`
 * writes a sentence about every occupied cell for the accessibility layer.
 * If the drawing said "control" where the description said "target", a
 * screen reader user and a sighted user would be looking at different
 * circuits. So the classification lives here once, free of React and of
 * i18next, and both read from it.
 *
 * i18next is kept out on purpose: this module returns *segments* — an
 * untranslatable notation token, or a catalog key plus its interpolations —
 * and the component turns them into text. That is what keeps gate symbols
 * flowing through `Notation` (decision D2) instead of being pasted into the
 * middle of a translated sentence where no lint rule can see them.
 */

import {
  controlsOf,
  lookupGate,
  type Circuit,
  type Operation,
  type ParamValue,
} from '@qsim/schema'

import { gateSymbol, targetShape } from './gateGlyphs'
import { defaultQubitLabel } from './useCircuitStore'

/*
 * The glyph table moved to `gateGlyphs.ts` in M1.5b and is re-exported here so
 * that every existing caller is untouched — and so that there is still exactly
 * one table. It had to move because this module reaches `useCircuitStore`,
 * which builds the document store at module scope: a bundler cannot shake that
 * away, so the gallery's thumbnail would have carried Zustand and the whole
 * undo history to find out whether a `cx` is drawn as a plus. See that file.
 */
export { boxLabel, gateSymbol, paramLabel, targetShape } from './gateGlyphs'
export type { TargetShape } from './gateGlyphs'

/** What a wire does for an operation, from that wire's point of view. */
export type WireRole = 'target' | 'control' | 'negative-control'

/**
 * The role a qubit plays in an operation, or `null` when the operation does
 * not touch it. Controls are checked first: the contract forbids a qubit
 * being both, so the order only decides which lookup runs, not the answer.
 */
export function roleOnQubit(
  operation: Operation,
  qubit: number
): WireRole | null {
  for (const control of controlsOf(operation)) {
    if (control.qubit === qubit) {
      return control.state === 1 ? 'control' : 'negative-control'
    }
  }
  return operation.targets.includes(qubit) ? 'target' : null
}

/** Display name of a wire: the user's own label, or `q0` when unnamed. */
export function qubitLabel(circuit: Circuit, index: number): string {
  return circuit.qubitLabels?.[index] ?? defaultQubitLabel(index)
}

/** Classical bits have no user-settable names; `c0` is their only name. */
export function clbitLabel(index: number): string {
  return `c${index}`
}

/**
 * `q0`, `q0 and q1`, `q0, q1 and q2` — joined the way the active language
 * joins a list.
 *
 * `Intl.ListFormat` rather than `", "`: the conjunction is a different word
 * in each of the three languages and a comma-separated list read aloud is
 * not how any of them enumerates. The names themselves are notation and are
 * left exactly as they are.
 */
export function formatWireList(
  names: readonly string[],
  locale: string
): string {
  return new Intl.ListFormat(locale, {
    style: 'long',
    type: 'conjunction',
  }).format(names)
}

/**
 * Parameter names as the literature spells them. `theta` is what survives a
 * round trip through OpenQASM, `θ` is what a physicist reads, and the
 * contract stores the former — so the translation happens at the last
 * possible moment, here.
 */
const PARAM_SYMBOLS: Readonly<Record<string, string>> = {
  theta: 'θ',
  phi: 'φ',
  lambda: 'λ',
}

/**
 * `θ = 1.571, φ = 0`, with the numbers formatted for the active locale —
 * French writes `1,571`, and an angle that reads as a thousands separator
 * is worse than no angle at all (see D2's note on `Intl.NumberFormat`).
 * A symbolic parameter is passed through untouched: it is an identifier,
 * not a quantity.
 */
export function formatParams(
  names: readonly string[],
  values: readonly ParamValue[],
  locale: string
): string {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 })
  return values
    .map((value, index) => {
      const raw = names[index] ?? ''
      const name = PARAM_SYMBOLS[raw] ?? raw
      const shown = typeof value === 'number' ? format.format(value) : value
      return name === '' ? shown : `${name} = ${shown}`
    })
    .join(', ')
}

/**
 * One piece of a cell's accessible description.
 *
 *  - `notation` is invariant across locales and renders through `Notation`
 *  - `phrase` is a catalog key in the `editor` namespace
 *  - `params` carries raw values because formatting them needs the locale
 *
 * `wires` on a phrase is the one interpolation this module cannot finish on
 * its own. "controlled by q0, q1" is prose, and prose enumerates with a
 * conjunction — `q0 and q1`, `q0 y q1`, `q0 et q1` — so the names travel as a
 * list and the view joins them with `Intl.ListFormat` for the active locale.
 * That is the same argument this module already makes for `Intl.NumberFormat`
 * in `formatParams`; a hard-coded ", " was the one place it was not applied.
 */
export type CellSegment =
  | { readonly kind: 'notation'; readonly value: string }
  | {
      readonly kind: 'phrase'
      readonly key: string
      readonly values?: Readonly<Record<string, string>>
      /** Names to join into `{{qubits}}` the way the locale joins a list. */
      readonly wires?: readonly string[]
    }
  | {
      readonly kind: 'params'
      readonly names: readonly string[]
      readonly values: readonly ParamValue[]
    }

/**
 * What to say about the cell where `operation` meets `qubit`.
 *
 * Written from the wire's point of view, because that is how a screen reader
 * arrives: it has already announced the row and the column, and what is
 * missing is "and what does this wire do here". A control wire therefore
 * says "CNOT control", not "CNOT from q0 to q1" — the latter is the same
 * sentence twice for a two-wire gate.
 */
export function describeQubitCell(
  circuit: Circuit,
  operation: Operation,
  qubit: number
): CellSegment[] {
  const role = roleOnQubit(operation, qubit)
  if (role === null) return []

  const shape = targetShape(operation.gate)

  // A barrier has no symbol worth speaking: `⋮` is a drawing, not a word.
  if (shape === 'barrier')
    return [{ kind: 'phrase', key: 'canvas.cell.barrier' }]

  const segments: CellSegment[] = [
    { kind: 'notation', value: gateSymbol(operation.gate, circuit) },
  ]

  if (role !== 'target') {
    segments.push({
      kind: 'phrase',
      key:
        role === 'control'
          ? 'canvas.cell.control'
          : 'canvas.cell.negativeControl',
    })
    return segments
  }

  const params = operation.params ?? []
  if (params.length > 0) {
    segments.push({
      kind: 'params',
      names: lookupGate(operation.gate)?.paramNames ?? [],
      values: params,
    })
  }

  if (operation.gate === 'reset') {
    segments.push({ kind: 'phrase', key: 'canvas.cell.reset' })
  }

  for (const clbit of operation.clbitTargets ?? []) {
    segments.push({
      kind: 'phrase',
      key: 'canvas.cell.measuredInto',
      values: { clbit: clbitLabel(clbit) },
    })
  }

  const controls = controlsOf(operation)
  if (controls.length > 0) {
    segments.push({ kind: 'phrase', key: 'canvas.cell.target' })
    segments.push({
      kind: 'phrase',
      key: 'canvas.cell.controlledBy',
      wires: controls.map((control) => qubitLabel(circuit, control.qubit)),
    })
  }

  if (operation.condition !== undefined) {
    segments.push({
      kind: 'phrase',
      key: 'canvas.cell.conditional',
      values: {
        clbit: clbitLabel(operation.condition.clbit),
        value: String(operation.condition.equals),
      },
    })
  }

  return segments
}

/**
 * What to say about the cell where `operation` meets the classical register.
 * Empty for the operations that never reach it, which is nearly all of them.
 */
export function describeClassicalCell(
  circuit: Circuit,
  operation: Operation
): CellSegment[] {
  const segments: CellSegment[] = []

  for (const clbit of operation.clbitTargets ?? []) {
    segments.push({ kind: 'notation', value: clbitLabel(clbit) })
    segments.push({
      kind: 'phrase',
      key: 'canvas.cell.classicalWrite',
      wires: operation.targets.map((qubit) => qubitLabel(circuit, qubit)),
    })
  }

  if (operation.condition !== undefined) {
    segments.push({
      kind: 'phrase',
      key: 'canvas.cell.classicalRead',
      values: {
        clbit: clbitLabel(operation.condition.clbit),
        value: String(operation.condition.equals),
      },
    })
  }

  return segments
}

/** Whether an operation draws anything on the classical register wire. */
export function touchesRegister(operation: Operation): boolean {
  return (
    (operation.clbitTargets?.length ?? 0) > 0 ||
    operation.condition !== undefined
  )
}

/** Every operation in a column that reaches the classical register. */
export function registerOperationsAt(
  circuit: Circuit,
  column: number
): Operation[] {
  return circuit.operations.filter(
    (operation) => operation.column === column && touchesRegister(operation)
  )
}
