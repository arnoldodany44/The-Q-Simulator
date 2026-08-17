/**
 * Reading a Y.Doc back as a circuit — and the answer to the question
 * `document.ts` poses.
 *
 * =====================================================================
 * THE DECISION: CONVERGE, THEN PARTITION — NEVER REPAIR THE BYTES
 * =====================================================================
 *
 * A merged document can hold two operations that both want (q0, c3). Of the
 * three available answers, this is the third one sharpened until it keeps the
 * editor's invariant:
 *
 *   - Make it unrepresentable. Impossible; the argument is in `document.ts`,
 *     and it is that an operation is not a cell.
 *   - Repair the document. Refused, and the reason is worth stating precisely:
 *     a repair is a *write*, and every peer would perform it. Two peers each
 *     writing "I moved the loser to column 4" produce two moves, which is a
 *     second conflict — invented by the fix — and a repair loop that can, with
 *     the wrong luck, never settle. A reader that writes is how a CRDT
 *     diverges.
 *   - Converge and refuse to act. Taken, but not as "the circuit is invalid
 *     and everything downstream must cope". The editor built in phases 0-4
 *     rests on `useCircuitStore`'s first rule — *the circuit is always valid* —
 *     and every feature since assumes it: the canvas hit-tests `operationAt`,
 *     the analysis panel simulates on every keystroke, the exporters translate.
 *     Handing that an invalid document would not surface the conflict, it would
 *     scatter it.
 *
 * So the document converges, nobody repairs it, and the *projection* is what
 * decides:
 *
 *   **Every peer places the document's operations in one deterministic order,
 *   keeps those that fit, and defers the rest. The circuit is always valid.
 *   The deferred operations are still in the document — nothing is lost — and
 *   both peers compute the same partition from the same bytes.**
 *
 * Which of two contenders is deferred follows `seq`, the Lamport stamp
 * `document.ts` describes: the operation already in the document when the other
 * was written keeps its cell. Genuinely concurrent writes tie and fall back to
 * the slot key, which is arbitrary on purpose — there is no fact about which
 * of two simultaneous edits is right, only a requirement that both peers pick
 * the same one.
 *
 * What this buys, stated as the four things that can no longer happen:
 *
 *   - No divergence. The partition is a pure function of the document, so two
 *     peers holding the same bytes hold the same circuit. This is the failure
 *     mode that matters, because an invalid circuit is visible and two peers
 *     quietly disagreeing is not.
 *   - No invalid circuit anywhere downstream. `projectCircuit` returns a
 *     circuit the contract accepts, or it does not return.
 *   - No silent loss. A deferred operation is in `deferred`, with the ids of
 *     what blocked it, and it is still in the document — so resolving it is an
 *     ordinary edit (move the blocker, or move it) and not a recovery.
 *   - No fabricated edit. See `document.ts` on slot keys.
 *
 * The one cost, and it is real: **a gate you placed can arrive on the other
 * peer's screen as a deferred gate rather than as a gate.** It has to be
 * surfaced — an editor that quietly holds two of your gates back is worse than
 * one that shows a conflict — which is why `deferred` is part of the return
 * type and not an internal detail.
 *
 * =====================================================================
 * WHY EVERY PART GOES THROUGH THE CONTRACT
 * =====================================================================
 *
 * A Yjs update is opaque binary and anybody on the channel can send one, so
 * nothing read here is trusted: a slot may hold the number 7, a label may hold
 * a NUL, a gate name may be `__proto__`. Rather than re-state the contract's
 * rules with a second wording that would eventually disagree with it, each part
 * is *probed* through `@qsim/schema` — a label through a one-wire document, a
 * definition through a document declaring only it — and the projection's only
 * job is deciding what to do with a part the contract refuses. There is exactly
 * one definition of a legal circuit in this system, and it is not in this file.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  MAX_QUBITS,
  OperationSchema,
  ParameterSchema,
  emptyCircuit,
  qubitsOf,
  safeParseCircuit,
  type Circuit,
  type CustomGate,
  type Operation,
  type Parameter,
} from '@qsim/schema'
import type * as Y from 'yjs'

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
  circuitRoots,
  parameterSeq,
  parameterValue,
  readRegister,
  readSchemaVersion,
  slotFields,
  type CircuitRoots,
} from './document.js'

/**
 * How many operations one document may project.
 *
 * A document grows by many small updates, so bounding a single update
 * (`applyCircuitUpdate`) does not bound the document — and everything here is
 * linear in the operation count while `validateCircuit` also expands custom
 * gates, so an unbounded document is an unbounded amount of work per keystroke
 * on a small container.
 *
 * The number has to sit *above* the real ceiling on a saveable circuit, and the
 * first version of it did not: 256 KiB of JSON (`MAX_CIRCUIT_JSON_BYTES`, which
 * is what a circuit version may occupy in Postgres) holds about 4,780 compact
 * operations, not the ~3,300 that were estimated. A constant below that made
 * the truncation path reachable for an ordinary saved circuit — a session would
 * hand the peer a *shorter* circuit than the one that was saved, and saving from
 * that session would write the truncation into the head version. 8192 is
 * comfortably past 4,780, so no circuit anybody can save can overflow a
 * document, and the path below is once again what it was meant to be: a ceiling
 * on what a *hostile* peer can make every read cost.
 *
 * Slots past it are counted and never read: the cheap pass takes every key's
 * stamp, sorts, and only then parses, so the expensive work is bounded by this
 * number rather than by what a peer chose to send.
 */
export const MAX_DOCUMENT_OPERATIONS = 8192

/**
 * How many custom gate definitions one document may project.
 *
 * The contract puts no ceiling on `customGates` (the record is unbounded and
 * the JSON body limit is what binds a saved circuit), and reading them is not
 * free: the definitions are judged *together*, so a document with a thousand
 * keys is a thousand definitions through `safeParseCircuit` on every read. 256
 * is two orders of magnitude past what the editor's own packaging produces and
 * keeps the cost of one read bounded by this file rather than by a peer.
 */
export const MAX_DOCUMENT_GATES = 256

/**
 * How many times `settle` will drop what the contract names and try again.
 *
 * See the argument on `settle`: most refusals name every offender at once, so
 * one round is the honest case and two is a document full of unknown gates. The
 * cap is what stops a crafted document from making every read quadratic.
 */
const MAX_SETTLE_ROUNDS = 8

/** Why an operation the document holds is not in the projected circuit. */
export type DeferralReason =
  /** Its cells are taken by an operation with an older claim (§6). */
  | 'column-conflict'
  /**
   * Another operation of its column already writes one of its classical bits.
   * The contract permits that shape and the engine has no defined answer for
   * it, so the editor never builds it; see `classicalWrites.ts` in apps/web,
   * which is the same rule stated for a local edit.
   */
  | 'clbit-in-use'
  /** It names a qubit or a classical bit the register does not have. */
  | 'out-of-register'
  /** The slot does not hold a shape the contract recognises at all. */
  | 'malformed'
  /**
   * The shape is right and the document as a whole still refuses it — an
   * unknown gate, an arity that does not match, a parameter nothing declares.
   */
  | 'invalid'

export interface DeferredOperation {
  /** The slot key, which is the handle for resolving it later. */
  readonly slot: string
  readonly reason: DeferralReason
  /**
   * The operation, when the slot held a readable one. Absent for `malformed`,
   * where there is nothing to show.
   */
  readonly operation?: Operation
  /** Ids of the placed operations holding what it wanted, when there are any. */
  readonly blockedBy: readonly string[]
}

export interface CircuitProjection {
  /**
   * What the document says, as a circuit the contract accepts. Every peer
   * computes this same value from these same bytes.
   */
  readonly circuit: Circuit
  /** What the document holds and the circuit cannot carry. */
  readonly deferred: readonly DeferredOperation[]
  /**
   * How many slots past `MAX_DOCUMENT_OPERATIONS` the document holds.
   *
   * A count and not a list, which is the point: they are never read, so there
   * is nothing to list, and a document somebody inflated to a million slots
   * must not turn into a million-entry array on every projection. A number is
   * enough for the only two readers — a UI saying "3 operations could not be
   * loaded", and a relay deciding this document is not one to keep serving.
   */
  readonly overflow: number
  /**
   * `circuit.operations[].id` → the slot it came from.
   *
   * The diff writer needs it: an edit to an operation has to reach the slot it
   * lives in rather than mint a second one, and an id is not enough to find it
   * once a merge has renamed a duplicate.
   */
  readonly slots: ReadonlyMap<string, string>
  /** The version the document claims, or `undefined` when it claims none. */
  readonly schemaVersion: number | undefined
}

interface Candidate {
  readonly slot: string
  readonly seq: number
  operation: Operation
}

/**
 * Read a document as a circuit, deterministically.
 *
 * Pure: it never writes to `doc`. That is the property the whole design rests
 * on — see the header on why a reader that writes is how a CRDT diverges — and
 * it is what makes calling this on every update safe.
 */
export function projectCircuit(doc: Y.Doc): CircuitProjection {
  const roots = circuitRoots(doc)
  const deferred: DeferredOperation[] = []

  const { candidates, overflow } = readCandidates(roots, deferred)
  renameDuplicateIds(candidates)

  const register = readRegister(roots, neededRegister(candidates))
  const placed = placeCandidates(candidates, register, deferred)

  const labels = readLabels(roots, register.qubits)
  const parameters = readParameters(roots)
  const gates = readGates(roots)

  const settled = settle(register, placed, labels, parameters, gates, deferred)

  return {
    circuit: settled.circuit,
    deferred,
    overflow,
    slots: new Map(
      settled.survivors.map((candidate) => [
        candidate.operation.id,
        candidate.slot,
      ])
    ),
    schemaVersion: readSchemaVersion(roots),
  }
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Every slot the document holds, in `(seq, slot)` order, shape-checked.
 *
 * Two passes on purpose. The first reads only each slot's stamp, which is one
 * map lookup, so sorting and applying the ceiling costs nothing much even on a
 * document somebody inflated. Only the survivors are parsed.
 */
function readCandidates(
  roots: CircuitRoots,
  deferred: DeferredOperation[]
): { candidates: Candidate[]; overflow: number } {
  const stamps: { slot: string; seq: number }[] = []
  for (const slot of roots.operations.keys()) {
    const seq = slotFields(roots, slot)?.get(FIELD_SEQ)
    stamps.push({
      slot,
      seq: typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0,
    })
  }
  stamps.sort(byStampThenSlot)

  const overflow = Math.max(0, stamps.length - MAX_DOCUMENT_OPERATIONS)
  const candidates: Candidate[] = []
  for (const stamp of stamps.slice(0, MAX_DOCUMENT_OPERATIONS)) {
    const operation = readOperation(roots, stamp.slot)
    if (operation === undefined) {
      deferred.push({ slot: stamp.slot, reason: 'malformed', blockedBy: [] })
      continue
    }
    candidates.push({ slot: stamp.slot, seq: stamp.seq, operation })
  }
  return { candidates, overflow }
}

function byStampThenSlot(
  left: { slot: string; seq: number },
  right: { slot: string; seq: number }
): number {
  if (left.seq !== right.seq) return left.seq - right.seq
  return left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0
}

/**
 * One slot as an operation, or `undefined` when it is not one.
 *
 * The fields are assembled and handed to the contract's own
 * `OperationSchema`, which is `strictObject` — so an unknown key is a refusal
 * rather than data that survives into the circuit. `seq` is this layer's and
 * is deliberately not part of what is assembled.
 */
function readOperation(
  roots: CircuitRoots,
  slot: string
): Operation | undefined {
  const fields = slotFields(roots, slot)
  if (fields === undefined) return undefined

  const draft: Record<string, unknown> = {
    id: fields.get(FIELD_ID),
    gate: fields.get(FIELD_GATE),
    targets: fields.get(FIELD_TARGETS),
    column: fields.get(FIELD_COLUMN),
  }
  // Optional fields are omitted rather than set to `undefined`: the schema is
  // strict, and `{ controls: undefined }` is a key the contract has to judge.
  for (const key of [
    FIELD_CONTROLS,
    FIELD_PARAMS,
    FIELD_CLBIT_TARGETS,
    FIELD_CONDITION,
  ] as const) {
    const value = fields.get(key)
    if (value !== undefined && value !== null) draft[key] = value
  }

  const parsed = OperationSchema.safeParse(draft)
  return parsed.success ? parsed.data : undefined
}

/**
 * Two slots may carry the same contract id — that is what happens when two
 * peers, each counting up from `op_1`, place a gate while apart. The document
 * is fine (they are different slots, and neither edit was fused with the
 * other), but `duplicate-operation-id` would refuse the circuit, so a colliding
 * id is renamed.
 *
 * ── Why *every* holder is renamed and not just the later one ───────────────
 *
 * The first version kept the plain id on whichever claim sorted first and moved
 * the other to `<id>#<slot>`, on the argument that an id is an internal handle
 * and the only cost is a lost selection. M5.4 ended that argument: `anchorOpId`
 * is a durable database column, so the id is what a *comment* names. Keeping
 * the plain id on one of two colliding gates therefore hands somebody's comment
 * to somebody else's gate — and the (seq, slot) tie-break that decides which is
 * arbitrary by design, which is exactly what an anchor may not be.
 *
 * §3.4's rule for an anchor is that it may fail to resolve but may never
 * resolve to a different gate. So a collision retires the plain id: both gates
 * survive, both are renamed, and the comment written against the shared id now
 * resolves to nothing and is shown as an orphan. That is the honest reading of
 * "two people independently called their gate op_2 and there is no fact about
 * which one the comment was about".
 *
 * The rename is deterministic — the candidates are already in `(seq, slot)`
 * order and the slot is unique — so both peers rename the same ones to the same
 * things.
 */
function renameDuplicateIds(candidates: Candidate[]): void {
  const holders = new Map<string, number>()
  for (const candidate of candidates) {
    const id = candidate.operation.id
    holders.set(id, (holders.get(id) ?? 0) + 1)
  }

  const taken = new Set<string>()
  for (const candidate of candidates) {
    const id = candidate.operation.id
    if (holders.get(id) === 1 && !taken.has(id)) {
      taken.add(id)
      continue
    }
    const renamed = uniqueId(id, candidate.slot, taken)
    taken.add(renamed)
    candidate.operation = { ...candidate.operation, id: renamed }
  }
}

/**
 * `<id>#<slot>`, trimmed to the 64 characters the contract allows.
 *
 * The *original* is what gets trimmed rather than the slot, because the slot is
 * what makes the result unique. The attempt counter only ever runs if a peer
 * wrote an id that already ends in another slot's name; it is here because a
 * duplicate produced by the renaming would defeat the whole point of it, and
 * because a result over 64 characters would make the contract refuse the
 * circuit rather than the operation.
 */
function uniqueId(
  id: string,
  slot: string,
  taken: ReadonlySet<string>
): string {
  for (let attempt = 0; ; attempt += 1) {
    const tail = attempt === 0 ? `#${slot}` : `#${slot}#${attempt}`
    const room = Math.max(1, 64 - tail.length)
    const renamed = `${id.slice(0, room)}${tail}`.slice(0, 64)
    if (!taken.has(renamed)) return renamed
  }
}

/** The smallest register that would hold every candidate. */
function neededRegister(candidates: readonly Candidate[]): {
  qubits: number
  clbits: number
} {
  let qubits = 1
  let clbits = 0
  for (const { operation } of candidates) {
    for (const qubit of qubitsOf(operation)) {
      if (qubit + 1 > qubits) qubits = qubit + 1
    }
    for (const clbit of operation.clbitTargets ?? []) {
      if (clbit + 1 > clbits) clbits = clbit + 1
    }
    const condition = operation.condition
    if (condition !== undefined && condition.clbit + 1 > clbits) {
      clbits = condition.clbit + 1
    }
  }
  return { qubits: Math.min(qubits, MAX_QUBITS), clbits }
}

/* ------------------------------------------------------------------ *
 * Placement — the rule that makes the projection valid
 * ------------------------------------------------------------------ */

/**
 * Place candidates in order, deferring whatever no longer fits.
 *
 * The order is the whole mechanism: it is the same on every peer, so the same
 * operations survive. Three things can stop one:
 *
 *   - the register does not have a wire or a bit it names, which happens when
 *     one peer narrowed the register while another used it;
 *   - a cell it wants is held (§6, the constraint this milestone exists for);
 *   - a classical bit it writes is already written in that column, which the
 *     contract allows and the engine cannot order.
 */
function placeCandidates(
  candidates: readonly Candidate[],
  register: { readonly qubits: number; readonly clbits: number },
  deferred: DeferredOperation[]
): Candidate[] {
  /** column → qubit → id of the operation holding it. */
  const cells = new Map<number, Map<number, string>>()
  /** column → classical bit → id of the operation writing it. */
  const writes = new Map<number, Map<number, string>>()
  const placed: Candidate[] = []

  for (const candidate of candidates) {
    const { operation } = candidate

    if (!withinRegister(operation, register)) {
      deferred.push({
        slot: candidate.slot,
        reason: 'out-of-register',
        operation,
        blockedBy: [],
      })
      continue
    }

    const column = cells.get(operation.column) ?? new Map<number, string>()
    const wanted = new Set(qubitsOf(operation))
    const blockedBy = [
      ...new Set(
        [...wanted].map((qubit) => column.get(qubit)).filter(isPresent)
      ),
    ]
    if (blockedBy.length > 0) {
      deferred.push({
        slot: candidate.slot,
        reason: 'column-conflict',
        operation,
        blockedBy,
      })
      continue
    }

    const written = writes.get(operation.column) ?? new Map<number, string>()
    const bits = new Set(operation.clbitTargets ?? [])
    const writers = [
      ...new Set([...bits].map((bit) => written.get(bit)).filter(isPresent)),
    ]
    if (writers.length > 0) {
      deferred.push({
        slot: candidate.slot,
        reason: 'clbit-in-use',
        operation,
        blockedBy: writers,
      })
      continue
    }

    for (const qubit of wanted) column.set(qubit, operation.id)
    cells.set(operation.column, column)
    for (const bit of bits) written.set(bit, operation.id)
    writes.set(operation.column, written)
    placed.push(candidate)
  }

  return placed
}

function withinRegister(
  operation: Operation,
  register: { readonly qubits: number; readonly clbits: number }
): boolean {
  for (const qubit of qubitsOf(operation)) {
    if (qubit >= register.qubits) return false
  }
  for (const clbit of operation.clbitTargets ?? []) {
    if (clbit >= register.clbits) return false
  }
  const condition = operation.condition
  return condition === undefined || condition.clbit < register.clbits
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

/* ------------------------------------------------------------------ *
 * The parts a placement cannot judge
 * ------------------------------------------------------------------ */

/**
 * Wire names, or `undefined` when the document names none.
 *
 * §6 wants one label per qubit or no labels at all, so naming a single wire
 * materialises the list — the missing entries get the same `qN` the editor's
 * `defaultQubitLabel` produces, because a wire that appears unnamed on one
 * screen and named on another is the divergence this file exists to prevent.
 *
 * The assembled list is probed through the contract rather than checked here:
 * a label is `storableText` bounded at 32 characters, and re-stating that would
 * be a second wording of the same rule. One parse when the document is honest,
 * one per label when it is not.
 */
function readLabels(
  roots: CircuitRoots,
  qubits: number
): readonly string[] | undefined {
  const named = new Map<number, string>()
  for (const key of roots.labels.keys()) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= qubits) continue
    /*
     * The key has to be the *canonical* spelling of its index, and this is the
     * one line in the whole projection that would otherwise depend on Y.Map key
     * order. `Number('00')` is 0, so '0' and '00' would name one wire and the
     * later key would win — and "later" is this peer's own integration order,
     * which two peers holding identical bytes do not agree on. That is the
     * divergence this file exists to prevent, arriving through a key nobody
     * would look at twice. A non-canonical key is ignored rather than resolved
     * by a rule, because there is no wire it can honestly be about.
     */
    if (String(index) !== key) continue
    const label = roots.labels.get(key)
    if (typeof label === 'string') named.set(index, label)
  }
  if (named.size === 0) return undefined

  const labels = Array.from(
    { length: qubits },
    (_, index) => named.get(index) ?? defaultQubitLabel(index)
  )
  if (acceptsLabels(labels)) return labels
  return labels.map((label, index) =>
    acceptsLabels([label]) ? label : defaultQubitLabel(index)
  )
}

/**
 * The placeholder a wire with no name of its own carries.
 *
 * The same string `apps/web`'s `defaultQubitLabel` produces, and it has to
 * stay that way: the editor and the projection must agree about what an
 * unnamed wire is called or the two disagree about the document. The
 * duplication is asserted in the bridge's tests, which is the one place that
 * may import both.
 */
export function defaultQubitLabel(index: number): string {
  return `q${index}`
}

function acceptsLabels(labels: readonly string[]): boolean {
  return safeParseCircuit({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: labels.length,
    operations: [],
    qubitLabels: labels,
  }).ok
}

/**
 * Declared parameters, in `(seq, name)` order.
 *
 * Keyed by name, so two peers declaring different parameters both keep theirs
 * and two peers setting the same one resolve to a single value. The stamp is
 * what keeps the order stable — a list that reordered itself when a peer typed
 * would move the sliders under the other peer's cursor.
 */
function readParameters(roots: CircuitRoots): readonly Parameter[] {
  const entries: { parameter: Parameter; seq: number }[] = []
  for (const name of roots.parameters.keys()) {
    const value = parameterValue(roots, name)
    if (value === undefined) continue
    const parsed = ParameterSchema.safeParse({ name, value })
    if (!parsed.success) continue
    entries.push({ parameter: parsed.data, seq: parameterSeq(roots, name) })
  }
  entries.sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq
    return left.parameter.name < right.parameter.name ? -1 : 1
  })
  return entries.map((entry) => entry.parameter)
}

/**
 * Custom gate definitions, judged *together*.
 *
 * A definition is one opaque value (see `document.ts`), and the probe is a
 * document declaring the definitions and nothing else — which is what makes the
 * *names* judged too: `customGates` is a `z.record` with an identifier key, and
 * a name the record cannot carry is a definition that would silently vanish
 * between the input and the parsed circuit.
 *
 * ── Why they cannot be probed one at a time ────────────────────────────────
 *
 * Because a definition may call another one. §3.1 permits it, the contract
 * bounds it with `MAX_CUSTOM_GATE_DEPTH`, and `packageSelection` *produces* it —
 * wrapping a block that already contains a block is the ordinary way a person
 * builds one. Probed alone, such a definition names a gate nothing declares, so
 * `safeParseCircuit` answers `unknown-gate` and the definition is dropped from
 * the projection; `settle` then defers every operation that used it, and the
 * first local edit afterwards makes `writeGates` delete the definition from the
 * shared document for good. Opening a session on a perfectly ordinary saved
 * circuit emptied it, and every peer agreed, so nothing detected it.
 *
 * So a definition is judged in the context of the document that declares it,
 * which is also how `validateCircuit` judges one. When the whole set is refused,
 * the definitions the contract *names* are dropped and the rest tried again —
 * the same narrowing `settle` performs, for the same reason, and bounded by the
 * same round count so that a crafted document cannot make every read quadratic.
 */
function readGates(roots: CircuitRoots): Record<string, CustomGate> {
  const declared: Record<string, unknown> = {}
  let read = 0
  for (const name of [...roots.gates.keys()].sort()) {
    if (read >= MAX_DOCUMENT_GATES) break
    const definition = roots.gates.get(name)
    if (typeof definition !== 'object' || definition === null) continue
    declared[name] = definition
    read += 1
  }
  return acceptsGates(declared)
}

function acceptsGates(
  declared: Readonly<Record<string, unknown>>
): Record<string, CustomGate> {
  let candidates = declared
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    const names = Object.keys(candidates)
    if (names.length === 0) return {}
    const parsed = safeParseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      operations: [],
      customGates: candidates,
    })
    // The probe re-declares the gates under their own names, so these are the
    // parsed definitions rather than the raw values — defaults applied, unknown
    // keys already refused.
    if (parsed.ok) return parsed.circuit.customGates ?? {}

    const condemned = new Set<string>()
    for (const issue of parsed.issues) {
      if (issue.customGate !== undefined) condemned.add(issue.customGate)
    }
    /*
     * A refusal the contract cannot pin on a definition: a name the record
     * cannot carry as an own property (`__proto__`, which `IdentifierSchema`
     * accepts), or a shape error reported without a scope. Nothing in the
     * issues narrows it, so the *first* name in the sorted order goes and the
     * rest are tried again. Deterministic, which is the only thing that
     * matters: every peer drops the same one.
     */
    if (condemned.size === 0) condemned.add(names[0] as string)
    candidates = Object.fromEntries(
      Object.entries(candidates).filter(([name]) => !condemned.has(name))
    )
  }
  // Eight rounds of narrowing did not reach a set the contract accepts. A
  // document nobody honest produced; no definitions is the only reading left.
  return {}
}

/* ------------------------------------------------------------------ *
 * Settling — the last resort, and why it exists
 * ------------------------------------------------------------------ */

/**
 * Build the circuit and let the contract have the final word.
 *
 * The placement pass enforces the register and §6, which is everything a
 * *structural* reading can enforce. It cannot know that `gate: "nope"` is not
 * a gate, that `cx` takes two qubits, or that two definitions use each other in
 * a cycle — and a peer with a newer catalog, or one that is simply hostile, can
 * write all three. So the candidate goes through `safeParseCircuit`, and every
 * operation or definition it names is dropped and the rest tried again.
 *
 * Rounds are capped at a small number rather than at "one per operation", and
 * the reason is §11 rather than tidiness. Most refusals name every offender at
 * once, so an honest document settles in one round and a document full of
 * unknown gates settles in two. But not all of them do: the expansion ceiling
 * is reported one operation at a time, so a document built to trip it could ask
 * for one full re-validation per operation — quadratic work, on every read, from
 * one crafted update. Eight rounds is far more than any real document needs and
 * turns that into a bounded cost.
 *
 * The last resort — the register and nothing in it — is not reachable from any
 * honest client. It is the difference between a relay that refuses one hostile
 * document and a relay that throws, or hangs, on every read of it forever.
 */
function settle(
  register: { readonly qubits: number; readonly clbits: number },
  placed: readonly Candidate[],
  labels: readonly string[] | undefined,
  parameters: readonly Parameter[],
  gates: Record<string, CustomGate>,
  deferred: DeferredOperation[]
): { readonly circuit: Circuit; readonly survivors: readonly Candidate[] } {
  let survivors: readonly Candidate[] = placed
  let definitions = gates

  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    const candidate = assemble(
      register,
      survivors,
      labels,
      parameters,
      definitions
    )
    const parsed = safeParseCircuit(candidate)
    if (parsed.ok) return { circuit: parsed.circuit, survivors }

    const condemnedGates = new Set<string>()
    const condemnedOperations = new Set<string>()
    for (const issue of parsed.issues) {
      // An issue inside a definition's body carries both names. Only the
      // definition is at fault: the id it reports belongs to an operation of
      // that body, and a top-level operation may legitimately share it.
      if (issue.customGate !== undefined) condemnedGates.add(issue.customGate)
      else if (issue.operationId !== undefined) {
        condemnedOperations.add(issue.operationId)
      }
    }

    const before = survivors.length + Object.keys(definitions).length
    definitions = Object.fromEntries(
      Object.entries(definitions).filter(([name]) => !condemnedGates.has(name))
    )
    survivors = survivors.filter((entry) => {
      if (!condemnedOperations.has(entry.operation.id)) return true
      deferred.push({
        slot: entry.slot,
        reason: 'invalid',
        operation: entry.operation,
        blockedBy: [],
      })
      return false
    })
    // Nothing was dropped, so trying again would ask the same question and get
    // the same answer. Whatever is wrong is not named by an operation or a
    // definition, and the last resort below is the only honest reading left.
    if (survivors.length + Object.keys(definitions).length === before) break
  }

  for (const entry of survivors) {
    deferred.push({
      slot: entry.slot,
      reason: 'invalid',
      operation: entry.operation,
      blockedBy: [],
    })
  }
  return {
    circuit: emptyCircuit(register.qubits, register.clbits),
    survivors: [],
  }
}

function assemble(
  register: { readonly qubits: number; readonly clbits: number },
  operations: readonly Candidate[],
  labels: readonly string[] | undefined,
  parameters: readonly Parameter[],
  gates: Record<string, CustomGate>
): Circuit {
  const circuit: Circuit = {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: register.qubits,
    clbits: register.clbits,
    operations: operations.map((entry) => entry.operation),
  }
  if (labels !== undefined) circuit.qubitLabels = [...labels]
  if (parameters.length > 0) circuit.parameters = [...parameters]
  if (Object.keys(gates).length > 0) circuit.customGates = gates
  return circuit
}
