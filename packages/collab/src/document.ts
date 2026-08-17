/**
 * How a circuit lives inside a Y.Doc — the whole of the representation
 * decision, in one file, with the argument for it.
 *
 * =====================================================================
 * THE PROBLEM A CRDT DOES NOT SOLVE
 * =====================================================================
 *
 * A CRDT converges. It does not validate. §6 gives circuits a constraint text
 * documents do not have — two operations of one column may not share a qubit —
 * and two people can each make a legal edit whose *merge* breaks it: Ana drops
 * an H on (q0, c3) while Beto drops an X on (q0, c3). Nothing about
 * convergence refuses that, so the question this file has to answer is not
 * "does it converge" but "is what it converges to a circuit".
 *
 * Three answers were available (see `project.ts` for the one taken):
 *
 *   1. Encode the grid so the collision cannot be represented at all.
 *   2. Let it converge and repair deterministically, in every peer alike.
 *   3. Let it converge invalid and refuse to simulate until a human resolves it.
 *
 * ── Why (1) is impossible, and not merely awkward ─────────────────────────
 *
 * The tempting encoding is a map keyed by cell — `"3:7"` for qubit 3, column 7
 * — so that a cell has one occupant by construction. It does not work, and the
 * reason is structural rather than a matter of taste: **an operation is not a
 * cell.** A `cx` occupies two, a `ccx` three, a barrier every wire it spans.
 * A cell-keyed map must therefore either
 *
 *   - store the operation once, under one anchor cell, and *reference* it from
 *     the others — in which case the other cells are not protected by the
 *     keying at all, and Ana's H lands happily on the wire Beto's `cx` was
 *     using as a control. The collision is back, only now it is invisible
 *     because the representation claims to have made it impossible; or
 *   - store a copy of the operation under each of its cells — in which case
 *     two concurrent writes tear one gate apart. A `cx` whose control cell was
 *     overwritten and whose target cell was not is not a bad circuit, it is
 *     not a circuit at all: no shape in §6 spells "half of a two-qubit gate".
 *     A column conflict at least names two operations a person recognises and
 *     can move; a torn gate names nothing.
 *
 * And that is before the churn: inserting a qubit, reordering wires and
 * normalising columns all move *every key*, so the editor's ordinary
 * structural commands would each rewrite the whole document and collide with
 * every concurrent edit anywhere in it.
 *
 * So the collision is representable, necessarily, and the design problem moves
 * to the *reading*. That is what `project.ts` is: validity is a property of
 * the projection, computed identically by every peer on every read, and never
 * of the bytes.
 *
 * =====================================================================
 * WHAT IS ACTUALLY STORED
 * =====================================================================
 *
 * Five roots, each a Y.Map, each chosen for how it merges:
 *
 *   meta         `qubits`, `clbits`, `schemaVersion` — scalars, last write wins.
 *   operations   slot key → Y.Map of the operation's fields.
 *   labels       qubit index (as a string) → wire name.
 *   parameters   parameter name → `{ value, seq }`.
 *   gates        custom gate name → the whole definition, as opaque JSON.
 *
 * ── Why operations are keyed by an opaque slot and not by their id ────────
 *
 * Because two peers mint the same id. `useCircuitStore`'s allocator counts
 * up from `op_1` inside one document, so Ana and Beto, both editing the
 * circuit they opened a minute ago, both call their next gate `op_4`. Keyed by
 * id, those two keys are *one* key, and a Y.Map merges one key field by field:
 * the result is an operation with Ana's gate and Beto's targets — an edit
 * neither of them made, silently fabricated by the merge. That is the worst
 * outcome available, worse than either edit being lost, because nobody can
 * even name what went wrong.
 *
 * So the key is a slot: `<clientID in base 36>-<counter>`, unique by
 * construction because Yjs already gives every document instance a random
 * client id, and cheap to read in a raw dump — which is what you are doing
 * when you are debugging a merge. The contract's `id` rides along as a field,
 * where a duplicate is a name clash rather than a fusion, and
 * `project.ts` renames the loser.
 *
 * ── Why operations are a nested Y.Map and not one opaque JSON value ───────
 *
 * Two reasons, and the second is the one that would have forced it anyway.
 *
 * First, merging: Ana adding a control while Beto changes the angle of the
 * same gate is two writes to two keys, and both survive. Stored as one JSON
 * value the operation is last-write-wins as a whole and one of them
 * disappears — for no reason, since the two edits do not conflict in any sense
 * a person would recognise.
 *
 * Second, update size (§11 asks that an update be bounded). A slider drag is
 * dozens of commits a second, and each one has to travel. With fields as keys
 * it writes `params` and nothing else, about eighty bytes; as one value it
 * rewrites the gate, the targets, the controls and the column on every frame.
 *
 * ── Why a custom gate *is* one opaque value ───────────────────────────────
 *
 * The opposite decision, for the opposite reason. A definition is edited
 * through the definition editor, which swaps the whole document being edited
 * (`openDefinition`) and writes the result back in one act. Field-level
 * merging inside a body would therefore never merge two *gestures*; it would
 * merge two whole rewrites into a body neither person wrote, which is the
 * fusion problem again one level down. Last write wins per definition name is
 * the honest reading of "two people rewrote this block": one of the rewrites
 * won. Definitions with different names never conflict.
 *
 * ── `seq`, and what it is for ─────────────────────────────────────────────
 *
 * Every operation carries a Lamport stamp: one more than the highest `seq` the
 * writing peer has seen. It does two jobs, and both need it to be comparable
 * across peers rather than a wall clock (two laptops disagree about the time
 * by minutes, and a CRDT must not care).
 *
 *   - It is the total order the projection places operations in, so two peers
 *     resolve a contested cell the same way, and the older claim wins: an
 *     operation that was already in the document when yours was written is
 *     never displaced by yours. What you were looking at stays put, and what
 *     arrives late is what gets flagged.
 *   - It is the order `operations` comes back in, which keeps the array stable
 *     against remote edits and matches the order a solo editor's own appends
 *     produce — so attaching a document to a session changes nothing visible.
 *
 * Ties (genuinely concurrent placements, which is exactly the case that
 * motivates all of this) break on the slot key. That is arbitrary, and it is
 * *supposed* to be: there is no fact about which of two simultaneous edits is
 * right. What matters is that both peers pick the same one and neither edit is
 * thrown away.
 */

import { MAX_CLBITS, MAX_QUBITS } from '@qsim/schema'
import * as Y from 'yjs'

/* ── Root names ─────────────────────────────────────────────────────────── *
 *
 * A Y.Doc's roots are named, and the names are part of the wire format: two
 * peers that spell them differently share a document and see nothing of each
 * other. They are constants for that reason, not for tidiness.
 */

export const ROOT_META = 'meta'
export const ROOT_OPERATIONS = 'operations'
export const ROOT_LABELS = 'labels'
export const ROOT_PARAMETERS = 'parameters'
export const ROOT_GATES = 'gates'

/* ── Keys inside `meta` ─────────────────────────────────────────────────── */

export const META_SCHEMA_VERSION = 'schemaVersion'
export const META_QUBITS = 'qubits'
export const META_CLBITS = 'clbits'

/* ── Keys inside one operation's map ────────────────────────────────────── *
 *
 * The contract's own field names, so a raw document dump reads like §6 —
 * plus `seq`, which is this layer's and is documented in the header.
 */

export const FIELD_ID = 'id'
export const FIELD_GATE = 'gate'
export const FIELD_TARGETS = 'targets'
export const FIELD_CONTROLS = 'controls'
export const FIELD_PARAMS = 'params'
export const FIELD_COLUMN = 'column'
export const FIELD_CLBIT_TARGETS = 'clbitTargets'
export const FIELD_CONDITION = 'condition'
export const FIELD_SEQ = 'seq'

/** Keys inside one parameter's entry. `seq` means what it means above. */
export const PARAMETER_VALUE = 'value'
export const PARAMETER_SEQ = 'seq'

/**
 * The five roots of a circuit document.
 *
 * Everything is `Y.Map<unknown>`, deliberately. A document is written by
 * peers this process does not control, so what a key holds is a *claim* until
 * it has been through the contract — the same reason `parseCircuit` exists.
 * Typing the roots as `Y.Map<Operation>` would let every reader believe the
 * claim, and the first hostile update would be an unchecked cast.
 */
export interface CircuitRoots {
  readonly meta: Y.Map<unknown>
  readonly operations: Y.Map<unknown>
  readonly labels: Y.Map<unknown>
  readonly parameters: Y.Map<unknown>
  readonly gates: Y.Map<unknown>
}

/**
 * The roots of a document, creating them if this is the first look.
 *
 * `getMap` is idempotent and does not write, so calling it on a document that
 * has never held a circuit is free and produces no update — which is what
 * lets a joiner attach before the first sync frame has arrived.
 */
export function circuitRoots(doc: Y.Doc): CircuitRoots {
  return {
    meta: doc.getMap(ROOT_META),
    operations: doc.getMap(ROOT_OPERATIONS),
    labels: doc.getMap(ROOT_LABELS),
    parameters: doc.getMap(ROOT_PARAMETERS),
    gates: doc.getMap(ROOT_GATES),
  }
}

/**
 * Whether this document has ever held a circuit.
 *
 * The transport needs it and cannot compute it: a joiner that syncs first and
 * finds an empty document is looking at a *new* document and should seed it
 * from the editor, while one that finds content must adopt it. Emptiness of
 * the roots is the only signal available, which is why the transport must sync
 * before it bridges — an unsynced document is indistinguishable from a new
 * one, and seeding one is how two circuits get merged into nonsense.
 */
export function isEmptyDocument(doc: Y.Doc): boolean {
  const roots = circuitRoots(doc)
  return (
    roots.meta.size === 0 &&
    roots.operations.size === 0 &&
    roots.labels.size === 0 &&
    roots.parameters.size === 0 &&
    roots.gates.size === 0
  )
}

/**
 * The slot keys a document currently holds, unsorted.
 *
 * Unsorted because a Y.Map iterates in the insertion order of *this peer's*
 * copy, which two peers do not agree on. Anything that needs an order sorts by
 * `(seq, slot)`; see the header.
 */
export function slotKeys(roots: CircuitRoots): string[] {
  return [...roots.operations.keys()]
}

/**
 * One operation's field map, or `undefined` when the slot holds something
 * else.
 *
 * The guard is not defensive programming, it is the boundary: `operations` is
 * a map a stranger can write, and a stranger can write the number 7 where a
 * field map belongs. TypeScript cannot know, so the check has to be a runtime
 * one at exactly this seam, once.
 */
export function slotFields(
  roots: CircuitRoots,
  slot: string
): Y.Map<unknown> | undefined {
  const held = roots.operations.get(slot)
  return held instanceof Y.Map ? (held as Y.Map<unknown>) : undefined
}

/**
 * Mints slot keys.
 *
 * `clientID` is random per Y.Doc, so two peers cannot collide. The second half
 * is this client's Yjs clock, and that choice is load-bearing rather than
 * convenient: **a slot key must never be reused, even after the operation in
 * it is deleted.**
 *
 * A counter that restarted, or that only skipped keys currently present, would
 * hand out the key of a deleted operation again — and then a remote peer's
 * field edit to the *old* operation, made before it saw the deletion, would
 * land on the *new* one. That is precisely the fusion of two unrelated
 * operations that keying by slot instead of by id exists to prevent, arriving
 * through the back door.
 *
 * Yjs's clock is already the number that makes every item id in the document
 * unique for this client: it is monotone, it survives deletions, and it
 * continues rather than restarts when a persisted document is loaded into a
 * client that kept its id. Reusing it means this layer inherits that guarantee
 * instead of re-inventing a weaker one. `handed` and the map check cover a
 * caller that mints several keys before integrating any of them.
 */
export function slotMinter(doc: Y.Doc): { take: () => string } {
  const roots = circuitRoots(doc)
  const prefix = doc.clientID.toString(36)
  const handed = new Set<string>()
  return {
    take(): string {
      let clock = Y.getState(doc.store, doc.clientID)
      let slot = `${prefix}-${clock.toString(36)}`
      while (handed.has(slot) || roots.operations.has(slot)) {
        clock += 1
        slot = `${prefix}-${clock.toString(36)}`
      }
      handed.add(slot)
      return slot
    },
  }
}

/**
 * One more than the highest `seq` in the document — the next Lamport stamp.
 *
 * Computed from what this peer has seen, which is the whole definition of a
 * Lamport clock: an operation written after seeing Ana's is strictly younger
 * than hers, and two written without seeing each other tie. A non-numeric or
 * missing stamp counts as 0, so a hostile document cannot push the counter to
 * `Infinity` and make every later stamp equal.
 */
export function nextSeq(roots: CircuitRoots): number {
  let highest = 0
  for (const slot of roots.operations.keys()) {
    const fields = slotFields(roots, slot)
    const seq = fields?.get(FIELD_SEQ)
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > highest) {
      highest = seq
    }
  }
  for (const name of roots.parameters.keys()) {
    const seq = parameterSeq(roots, name)
    if (seq > highest) highest = seq
  }
  return highest + 1
}

/** A parameter entry's stamp, or 0 when it has none this layer can read. */
export function parameterSeq(roots: CircuitRoots, name: string): number {
  const entry = roots.parameters.get(name)
  if (typeof entry !== 'object' || entry === null) return 0
  const seq = (entry as Record<string, unknown>)[PARAMETER_SEQ]
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0
    ? seq
    : 0
}

/** A parameter entry's value, or `undefined` when it is not a number. */
export function parameterValue(
  roots: CircuitRoots,
  name: string
): number | undefined {
  const entry = roots.parameters.get(name)
  if (typeof entry !== 'object' || entry === null) return undefined
  const value = (entry as Record<string, unknown>)[PARAMETER_VALUE]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The register the document declares, or the smallest one that holds what it
 * carries.
 *
 * A stored count that is an integer in the contract's range is used as it
 * stands, including one that is *smaller* than the operations need — that is a
 * real state (Ana widened the register while Beto narrowed it, and last write
 * won), and the operations that no longer fit are deferred rather than
 * silently re-enabled by growing the register back.
 *
 * The fallback is for a document with no readable count at all: a peer that
 * has synced operations but not yet the meta root, or a hostile writer that
 * put a string there. Deriving the register from the operations keeps such a
 * document readable, and every peer derives the same number from the same
 * bytes.
 */
export function readRegister(
  roots: CircuitRoots,
  needed: { readonly qubits: number; readonly clbits: number }
): { readonly qubits: number; readonly clbits: number } {
  return {
    qubits: bounded(roots.meta.get(META_QUBITS), 1, MAX_QUBITS, needed.qubits),
    clbits: bounded(roots.meta.get(META_CLBITS), 0, MAX_CLBITS, needed.clbits),
  }
}

/** The schema version the document claims, or `undefined` when it claims none. */
export function readSchemaVersion(roots: CircuitRoots): number | undefined {
  const version = roots.meta.get(META_SCHEMA_VERSION)
  return typeof version === 'number' ? version : undefined
}

function bounded(
  value: unknown,
  low: number,
  high: number,
  fallback: number
): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= low && value <= high) return value
  }
  return Math.min(Math.max(fallback, low), high)
}
