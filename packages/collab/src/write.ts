/**
 * Writing a circuit into a Y.Doc, as a difference rather than as a document.
 *
 * ── Why a diff and not a replacement ──────────────────────────────────────
 *
 * Because a replacement is not an edit. Clearing the operations map and
 * writing it again would produce, in CRDT terms, "every operation was deleted
 * and every operation was created" — so a concurrent edit by anybody else
 * merges against deletions and vanishes, every update carries the whole
 * document, and `Y.UndoManager` records a single stack item that undoes the
 * entire circuit. All three are the same mistake: the document has to be told
 * what changed, because that is the only thing a merge can reason about.
 *
 * ── The rule about origins, which is what keeps the bridge from looping ───
 *
 * Everything here writes inside `doc.transact(fn, origin)` with the caller's
 * origin. The bridge passes a sentinel object unique to this client and
 * ignores document updates that carry it, so:
 *
 *   **a write this client made is never read back as a change to apply.**
 *
 * Without that, the loop is immediate and invisible: the store commits, the
 * document changes, the document notifies the store, the store commits. With
 * it, the only updates the bridge reacts to are the ones it did not cause —
 * remote peers, and `Y.UndoManager`, which transacts under its own origin
 * precisely so that it can be told apart.
 *
 * ── The baseline, and why it is a parameter ───────────────────────────────
 *
 * A diff needs to know which slot each operation lives in, and an id is not
 * enough to find it: a merge can rename a duplicate id (see `project.ts`), so
 * the mapping is the projection's, not something to recompute from the raw
 * fields. It also needs to know which slots the projection *deferred*, because
 * those operations are in the document and not in the circuit — and a writer
 * that deleted "everything the circuit does not have" would delete exactly the
 * gates a conflict is holding back. That is data loss caused by the conflict
 * handling, which would be worse than the conflict.
 *
 * So the caller passes the projection the circuit was derived from. It must be
 * current — the projection of this document as it stands — and the bridge
 * guarantees that by keeping the value `writeCircuit` returns. A stale baseline
 * is defended against rather than trusted: nothing is deleted unless the
 * baseline placed it and the circuit no longer has it, so an unknown slot is
 * left alone instead of being destroyed.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  MAX_CLBITS,
  MAX_QUBITS,
  qubitsOf,
  type Circuit,
  type Operation,
} from '@qsim/schema'
import * as Y from 'yjs'

import {
  FIELD_CLBIT_TARGETS,
  FIELD_COLUMN,
  FIELD_CONDITION,
  FIELD_CONTROLS,
  FIELD_GATE,
  FIELD_ID,
  FIELD_PARAMS,
  FIELD_SEQ,
  FIELD_TARGETS,
  META_CLBITS,
  META_QUBITS,
  META_SCHEMA_VERSION,
  PARAMETER_SEQ,
  PARAMETER_VALUE,
  circuitRoots,
  nextSeq,
  parameterSeq,
  parameterValue,
  slotMinter,
  slotFields,
  type CircuitRoots,
} from './document.js'
import {
  defaultQubitLabel,
  projectCircuit,
  type CircuitProjection,
} from './project.js'

export interface WriteOptions {
  /**
   * The transaction origin. The bridge's own sentinel, so that its document
   * listener can tell its own writes from everybody else's — see the header.
   */
  readonly origin: unknown
  /**
   * The projection this circuit was derived from, and therefore the state of
   * the document as the caller last read it.
   */
  readonly baseline: CircuitProjection
}

/**
 * Write `circuit` into `doc` as the difference from `options.baseline`, and
 * return the projection of the result.
 *
 * The return value is not the circuit that went in, and the difference
 * matters: writing can *un-defer* an operation. A user who deletes the gate
 * that was blocking a peer's gate has, by that single edit, made the peer's
 * gate placeable — so the document now says more than the circuit the caller
 * handed over, and the caller has to adopt what comes back. That is why the
 * projection is recomputed here rather than derived incrementally: the
 * placement rule has exactly one implementation, and a second one that
 * "knows" what a write implies would eventually disagree with it.
 */
export function writeCircuit(
  doc: Y.Doc,
  circuit: Circuit,
  options: WriteOptions
): CircuitProjection {
  const roots = circuitRoots(doc)
  doc.transact(() => {
    writeMeta(roots, circuit)
    writeOperations(doc, roots, circuit, options.baseline)
    writeLabels(roots, circuit)
    writeParameters(roots, circuit)
    writeGates(roots, circuit)
  }, options.origin)
  return projectCircuit(doc)
}

/**
 * A fresh document holding this circuit.
 *
 * For tests and for seeding a document nobody has written yet. The editor's
 * path is `writeCircuit` with the projection it already holds; this is the
 * same code with an empty baseline, so the two cannot disagree about the
 * shape they produce.
 */
export function documentOf(circuit: Circuit, origin: unknown = null): Y.Doc {
  const doc = new Y.Doc()
  writeCircuit(doc, circuit, { origin, baseline: projectCircuit(doc) })
  return doc
}

function writeMeta(roots: CircuitRoots, circuit: Circuit): void {
  setIfChanged(roots.meta, META_SCHEMA_VERSION, CIRCUIT_SCHEMA_VERSION)
  setIfChanged(roots.meta, META_QUBITS, circuit.qubits)
  setIfChanged(roots.meta, META_CLBITS, circuit.clbits)
}

function writeOperations(
  doc: Y.Doc,
  roots: CircuitRoots,
  circuit: Circuit,
  baseline: CircuitProjection
): void {
  const minter = slotMinter(doc)
  let seq = nextSeq(roots)

  for (const operation of circuit.operations) {
    const slot = baseline.slots.get(operation.id)
    const fields = slot === undefined ? undefined : slotFields(roots, slot)
    if (fields === undefined) {
      /*
       * New here, in both senses that reach this branch. Either the store just
       * created it, or the slot it used to live in is gone — a peer deleted the
       * operation while this client was editing it. Re-creating it is the
       * deliberate answer to the second case: an edit is a statement that the
       * operation should exist, and a client that had it on screen a moment ago
       * has more claim to that than a delete it never saw. The alternative,
       * dropping the edit silently, is the one thing worse.
       */
      const created = fieldsOf(operation).filter(
        ([, value]) => value !== undefined
      )
      created.push([FIELD_SEQ, seq])
      seq += 1
      roots.operations.set(minter.take(), new Y.Map<unknown>(created))
      continue
    }
    for (const [key, value] of fieldsOf(operation)) {
      if (value === undefined) fields.delete(key)
      else setIfChanged(fields, key, value)
    }
  }

  /*
   * Deletions, and only the ones this client can account for: a slot the
   * baseline placed whose operation the circuit no longer carries. A slot the
   * baseline never saw is left alone — see the header on stale baselines — and
   * a deferred slot is not a candidate at all, because the circuit was never
   * given the chance to carry it.
   */
  const ids = new Set(circuit.operations.map((operation) => operation.id))
  for (const [id, slot] of baseline.slots) {
    if (!ids.has(id)) roots.operations.delete(slot)
  }
}

/**
 * One operation as document fields.
 *
 * An optional field the operation does not have appears here as `undefined`,
 * which an existing slot turns into a deletion and a new slot filters out.
 * Writing `undefined` into the map instead would leave a key behind, and the
 * contract's objects are strict — a `controls: undefined` that survived into a
 * projected operation would be refused as an unknown key rather than read as
 * an absent one.
 *
 * `FIELD_SEQ` is deliberately not here. The stamp records when an operation
 * *entered* the document and is written exactly once, at creation: if an edit
 * refreshed it, a remote param change would reorder the array on somebody
 * else's screen, and a move would cost an operation the cell it already held to
 * whoever placed one concurrently.
 */
function fieldsOf(operation: Operation): [string, unknown][] {
  return [
    [FIELD_ID, operation.id],
    [FIELD_GATE, operation.gate],
    [FIELD_TARGETS, operation.targets],
    [FIELD_COLUMN, operation.column],
    [FIELD_CONTROLS, operation.controls],
    [FIELD_PARAMS, operation.params],
    [FIELD_CLBIT_TARGETS, operation.clbitTargets],
    [FIELD_CONDITION, operation.condition],
  ]
}

function writeLabels(roots: CircuitRoots, circuit: Circuit): void {
  const labels = circuit.qubitLabels ?? []
  for (const [index, label] of labels.entries()) {
    const key = String(index)
    /*
     * A wire whose name is still the placeholder and that this document has
     * never named is left unwritten, and that is a rule rather than an
     * optimisation.
     *
     * §6 wants one label per qubit or none, so naming a single wire
     * *materialises* the whole list in the store — `setQubitLabel(0, 'alice')`
     * on an unlabelled circuit produces `['alice', 'q1', 'q2']`. Writing every
     * entry of that would make Ana's rename of q0 a write to q1's and q2's keys
     * as well, so Ana naming q0 and Beto naming q2 for the first time would be
     * two writes to one key, and last-write-wins would discard one of the two
     * renames with nothing in `deferred` to report it. Silent loss, caused
     * entirely by the materialisation.
     *
     * `readLabels` fills an absent key with this same placeholder, so the
     * projection is byte-for-byte the same circuit either way — while a rename
     * now touches exactly the wire it renamed.
     */
    if (!roots.labels.has(key) && label === defaultQubitLabel(index)) continue
    setIfChanged(roots.labels, key, label)
  }
  /*
   * Keys the circuit does not account for go, which covers a wire that was
   * removed, a label a peer wrote for a wire that no longer exists, and a
   * non-canonical spelling of an index (`'00'`) that `readLabels` refuses to
   * read. The projection ignores all three anyway, so this is housekeeping
   * rather than a rule — but leaving them would resurrect a stale name the next
   * time somebody widened the register back.
   */
  for (const key of [...roots.labels.keys()]) {
    const index = Number(key)
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= labels.length ||
      String(index) !== key
    ) {
      roots.labels.delete(key)
    }
  }
}

/**
 * Widen the register so that everything the document holds fits in it, and
 * report whether anything had to change.
 *
 * ── Why this exists, which is not a rule about registers ───────────────────
 *
 * `readRegister` deliberately trusts a stored count that is *smaller* than the
 * operations need: one peer narrowing the register while another used the wide
 * part is a real state, and the operations that no longer fit are deferred
 * rather than silently re-enabled. That is right for an edit, because somebody
 * chose it.
 *
 * A per-user *undo* can reach the same state without anybody choosing it. Ana
 * inserts a wire — which writes `qubits` and rewrites the `targets` of every
 * operation, Beto's included — Beto then moves his own gate onto the new wire,
 * and Ana presses undo. Yjs reverts Ana's `qubits` (hers, untouched since) and
 * correctly refuses to revert the `targets` Beto has written, so *half* of one
 * step lands and Beto's gate is left outside the register: it vanishes from both
 * canvases with only `projection.deferred` to say why. Nothing was lost from the
 * document and the peers still agree, which is precisely why nobody would
 * notice.
 *
 * So the peer that pressed undo widens the register back. It is part of that
 * user's command, not a reader writing (see `project.ts`): exactly one peer does
 * it, it is broadcast as an ordinary edit, and the sentence it enforces is one a
 * person recognises — **a wire cannot be withdrawn from under somebody else's
 * gate.**
 */
export function widenRegister(doc: Y.Doc, origin: unknown): boolean {
  const roots = circuitRoots(doc)
  const projection = projectCircuit(doc)
  const outside = projection.deferred.filter(
    (entry) => entry.reason === 'out-of-register'
  )
  if (outside.length === 0) return false

  let qubits = projection.circuit.qubits
  let clbits = projection.circuit.clbits
  for (const entry of outside) {
    const operation = entry.operation
    if (operation === undefined) continue
    for (const qubit of qubitsOf(operation)) {
      qubits = Math.max(qubits, qubit + 1)
    }
    for (const clbit of operation.clbitTargets ?? []) {
      clbits = Math.max(clbits, clbit + 1)
    }
    const condition = operation.condition
    if (condition !== undefined) clbits = Math.max(clbits, condition.clbit + 1)
  }
  qubits = Math.min(qubits, MAX_QUBITS)
  clbits = Math.min(clbits, MAX_CLBITS)
  if (
    qubits === projection.circuit.qubits &&
    clbits === projection.circuit.clbits
  ) {
    // Nothing this widening can reach — an operation past `MAX_QUBITS`, which
    // only a hostile document holds. It stays deferred, which is correct.
    return false
  }

  doc.transact(() => {
    setIfChanged(roots.meta, META_QUBITS, qubits)
    setIfChanged(roots.meta, META_CLBITS, clbits)
  }, origin)
  return true
}

/**
 * Give the operations in `slots` the newest claim on the cells they occupy, and
 * report whether anything had to change.
 *
 * ── The case this exists for: a redo presents a claim from before it ────────
 *
 * `seq` is written once, when an operation *enters* the document, and
 * `project.ts` resolves a contested cell in its favour: an operation that was
 * already there when yours was written keeps its cell. Yjs's redo re-inserts a
 * deleted item with `item.content.copy()`, which carries `seq` verbatim — so an
 * operation that was absent for a while comes back wearing a claim older than
 * every edit made while it was gone, and displaces a gate somebody put in the
 * cell it had vacated. The rule the projection states is then broken by the one
 * command that is supposed to affect only the person who pressed it.
 *
 * A revived operation is new to the document as far as the ordering is
 * concerned, so it takes a fresh stamp. The relative order of several revived
 * together is preserved, so a `redo(3)` comes back in the order it went.
 */
export function restampOperations(
  doc: Y.Doc,
  slots: readonly string[],
  origin: unknown
): boolean {
  const roots = circuitRoots(doc)
  const present = slots
    .map((slot) => ({ slot, fields: slotFields(roots, slot) }))
    .filter(
      (entry): entry is { slot: string; fields: Y.Map<unknown> } =>
        entry.fields !== undefined
    )
  if (present.length === 0) return false

  present.sort((left, right) => {
    const leftSeq = stampOf(left.fields)
    const rightSeq = stampOf(right.fields)
    if (leftSeq !== rightSeq) return leftSeq - rightSeq
    return left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0
  })

  let changed = false
  doc.transact(() => {
    let seq = nextSeq(roots)
    for (const entry of present) {
      if (stampOf(entry.fields) === seq) {
        seq += 1
        continue
      }
      entry.fields.set(FIELD_SEQ, seq)
      seq += 1
      changed = true
    }
  }, origin)
  return changed
}

function stampOf(fields: Y.Map<unknown>): number {
  const seq = fields.get(FIELD_SEQ)
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0
}

function writeParameters(roots: CircuitRoots, circuit: Circuit): void {
  const wanted = new Map(
    (circuit.parameters ?? []).map((parameter) => [
      parameter.name,
      parameter.value,
    ])
  )
  let seq = nextSeq(roots)
  for (const [name, value] of wanted) {
    const held = parameterValue(roots, name)
    if (held === value) continue
    // A parameter keeps the stamp it was declared with, so editing a value
    // does not move a slider to the end of the panel on somebody else's
    // screen. Only a name nobody has declared yet takes a new one.
    const stamp = held === undefined ? seq++ : parameterSeq(roots, name)
    roots.parameters.set(name, {
      [PARAMETER_VALUE]: value,
      [PARAMETER_SEQ]: stamp,
    })
  }
  for (const name of [...roots.parameters.keys()]) {
    if (!wanted.has(name)) roots.parameters.delete(name)
  }
}

function writeGates(roots: CircuitRoots, circuit: Circuit): void {
  const wanted = circuit.customGates ?? {}
  for (const [name, definition] of Object.entries(wanted)) {
    if (!sameJson(roots.gates.get(name), definition)) {
      roots.gates.set(name, definition)
    }
  }
  for (const name of [...roots.gates.keys()]) {
    if (!Object.hasOwn(wanted, name)) roots.gates.delete(name)
  }
}

/**
 * Write only what changed.
 *
 * Not an optimisation: an unconditional `set` is a real change, so it emits an
 * update, clears the redo stack of the undo manager, and — for a field two
 * peers hold the same value in — makes one of them the last writer of a value
 * neither of them touched. A document should record edits, not keystrokes.
 */
function setIfChanged(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (sameJson(map.get(key), value)) return
  map.set(key, value)
}

/**
 * Structural comparison of two document values.
 *
 * The values here are JSON: numbers, strings, and the small arrays and objects
 * a `targets` list or a `condition` is. `JSON.stringify` would answer the same
 * question for most of them and get key order wrong for the rest — two
 * conditions meaning the same thing can be spelled `{clbit, equals}` and
 * `{equals, clbit}` depending on which code path built them, and a spurious
 * write is exactly what `setIfChanged` exists to avoid.
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
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  const other = right as Record<string, unknown>
  return leftKeys.every(
    (key) =>
      key in other &&
      sameJson((left as Record<string, unknown>)[key], other[key])
  )
}
