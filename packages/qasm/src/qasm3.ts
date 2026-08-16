/**
 * The circuit contract, written as OpenQASM 3 — specification §3.5.
 *
 * This is the serialiser only. Reading OpenQASM back in is Phase 2; the two
 * halves are deliberately not written together, because a parser tested only
 * against its own writer proves nothing about the files anyone else produces.
 *
 * ── WHAT THE OUTPUT IS FOR ───────────────────────────────────────────────
 *
 * A file somebody pastes into Qiskit, into a hardware provider's console, or
 * into a paper. So it declares `OPENQASM 3.0;`, includes `stdgates.inc`, and
 * uses the names in that include for every gate that has one. Nothing here is
 * "our dialect".
 *
 * ── ENDIANNESS IS THE WHOLE RISK (D1, §16 risk 2) ────────────────────────
 *
 * `q[k]` in the emitted program is qubit `k` of the document, unmirrored. That
 * is the entire mapping, and it is right precisely because this project chose
 * Qiskit's convention: qubit 0 is the least significant bit of the state
 * index, here and there. Reversing indices on the way out would produce a file
 * that runs perfectly and computes the mirror image of what the user drew —
 * self-consistent from inside, wrong on hardware, and invisible until somebody
 * compares. `verification/qiskit-agreement.test.ts` is the comparison: it
 * reads this output back with an independent simulator that applies Qiskit's
 * stated conventions, and asserts the measurement distributions match
 * `@qsim/core` on circuits chosen to be asymmetric, because a Bell pair would
 * pass under either convention.
 *
 * ── WHERE THERE IS NO DIRECT EQUIVALENT ──────────────────────────────────
 *
 * One gate in the catalog is not in `stdgates.inc`: `iswap`. It is emitted as
 * its exact decomposition, under a comment that says so and names it. Nothing
 * is approximated anywhere in this file — an export that quietly differs from
 * the circuit it came from is worse than an export that refuses.
 *
 * Controls beyond a gate's built-in ones, and negative controls, use the
 * `ctrl @` and `negctrl @` modifiers, which are OpenQASM 3 language features
 * rather than an invention here. A gate whose controls match the form
 * `stdgates.inc` already names — a `cx` with one positive control, a `ccx`
 * with two — is written with that name instead, because `cx a, b;` is what a
 * reader expects to see and `ctrl @ x a, b;` is not.
 */

import {
  controlsOf,
  lookupGate,
  type Circuit,
  type ControlSpec,
  type CustomGate,
  type Operation,
  type Parameter,
} from '@qsim/schema'

import { formatAngle } from './angles.js'
import {
  CircuitExportError,
  angles,
  describeExport,
  orderedCustomGates,
  orderedOperations,
  readsABitWrittenInItsColumn,
  rejectUnknownGate,
  type ExportOptions,
} from './program.js'

/** Name of the quantum register in the emitted program. */
const QUBIT_REGISTER = 'q'

/** Name of the classical register in the emitted program. */
const CLBIT_REGISTER = 'c'

/** Indentation of a nested block, in spaces. */
const INDENT = '  '

/**
 * How a catalog gate reaches OpenQASM 3.
 *
 * `direct` is the name to use when the operation's controls are exactly the
 * ones that name carries, all positive. `base` is the same gate stripped of
 * them, which is what the `ctrl @` / `negctrl @` form applies — so a `cx` with
 * a negative control comes out as `negctrl @ x`, and a Hadamard with two extra
 * controls as `ctrl @ ctrl @ h`.
 */
interface QasmForm {
  readonly direct: string
  readonly base: string
  readonly builtInControls: number
}

function form(
  direct: string,
  base: string = direct,
  builtInControls = 0
): QasmForm {
  return { direct, base, builtInControls }
}

/**
 * Every catalog gate that is a gate *call*, by its contract id.
 *
 * `barrier`, `reset` and `measure` are absent because they are statements in
 * OpenQASM rather than gates, and `iswap` because it has no name in
 * `stdgates.inc` at all — both are handled in `emitOperation`.
 *
 * `u` maps to the built-in `U`, which is the universal one-qubit gate of the
 * language and is entry-for-entry Qiskit's `u`. The deprecated `u3` of
 * `stdgates.inc` is the same matrix with a global phase attached, and a global
 * phase stops being global the moment somebody controls the gate.
 */
const QASM_FORMS: Readonly<Record<string, QasmForm>> = {
  i: form('id'),
  x: form('x'),
  y: form('y'),
  z: form('z'),
  h: form('h'),
  s: form('s'),
  sdg: form('sdg'),
  t: form('t'),
  tdg: form('tdg'),
  sx: form('sx'),

  rx: form('rx'),
  ry: form('ry'),
  rz: form('rz'),
  p: form('p'),
  u: form('U'),

  cx: form('cx', 'x', 1),
  cz: form('cz', 'z', 1),
  crz: form('crz', 'rz', 1),
  cp: form('cp', 'p', 1),
  ccx: form('ccx', 'x', 2),

  swap: form('swap'),
  cswap: form('cswap', 'swap', 1),
}

/**
 * Identifiers the emitted program already uses. A custom gate that happens to
 * be called `h` would otherwise redefine the Hadamard for the rest of the
 * file — the contract's identifier rule permits the name, and nothing
 * downstream would report the collision.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(QASM_FORMS).flatMap((entry) => [entry.direct, entry.base]),
  // The rest of stdgates.inc, which this file does not emit but a reader's
  // toolchain has already defined by the time it reaches a definition here.
  'cy',
  'ch',
  'crx',
  'cry',
  'cu',
  'CX',
  'phase',
  'cphase',
  'u1',
  'u2',
  'u3',
  'gphase',
  // Statements, modifiers, types and the two register names.
  'barrier',
  'measure',
  'reset',
  'delay',
  'ctrl',
  'negctrl',
  'inv',
  'pow',
  'gate',
  'def',
  'defcal',
  'if',
  'else',
  'for',
  'while',
  'in',
  'return',
  'break',
  'continue',
  'box',
  'let',
  'const',
  'extern',
  'input',
  'output',
  'include',
  'pragma',
  'qubit',
  'bit',
  'bool',
  'int',
  'uint',
  'float',
  'angle',
  'complex',
  'duration',
  'stretch',
  'array',
  'creg',
  'qreg',
  'true',
  'false',
  'pi',
  'tau',
  'euler',
  QUBIT_REGISTER,
  CLBIT_REGISTER,
])

/** Everything an operation needs that is not the operation itself. */
interface Scope {
  /** How a qubit index is spelled here: `q[2]` at the top level, `a2` in a body. */
  readonly qubit: (index: number) => string
  readonly parameters: readonly Parameter[]
  /** Contract name → the name its `gate` definition was given. */
  readonly customNames: ReadonlyMap<string, string>
  /** Set inside a custom gate body, where classical bits do not exist. */
  readonly insideDefinition: string | undefined
  /**
   * The definition's own formal parameter names (M2.3), inside a body; empty at
   * the top level.
   *
   * They are what makes a parameterised block exportable at all. A body reads
   * only its own parameters and never the circuit's — that is the decision on
   * `CustomGateSchema`, and it is what lets a definition be copied into another
   * document — so a body angle naming `theta` must be written out as the
   * identifier `theta` and not resolved against `circuit.parameters`, where a
   * name that happened to match would silently substitute the wrong value.
   */
  readonly formals: readonly string[]
}

/**
 * Serialise a circuit as an OpenQASM 3 program.
 *
 * Throws `CircuitExportError` for a gate neither the catalog nor `customGates`
 * declares, and `RangeError` for a non-finite angle. A circuit that passed
 * `validateCircuit()` cannot reach either.
 */
export function toOpenQasm3(
  circuit: Circuit,
  options: ExportOptions = {}
): string {
  const customNames = nameCustomGates(circuit)
  const lines: string[] = ['OPENQASM 3.0;', 'include "stdgates.inc";', '']

  for (const sentence of describeExport(circuit, options)) {
    lines.push(...wrapComment(sentence))
  }
  lines.push('')

  // Dependency order, not key order: see `orderedCustomGates`. A gate that
  // calls one declared after it is a file OpenQASM refuses to parse.
  for (const [name, definition] of orderedCustomGates(circuit)) {
    lines.push(
      ...emitDefinition(
        name,
        customNames.get(name) ?? name,
        definition,
        circuit,
        customNames
      ),
      ''
    )
  }

  lines.push(`qubit[${circuit.qubits}] ${QUBIT_REGISTER};`)
  if (circuit.clbits > 0) {
    lines.push(`bit[${circuit.clbits}] ${CLBIT_REGISTER};`)
  }
  lines.push('')

  const scope: Scope = {
    qubit: (index) => `${QUBIT_REGISTER}[${index}]`,
    parameters: circuit.parameters ?? [],
    customNames,
    insideDefinition: undefined,
    formals: [],
  }
  for (const operation of orderedOperations(circuit.operations)) {
    lines.push(...emitStatement(operation, scope, circuit, circuit.operations))
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

/**
 * How a tested bit value is written in the condition.
 *
 * ── THE DEFECT THIS CONSTANT EXISTS FOR ──────────────────────────────────
 *
 * This used to emit the literal from the document: `if (c[0] == 1)`. Per the
 * OpenQASM 3 types table `bit` → `int` is a permitted implicit cast, so the
 * file is arguably spec-legal — and Qiskit does not read it. `qasm3.loads`
 * answers `QASM3ImporterError: conditions must be 'bit == const bool' or
 * 'bitarray == const int', not 'bit == const int'`, on qiskit-qasm3-import
 * 0.3.0 and 0.6.0 alike. Every conditioned circuit failed, including the
 * shipped Teleportation example — the flagship interchange format refusing on
 * the flagship circuit, while this file's own header promises "a file somebody
 * pastes into Qiskit" and the export panel promises in three languages that
 * "Qiskit and most hardware toolchains read it".
 *
 * A `bool` literal is the spelling Qiskit's own exporter's grammar accepts and
 * is equally legal: `bit` → `bool` is in the same implicit-cast table. It is
 * also the more honest reading of the value, because `condition.equals` is a
 * single bit and never an integer.
 */
const CONDITION_LITERALS = ['false', 'true'] as const

/**
 * One operation, with its classical condition around it.
 *
 * OpenQASM 3 spells the condition as an `if` over a bit of the register, which
 * is exactly what `Operation.condition` carries — one bit, tested against one
 * value (§6). A conditioned decomposition puts every line of the
 * decomposition inside the same block rather than repeating the test.
 */
function emitStatement(
  operation: Operation,
  scope: Scope,
  circuit: Circuit,
  siblings: readonly Operation[]
): string[] {
  const body = emitOperation(operation, scope, circuit)
  const condition = operation.condition
  if (condition === undefined) return body
  if (scope.insideDefinition !== undefined) {
    throw new CircuitExportError(
      `Operation "${operation.id}" inside custom gate ` +
        `"${scope.insideDefinition}" is conditioned on a classical bit, but a ` +
        `custom gate has no classical register to read.`,
      operation.id
    )
  }
  return [
    ...(readsABitWrittenInItsColumn(operation, siblings)
      ? wrapComment(
          `Before the measurement below on purpose: in the source document ` +
            `both are in column ${operation.column}, and a condition reads ` +
            `the register as it was when the column began.`
        )
      : []),
    `if (${CLBIT_REGISTER}[${condition.clbit}] == ` +
      `${CONDITION_LITERALS[condition.equals]}) {`,
    ...body.map((line) => `${INDENT}${line}`),
    '}',
  ]
}

function emitOperation(
  operation: Operation,
  scope: Scope,
  circuit: Circuit
): string[] {
  const targets = operation.targets.map(scope.qubit)

  switch (operation.gate) {
    case 'barrier':
      return [`barrier ${targets.join(', ')};`]
    case 'reset':
      return targets.map((target) => `reset ${target};`)
    case 'measure':
      return [emitMeasure(operation, scope, targets)]
    case 'iswap':
      return emitISwap(operation, scope)
    default:
      break
  }

  const shape = QASM_FORMS[operation.gate]
  if (shape === undefined) {
    // The catalog is consulted before `customGates`, in that order, because
    // that is the order `validateCircuit`'s own resolver uses: a custom gate
    // named `h` never shadows the Hadamard. Reversing it here would give the
    // exported file a different meaning from the simulated one.
    if (lookupGate(operation.gate) !== undefined) {
      // A catalog gate with no entry above: the table and the catalog have
      // drifted. `catalog-coverage.test.ts` fails on exactly that, so reaching
      // this at runtime means the test was deleted rather than that a user did
      // something unusual.
      throw new CircuitExportError(
        `Gate "${operation.gate}" is in the catalog but has no OpenQASM 3 ` +
          `form. This is a gap in the exporter, not in the circuit.`,
        operation.id
      )
    }
    const custom = scope.customNames.get(operation.gate)
    if (custom === undefined) rejectUnknownGate(operation, circuit)
    const args = paramTexts(operation, scope)
    const applied = args.length === 0 ? '' : `(${args.join(', ')})`
    return [`${custom}${applied} ${targets.join(', ')};`]
  }

  return [
    call(
      shape,
      controlsOf(operation),
      operation.targets,
      paramTexts(operation, scope),
      scope
    ),
  ]
}

/**
 * An operation's angles as source text.
 *
 * At the top level a symbolic parameter becomes the literal it currently stands
 * for, which is the deliberate loss `program.ts` argues for: the exported file
 * has to run when it is pasted into a notebook, and `input float[64] theta`
 * would not until somebody bound a value.
 *
 * Inside a `gate` body the same string is written out *as a name*, because that
 * is what it is — a formal parameter of the definition, which OpenQASM 3 spells
 * exactly the way the contract does. Resolving it against `circuit.parameters`
 * here would produce a definition that ignores its own arguments, and it would
 * do so silently whenever a circuit-level parameter happened to share the name.
 */
function paramTexts(operation: Operation, scope: Scope): string[] {
  if (scope.insideDefinition === undefined) {
    return angles(operation, scope.parameters).map(formatAngle)
  }
  return (operation.params ?? []).map((param) => {
    if (typeof param === 'number') return formatAngle(param)
    if (scope.formals.includes(param)) return param
    throw new CircuitExportError(
      `Operation "${operation.id}" inside custom gate ` +
        `"${scope.insideDefinition ?? ''}" uses parameter "${param}", which ` +
        `the definition does not declare in "params". A definition reads only ` +
        `its own parameters.`,
      operation.id
    )
  })
}

function emitMeasure(
  operation: Operation,
  scope: Scope,
  targets: readonly string[]
): string {
  if (scope.insideDefinition !== undefined) {
    throw new CircuitExportError(
      `Operation "${operation.id}" measures inside custom gate ` +
        `"${scope.insideDefinition}", which has no classical register. A ` +
        `custom gate is a unitary block.`,
      operation.id
    )
  }
  const clbits = operation.clbitTargets ?? []
  if (clbits.length !== 1 || targets.length !== 1) {
    throw new CircuitExportError(
      `Operation "${operation.id}" measures ${targets.length} qubit(s) into ` +
        `${clbits.length} classical bit(s); a measurement writes exactly one ` +
        `bit from one qubit.`,
      operation.id
    )
  }
  return `${CLBIT_REGISTER}[${clbits[0]}] = measure ${targets[0]};`
}

/**
 * `iswap` as the exact sequence `stdgates.inc` can express.
 *
 * S·S·H·CX·CX·H is Qiskit's own definition of `iSwapGate`, and it is an
 * equality rather than an equivalence up to phase — `decompositions.test.ts`
 * multiplies it out against the engine's `ISWAP_MATRIX` entry for entry. That
 * matters beyond tidiness: an "up to global phase" decomposition stops being
 * equal the moment somebody controls it.
 */
function emitISwap(operation: Operation, scope: Scope): string[] {
  const [first, second] = operation.targets
  if (first === undefined || second === undefined) {
    throw new CircuitExportError(
      `Operation "${operation.id}" applies iswap to ` +
        `${operation.targets.length} qubit(s); it takes exactly two.`,
      operation.id
    )
  }

  const controls = controlsOf(operation)
  const steps: { gate: QasmForm; qubits: number[] }[] = [
    { gate: form('s'), qubits: [first] },
    { gate: form('s'), qubits: [second] },
    { gate: form('h'), qubits: [first] },
    { gate: form('cx', 'x', 1), qubits: [first, second] },
    { gate: form('cx', 'x', 1), qubits: [second, first] },
    { gate: form('h'), qubits: [second] },
  ]

  return [
    '// iswap has no name in stdgates.inc. Emitted as its exact',
    '// decomposition S·S·H·CX·CX·H (Qiskit iSwapGate), not an approximation.',
    ...steps.map((step) => {
      // The built-in controls of a step are its own leading qubits; any
      // controls the operation itself carries wrap every step, which is
      // exactly what controlling a product of unitaries means.
      const own = step.qubits.slice(0, step.gate.builtInControls).map(positive)
      const targets = step.qubits.slice(step.gate.builtInControls)
      return call(step.gate, [...controls, ...own], targets, [], scope)
    }),
  ]
}

function positive(qubit: number): ControlSpec {
  return { qubit, state: 1 }
}

/**
 * One gate call: the `stdgates.inc` name when the controls fit it, and the
 * modifier form otherwise.
 *
 * The modifier form lists control qubits in modifier order, ahead of the
 * targets — `ctrl @ negctrl @ x a, b, t` fires on a = 1 and b = 0 — which is
 * the language's own rule, not a convention chosen here.
 */
function call(
  shape: QasmForm,
  controls: readonly ControlSpec[],
  targets: readonly number[],
  params: readonly string[],
  scope: Scope
): string {
  const args = [...controls.map((control) => control.qubit), ...targets]
    .map(scope.qubit)
    .join(', ')
  const parameters = params.length === 0 ? '' : `(${params.join(', ')})`

  const fitsDirect =
    controls.length === shape.builtInControls &&
    controls.every((control) => control.state === 1)
  if (fitsDirect) return `${shape.direct}${parameters} ${args};`

  const modifiers = controls
    .map((control) => (control.state === 1 ? 'ctrl @' : 'negctrl @'))
    .join(' ')
  return `${modifiers} ${shape.base}${parameters} ${args};`
}

/**
 * A `gate` definition for one entry of `customGates`.
 *
 * The body has its own qubit numbering `0..qubits-1` (§6), so its qubits
 * become the formal parameters `a0, a1, …` rather than indices into `q`.
 */
function emitDefinition(
  contractName: string,
  emittedName: string,
  definition: CustomGate,
  circuit: Circuit,
  customNames: ReadonlyMap<string, string>
): string[] {
  const parameters = definition.params ?? []
  const scope: Scope = {
    qubit: (index) => `a${index}`,
    parameters: circuit.parameters ?? [],
    customNames,
    insideDefinition: contractName,
    formals: parameters,
  }
  const wires = Array.from(
    { length: definition.qubits },
    (_, index) => `a${index}`
  ).join(', ')
  // `gate rzz(theta) a0, a1 { … }` — the parameter list is OpenQASM's own
  // spelling of the definition's formals, so a parameterised block survives the
  // export as a parameterised gate rather than as a copy per angle.
  const signature = parameters.length === 0 ? '' : `(${parameters.join(', ')})`

  const body = orderedOperations(definition.operations).flatMap((operation) =>
    emitStatement(operation, scope, circuit, definition.operations)
  )

  return [
    ...(emittedName === contractName
      ? []
      : wrapComment(
          `Custom gate "${contractName}" is defined here as "${emittedName}" ` +
            `because "${contractName}" already names a gate in OpenQASM 3. ` +
            `Nothing calls it: the document's own resolver gives the built-in ` +
            `catalog priority over customGates, so operations named ` +
            `"${contractName}" are the built-in gate.`
        )),
    `gate ${emittedName}${signature} ${wires} {`,
    ...body.map((line) => `${INDENT}${line}`),
    '}',
  ]
}

/**
 * A name for every custom gate that no part of the emitted program already
 * uses. Computed once and shared by the definitions and the call sites, so the
 * two can never disagree.
 */
function nameCustomGates(circuit: Circuit): ReadonlyMap<string, string> {
  const taken = new Set(RESERVED_NAMES)
  const names = new Map<string, string>()
  for (const contractName of Object.keys(circuit.customGates ?? {})) {
    let name = contractName
    while (taken.has(name)) name += '_'
    taken.add(name)
    names.set(contractName, name)
  }
  return names
}

/** Comment width, chosen to match the project's 80-column prose. */
const COMMENT_WIDTH = 76

/** One sentence as `//` comment lines, wrapped so nothing runs off. */
function wrapComment(sentence: string): string[] {
  const words = sentence.split(' ')
  const lines: string[] = []
  let current = '//'
  for (const word of words) {
    if (current.length + word.length + 1 > COMMENT_WIDTH && current !== '//') {
      lines.push(current)
      current = '//'
    }
    current += ` ${word}`
  }
  lines.push(current)
  return lines
}
