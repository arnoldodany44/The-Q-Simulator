/**
 * The parsed program becomes a circuit document — the half that knows the gate
 * catalog, and therefore the half that says no.
 *
 * ── THE THREE THINGS OPENQASM HAS AND THE CONTRACT DOES NOT ──────────────
 *
 * 1. **Named registers.** A file may declare `qreg alice[2]; qreg bob[3];` and
 *    the contract has one flat register of five qubits. They are concatenated
 *    in declaration order, so `bob[0]` is qubit 2 — and when a file declares
 *    more than one, the names are kept as `qubitLabels` so the flattening is
 *    visible on the canvas instead of being a fact only this file knows.
 *
 * 2. **A sequence, where the contract has columns.** OpenQASM is a program read
 *    top to bottom; `column` is time, and everything in one column happens at
 *    once (§6). A text file carries no column information at all, so any
 *    assignment is a reconstruction, and the one chosen is as-soon-as-possible:
 *    each operation goes in the earliest column where every qubit it touches is
 *    free. That is the layout the editor itself produces, and it is the only one
 *    that shows the parallelism a reader would draw. Laying every statement out
 *    in its own column would be equally correct and would render a fifty-gate
 *    program as fifty columns of one gate each.
 *
 *    The classical register takes part in the same scheduling, and that part is
 *    not cosmetic. The engine reads a condition against the register **as it
 *    entered the column** (see `runner.ts`), so an operation conditioned on a
 *    bit must land in a column strictly after the measurement that writes it,
 *    or it would read the previous value. `Scheduler` enforces exactly that,
 *    which is what makes the imported circuit run the way the file reads.
 *
 * 3. **Gate definitions that may be controlled, inverted and repeated.** A
 *    contract custom gate is a plain unitary block: no controls, no inverse, and
 *    its parameters are names rather than expressions (§3.1 decision 1). So a
 *    definition becomes a `customGates` entry when it fits that shape, and is
 *    **inlined at its call sites** when it does not — under `ctrl @`, under
 *    `inv @`, when its body computes with its own parameters, or when it calls
 *    something like `u3` that is not a single catalog gate. Inlining is never
 *    an approximation; it is the same operations without the wrapper, which is
 *    what the engine would have expanded them to anyway (§3.1 decision 2).
 *
 * ── ENDIANNESS (D1, §16 risk 2) ──────────────────────────────────────────
 *
 * `q[k]` of the first quantum register is qubit `k` of the document. Unmirrored,
 * exactly as the exporter writes it, because this project chose Qiskit's
 * convention on both sides. Import is where a mirrored convention hides best: a
 * file imported and re-exported by a mirrored pair agrees with itself perfectly
 * and disagrees with every other tool on earth. `verification/import-agreement.
 * test.ts` is the check, and it compares simulated distributions on asymmetric
 * circuits rather than text, because text cannot reveal it.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  MAX_CUSTOM_GATE_PARAMS,
  parseCircuit,
  CircuitValidationError,
  isGateId,
  type Circuit,
  type Condition,
  type ControlSpec,
  type CustomGate,
  type Operation,
  type ParamValue,
} from '@qsim/schema'

import {
  limitError,
  QasmImportError,
  semanticError,
  unsupportedError,
  START_OF_FILE,
  type QasmPosition,
} from './errors.js'
import {
  evaluate,
  evaluateSymbolic,
  NotRepresentable,
  type SymbolicValue,
} from './expressions.js'
import {
  libraryFor,
  rejectKnownUnsupported,
  type LibraryGate,
} from './library.js'
import {
  MAX_CLBITS,
  MAX_COLUMNS,
  MAX_DEFINITION_DEPTH,
  MAX_OPERATIONS,
  MAX_QUBITS,
} from './limits.js'
import { addControls, invert, power } from './modifiers.js'
import { choose, type Prim } from './prim.js'
import type {
  QasmGateCall,
  QasmGateDefinition,
  QasmModifier,
  QasmOperand,
  QasmProgram,
  QasmStatement,
} from './ast.js'

/** Where a named register begins in the flat register the contract has. */
interface RegisterSlice {
  readonly base: number
  readonly size: number
}

/** A definition that became a `customGates` entry, and under what name. */
interface ContractGate {
  readonly name: string
  readonly definition: CustomGate
}

/**
 * As-soon-as-possible column assignment.
 *
 * Every qubit and every classical bit carries the first column at which it is
 * free. An operation goes at the maximum of the ones it touches, and then
 * advances them. A classical bit it *reads* — a condition — is consulted but
 * not advanced, because reading does not occupy the wire; a bit it *writes* is
 * both.
 *
 * The consulting is the load-bearing half. `clbitFree[c]` after a measurement in
 * column k is k + 1, so a conditional on `c` cannot land in column k, which is
 * precisely the column in which the engine would still see the old value. The
 * scheduler therefore reproduces the file's sequential meaning rather than
 * merely packing tightly.
 */
class Scheduler {
  private readonly qubitFree: number[]
  private readonly clbitFree: number[]

  constructor(qubits: number, clbits: number) {
    this.qubitFree = new Array<number>(qubits).fill(0)
    this.clbitFree = new Array<number>(clbits).fill(0)
  }

  place(
    qubits: readonly number[],
    writes: readonly number[],
    reads: readonly number[],
    at: QasmPosition
  ): number {
    let column = 0
    for (const qubit of qubits) {
      column = Math.max(column, this.qubitFree[qubit] ?? 0)
    }
    for (const clbit of [...writes, ...reads]) {
      column = Math.max(column, this.clbitFree[clbit] ?? 0)
    }
    if (column >= MAX_COLUMNS) {
      throw limitError(
        at,
        `This program needs more than ${String(MAX_COLUMNS)} columns, which ` +
          `is past what a circuit document holds.`
      )
    }
    for (const qubit of qubits) this.qubitFree[qubit] = column + 1
    for (const clbit of writes) this.clbitFree[clbit] = column + 1
    return column
  }
}

/**
 * Turns a parsed program into a circuit, or throws `QasmImportError`.
 *
 * The circuit is handed to `parseCircuit` before it is returned, and that is
 * not a formality: §3.5's promise is that an import produces something the
 * contract accepts or a clear error, and never something in between. Anything
 * this file builds that the validator rejects is a defect *here*, and the error
 * it raises says so rather than blaming the file.
 */
export function lowerProgram(program: QasmProgram): Circuit {
  return new Lowering(program).run()
}

class Lowering {
  private readonly program: QasmProgram
  private readonly library: Readonly<Record<string, LibraryGate>>

  private readonly qubitSlices = new Map<string, RegisterSlice>()
  private readonly clbitSlices = new Map<string, RegisterSlice>()
  private qubits = 0
  private clbits = 0

  private readonly definitions = new Map<string, QasmGateDefinition>()
  private readonly contractGates = new Map<string, ContractGate>()

  private readonly operations: Operation[] = []
  private scheduler = new Scheduler(0, 0)
  private nextId = 1

  constructor(program: QasmProgram) {
    this.program = program
    this.library = libraryFor(program.version)
  }

  run(): Circuit {
    this.readRegisters()
    this.readDefinitions()
    this.scheduler = new Scheduler(this.qubits, this.clbits)

    for (const statement of this.program.statements) {
      this.emitStatement(statement, undefined)
    }

    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: this.qubits,
      clbits: this.clbits,
      ...(this.wireLabels() === undefined
        ? {}
        : { qubitLabels: this.wireLabels() }),
      operations: this.operations,
      ...(this.contractGates.size === 0
        ? {}
        : { customGates: this.customGates() }),
    }

    try {
      return parseCircuit(circuit)
    } catch (cause) {
      if (!(cause instanceof CircuitValidationError)) throw cause
      /*
       * Two of the contract's codes are resource ceilings rather than defects,
       * and they are reachable from a hostile file that this importer read
       * perfectly well: a chain of `gate` definitions each calling the next
       * becomes a chain of *blocks*, and the size of the expansion is a fact
       * about the definitions rather than about any one statement. Reporting
       * those as `contract` would tell the reader their import hit an internal
       * inconsistency, when what it hit was a limit — so they are re-labelled.
       *
       * Everything else really is a defect here, because §3.5's promise is that
       * an import produces a circuit the contract accepts or a clear error, and
       * a rejection at this line means neither happened.
       */
      const ceilings = new Set([
        'custom-gate-too-deep',
        'custom-gate-too-large',
      ])
      const first = cause.issues[0]
      if (first !== undefined && ceilings.has(first.code)) {
        throw limitError(START_OF_FILE, first.message)
      }
      throw new QasmImportError(
        'contract',
        START_OF_FILE,
        `This file was read but the circuit it describes is not one the ` +
          `format accepts: ${first?.message ?? cause.message}`,
        { issues: cause.issues }
      )
    }
  }

  /* ──────────────────────────── registers ────────────────────────────── */

  private readRegisters(): void {
    for (const register of this.program.qubitRegisters) {
      this.declare(this.qubitSlices, register.name, register.at)
      this.qubitSlices.set(register.name, {
        base: this.qubits,
        size: register.size,
      })
      this.qubits += register.size
      if (this.qubits > MAX_QUBITS) {
        throw limitError(
          register.at,
          `The registers declared so far add up to ${String(this.qubits)} ` +
            `qubits; a circuit holds at most ${String(MAX_QUBITS)}.`
        )
      }
    }

    for (const register of this.program.clbitRegisters) {
      this.declare(this.clbitSlices, register.name, register.at)
      this.clbitSlices.set(register.name, {
        base: this.clbits,
        size: register.size,
      })
      this.clbits += register.size
      if (this.clbits > MAX_CLBITS) {
        throw limitError(
          register.at,
          `The classical registers declared so far add up to ` +
            `${String(this.clbits)} bits; a circuit holds at most ` +
            `${String(MAX_CLBITS)}.`
        )
      }
    }

    if (this.qubits === 0) {
      throw semanticError(
        START_OF_FILE,
        'This file declares no qubits, so there is no circuit in it.'
      )
    }
  }

  private declare(
    into: ReadonlyMap<string, RegisterSlice>,
    name: string,
    at: QasmPosition
  ): void {
    if (
      into.has(name) ||
      this.qubitSlices.has(name) ||
      this.clbitSlices.has(name)
    ) {
      throw semanticError(at, `Register "${name}" is declared more than once.`)
    }
  }

  /**
   * Wire names, when the flattening would otherwise be invisible.
   *
   * One register is the ordinary case and needs no labels: `q[2]` is qubit 2 and
   * the canvas already says so. Two or more registers are concatenated into one,
   * and without the names a reader has no way to know that `bob[0]` became
   * qubit 2 — which is exactly the sort of silent renumbering an import should
   * never do. Labels longer than the contract holds are dropped as a set rather
   * than truncated: a truncated label is a wrong label.
   */
  private wireLabels(): string[] | undefined {
    if (this.program.qubitRegisters.length < 2) return undefined
    const labels: string[] = []
    for (const register of this.program.qubitRegisters) {
      for (let index = 0; index < register.size; index++) {
        labels.push(
          register.size === 1
            ? register.name
            : `${register.name}[${String(index)}]`
        )
      }
    }
    return labels.every((label) => label.length <= 32) ? labels : undefined
  }

  /* ─────────────────────────── definitions ───────────────────────────── */

  private readDefinitions(): void {
    for (const definition of this.program.gates) {
      if (this.definitions.has(definition.name)) {
        throw semanticError(
          definition.at,
          `Gate "${definition.name}" is defined more than once.`
        )
      }
      const formals = new Set<string>()
      for (const qubit of definition.qubits) {
        if (formals.has(qubit)) {
          throw semanticError(
            definition.at,
            `Gate "${definition.name}" names the qubit "${qubit}" twice.`
          )
        }
        formals.add(qubit)
      }
      this.definitions.set(definition.name, definition)
    }

    // Dependency order, so a definition is only offered as a `customGates`
    // entry after everything it calls already is one. The walk also refuses a
    // definition that reaches itself, directly or through another: OpenQASM
    // forbids it, the expander would recurse until the stack gave out, and the
    // reader would see a crash instead of the name of the gate they looped.
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (name: string, trail: readonly string[]): void => {
      const mark = state.get(name)
      if (mark === 'done') return
      const definition = this.definitions.get(name)
      if (definition === undefined) return
      if (mark === 'visiting') {
        throw semanticError(
          definition.at,
          `Gate "${name}" is defined in terms of itself ` +
            `(${[...trail, name].join(' → ')}). A gate cannot use itself, ` +
            `directly or through another gate.`
        )
      }
      state.set(name, 'visiting')
      for (const called of calledGates(definition.body)) {
        if (this.definitions.has(called)) visit(called, [...trail, name])
      }
      state.set(name, 'done')
      this.registerContractGate(definition)
    }
    for (const definition of this.program.gates) visit(definition.name, [])
  }

  /**
   * Offers a definition as a `customGates` entry, if it fits.
   *
   * Everything that does not fit answers `undefined` rather than throwing:
   * failing to be a block is not a failure at all, it just means the definition
   * is inlined where it is used. The refusals are all shape refusals — a name
   * the contract cannot store, too many parameters, a body that measures, an
   * angle computed from a formal — and each one is a case where a `customGates`
   * entry would have to carry something it has no field for.
   */
  private registerContractGate(definition: QasmGateDefinition): void {
    if (definition.params.length > MAX_CUSTOM_GATE_PARAMS) return
    if (definition.qubits.length > MAX_QUBITS) return
    if (!definition.params.every(isContractIdentifier)) return
    if (new Set(definition.params).size !== definition.params.length) return

    const name = this.contractNameFor(definition.name)
    if (name === undefined) return

    const formals = new Set(definition.params)
    const positions = new Map(
      definition.qubits.map((qubit, index) => [qubit, index])
    )
    const scheduler = new Scheduler(definition.qubits.length, 0)
    const operations: Operation[] = []

    try {
      for (const statement of definition.body) {
        const emitted = this.definitionOperation(
          statement,
          formals,
          positions,
          operations.length
        )
        if (emitted === null) return
        for (const operation of emitted) {
          const column = scheduler.place(
            qubitsTouched(operation),
            [],
            [],
            statement.at
          )
          operations.push({ ...operation, column })
        }
      }
    } catch (cause) {
      if (cause instanceof NotRepresentable) return
      throw cause
    }

    this.contractGates.set(definition.name, {
      name,
      definition: {
        qubits: definition.qubits.length,
        ...(definition.params.length === 0
          ? {}
          : { params: [...definition.params] }),
        operations,
      },
    })
  }

  /**
   * One body statement as a contract operation, with parameters left symbolic.
   *
   * `null` means "this definition cannot be a block", never "this file is
   * wrong": the same statement is lowered again, numerically, wherever the
   * definition is used.
   */
  private definitionOperation(
    statement: QasmStatement,
    formals: ReadonlySet<string>,
    positions: ReadonlyMap<string, number>,
    index: number
  ): Omit<Operation, 'column'>[] | null {
    const id = `g_${String(index + 1)}`
    const resolve = (operand: QasmOperand): number | null => {
      if (operand.index !== null) return null
      return positions.get(operand.name) ?? null
    }

    if (statement.kind === 'barrier') {
      /*
       * `barrier;` with no operands means every qubit of the gate being
       * defined — the same reading `emitStatement` gives it at the top level,
       * where it means every qubit of the circuit. Without this it produced an
       * empty target list, which the contract refuses with `contract` at line
       * 1: a *valid* OpenQASM 3 file failing with an error that claims a defect
       * in the importer and points nowhere.
       */
      const targets =
        statement.operands.length === 0
          ? unique([...positions.values()])
          : unique(statement.operands.map(resolve) as number[])
      if (statement.operands.some((operand) => resolve(operand) === null)) {
        return null
      }
      return [{ id, gate: 'barrier', targets }]
    }
    if (statement.kind !== 'gateCall') return null

    const qubits: number[] = []
    for (const operand of statement.operands) {
      const resolved = resolve(operand)
      if (resolved === null) return null
      qubits.push(resolved)
    }
    /*
     * `cx a, a` inside a body. Not a block: the contract refuses an operation
     * that uses one qubit twice, and building one anyway made the whole import
     * fail as `contract` at line 1. Answering `null` inlines the definition at
     * its call sites instead, where the identical check in `emitApplication`
     * refuses it as `semantic` at the line that wrote it.
     */
    if (unique(qubits).length !== qubits.length) return null

    const controls: ControlSpec[] = []
    let taken = 0
    for (const modifier of statement.modifiers) {
      if (modifier.kind === 'inv' || modifier.kind === 'pow') return null
      const count =
        modifier.count === null ? 1 : evaluate(modifier.count, new Map())
      if (!Number.isInteger(count) || count < 0) return null
      for (let step = 0; step < count; step++) {
        const qubit = qubits[taken]
        if (qubit === undefined) return null
        controls.push({ qubit, state: modifier.kind === 'ctrl' ? 1 : 0 })
        taken += 1
      }
    }
    const operands = qubits.slice(taken)
    const params = statement.args.map((argument) =>
      symbolicToParam(evaluateSymbolic(argument, formals))
    )

    const called = this.contractGates.get(statement.name)
    if (called !== undefined) {
      // A block inside a block. The contract allows the nesting and refuses
      // controls on it (§3.1 decision 1), so a controlled use has to inline.
      if (controls.length > 0) return null
      if (
        operands.length !== this.definitions.get(statement.name)?.qubits.length
      ) {
        return null
      }
      return [
        {
          id,
          gate: called.name,
          targets: operands,
          ...(params.length === 0 ? {} : { params }),
        },
      ]
    }
    if (this.definitions.has(statement.name)) return null

    const entry = this.library[statement.name]
    if (entry?.passThrough === undefined) return null
    if (entry.params !== params.length) return null
    if (entry.qubits !== operands.length) return null

    const { kernel, controlCount } = entry.passThrough
    const shaped = choose({
      kind: 'gate',
      kernel,
      targets: operands.slice(controlCount),
      controls: [
        ...controls,
        ...operands
          .slice(0, controlCount)
          .map((qubit) => ({ qubit, state: 1 as const })),
      ],
      params: [],
    })
    if (shaped === null) return null
    return [
      {
        id,
        gate: shaped.gate,
        targets: [...shaped.targets],
        ...(shaped.controls.length === 0
          ? {}
          : { controls: shaped.controls.map((control) => ({ ...control })) }),
        ...(params.length === 0 ? {} : { params }),
      },
    ]
  }

  /**
   * A name for a definition that no catalog gate and no other definition holds.
   *
   * The contract's own resolver gives the built-in catalog priority over
   * `customGates` (`validate.ts`), so a definition called `h` would be declared
   * and never reachable. Renaming it — the exporter's `nameCustomGates` rule,
   * run backwards — keeps it callable and keeps the file's meaning: a QASM file
   * that redefines `h` means its own `h`, and dropping the definition would
   * silently substitute the built-in Hadamard for it.
   */
  private contractNameFor(qasmName: string): string | undefined {
    const taken = new Set(
      [...this.contractGates.values()].map((entry) => entry.name)
    )
    let name = qasmName
    while (isGateId(name) || taken.has(name)) name += '_'
    return isContractIdentifier(name) ? name : undefined
  }

  private customGates(): Record<string, CustomGate> {
    const out: Record<string, CustomGate> = {}
    for (const entry of this.contractGates.values()) {
      out[entry.name] = entry.definition
    }
    return out
  }

  /* ──────────────────────────── statements ───────────────────────────── */

  private emitStatement(
    statement: QasmStatement,
    condition: Condition | undefined
  ): void {
    switch (statement.kind) {
      case 'if':
        this.emitConditional(statement, condition)
        return
      case 'barrier': {
        const targets =
          statement.operands.length === 0
            ? range(this.qubits)
            : unique(
                statement.operands.flatMap((operand) => this.qubitsOf(operand))
              )
        this.push({ gate: 'barrier', targets }, condition, statement.at)
        return
      }
      case 'reset':
        for (const operand of statement.operands) {
          for (const qubit of this.qubitsOf(operand)) {
            this.push(
              { gate: 'reset', targets: [qubit] },
              condition,
              statement.at
            )
          }
        }
        return
      case 'measure':
        this.emitMeasure(statement, condition)
        return
      case 'gateCall':
        this.emitGateCall(statement, condition)
        return
    }
  }

  private emitMeasure(
    statement: Extract<QasmStatement, { kind: 'measure' }>,
    condition: Condition | undefined
  ): void {
    if (statement.target === null) {
      throw unsupportedError(
        statement.at,
        'measure without a target',
        'A measurement has to write to a classical bit: the circuit format ' +
          'records the bit it wrote, and a discarded result has nowhere to go.'
      )
    }
    const qubits = this.qubitsOf(statement.source)
    const clbits = this.clbitsOf(statement.target)
    if (qubits.length !== clbits.length) {
      throw semanticError(
        statement.at,
        `This measures ${String(qubits.length)} qubit(s) into ` +
          `${String(clbits.length)} classical bit(s); the two must match.`
      )
    }
    for (let index = 0; index < qubits.length; index++) {
      this.push(
        {
          gate: 'measure',
          targets: [qubits[index] as number],
          clbitTargets: [clbits[index] as number],
        },
        condition,
        statement.at
      )
    }
  }

  /**
   * `if (…) … else …`.
   *
   * `else` costs nothing to support and is worth having: the same operations
   * conditioned on the opposite value of the same bit is exactly what it means,
   * and the contract's `condition` carries the value it tests (§6). A
   * conditional *inside* a conditional is refused, because an operation carries
   * one condition and two nested tests on different bits cannot be folded into
   * one.
   *
   * ── AND THAT READING HOLDS ONLY WHILE THE BIT STAYS PUT ──────────────────
   *
   * A conditional in the source is one test, taken once. A conditional in the
   * contract is a *predicate on every operation*, re-read against the register
   * as each column begins — so the two agree exactly as long as nothing inside
   * the conditional rewrites the bit it tests. The moment something does, they
   * part company, and silently:
   *
   *     if (c[0] == true) { c[0] = measure q[1]; } else { x q[1]; }
   *
   * The then-branch measures 0 into `c[0]`; the else-branch, scheduled into a
   * later column, re-reads `c[0]`, finds the new value, and fires too. Both
   * branches run, on an ordinary valid file, with no diagnostic — a circuit
   * that is not the one the reader imported. The same happens without `else`
   * when a branch overwrites its own guard and has statements after it.
   *
   * There is no faithful lowering: the contract has no way to say "the value
   * this bit had before the branch", and no ordering of the emitted operations
   * restores it once both branches touch the bit. So it is refused, by name and
   * at the line — the rule this importer follows everywhere else for a
   * construct that has no shape here.
   */
  private emitConditional(
    statement: Extract<QasmStatement, { kind: 'if' }>,
    outer: Condition | undefined
  ): void {
    if (outer !== undefined) {
      throw unsupportedError(
        statement.at,
        'nested if',
        'An operation in the circuit format carries one classical ' +
          'condition, so a conditional inside a conditional has no shape.'
      )
    }
    const condition = this.conditionOf(statement)
    const branches = [...statement.body, ...(statement.otherwise ?? [])]
    for (const inner of branches) {
      if (!this.writesClbit(inner, condition.clbit)) continue
      throw unsupportedError(
        inner.at,
        'a conditional branch that measures into the bit it tests',
        `This branch writes the classical bit its own condition tests. A ` +
          `condition in the circuit format is re-read for every operation ` +
          `(§6), so the operations after this one — and every operation of ` +
          `the other branch — would read the new value rather than the one ` +
          `the "if" was taken on, and both branches could run. Measure into ` +
          `a different bit if that is what you meant.`
      )
    }
    for (const inner of statement.body) this.emitStatement(inner, condition)
    for (const inner of statement.otherwise ?? []) {
      this.emitStatement(inner, {
        clbit: condition.clbit,
        equals: condition.equals === 1 ? 0 : 1,
      })
    }
  }

  /** Whether this statement fills `clbit` — the only way a bit is written. */
  private writesClbit(statement: QasmStatement, clbit: number): boolean {
    if (statement.kind !== 'measure') return false
    if (statement.target === null) return false
    return this.clbitsOf(statement.target).includes(clbit)
  }

  private conditionOf(
    statement: Extract<QasmStatement, { kind: 'if' }>
  ): Condition {
    const slice = this.clbitSlices.get(statement.register)
    if (slice === undefined) {
      throw semanticError(
        statement.at,
        `"${statement.register}" is not a classical register, so it cannot ` +
          `be tested.`
      )
    }
    if (statement.value !== 0 && statement.value !== 1) {
      throw unsupportedError(
        statement.at,
        `if (${statement.register} == ${String(statement.value)})`,
        `A condition in the circuit format tests one classical bit against ` +
          `0 or 1 (§6). Comparing a register against ` +
          `${String(statement.value)} tests several bits at once.`
      )
    }
    if (statement.bit === null && slice.size !== 1) {
      throw unsupportedError(
        statement.at,
        `if (${statement.register} == …)`,
        `This compares the whole ${String(slice.size)}-bit register ` +
          `"${statement.register}", and a condition in the circuit format ` +
          `tests one bit (§6). Write it as ` +
          `if (${statement.register}[0] == …) if that is what you meant.`
      )
    }
    const bit = statement.bit ?? 0
    if (bit >= slice.size) {
      throw semanticError(
        statement.at,
        `"${statement.register}" has ${String(slice.size)} bit(s), so ` +
          `${statement.register}[${String(bit)}] does not exist.`
      )
    }
    return { clbit: slice.base + bit, equals: statement.value }
  }

  /* ───────────────────────────── gate calls ──────────────────────────── */

  /**
   * A gate call, including OpenQASM's register broadcast.
   *
   * `h q;` on a three-qubit register is three Hadamards and `cx a, b;` on two
   * registers of the same size is three CNOTs — a language feature rather than
   * a shorthand, and the reason operands are resolved to *lists* everywhere in
   * this file. Mixing a whole register with a single bit repeats the single
   * one, which is again the language's rule.
   */
  private emitGateCall(
    call: QasmGateCall,
    condition: Condition | undefined
  ): void {
    const lists = call.operands.map((operand) => this.qubitsOf(operand))
    const widths = lists
      .map((list, index) =>
        call.operands[index]?.index === null ? list.length : 1
      )
      .filter((width) => width > 1)
    const broadcast = widths.length === 0 ? 1 : (widths[0] as number)
    if (widths.some((width) => width !== broadcast)) {
      throw semanticError(
        call.at,
        'This applies one gate to registers of different sizes, which has no ' +
          'meaning: a broadcast pairs registers index by index.'
      )
    }

    const args = call.args.map((argument) => evaluate(argument, new Map()))
    for (let slot = 0; slot < broadcast; slot++) {
      const qubits = lists.map((list) =>
        list.length === 1 ? (list[0] as number) : (list[slot] as number)
      )
      this.emitApplication(call, args, qubits, condition)
    }
  }

  private emitApplication(
    call: QasmGateCall,
    args: readonly number[],
    qubits: readonly number[],
    condition: Condition | undefined
  ): void {
    if (new Set(qubits).size !== qubits.length) {
      throw semanticError(
        call.at,
        `This applies "${call.name}" to the same qubit twice; a gate acts on ` +
          `distinct qubits.`
      )
    }

    // A definition that fits the contract, used plainly, stays a block. Under
    // any modifier it is inlined instead: the contract has no controlled,
    // inverted or repeated custom gate, and refusing would lose a file that
    // every other toolchain reads.
    const block = this.contractGates.get(call.name)
    if (block !== undefined && call.modifiers.length === 0) {
      const definition = this.definitions.get(call.name)
      this.checkArity(call, args.length, qubits.length, {
        params: definition?.params.length ?? 0,
        qubits: definition?.qubits.length ?? 0,
      })
      this.push(
        {
          gate: block.name,
          targets: [...qubits],
          ...(args.length === 0 ? {} : { params: [...args] }),
        },
        condition,
        call.at
      )
      return
    }

    for (const prim of this.applyModifiers(call, args, qubits)) {
      if (prim.kind === 'gphase') continue
      if (prim.kind === 'barrier') {
        this.push(
          { gate: 'barrier', targets: [...prim.qubits] },
          condition,
          call.at
        )
        continue
      }
      const shaped = choose(prim)
      if (shaped === null) {
        throw unsupportedError(
          call.at,
          `controlled ${prim.kernel}`,
          `This asks for a controlled "${prim.kernel}", and the gate catalog ` +
            `has no such entry: only one-qubit gates take arbitrary controls, ` +
            `plus the named "cswap".`
        )
      }
      this.push(
        {
          gate: shaped.gate,
          targets: [...shaped.targets],
          ...(shaped.controls.length === 0
            ? {}
            : { controls: shaped.controls.map((control) => ({ ...control })) }),
          ...(prim.params.length === 0 ? {} : { params: [...prim.params] }),
        },
        condition,
        call.at
      )
    }
  }

  /** Binds the modifiers' control qubits, then applies them innermost first. */
  private applyModifiers(
    call: QasmGateCall,
    args: readonly number[],
    qubits: readonly number[]
  ): Prim[] {
    const bound: { modifier: QasmModifier; controls: ControlSpec[] }[] = []
    let taken = 0
    for (const modifier of call.modifiers) {
      const controls: ControlSpec[] = []
      if (modifier.kind === 'ctrl' || modifier.kind === 'negctrl') {
        const count =
          modifier.count === null ? 1 : evaluate(modifier.count, new Map())
        if (!Number.isInteger(count) || count < 1) {
          throw semanticError(
            modifier.at,
            `"${modifier.kind}(${String(count)})" needs a whole number of ` +
              `control qubits, at least one.`
          )
        }
        for (let step = 0; step < count; step++) {
          const qubit = qubits[taken]
          if (qubit === undefined) {
            throw semanticError(
              modifier.at,
              `The modifiers on "${call.name}" need more control qubits than ` +
                `the call supplies.`
            )
          }
          controls.push({ qubit, state: modifier.kind === 'ctrl' ? 1 : 0 })
          taken += 1
        }
      }
      bound.push({ modifier, controls })
    }

    let prims = this.lowerCall(call.name, args, qubits.slice(taken), call.at, 0)
    // Right to left: the modifier nearest the gate acts first.
    for (let index = bound.length - 1; index >= 0; index--) {
      const { modifier, controls } = bound[index] as (typeof bound)[number]
      if (modifier.kind === 'inv') prims = invert(prims, modifier.at)
      else if (modifier.kind === 'pow') {
        prims = power(
          prims,
          evaluate(modifier.exponent, new Map()),
          modifier.at
        )
      } else prims = addControls(prims, controls, modifier.at)
    }
    return prims
  }

  /**
   * One gate application as primitives, expanding user definitions.
   *
   * `depth` is the nesting of definitions calling definitions, bounded for the
   * reason `MAX_CUSTOM_GATE_DEPTH` gives in the contract: cycle detection proves
   * the graph terminates and says nothing about how deep it is, and a chain
   * thousands of links long fits inside a small file.
   */
  private lowerCall(
    name: string,
    args: readonly number[],
    qubits: readonly number[],
    at: QasmPosition,
    depth: number
  ): Prim[] {
    if (depth > MAX_DEFINITION_DEPTH) {
      throw limitError(
        at,
        `Gate definitions are nested more than ` +
          `${String(MAX_DEFINITION_DEPTH)} deep.`
      )
    }

    const definition = this.definitions.get(name)
    if (definition !== undefined) {
      this.checkArity({ name, at }, args.length, qubits.length, {
        params: definition.params.length,
        qubits: definition.qubits.length,
      })
      const scope = new Map(
        definition.params.map((formal, index) => [
          formal,
          args[index] as number,
        ])
      )
      const wires = new Map(
        definition.qubits.map((formal, index) => [
          formal,
          qubits[index] as number,
        ])
      )
      const prims: Prim[] = []
      for (const statement of definition.body) {
        prims.push(...this.lowerBodyStatement(statement, scope, wires, depth))
        this.count(prims.length, at)
      }
      return prims
    }

    rejectKnownUnsupported(name, at)
    const entry = this.library[name]
    if (entry === undefined) {
      throw semanticError(
        at,
        `"${name}" is not a gate this file defines, and it is not in the ` +
          `OpenQASM ${String(this.program.version)} standard library.`
      )
    }
    this.checkArity({ name, at }, args.length, qubits.length, entry)
    const prims = entry.lower(args, qubits)
    this.count(prims.length, at)
    return prims
  }

  /** A statement inside a `gate` body, with the formals already bound. */
  private lowerBodyStatement(
    statement: QasmStatement,
    scope: ReadonlyMap<string, number>,
    wires: ReadonlyMap<string, number>,
    depth: number
  ): Prim[] {
    if (statement.kind === 'barrier') {
      return [
        {
          kind: 'barrier',
          qubits: statement.operands.map((operand) =>
            this.formalQubit(operand, wires)
          ),
        },
      ]
    }
    if (statement.kind !== 'gateCall') {
      throw unsupportedError(
        statement.at,
        statement.kind,
        `A gate definition is a unitary block, so its body cannot ` +
          `${statement.kind === 'measure' ? 'measure' : statement.kind === 'reset' ? 'reset a qubit' : 'test a classical bit'}.`
      )
    }

    const qubits = statement.operands.map((operand) =>
      this.formalQubit(operand, wires)
    )
    const args = statement.args.map((argument) => evaluate(argument, scope))

    const bound: { modifier: QasmModifier; controls: ControlSpec[] }[] = []
    let taken = 0
    for (const modifier of statement.modifiers) {
      const controls: ControlSpec[] = []
      if (modifier.kind === 'ctrl' || modifier.kind === 'negctrl') {
        const count =
          modifier.count === null ? 1 : evaluate(modifier.count, scope)
        for (let step = 0; step < count; step++) {
          const qubit = qubits[taken]
          if (qubit === undefined) {
            throw semanticError(
              modifier.at,
              `The modifiers on "${statement.name}" need more control ` +
                `qubits than the call supplies.`
            )
          }
          controls.push({ qubit, state: modifier.kind === 'ctrl' ? 1 : 0 })
          taken += 1
        }
      }
      bound.push({ modifier, controls })
    }

    let prims = this.lowerCall(
      statement.name,
      args,
      qubits.slice(taken),
      statement.at,
      depth + 1
    )
    for (let index = bound.length - 1; index >= 0; index--) {
      const { modifier, controls } = bound[index] as (typeof bound)[number]
      if (modifier.kind === 'inv') prims = invert(prims, modifier.at)
      else if (modifier.kind === 'pow') {
        prims = power(prims, evaluate(modifier.exponent, scope), modifier.at)
      } else prims = addControls(prims, controls, modifier.at)
    }
    return prims
  }

  private formalQubit(
    operand: QasmOperand,
    wires: ReadonlyMap<string, number>
  ): number {
    if (operand.index !== null) {
      throw semanticError(
        operand.at,
        `Inside a gate definition, "${operand.name}" is a single qubit and ` +
          `cannot be indexed.`
      )
    }
    const qubit = wires.get(operand.name)
    if (qubit === undefined) {
      throw semanticError(
        operand.at,
        `"${operand.name}" is not one of the qubits this gate declares.`
      )
    }
    return qubit
  }

  /* ───────────────────────────── plumbing ────────────────────────────── */

  private checkArity(
    call: { readonly name: string; readonly at: QasmPosition },
    args: number,
    qubits: number,
    expected: { readonly params: number; readonly qubits: number }
  ): void {
    if (args !== expected.params) {
      throw semanticError(
        call.at,
        `"${call.name}" takes ${String(expected.params)} parameter(s), and ` +
          `this call passes ${String(args)}.`
      )
    }
    if (qubits !== expected.qubits) {
      throw semanticError(
        call.at,
        `"${call.name}" takes ${String(expected.qubits)} qubit(s), and this ` +
          `call passes ${String(qubits)}.`
      )
    }
  }

  private qubitsOf(operand: QasmOperand): number[] {
    return this.resolve(operand, this.qubitSlices, 'qubit')
  }

  private clbitsOf(operand: QasmOperand): number[] {
    return this.resolve(operand, this.clbitSlices, 'classical')
  }

  private resolve(
    operand: QasmOperand,
    slices: ReadonlyMap<string, RegisterSlice>,
    kind: 'qubit' | 'classical'
  ): number[] {
    const slice = slices.get(operand.name)
    if (slice === undefined) {
      throw semanticError(
        operand.at,
        `"${operand.name}" is not a ${kind} register declared in this file.`
      )
    }
    if (operand.index === null) {
      return range(slice.size).map((offset) => slice.base + offset)
    }
    if (operand.index >= slice.size) {
      throw semanticError(
        operand.at,
        `"${operand.name}" has ${String(slice.size)} entries, so ` +
          `${operand.name}[${String(operand.index)}] does not exist.`
      )
    }
    return [slice.base + operand.index]
  }

  /** Appends an operation, scheduling its column and counting it. */
  private push(
    operation: Omit<Operation, 'id' | 'column'>,
    condition: Condition | undefined,
    at: QasmPosition
  ): void {
    this.count(1, at)
    const withCondition = {
      ...operation,
      ...(condition === undefined ? {} : { condition }),
    }
    const touched = qubitsTouched(withCondition)
    /*
     * The last gate before the contract sees this, and the only one every path
     * passes through. `emitApplication` checks the operands of a *call*, which
     * says nothing about a body inlined into it — `gate g a, b { cx a, a; }`
     * used to reach `parseCircuit` and be refused there as `contract` at line
     * 1, the code `errors.ts` defines as a defect in the importer, with no
     * position for the reader. Refused here instead, at the line that wrote it.
     */
    if (unique(touched).length !== touched.length) {
      throw semanticError(
        at,
        'This operation uses the same qubit twice: a gate acts on distinct ' +
          'qubits, and a control cannot be the qubit the gate acts on.'
      )
    }
    const column = this.scheduler.place(
      touched,
      operation.clbitTargets ?? [],
      condition === undefined ? [] : [condition.clbit],
      at
    )
    this.operations.push({
      id: `op_${String(this.nextId)}`,
      ...withCondition,
      column,
    })
    this.nextId += 1
  }

  private count(added: number, at: QasmPosition): void {
    if (this.operations.length + added > MAX_OPERATIONS) {
      throw limitError(
        at,
        `This program produces more than ${String(MAX_OPERATIONS)} ` +
          `operations, which is past what a circuit document holds.`
      )
    }
  }
}

/* ───────────────────────────── small helpers ─────────────────────────── */

/** Names a body calls, for the dependency walk. Modifiers do not change one. */
function calledGates(body: readonly QasmStatement[]): string[] {
  const names: string[] = []
  for (const statement of body) {
    if (statement.kind === 'gateCall') names.push(statement.name)
  }
  return names
}

function qubitsTouched(operation: {
  readonly targets: readonly number[]
  readonly controls?: readonly (number | ControlSpec)[]
}): number[] {
  return [
    ...operation.targets,
    ...(operation.controls ?? []).map((control) =>
      typeof control === 'number' ? control : control.qubit
    ),
  ]
}

function symbolicToParam(value: SymbolicValue): ParamValue {
  return typeof value === 'number' ? value : value.formal
}

/** The contract's own identifier rule, from `circuit.ts`. */
function isContractIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 64
}

function range(size: number): number[] {
  return Array.from({ length: size }, (_, index) => index)
}

function unique(values: readonly number[]): number[] {
  return [...new Set(values)]
}
