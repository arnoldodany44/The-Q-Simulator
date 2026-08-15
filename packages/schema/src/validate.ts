/**
 * Semantic validation — the rules a shape cannot express.
 *
 * Zod answers "is this the right shape?". This file answers "is this a
 * circuit that can actually be run?": indices inside the register, one gate
 * per qubit per column, parameters that exist, custom gates that terminate.
 *
 * Every issue names the offending operation by its `id`, because that is the
 * only handle the editor can turn into a highlighted gate on the canvas, and
 * the only thing an API client can act on. An error that says "invalid
 * circuit" is an error nobody can fix.
 */

import {
  CircuitSchema,
  type Circuit,
  type CustomGate,
  type Operation,
} from './circuit.js'
import { VARIABLE_ARITY, lookupGate, type GateArity } from './gates.js'
import { controlsOf, qubitsOf } from './helpers.js'

/**
 * Machine-readable issue kind. The UI keys off this to decide how to render
 * a problem; `message` is what it shows when it has no special handling.
 */
export type ValidationCode =
  | 'shape'
  | 'unknown-gate'
  | 'arity-mismatch'
  | 'control-count-mismatch'
  | 'param-count-mismatch'
  | 'clbit-target-mismatch'
  | 'qubit-out-of-range'
  | 'clbit-out-of-range'
  | 'target-control-overlap'
  | 'repeated-qubit'
  | 'column-conflict'
  | 'unknown-parameter'
  | 'duplicate-operation-id'
  | 'duplicate-parameter'
  | 'qubit-label-count'
  | 'custom-gate-cycle'

export interface ValidationIssue {
  readonly code: ValidationCode
  /** A sentence a user can act on, naming the operation where possible. */
  readonly message: string
  /** `operations[].id` of the offending operation, when there is one. */
  readonly operationId?: string
  /** Set when the issue is inside a custom gate's body rather than the circuit. */
  readonly customGate?: string
}

export type CircuitParseResult =
  | { readonly ok: true; readonly circuit: Circuit }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

/** Thrown by `parseCircuit`. Carries every issue, not just the first. */
export class CircuitValidationError extends Error {
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super(formatIssues(issues))
    this.name = 'CircuitValidationError'
    this.issues = issues
  }
}

/** Render issues as one multi-line message, for logs and thrown errors. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  const count = issues.length
  const heading = `Invalid circuit (${count} ${count === 1 ? 'problem' : 'problems'}):`
  return [heading, ...issues.map((issue) => `  - ${issue.message}`)].join('\n')
}

/**
 * Parse and validate untrusted JSON — the entry point for the API, for
 * imports and for anything read out of a URL.
 */
export function safeParseCircuit(input: unknown): CircuitParseResult {
  const shape = CircuitSchema.safeParse(input)
  if (!shape.success) {
    return { ok: false, issues: shapeIssues(input, shape.error.issues) }
  }
  const dropped = droppedCustomGates(input, shape.data)
  if (dropped.length > 0) return { ok: false, issues: dropped }
  const issues = validateCircuit(shape.data)
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, circuit: shape.data }
}

/**
 * Custom gate names the shape parser accepted the document *without*.
 *
 * `z.record` builds its result on an ordinary object literal, so a key that
 * JavaScript will not place there as an own property vanishes between the input
 * and the parsed circuit — and `__proto__`, the one such key, matches
 * `IdentifierSchema` perfectly well. The definition goes with it, however
 * invalid it was, and the document then parses as though the gate had never
 * been declared. That is a silent partial discard of untrusted input, which is
 * the one thing this module exists to prevent: a payload arriving from a URL is
 * either judged whole or refused, never quietly edited on the way in.
 *
 * Comparing the two key sets catches it without naming the key, so a future
 * parser that swallowed a different one would be caught by the same check.
 */
function droppedCustomGates(
  input: unknown,
  parsed: Circuit
): ValidationIssue[] {
  const declared = readKey(input, 'customGates')
  if (typeof declared !== 'object' || declared === null) return []
  const kept = new Set(Object.getOwnPropertyNames(parsed.customGates ?? {}))
  return Object.getOwnPropertyNames(declared)
    .filter((name) => !kept.has(name))
    .map((name) => ({
      code: 'shape' as const,
      message:
        `customGates.${name}: "${name}" cannot be carried as a gate name — ` +
        `the definition under it was dropped rather than read. Rename the ` +
        `custom gate.`,
    }))
}

/** As `safeParseCircuit`, but throws `CircuitValidationError` on failure. */
export function parseCircuit(input: unknown): Circuit {
  const result = safeParseCircuit(input)
  if (!result.ok) throw new CircuitValidationError(result.issues)
  return result.circuit
}

/**
 * Semantic rules only, on a circuit that already has the right shape. The
 * editor calls this on every keystroke against the circuit it holds in
 * memory, where re-parsing the shape would be wasted work.
 *
 * Returns every issue it finds rather than stopping at the first: a user who
 * pasted a bad circuit wants the whole list, not a game of whack-a-mole.
 */
export function validateCircuit(circuit: Circuit): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const customGates = circuit.customGates ?? {}

  checkQubitLabels(circuit, issues)
  const parameterNames = checkParameters(circuit, issues)
  checkCustomGateCycles(customGates, issues)

  const resolveGate = gateResolver(customGates)

  checkOperations(circuit.operations, issues, {
    qubits: circuit.qubits,
    clbits: circuit.clbits,
    parameterNames,
    resolveGate,
  })

  // Custom gate bodies obey the same rules against their own register. They
  // are checked once each, never expanded, so a cyclic definition still
  // terminates here — the cycle itself is reported separately.
  for (const [name, definition] of Object.entries(customGates)) {
    checkOperations(definition.operations, issues, {
      qubits: definition.qubits,
      clbits: 0,
      parameterNames,
      resolveGate,
      customGate: name,
    })
  }

  return issues
}

/**
 * What the validator needs to know about a gate, whether it came from the
 * catalog or from `customGates`.
 */
interface ResolvedGate {
  readonly arity: GateArity
  readonly controlCount: number
  readonly acceptsControls: boolean
  readonly paramCount: number
  readonly clbitCount: number
}

interface Scope {
  readonly qubits: number
  readonly clbits: number
  readonly parameterNames: ReadonlySet<string>
  readonly resolveGate: (gate: string) => ResolvedGate | undefined
  /** Name of the custom gate being checked, if this is not the circuit itself. */
  readonly customGate?: string
}

function gateResolver(
  customGates: Readonly<Record<string, CustomGate>>
): (gate: string) => ResolvedGate | undefined {
  return (gate) => {
    const builtin = lookupGate(gate)
    if (builtin !== undefined) return builtin
    // `Object.hasOwn` rather than a bare read: `customGates` is an ordinary
    // object and every name on `Object.prototype` is therefore a "gate" it
    // appears to declare. A circuit using `toString` would resolve to an
    // inherited function, and the reader would be told its arity did not match
    // `undefined` instead of that the gate does not exist — a diagnostic
    // nobody can act on, keyed to a `ValidationCode` the UI is documented to
    // branch on.
    const custom = Object.hasOwn(customGates, gate)
      ? customGates[gate]
      : undefined
    if (custom === undefined) return undefined
    // A custom gate is applied to exactly its own qubits, with no controls
    // and no parameters. Both are Fase 2 features; until then, rejecting
    // them here beats accepting shapes the expander cannot honour.
    return {
      arity: custom.qubits,
      controlCount: 0,
      acceptsControls: false,
      paramCount: 0,
      clbitCount: 0,
    }
  }
}

function report(
  issues: ValidationIssue[],
  scope: Scope,
  issue: Omit<ValidationIssue, 'customGate'>
): void {
  issues.push({
    ...issue,
    customGate: scope.customGate,
    message: scope.customGate
      ? `Custom gate "${scope.customGate}": ${issue.message}`
      : issue.message,
  })
}

function checkQubitLabels(circuit: Circuit, issues: ValidationIssue[]): void {
  const labels = circuit.qubitLabels
  if (labels !== undefined && labels.length !== circuit.qubits) {
    issues.push({
      code: 'qubit-label-count',
      message:
        `"qubitLabels" has ${labels.length} entries but the circuit has ` +
        `${circuit.qubits} qubits. Provide one label per qubit, or omit ` +
        `the field entirely.`,
    })
  }
}

/** Collects declared parameter names, reporting any declared twice. */
function checkParameters(
  circuit: Circuit,
  issues: ValidationIssue[]
): ReadonlySet<string> {
  const names = new Set<string>()
  for (const parameter of circuit.parameters ?? []) {
    if (names.has(parameter.name)) {
      issues.push({
        code: 'duplicate-parameter',
        message:
          `Parameter "${parameter.name}" is declared more than once. ` +
          `A name must resolve to a single value.`,
      })
      continue
    }
    names.add(parameter.name)
  }
  return names
}

/**
 * Depth-first walk over `customGates` looking for a gate that reaches
 * itself. Without this the expander in Fase 2 would recurse until the stack
 * gives out, and the user would see a crash instead of the name of the gate
 * they wired into a loop.
 *
 * ── Why the walk is iterative ─────────────────────────────────────────────
 *
 * It used to recurse, one JavaScript frame per gate in the chain, and that is
 * the same unbounded recursion the check exists to prevent — only in the
 * checker rather than in the expander. A document declaring a chain
 * `g0 → g1 → … → gN` costs about 87 bytes per link, so roughly twelve
 * thousand links fit inside the API's 1 MiB body limit and overflow the
 * default stack: `RangeError: Maximum call stack size exceeded`, which
 * reaches the client as a 500 that a client produced. The margin is worse
 * than it looks, because a smaller stack (a container tuned down, or simply a
 * deeper call stack under a real HTTP server than under `inject`) moves the
 * threshold below the 256 KiB a version is allowed to *store* — and stored
 * payloads are re-parsed through here on every read, so the circuit would
 * then 500 forever.
 *
 * An explicit stack costs one array and removes the bound entirely: depth is
 * limited by the payload, and the payload is limited by the body limit.
 */
function checkCustomGateCycles(
  customGates: Readonly<Record<string, CustomGate>>,
  issues: ValidationIssue[]
): void {
  const status = new Map<string, 'visiting' | 'done'>()
  /** The current DFS path, as the cycle message needs to name it. */
  const path: string[] = []

  /*
   * Each frame is a gate plus how far through its operations we are. `enter`
   * is false on the bookkeeping visit that pops the path again — the explicit
   * form of "the code after the recursive call".
   */
  interface Frame {
    readonly name: string
    index: number
  }

  const walk = (root: string): void => {
    const stack: Frame[] = [{ name: root, index: -1 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame
      const { name } = frame

      if (frame.index === -1) {
        const state = status.get(name)
        if (state === 'done') {
          stack.pop()
          continue
        }
        if (state === 'visiting') {
          const cycle = [...path.slice(path.indexOf(name)), name].join(' → ')
          issues.push({
            code: 'custom-gate-cycle',
            customGate: name,
            message:
              `Custom gate "${name}" contains itself: ${cycle}. A custom ` +
              `gate cannot use itself, directly or through another custom ` +
              `gate.`,
          })
          stack.pop()
          continue
        }
        status.set(name, 'visiting')
        path.push(name)
        frame.index = 0
      }

      const operations = customGates[name]?.operations ?? []
      let descended = false
      while (frame.index < operations.length) {
        const operation = operations[frame.index] as Operation
        frame.index += 1
        if (Object.hasOwn(customGates, operation.gate)) {
          stack.push({ name: operation.gate, index: -1 })
          descended = true
          break
        }
      }
      if (descended) continue

      path.pop()
      status.set(name, 'done')
      stack.pop()
    }
  }

  for (const name of Object.keys(customGates)) walk(name)
}

function checkOperations(
  operations: readonly Operation[],
  issues: ValidationIssue[],
  scope: Scope
): void {
  const seenIds = new Set<string>()
  // column → qubit → id of the operation already holding that qubit.
  const occupancy = new Map<number, Map<number, string>>()

  for (const operation of operations) {
    if (seenIds.has(operation.id)) {
      report(issues, scope, {
        code: 'duplicate-operation-id',
        operationId: operation.id,
        message:
          `Operation id "${operation.id}" is used more than once. Ids ` +
          `identify operations for selection and undo, so they must be unique.`,
      })
    }
    seenIds.add(operation.id)

    checkGateShape(operation, issues, scope)
    checkIndices(operation, issues, scope)
    checkParameterRefs(operation, issues, scope)
    checkColumn(operation, occupancy, issues, scope)
  }
}

/** Arity, control count, parameter count and classical writes vs. the catalog. */
function checkGateShape(
  operation: Operation,
  issues: ValidationIssue[],
  scope: Scope
): void {
  const gate = scope.resolveGate(operation.gate)
  if (gate === undefined) {
    report(issues, scope, {
      code: 'unknown-gate',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" uses gate "${operation.gate}", which ` +
        `is neither in the gate catalog nor declared in "customGates".`,
    })
    return
  }

  const targets = operation.targets.length
  if (gate.arity !== VARIABLE_ARITY && targets !== gate.arity) {
    report(issues, scope, {
      code: 'arity-mismatch',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" applies gate "${operation.gate}" to ` +
        `${targets} target qubit(s), but that gate takes exactly ` +
        `${gate.arity}.`,
    })
  }

  const controls = operation.controls?.length ?? 0
  const controlsAreWrong = gate.acceptsControls
    ? controls < gate.controlCount
    : controls !== gate.controlCount
  if (controlsAreWrong) {
    report(issues, scope, {
      code: 'control-count-mismatch',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" gives gate "${operation.gate}" ` +
        `${controls} control(s), but that gate takes ` +
        `${gate.acceptsControls ? 'at least' : 'exactly'} ` +
        `${gate.controlCount}.`,
    })
  }

  const params = operation.params?.length ?? 0
  if (params !== gate.paramCount) {
    report(issues, scope, {
      code: 'param-count-mismatch',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" passes ${params} parameter(s) to gate ` +
        `"${operation.gate}", which takes exactly ${gate.paramCount}.`,
    })
  }

  const clbitTargets = operation.clbitTargets?.length ?? 0
  if (clbitTargets !== gate.clbitCount) {
    report(issues, scope, {
      code: 'clbit-target-mismatch',
      operationId: operation.id,
      message:
        gate.clbitCount === 0
          ? `Operation "${operation.id}" declares "clbitTargets", but gate ` +
            `"${operation.gate}" does not write to the classical register.`
          : `Operation "${operation.id}" writes to ${clbitTargets} classical ` +
            `bit(s), but gate "${operation.gate}" writes to exactly ` +
            `${gate.clbitCount}.`,
    })
  }
}

/** Every index the operation mentions, against the registers it runs on. */
function checkIndices(
  operation: Operation,
  issues: ValidationIssue[],
  scope: Scope
): void {
  const { qubits, clbits } = scope
  const targets = operation.targets
  const controls = controlsOf(operation)

  const outOfRange = (qubit: number, role: 'target' | 'control'): void => {
    report(issues, scope, {
      code: 'qubit-out-of-range',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" uses qubit ${qubit} as a ${role}, but ` +
        `the circuit has ${qubits} qubit(s) — valid indices are ` +
        `0 to ${qubits - 1}.`,
    })
  }

  const seenTargets = new Set<number>()
  for (const target of targets) {
    if (target >= qubits) outOfRange(target, 'target')
    if (seenTargets.has(target)) {
      report(issues, scope, {
        code: 'repeated-qubit',
        operationId: operation.id,
        message:
          `Operation "${operation.id}" lists qubit ${target} twice in ` +
          `"targets". A gate acts on distinct qubits.`,
      })
    }
    seenTargets.add(target)
  }

  const seenControls = new Set<number>()
  for (const control of controls) {
    if (control.qubit >= qubits) outOfRange(control.qubit, 'control')
    if (seenControls.has(control.qubit)) {
      report(issues, scope, {
        code: 'repeated-qubit',
        operationId: operation.id,
        message:
          `Operation "${operation.id}" lists qubit ${control.qubit} twice ` +
          `in "controls".`,
      })
    }
    seenControls.add(control.qubit)

    if (seenTargets.has(control.qubit)) {
      report(issues, scope, {
        code: 'target-control-overlap',
        operationId: operation.id,
        message:
          `Operation "${operation.id}" uses qubit ${control.qubit} as both ` +
          `a target and a control. A gate cannot be conditioned on the ` +
          `qubit it acts on.`,
      })
    }
  }

  for (const clbit of operation.clbitTargets ?? []) {
    if (clbit >= clbits) {
      report(issues, scope, {
        code: 'clbit-out-of-range',
        operationId: operation.id,
        message:
          `Operation "${operation.id}" writes to classical bit ${clbit}, ` +
          `but the circuit has ${clbits} classical bit(s)` +
          `${clbits === 0 ? '' : ` — valid indices are 0 to ${clbits - 1}`}.`,
      })
    }
  }

  const condition = operation.condition
  if (condition !== undefined && condition.clbit >= clbits) {
    report(issues, scope, {
      code: 'clbit-out-of-range',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" is conditioned on classical bit ` +
        `${condition.clbit}, but the circuit has ${clbits} classical bit(s)` +
        `${clbits === 0 ? '' : ` — valid indices are 0 to ${clbits - 1}`}.`,
    })
  }
}

function checkParameterRefs(
  operation: Operation,
  issues: ValidationIssue[],
  scope: Scope
): void {
  for (const param of operation.params ?? []) {
    if (typeof param === 'number') continue
    if (scope.parameterNames.has(param)) continue
    report(issues, scope, {
      code: 'unknown-parameter',
      operationId: operation.id,
      message:
        `Operation "${operation.id}" references parameter "${param}", which ` +
        `is not declared in "parameters".`,
    })
  }
}

/**
 * Operations in one column run simultaneously, so no two of them may touch
 * the same qubit (§6). This is the rule the editor enforces by construction
 * when dragging, and the one an imported or hand-written circuit breaks.
 */
function checkColumn(
  operation: Operation,
  occupancy: Map<number, Map<number, string>>,
  issues: ValidationIssue[],
  scope: Scope
): void {
  let column = occupancy.get(operation.column)
  if (column === undefined) {
    column = new Map<number, string>()
    occupancy.set(operation.column, column)
  }

  // Deduplicated: a qubit repeated inside one operation is the
  // `repeated-qubit` rule's business, not a column conflict with itself.
  for (const qubit of new Set(qubitsOf(operation))) {
    const holder = column.get(qubit)
    if (holder !== undefined) {
      report(issues, scope, {
        code: 'column-conflict',
        operationId: operation.id,
        message:
          `Operations "${holder}" and "${operation.id}" both act on qubit ` +
          `${qubit} in column ${operation.column}. Operations in the same ` +
          `column run at the same time, so they cannot share a qubit.`,
      })
      continue
    }
    column.set(qubit, operation.id)
  }
}

/**
 * Turn Zod's issues into ours. The JSON path is kept in the message because
 * `operations[3].targets[0]` is the fastest way to find the offending value,
 * and the operation's id is recovered from the raw input when the path
 * points inside an operation.
 */
function shapeIssues(
  input: unknown,
  zodIssues: readonly { path: PropertyKey[]; message: string }[]
): ValidationIssue[] {
  return zodIssues.map((issue) => ({
    code: 'shape' as const,
    operationId: operationIdAt(input, issue.path),
    message: `${formatPath(issue.path)}: ${issue.message}`,
  }))
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? String(segment) : `.${String(segment)}`
  }
  return out === '' ? '(root)' : out
}

/** Reads `input[key]` without asserting anything about `input`. */
function readKey(input: unknown, key: PropertyKey): unknown {
  if (typeof input !== 'object' || input === null) return undefined
  return (input as Record<PropertyKey, unknown>)[key]
}

function operationIdAt(
  input: unknown,
  path: readonly PropertyKey[]
): string | undefined {
  const [head, index] = path
  if (head !== 'operations' || typeof index !== 'number') return undefined
  const id = readKey(readKey(readKey(input, head), index), 'id')
  return typeof id === 'string' ? id : undefined
}
