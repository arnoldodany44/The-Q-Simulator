/**
 * What "the same circuit" means, so the round-trip claim is a claim and not a
 * feeling.
 *
 * ── WHY NOT `toEqual` ON THE TWO DOCUMENTS ───────────────────────────────
 *
 * Because five things legitimately differ across a round trip, and none of
 * them is the circuit:
 *
 *  1. **Operation ids.** `op_1` is the editor's handle for selection and undo.
 *     A file has none, so the importer invents them; comparing them would test
 *     the counter.
 *  2. **Column numbers.** `column` is time, and everything in one column happens
 *     at once (§6) — but OpenQASM is a *sequence* and carries no columns at all.
 *     Any assignment on the way back in is a reconstruction. What survives the
 *     text, and all that survives it, is the *order* along each wire.
 *  3. **Custom gate names and their packaging.** The exporter renames a
 *     definition that collides with `stdgates.inc`; a definition whose body
 *     computes with its own parameters is inlined rather than re-packaged. Both
 *     change the document and neither changes what runs, which is why the
 *     comparison is made after `expandCircuit` — the same flattening the engine
 *     performs before simulating anything (§3.1 decision 2).
 *  4. **Wire labels.** `qubitLabels` is reconstructed on the way *in* from the
 *     file's register names (`alice[0]`, `bob`), and lost on the way out: the
 *     exporter writes one register `q`, because a circuit document's qubits are
 *     a single flat register and splitting them back into the registers they
 *     came from is a guess about a document that no longer records it. The
 *     names survive as prose in the header comment `describeExport` writes, and
 *     as data they do not survive at all. A label is what a wire is *called*,
 *     never what it does, so nothing about the circuit changes.
 *  5. **A custom gate's `symbol`.** §3.1 calls a block "a name and an icon";
 *     OpenQASM has a `gate` declaration and no icon, so the icon is dropped.
 *     The block keeps its name, its arity, its parameters and its body — the
 *     editor draws the name when there is no symbol, which is the same thing it
 *     does for a block that never had one.
 *
 * Both of the last two are losses on the way *out* of this project's own
 * format, and they are listed rather than fixed because the alternative is to
 * encode private data in comments and read it back — a second, invisible
 * format inside the first, which is exactly what makes a file stop being
 * interoperable (§3.5).
 *
 * ── THE DEFINITION ───────────────────────────────────────────────────────
 *
 * Two circuits are equivalent when they have the same number of qubits and
 * classical bits and, after expansion, **every wire sees the same sequence of
 * events**:
 *
 *  - for each qubit, the operations touching it in time order, each recorded
 *    with the part that qubit plays in it — target number *k*, positive control,
 *    negative control — together with the gate's name, its resolved angles, and
 *    the classical bits it reads or writes;
 *  - for each classical bit, the operations that write it and the operations
 *    conditioned on it, in time order, with reads before writes inside a column
 *    because that is the order the engine resolves them in.
 *
 * That is exactly the circuit's dependency graph. Two circuits with the same
 * per-wire sequences have the same DAG — the edges of the DAG *are* consecutive
 * pairs in those sequences — so they compute the same thing, and a scheduler
 * that packs the columns differently cannot make them differ. It is a stronger
 * statement than "the same distribution", which a mirrored circuit can satisfy
 * by accident, and weaker than textual identity, which nothing satisfies.
 *
 * ── WHAT IT DELIBERATELY DOES NOT COVER ──────────────────────────────────
 *
 * `iswap`. It has no name in `stdgates.inc`, so the exporter writes it out as
 * the six-gate decomposition Qiskit uses, under a comment saying so — a
 * deliberate, documented loss on the way *out*. A circuit containing one
 * therefore comes back as six gates and is **not** equivalent by this
 * definition, which is the honest answer: the gate count really did change.
 * `roundtrip.test.ts` pins that case by name and checks it the only way left —
 * by simulating both and comparing the states.
 *
 * Angles are compared to 1e-10 (D6). Exact equality would in fact hold for
 * every angle this pair produces, because `formatAngle` prints the shortest
 * decimal that reads back as the same double — but a comparison that would fail
 * on the last bit of a `u3` phase computed as `-(φ+λ)/2` would be testing
 * floating-point associativity rather than the importer.
 */

import {
  controlsOf,
  expandCircuit,
  resolveParams,
  type Circuit,
  type Operation,
} from '@qsim/schema'

/** Absolute tolerance on an angle, from decision D6. */
export const ANGLE_TOLERANCE = 1e-10

/**
 * Catalog names that are a synonym for a kernel plus the controls the operation
 * already carries.
 *
 * `GATES.cx` is `arity: 1, controlCount: 1` — a one-qubit X whose single
 * control lives in `controls` like any other. So `{gate: 'cx', targets: [b],
 * controls: [a]}` and `{gate: 'x', targets: [b], controls: [a]}` are the same
 * object with two names, and the engine proves it: both reach
 * `applyControlled(state, GATE_MATRICES.x, target, controls)` in `runner.ts`.
 * Both spellings are contract-valid, the editor writes the first and a
 * hand-built document may write the second, and an equivalence that called them
 * different circuits would be reporting on the *name* rather than on what runs.
 *
 * The importer canonicalises to the named form because it is what the palette
 * and the exporter produce; this table is how the comparison stays blind to
 * that choice rather than enforcing it.
 */
const KERNEL_OF: Readonly<Record<string, string>> = {
  cx: 'x',
  ccx: 'x',
  cz: 'z',
  crz: 'rz',
  cp: 'p',
  cswap: 'swap',
}

/** One operation as one wire sees it. */
export interface WireEvent {
  readonly gate: string
  /** `t0`, `t1` — which target — or `c1` / `c0` for a positive/negative control. */
  readonly role: string
  readonly params: readonly number[]
  /** How many targets and controls the operation has in total. */
  readonly shape: string
  /** Classical bits written, and the condition, as the operation carries them. */
  readonly classical: string
}

/** One classical bit's view: the writes and the reads, in order. */
export interface ClassicalEvent {
  readonly gate: string
  readonly kind: 'write' | 'read'
  /** For a read, the value tested. */
  readonly value: number
}

export interface CircuitFingerprint {
  readonly qubits: number
  readonly clbits: number
  readonly wires: readonly (readonly WireEvent[])[]
  readonly classical: readonly (readonly ClassicalEvent[])[]
}

/** The canonical form the definition above describes. */
export function fingerprintCircuit(circuit: Circuit): CircuitFingerprint {
  const flat = expandCircuit(circuit).circuit
  const parameters = flat.parameters ?? []

  /*
   * Sorted by column, then reads before writes, then by the document's own
   * order. The middle key is the engine's rule made explicit: a condition in
   * column k reads the register as it entered column k, so it happens before a
   * measurement of the same column writes into it.
   */
  const ordered = flat.operations
    .map((operation, index) => ({ operation, index }))
    .sort(
      (a, b) =>
        a.operation.column - b.operation.column ||
        rank(a.operation) - rank(b.operation) ||
        a.index - b.index
    )
    .map((entry) => entry.operation)

  const wires: WireEvent[][] = Array.from({ length: flat.qubits }, () => [])
  const classical: ClassicalEvent[][] = Array.from(
    { length: flat.clbits },
    () => []
  )

  for (const operation of ordered) {
    const params = resolveParams(operation, parameters)
    const controls = controlsOf(operation)
    const gate = KERNEL_OF[operation.gate] ?? operation.gate
    const shape = `${String(operation.targets.length)}t${String(controls.length)}c`
    const clbits = operation.clbitTargets ?? []
    const condition = operation.condition
    const classicalNote =
      `${clbits.map(String).join('.')}|` +
      `${condition === undefined ? '' : `${String(condition.clbit)}=${String(condition.equals)}`}`

    operation.targets.forEach((qubit, position) => {
      wires[qubit]?.push({
        gate,
        role: `t${String(position)}`,
        params,
        shape,
        classical: classicalNote,
      })
    })
    for (const control of controls) {
      wires[control.qubit]?.push({
        gate,
        role: `c${String(control.state)}`,
        params,
        shape,
        classical: classicalNote,
      })
    }

    if (condition !== undefined) {
      classical[condition.clbit]?.push({
        gate,
        kind: 'read',
        value: condition.equals,
      })
    }
    for (const clbit of clbits) {
      classical[clbit]?.push({ gate, kind: 'write', value: 1 })
    }
  }

  return { qubits: flat.qubits, clbits: flat.clbits, wires, classical }
}

function rank(operation: Operation): number {
  return operation.condition !== undefined ? 0 : 1
}

export type EquivalenceResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Whether two circuits run the same, by the definition at the top of this file.
 *
 * Answers a reason rather than a boolean on failure, because the failure of a
 * round-trip test is useless without one: "wire 2 differs at event 3" is the
 * difference between a five-minute fix and an afternoon.
 */
export function equivalentCircuits(
  left: Circuit,
  right: Circuit
): EquivalenceResult {
  const a = fingerprintCircuit(left)
  const b = fingerprintCircuit(right)

  if (a.qubits !== b.qubits) {
    return {
      ok: false,
      reason: `qubit counts differ: ${String(a.qubits)} vs ${String(b.qubits)}`,
    }
  }
  if (a.clbits !== b.clbits) {
    return {
      ok: false,
      reason: `classical bit counts differ: ${String(a.clbits)} vs ${String(b.clbits)}`,
    }
  }

  for (let qubit = 0; qubit < a.qubits; qubit++) {
    const left_ = a.wires[qubit] ?? []
    const right_ = b.wires[qubit] ?? []
    if (left_.length !== right_.length) {
      return {
        ok: false,
        reason:
          `qubit ${String(qubit)} sees ${String(left_.length)} operations on ` +
          `one side and ${String(right_.length)} on the other ` +
          `(${describe(left_)} vs ${describe(right_)})`,
      }
    }
    for (let index = 0; index < left_.length; index++) {
      const one = left_[index] as WireEvent
      const other = right_[index] as WireEvent
      if (!sameEvent(one, other)) {
        return {
          ok: false,
          reason:
            `qubit ${String(qubit)}, operation ${String(index)}: ` +
            `${format(one)} vs ${format(other)}`,
        }
      }
    }
  }

  for (let clbit = 0; clbit < a.clbits; clbit++) {
    const left_ = a.classical[clbit] ?? []
    const right_ = b.classical[clbit] ?? []
    if (left_.length !== right_.length) {
      return {
        ok: false,
        reason:
          `classical bit ${String(clbit)} sees ${String(left_.length)} ` +
          `events on one side and ${String(right_.length)} on the other`,
      }
    }
    for (let index = 0; index < left_.length; index++) {
      const one = left_[index] as ClassicalEvent
      const other = right_[index] as ClassicalEvent
      if (
        one.gate !== other.gate ||
        one.kind !== other.kind ||
        one.value !== other.value
      ) {
        return {
          ok: false,
          reason:
            `classical bit ${String(clbit)}, event ${String(index)}: ` +
            `${one.kind} by ${one.gate} vs ${other.kind} by ${other.gate}`,
        }
      }
    }
  }

  return { ok: true }
}

function sameEvent(one: WireEvent, other: WireEvent): boolean {
  return (
    one.gate === other.gate &&
    one.role === other.role &&
    one.shape === other.shape &&
    one.classical === other.classical &&
    one.params.length === other.params.length &&
    one.params.every(
      (value, index) =>
        Math.abs(value - (other.params[index] ?? Number.NaN)) <= ANGLE_TOLERANCE
    )
  )
}

function format(event: WireEvent): string {
  const params =
    event.params.length === 0
      ? ''
      : `(${event.params.map((value) => value.toFixed(6)).join(', ')})`
  return `${event.gate}${params} as ${event.role}`
}

function describe(events: readonly WireEvent[]): string {
  return events.map((event) => event.gate).join(' ')
}
