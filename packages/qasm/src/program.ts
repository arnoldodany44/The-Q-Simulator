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
 * by column, and within a column every other operation before the
 * measurements. See the header for why that second rule is load-bearing.
 *
 * `Array.prototype.sort` is stable, so operations that tie on both keys keep
 * the order the document lists them in and the output is deterministic.
 */
export function orderedOperations(
  operations: readonly Operation[]
): readonly Operation[] {
  return [...operations].sort(
    (a, b) => a.column - b.column || rank(a) - rank(b)
  )
}

function rank(operation: Operation): number {
  return operation.gate === 'measure' ? 1 : 0
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
