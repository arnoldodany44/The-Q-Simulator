/**
 * The circuit contract, written as Qiskit Python — specification §3.5.
 *
 * The target is not "valid Python": it is code a person opens in a notebook,
 * reads top to bottom, and recognises. So the registers are named and built
 * explicitly, every gate uses the `QuantumCircuit` method a Qiskit user
 * already knows, and the imports are exactly the ones the file needs — no
 * wildcard, no unused name, nothing to clean up before running it.
 *
 * ── ENDIANNESS ──────────────────────────────────────────────────────────
 *
 * `q[k]` is qubit `k`, unmirrored, for the same reason as in `qasm3.ts` and
 * with the same consequence if it were not: decision D1 chose Qiskit's
 * convention precisely so that this mapping is the identity. See that file's
 * header, and `verification/qiskit-agreement.test.ts` for the test that would
 * fail if anyone "helpfully" reversed the indices.
 *
 * ── WHAT DIFFERS FROM THE OPENQASM OUTPUT, AND WHY ──────────────────────
 *
 * `iswap` is decomposed there and is a method call here, because Qiskit has
 * `QuantumCircuit.iswap` and `stdgates.inc` has no such gate. Extra and
 * negative controls go through `.control(n, ctrl_state=…)` rather than the
 * `ctrl @` modifier. Both files describe the same circuit; neither pretends
 * the other language's spelling is available.
 *
 * ── ONE THING WORTH KNOWING ABOUT `ctrl_state` ──────────────────────────
 *
 * Qiskit numbers the bits of `ctrl_state` by the *position of the control in
 * the qubit list*: the rightmost character is the first control passed. That
 * is easy to read backwards, so a comment naming the qubits that fire on |0⟩
 * is emitted with it rather than leaving the reader to work it out.
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

import { formatAngle, usesPi } from './angles.js'
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

const QUBIT_REGISTER = 'q'
const CLBIT_REGISTER = 'c'
const CIRCUIT = 'circuit'

/** PEP 8 indentation. */
const INDENT = '    '

/**
 * How a catalog gate reaches Qiskit.
 *
 * `method` is the `QuantumCircuit` method for the gate exactly as the contract
 * stores it, controls included — `cx` is a method, not a controlled `x`.
 * `gateClass` is the *uncontrolled* gate's class, which is what `.control()`
 * is called on when the operation carries controls the method cannot express:
 * an extra one, or a negative one.
 */
interface QiskitForm {
  readonly method: string
  readonly gateClass: string
  readonly builtInControls: number
  /** Angles come before qubits in every Qiskit method that takes them. */
  readonly paramCount: number
}

function form(
  method: string,
  gateClass: string,
  builtInControls = 0,
  paramCount = 0
): QiskitForm {
  return { method, gateClass, builtInControls, paramCount }
}

/**
 * Every catalog gate that is a method call. `barrier`, `reset` and `measure`
 * are methods too but take classical arguments or none, so they are emitted
 * separately.
 */
const QISKIT_FORMS: Readonly<Record<string, QiskitForm>> = {
  i: form('id', 'IGate'),
  x: form('x', 'XGate'),
  y: form('y', 'YGate'),
  z: form('z', 'ZGate'),
  h: form('h', 'HGate'),
  s: form('s', 'SGate'),
  sdg: form('sdg', 'SdgGate'),
  t: form('t', 'TGate'),
  tdg: form('tdg', 'TdgGate'),
  sx: form('sx', 'SXGate'),

  rx: form('rx', 'RXGate', 0, 1),
  ry: form('ry', 'RYGate', 0, 1),
  rz: form('rz', 'RZGate', 0, 1),
  p: form('p', 'PhaseGate', 0, 1),
  u: form('u', 'UGate', 0, 3),

  cx: form('cx', 'XGate', 1),
  cz: form('cz', 'ZGate', 1),
  crz: form('crz', 'RZGate', 1, 1),
  cp: form('cp', 'PhaseGate', 1, 1),
  ccx: form('ccx', 'XGate', 2),

  swap: form('swap', 'SwapGate'),
  iswap: form('iswap', 'iSwapGate'),
  cswap: form('cswap', 'SwapGate', 1),
}

/**
 * Names the generated module already binds, plus the Python keywords and the
 * builtins a reader would notice being shadowed. A custom gate called `list`
 * or `circuit` would otherwise produce code that runs and then fails three
 * cells later for a reason nobody would connect to the export.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  QUBIT_REGISTER,
  CLBIT_REGISTER,
  CIRCUIT,
  'pi',
  'QuantumCircuit',
  'QuantumRegister',
  'ClassicalRegister',
  ...Object.values(QISKIT_FORMS).map((entry) => entry.gateClass),
  // Python keywords.
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  // The builtins most likely to be reached for in the same notebook.
  'abs',
  'all',
  'any',
  'bool',
  'dict',
  'float',
  'input',
  'int',
  'len',
  'list',
  'map',
  'max',
  'min',
  'print',
  'range',
  'round',
  'set',
  'str',
  'sum',
  'tuple',
  'type',
  'zip',
])

interface Scope {
  /** The `QuantumCircuit` variable statements are written against. */
  readonly target: string
  /** How a qubit index is spelled: `q[2]` at the top level, `2` in a body. */
  readonly qubit: (index: number) => string
  readonly parameters: readonly Parameter[]
  /** Contract name → the Python variable holding the built gate. */
  readonly customNames: ReadonlyMap<string, string>
  readonly insideDefinition: string | undefined
}

/** Gate classes an emission needed, collected so the imports can be exact. */
type Imports = Set<string>

/**
 * Serialise a circuit as a Qiskit program.
 *
 * Throws `CircuitExportError` for a gate neither the catalog nor `customGates`
 * declares, and `RangeError` for a non-finite angle — neither is reachable
 * from a circuit that passed `validateCircuit()`.
 */
export function toQiskit(
  circuit: Circuit,
  options: ExportOptions = {}
): string {
  const customNames = nameCustomGates(circuit)
  const imports: Imports = new Set()

  // The body is built first: what it uses is what the imports must name.
  /*
   * Dependency order, not key order: see `orderedCustomGates`. Python binds a
   * name when the statement that assigns it runs, so a gate whose body appends
   * one declared later is a `NameError` rather than a bad diagram.
   */
  const definitions = orderedCustomGates(circuit).flatMap(
    ([name, definition]) => [
      ...emitDefinition(
        name,
        customNames.get(name) ?? name,
        definition,
        circuit,
        customNames,
        imports
      ),
      '',
    ]
  )

  const scope: Scope = {
    target: CIRCUIT,
    qubit: (index) => `${QUBIT_REGISTER}[${index}]`,
    parameters: circuit.parameters ?? [],
    customNames,
    insideDefinition: undefined,
  }
  const body = orderedOperations(circuit.operations).flatMap((operation) =>
    emitStatement(operation, scope, circuit, imports, circuit.operations)
  )

  const lines: string[] = [
    ...describeExport(circuit, options).flatMap(wrapComment),
    '',
    ...importLines(circuit, imports),
    '',
    ...registerLines(circuit),
    '',
    ...definitions,
    ...body,
  ]

  if (measures(circuit)) lines.push('', ...RUN_HINT)

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

/**
 * How to actually get counts out of it, as a comment.
 *
 * A file that builds a circuit and then does nothing with it is a file the
 * reader has to finish before it says anything, and the one line they need is
 * not obvious if Qiskit is not already familiar. It stays a comment because
 * `qiskit-aer` is a separate install and an import that fails on line one
 * would be a worse first impression than no import at all.
 */
const RUN_HINT: readonly string[] = [
  '# Run it, for example with Aer:',
  '#     from qiskit_aer import AerSimulator',
  '#     result = AerSimulator().run(circuit, shots=1024).result()',
  '#     print(result.get_counts())',
]

function measures(circuit: Circuit): boolean {
  return circuit.operations.some((operation) => operation.gate === 'measure')
}

/**
 * Exactly the imports the emitted code uses, in the order a linter wants
 * them: the standard library, then the third-party package.
 */
function importLines(circuit: Circuit, imports: Imports): string[] {
  const lines: string[] = []
  if (needsPi(circuit)) lines.push('from math import pi', '')

  const constructors = ['QuantumCircuit', 'QuantumRegister']
  if (circuit.clbits > 0) constructors.unshift('ClassicalRegister')
  lines.push(`from qiskit import ${constructors.sort().join(', ')}`)

  if (imports.size > 0) {
    lines.push(
      `from qiskit.circuit.library import ${[...imports].sort().join(', ')}`
    )
  }
  return lines
}

/**
 * Whether any angle in the document prints as a multiple of π. Asked of the
 * resolved angles rather than of the literals, because a symbolic parameter
 * whose value is π/2 prints as `pi/2` like any other.
 */
function needsPi(circuit: Circuit): boolean {
  const parameters = circuit.parameters ?? []
  const all = [
    ...circuit.operations,
    ...Object.values(circuit.customGates ?? {}).flatMap(
      (definition) => definition.operations
    ),
  ].flatMap((operation) =>
    operation.params === undefined ? [] : angles(operation, parameters)
  )
  return usesPi(all)
}

function registerLines(circuit: Circuit): string[] {
  const lines = [
    `${QUBIT_REGISTER} = QuantumRegister(${circuit.qubits}, "${QUBIT_REGISTER}")`,
  ]
  if (circuit.clbits > 0) {
    lines.push(
      `${CLBIT_REGISTER} = ClassicalRegister(${circuit.clbits}, ` +
        `"${CLBIT_REGISTER}")`
    )
    lines.push(
      `${CIRCUIT} = QuantumCircuit(${QUBIT_REGISTER}, ${CLBIT_REGISTER})`
    )
  } else {
    lines.push(`${CIRCUIT} = QuantumCircuit(${QUBIT_REGISTER})`)
  }
  return lines
}

/**
 * One operation, with its classical condition around it.
 *
 * `with circuit.if_test((c[0], 1)):` is the current spelling. The older
 * `.c_if()` is gone from Qiskit 2, so emitting it would produce a file that
 * fails on any modern install — an export is only useful if it still runs.
 */
function emitStatement(
  operation: Operation,
  scope: Scope,
  circuit: Circuit,
  imports: Imports,
  siblings: readonly Operation[]
): string[] {
  const body = emitOperation(operation, scope, circuit, imports)
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
    `with ${scope.target}.if_test((${CLBIT_REGISTER}[${condition.clbit}], ` +
      `${condition.equals})):`,
    ...body.map((line) => `${INDENT}${line}`),
  ]
}

function emitOperation(
  operation: Operation,
  scope: Scope,
  circuit: Circuit,
  imports: Imports
): string[] {
  const targets = operation.targets.map(scope.qubit)

  switch (operation.gate) {
    case 'barrier':
      return [`${scope.target}.barrier(${targets.join(', ')})`]
    case 'reset':
      return targets.map((target) => `${scope.target}.reset(${target})`)
    case 'measure':
      return [emitMeasure(operation, scope, targets)]
    default:
      break
  }

  const shape = QISKIT_FORMS[operation.gate]
  if (shape === undefined) {
    // Catalog first, `customGates` second — the order `validateCircuit`'s own
    // resolver uses, so a custom gate named `h` never shadows the Hadamard
    // here when it does not shadow it there.
    if (lookupGate(operation.gate) !== undefined) {
      throw new CircuitExportError(
        `Gate "${operation.gate}" is in the catalog but has no Qiskit form. ` +
          `This is a gap in the exporter, not in the circuit.`,
        operation.id
      )
    }
    const custom = scope.customNames.get(operation.gate)
    if (custom === undefined) rejectUnknownGate(operation, circuit)
    return [`${scope.target}.append(${custom}, [${targets.join(', ')}])`]
  }

  const controls = controlsOf(operation)
  const params = angles(operation, scope.parameters).map(formatAngle)
  if (params.length !== shape.paramCount) {
    throw new CircuitExportError(
      `Operation "${operation.id}" passes ${params.length} parameter(s) to ` +
        `"${operation.gate}", which takes ${shape.paramCount}.`,
      operation.id
    )
  }

  const fitsMethod =
    controls.length === shape.builtInControls &&
    controls.every((control) => control.state === 1)
  if (fitsMethod) {
    const args = [
      ...params,
      ...controls.map((control) => scope.qubit(control.qubit)),
      ...targets,
    ]
    return [`${scope.target}.${shape.method}(${args.join(', ')})`]
  }

  return emitControlled(operation, shape, controls, params, scope, imports)
}

/**
 * A gate with controls no method covers: built through the gate class and
 * `.control()`.
 *
 * The controls a *method* would carry are part of the class here too — a `cx`
 * with one extra control is `XGate().control(2)`, not `CXGate().control(1)` —
 * because `ctrl_state` then indexes one flat list of controls and the comment
 * above it can name them all.
 */
function emitControlled(
  operation: Operation,
  shape: QiskitForm,
  controls: readonly ControlSpec[],
  params: readonly string[],
  scope: Scope,
  imports: Imports
): string[] {
  imports.add(shape.gateClass)

  const negatives = controls.filter((control) => control.state === 0)
  // Qiskit reads `ctrl_state` right to left over the control list: bit i is
  // the i-th control passed in `qargs`.
  const ctrlState = controls
    .map((control) => String(control.state))
    .reverse()
    .join('')
  const modifier =
    negatives.length === 0
      ? `.control(${controls.length})`
      : `.control(${controls.length}, ctrl_state="${ctrlState}")`

  const qargs = [
    ...controls.map((control) => scope.qubit(control.qubit)),
    ...operation.targets.map(scope.qubit),
  ].join(', ')

  const note =
    negatives.length === 0
      ? []
      : wrapComment(
          `Fires when ${negatives
            .map((control) => scope.qubit(control.qubit))
            .join(' and ')} reads |0>. In ctrl_state the rightmost bit is ` +
            `the first control in the list below.`
        )

  return [
    ...note,
    `${scope.target}.append(${shape.gateClass}(${params.join(', ')})` +
      `${modifier}, [${qargs}])`,
  ]
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
  return (
    `${scope.target}.measure(${targets[0]}, ` +
    `${CLBIT_REGISTER}[${clbits[0]}])`
  )
}

/**
 * A custom gate as a small `QuantumCircuit` turned into a gate.
 *
 * The definition circuit takes bare integer qubit indices, which is what makes
 * the body readable: inside `bellPair` the qubits are 0 and 1, exactly as the
 * contract numbers them (§6).
 */
function emitDefinition(
  contractName: string,
  variable: string,
  definition: CustomGate,
  circuit: Circuit,
  customNames: ReadonlyMap<string, string>,
  imports: Imports
): string[] {
  const builder = `${variable}_definition`
  const scope: Scope = {
    target: builder,
    qubit: (index) => String(index),
    parameters: circuit.parameters ?? [],
    customNames,
    insideDefinition: contractName,
  }
  const body = orderedOperations(definition.operations).flatMap((operation) =>
    emitStatement(operation, scope, circuit, imports, definition.operations)
  )

  return [
    ...wrapComment(
      `Custom gate "${contractName}" from the document's customGates.`
    ),
    `${builder} = QuantumCircuit(${definition.qubits}, ` +
      `name="${pythonString(contractName)}")`,
    ...body,
    `${variable} = ${builder}.to_gate()`,
  ]
}

/**
 * A name for every custom gate that the module does not already bind.
 * Computed once and shared by the definitions and the call sites.
 */
function nameCustomGates(circuit: Circuit): ReadonlyMap<string, string> {
  const taken = new Set(RESERVED_NAMES)
  const names = new Map<string, string>()
  for (const contractName of Object.keys(circuit.customGates ?? {})) {
    let name = contractName
    while (taken.has(name) || taken.has(`${name}_definition`)) name += '_'
    taken.add(name)
    names.set(contractName, name)
  }
  return names
}

/**
 * A custom gate name inside a Python double-quoted string. The contract's
 * identifier rule (`^[A-Za-z_][A-Za-z0-9_]*$`) already excludes everything
 * that would need escaping; this is the belt to that braces, so a future
 * loosening of the rule cannot produce a file with a broken string literal.
 */
function pythonString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const COMMENT_WIDTH = 76

/** One sentence as `#` comment lines, wrapped so nothing runs off. */
function wrapComment(sentence: string): string[] {
  const lines: string[] = []
  let current = '#'
  for (const word of sentence.split(' ')) {
    if (current.length + word.length + 1 > COMMENT_WIDTH && current !== '#') {
      lines.push(current)
      current = '#'
    }
    current += ` ${word}`
  }
  lines.push(current)
  return lines
}
