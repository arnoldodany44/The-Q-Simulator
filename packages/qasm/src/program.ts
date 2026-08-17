/**
 * What both text emitters need before they can disagree about anything.
 *
 * OpenQASM 3 and Qiskit Python are different languages, but they are the same
 * *reading* of the document: the same order of operations, the same resolved
 * angles, the same header sentences. Keeping that reading here is what stops
 * the two exports from describing two different circuits — which is a
 * divergence a user would only find by running both.
 *
 * ── COLUMNS ARE INSTANTS, AND SOURCE CODE IS A SEQUENCE ──────────────────
 *
 * `column` is time (§6): everything in one column happens at once, and the
 * contract guarantees those operations touch disjoint qubits, so their order
 * among themselves cannot change the quantum state. It *can* change the
 * classical one. The engine resolves that by reading conditions against the
 * register **as it entered the column** (see the header of `runner.ts`), and a
 * sequential language has no way to say "at the same time" — so a measurement
 * written before a conditional of the same column would be read by any QASM or
 * Python interpreter as happening first, and the exported circuit would behave
 * differently from the one on screen.
 *
 * `orderedOperations` therefore emits every non-measurement of a column before
 * its measurements. That is not a cosmetic ordering: it is the only sequential
 * arrangement in which a condition sees the value the engine gives it.
 *
 * ── AND A MEASUREMENT CAN BE A READER TOO ────────────────────────────────
 *
 * "Non-measurements first" is not the whole rule, because an operation may
 * both read the register and write it: a *conditioned measurement* tests one
 * bit and fills another. Ranked only by `gate === 'measure'` it ties with every
 * other measurement of its column, so the document's own order decided — and a
 * document that happened to list the writer first exported a file whose
 * condition reads the value the engine says it must not see. The export then
 * computes something the simulated document does not, which is the one failure
 * a round trip exists to prevent.
 *
 * So the order within a column is a real constraint and is solved as one:
 * **every operation that reads a classical bit is emitted before every
 * operation that writes that bit**, with the "non-measurements first" rule kept
 * as the tie-break so the output stays byte-stable. A column whose reads and
 * writes are genuinely circular — two conditioned measurements, each writing
 * the bit the other tests — has no sequential arrangement at all, and is
 * refused by name rather than emitted in whichever order the sort produced.
 */

import {
  lookupGate,
  resolveParams,
  type Circuit,
  type CustomGate,
  type Operation,
  type Parameter,
} from '@qsim/schema'

/**
 * A circuit that cannot be written down in the target language.
 *
 * Carries `operationId` for the same reason `CircuitRunError` does: the only
 * thing a UI can do with "this gate cannot be exported" is point at the gate.
 */
export class CircuitExportError extends Error {
  readonly operationId: string | undefined

  constructor(message: string, operationId?: string) {
    super(message)
    this.name = 'CircuitExportError'
    this.operationId = operationId
  }
}

/** Options both text exporters accept. */
export interface ExportOptions {
  /**
   * The document's title, written into the header comment. Anything that
   * cannot live on a comment line is stripped — see `commentText`.
   */
  readonly title?: string
}

/**
 * The operations in the order a sequential language must run them: ascending
 * by column, and within a column every reader of a classical bit before every
 * writer of it. See the header for why that second rule is load-bearing.
 *
 * The sort is stable and the ordering inside a column is deterministic, so an
 * export is byte-stable across runs — a file whose diff is noise is a file
 * nobody reviews.
 */
export function orderedOperations(
  operations: readonly Operation[]
): readonly Operation[] {
  const base = [...operations].sort(
    (a, b) => a.column - b.column || rank(a) - rank(b)
  )

  const ordered: Operation[] = []
  let start = 0
  while (start < base.length) {
    let end = start + 1
    const column = (base[start] as Operation).column
    while (end < base.length && (base[end] as Operation).column === column) {
      end += 1
    }
    ordered.push(...withinColumn(base.slice(start, end)))
    start = end
  }
  return ordered
}

function rank(operation: Operation): number {
  return operation.gate === 'measure' ? 1 : 0
}

function readsBit(operation: Operation): number | null {
  return operation.condition?.clbit ?? null
}

function writesBits(operation: Operation): readonly number[] {
  return operation.gate === 'measure' ? (operation.clbitTargets ?? []) : []
}

/**
 * One column, arranged so that every read of a classical bit happens before
 * every write of it.
 *
 * A topological sort rather than another sort key, because "reader before
 * writer" is a relation between *pairs* and a rank can only ever approximate
 * one — which is exactly how a conditioned measurement came to be ordered by
 * whichever way round the document happened to list it. Ties are broken by the
 * incoming order, which is already the column's stable "non-measurements
 * first" arrangement, so a column with no classical interaction comes out
 * exactly as it went in.
 */
function withinColumn(column: readonly Operation[]): readonly Operation[] {
  if (column.length < 2) return column

  const writersOf = new Map<number, number[]>()
  for (const [index, operation] of column.entries()) {
    for (const bit of writesBits(operation)) {
      const holders = writersOf.get(bit)
      if (holders === undefined) writersOf.set(bit, [index])
      else holders.push(index)
    }
  }
  if (writersOf.size === 0) return column

  const successors = column.map((): number[] => [])
  const incoming = column.map(() => 0)
  for (const [index, operation] of column.entries()) {
    const bit = readsBit(operation)
    if (bit === null) continue
    for (const writer of writersOf.get(bit) ?? []) {
      if (writer === index) continue
      ;(successors[index] as number[]).push(writer)
      incoming[writer] = (incoming[writer] as number) + 1
    }
  }

  const ready = column
    .map((_operation, index) => index)
    .filter((index) => incoming[index] === 0)
  const ordered: Operation[] = []
  while (ready.length > 0) {
    // The smallest index available, so the incoming order decides every tie
    // and the output does not depend on the traversal.
    ready.sort((a, b) => a - b)
    const index = ready.shift() as number
    ordered.push(column[index] as Operation)
    for (const next of successors[index] as number[]) {
      incoming[next] = (incoming[next] as number) - 1
      if (incoming[next] === 0) ready.push(next)
    }
  }

  if (ordered.length !== column.length) {
    const stuck = column
      .filter((_operation, index) => (incoming[index] as number) > 0)
      .map((operation) => operation.id)
    throw new CircuitExportError(
      `Operations ${stuck.join(', ')} share column ` +
        `${String((column[0] as Operation).column)} and each one's condition ` +
        `reads a classical bit another of them writes. The engine reads every ` +
        `condition against the register as it entered the column, and no ` +
        `sequential order of these statements reproduces that.`,
      stuck[0]
    )
  }
  return ordered
}

/**
 * The entries of `customGates` in an order where nothing is called before it is
 * defined.
 *
 * ── WHY THE JSON'S OWN ORDER IS NOT GOOD ENOUGH ──────────────────────────
 *
 * Both output languages are read top to bottom by a *declaration* rule, not by
 * a link step: OpenQASM 3 refuses a `gate` body that names an identifier no
 * earlier statement declared, and Python refuses a name that is not yet bound.
 * `customGates` is a JSON object, so its order is whoever wrote the document's,
 * and `validateCircuit` accepts one custom gate calling another regardless of
 * which key comes first. Emitted in key order, a gate defined after the one
 * that calls it produced a QASM program QASM3ImporterError rejects at the first
 * body — "gate 'inner' is not defined" — and Python that raises NameError.
 *
 * The editor cannot author custom gates today, but `circuit-url.ts` packs and
 * unpacks them into a shareable link and the API's schema accepts them, so a
 * hand-built link reaches this.
 *
 * ── HOW THE EDGES ARE DRAWN ──────────────────────────────────────────────
 *
 * Only for a called name that is *not* in the catalog and *is* in
 * `customGates`, which is the same resolution order `emitOperation` and
 * `validateCircuit` use: a custom gate named `h` never shadows the Hadamard, so
 * it is never a dependency either. Getting that backwards here would order the
 * file by an edge the emitted call does not have.
 *
 * Depth-first post-order, so a dependency is appended before its caller and
 * independent gates keep the document's own order — an export has to be
 * byte-stable across runs or every diff of one is noise.
 */
/**
 * Which qubit each classical bit holds when the emitted program ends.
 *
 * ── WHY THIS IS HERE AND NOT WHEREVER IT IS NEEDED ───────────────────────
 *
 * Because "the register the device sends home" is a property of the *emitted
 * program*, and this file is what decides the program's order. Two things read
 * that register and they must not have two definitions of it: the API freezes
 * the mapping into the job row at submission, and the browser uses it to key a
 * device's counts onto the chart's basis states (D1). A mapping computed twice
 * is a mapping that can differ once.
 *
 * The subtlety, and the reason a second implementation got it wrong: "later
 * measurements overwrite earlier ones" is a statement about **program order**,
 * which `orderedOperations` above defines as ascending `column` — not about the
 * order the operations happen to sit in the document's array. A document
 * listing `measure q0 → c0` at column 3 before `measure q1 → c0` at column 1 is
 * perfectly valid, and its final `c0` holds q0. Walking the array would answer
 * q1: a bijection, plausible, and the wrong bar on the histogram.
 *
 * `undefined` for a classical bit no measurement ever writes. The caller
 * decides what that means — a hole makes the register something other than a
 * relabelling of the qubit register, which is a refusal rather than a value.
 */
export function finalClassicalRegister(
  operations: readonly Operation[],
  clbits: number
): readonly (number | undefined)[] {
  const qubitOfClbit = new Array<number | undefined>(clbits).fill(undefined)
  for (const operation of orderedOperations(operations)) {
    if (operation.gate !== 'measure') continue
    const qubit = operation.targets[0]
    const clbit = operation.clbitTargets?.[0]
    if (qubit === undefined || clbit === undefined) continue
    if (clbit < 0 || clbit >= clbits) continue
    qubitOfClbit[clbit] = qubit
  }
  return qubitOfClbit
}

export function orderedCustomGates(
  circuit: Circuit
): readonly (readonly [string, CustomGate])[] {
  const definitions = circuit.customGates ?? {}
  const ordered: (readonly [string, CustomGate])[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (name: string, trail: readonly string[]): void => {
    const mark = state.get(name)
    if (mark === 'done') return
    if (mark === 'visiting') {
      /*
       * A cycle has no valid order in either language. Refused rather than
       * emitted in some arbitrary one: a file that does not load is at least
       * honest about it, and this names the loop so it can be found.
       */
      throw new CircuitExportError(
        `Custom gate "${name}" is defined in terms of itself ` +
          `(${[...trail, name].join(' → ')}), so there is no order in which ` +
          `the definitions can be written down.`
      )
    }

    const definition = definitions[name]
    if (definition === undefined) return

    state.set(name, 'visiting')
    for (const operation of definition.operations) {
      if (lookupGate(operation.gate) !== undefined) continue
      if (!Object.hasOwn(definitions, operation.gate)) continue
      visit(operation.gate, [...trail, name])
    }
    state.set(name, 'done')
    ordered.push([name, definition])
  }

  for (const name of Object.keys(definitions)) visit(name, [])
  return ordered
}

/**
 * An operation's angles as plain numbers, with symbolic references resolved
 * against the circuit's `parameters`.
 *
 * Symbolic parameters become literals on the way out, which is a deliberate
 * loss: OpenQASM 3 could carry them as `input float[64] theta` and Qiskit as a
 * `Parameter`, but then the exported file would not run until somebody bound a
 * value, and "paste this into a notebook and press run" is the whole point.
 * The header comment names every parameter that was substituted and the value
 * it was given, so nothing disappears silently.
 */
export function angles(
  operation: Operation,
  parameters: readonly Parameter[]
): number[] {
  try {
    return resolveParams(operation, parameters)
  } catch {
    throw new CircuitExportError(
      `Operation "${operation.id}" references a parameter the circuit does ` +
        `not declare, so its angle has no value to export.`,
      operation.id
    )
  }
}

/**
 * The sentences the header comment carries, without any comment marker: the
 * two languages spell those differently and each emitter adds its own.
 *
 * The endianness sentence is not decoration. It is the one claim a reader
 * needs in order to trust that `q[0]` here means the same qubit as `q[0]` in
 * the notebook they paste it into — decision D1, and the risk the whole
 * convention exists to prevent.
 */
export function describeExport(
  circuit: Circuit,
  options: ExportOptions = {}
): string[] {
  const title = commentText(options.title ?? '')
  const lines: string[] = [
    title === ''
      ? 'Generated by The Q Simulator.'
      : `Generated by The Q Simulator — ${title}`,
    'Little-endian qubit order: q[0] is qubit 0, the least significant bit ' +
      'of the state index. Qiskit uses the same convention, so a bitstring ' +
      'read here means the same thing there.',
  ]

  const labels = circuit.qubitLabels
  if (labels !== undefined && labels.length > 0) {
    const named = labels
      .map((label, index) => `q[${index}] = ${commentText(label)}`)
      .join(', ')
    lines.push(`Wire names in the source document: ${named}.`)
  }

  for (const parameter of usedParameters(circuit)) {
    lines.push(
      `Parameter ${parameter.name} was substituted as the literal ` +
        `${String(parameter.value)} radians.`
    )
  }

  return lines
}

/** Declared parameters that some operation actually references. */
function usedParameters(circuit: Circuit): readonly Parameter[] {
  const referenced = new Set<string>()
  const scan = (operations: readonly Operation[]): void => {
    for (const operation of operations) {
      for (const param of operation.params ?? []) {
        if (typeof param === 'string') referenced.add(param)
      }
    }
  }
  scan(circuit.operations)
  for (const definition of Object.values(circuit.customGates ?? {})) {
    scan(definition.operations)
  }
  return (circuit.parameters ?? []).filter((parameter) =>
    referenced.has(parameter.name)
  )
}

/** Code points that cannot sit on a comment line: C0, DEL and C1. */
function isControlCharacter(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/**
 * User text made safe to sit on a comment line.
 *
 * Titles and wire labels reach the schema through `storableText`, which
 * already refuses control characters — but this package serialises any
 * `Circuit` it is handed, including one built in memory, and a newline inside
 * a title would end the comment and leave the rest of the sentence as a syntax
 * error. A generated file with a stray character in it is a bad first
 * impression of everything else, so the guard is here rather than assumed
 * upstream.
 *
 * Written as a scan rather than as a regular expression because a character
 * class of literal control characters is unreadable in source and easy to
 * damage in an edit — the thing it exists to prevent.
 */
export function commentText(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    out += isControlCharacter(code) ? ' ' : character
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Whether this operation's condition reads a classical bit that a measurement
 * in the *same column* writes.
 *
 * The engine's answer is "it reads the value from before the column" and
 * `orderedOperations` reproduces that by emitting the conditional first — but
 * a generated file in which an `if` on `c[0]` stands above the measurement
 * that fills `c[0]` looks like a mistake to anyone reading it. So the emitters
 * say why, on the spot, in the rare case it happens. Both languages call this;
 * neither owns the rule.
 */
export function readsABitWrittenInItsColumn(
  operation: Operation,
  operations: readonly Operation[]
): boolean {
  const condition = operation.condition
  if (condition === undefined) return false
  return operations.some(
    (other) =>
      other.gate === 'measure' &&
      other.column === operation.column &&
      (other.clbitTargets ?? []).includes(condition.clbit)
  )
}

/** Refuses an operation neither the catalog nor `customGates` declares. */
export function rejectUnknownGate(
  operation: Operation,
  circuit: Circuit
): never {
  const declared = Object.keys(circuit.customGates ?? {})
  throw new CircuitExportError(
    `Operation "${operation.id}" uses gate "${operation.gate}", which is ` +
      `neither in the gate catalog nor declared in "customGates"` +
      `${declared.length === 0 ? '' : ` (declared: ${declared.join(', ')})`}.`,
    operation.id
  )
}
