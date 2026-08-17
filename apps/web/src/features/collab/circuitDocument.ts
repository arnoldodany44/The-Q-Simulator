/**
 * The bridge: the editor's store on one side, a Y.Doc on the other (M5.1).
 *
 * =====================================================================
 * THE DOCUMENT SITS BENEATH THE STORE. IT DOES NOT REPLACE IT.
 * =====================================================================
 *
 * The other design — every action writing straight into the Y.Doc, the store
 * reduced to a projection — is the one that reads better on a diagram, and it
 * is the wrong trade here. Three reasons, in order of how much they cost:
 *
 *  1. **The store is where legality lives.** Every action builds a candidate
 *     circuit and hands it to `safeParseCircuit`; a refused edit changes
 *     nothing, and every feature built since M0.5 depends on that. Writing to
 *     the document first means validating *after* the write, which is
 *     impossible to undo (a CRDT has no rollback) — so the editor would have to
 *     stop refusing edits and start repairing documents.
 *
 *  2. **Most sessions have one person in them.** With the document beneath, a
 *     solo editor is exactly the editor that shipped: same store, same zundo
 *     history, same 106 tests, and no Yjs in the chunk until somebody opens a
 *     shared session. With the document on top, every keystroke of every solo
 *     session pays for a CRDT nobody is sharing with.
 *
 *  3. **A gesture is local.** A slider drag is dozens of commits a second and
 *     the intermediate values are nobody else's business until the drag ends.
 *     The store already knows how to group those; the document only has to see
 *     the result.
 *
 * So: the store commits, and the bridge tells the document what changed. The
 * document changes underneath — a peer, or an undo — and the bridge tells the
 * store to adopt what it now says. Two directions, and the whole difficulty is
 * keeping them from chasing each other.
 *
 * =====================================================================
 * THE RULE THAT KEEPS IT FROM LOOPING
 * =====================================================================
 *
 * A naive two-way sync loops immediately: the store fires an update, the
 * document changes, the document notifies the store, the store fires an update.
 * Two guards, one on each side, and both are one line:
 *
 *   **Store → document.** Every write goes through `doc.transact(fn, origin)`
 *   with this bridge's own `origin` object. The document listener returns
 *   immediately when the update it is told about carries that origin. So a
 *   write this client made is never read back as a change to apply.
 *
 *   **Document → store.** The store is only ever written inside `applying`, and
 *   the store subscription returns immediately while it is set. So an adoption
 *   is never read back as an edit to write.
 *
 * Neither guard is sufficient alone, because the two directions are not
 * symmetric: `writeCircuit` can legitimately produce a projection that differs
 * from what went in — deleting a gate can un-block a peer's gate that a
 * conflict was holding back — and that difference has to reach the store. It
 * arrives through the same adoption path as a remote change, and `applying` is
 * what stops it from turning into a second write.
 *
 * Everything else that changes the document — a remote update, an undo — is
 * *supposed* to reach the store, which is why the test is `origin === origin`
 * and not "was this a local transaction". `Y.UndoManager` transacts under its
 * own origin precisely so that it can be told apart from the client that owns
 * it.
 *
 * =====================================================================
 * A NEW CIRCUIT IN THIS TAB IS NOT AN EDIT TO THE SHARED ONE
 * =====================================================================
 *
 * The subscription above sees one thing: `circuit` is a different object than it
 * was. Two completely different events produce that, and reading the second as
 * the first is how a session gets destroyed.
 *
 * An **edit** changes the document everybody is in. A **document swap** replaces
 * what this tab has open: `loadCircuit` (a preset, a URL payload, an OpenQASM
 * import, restoring a version, opening another circuit), `reset`, and
 * `openDefinition`, which swaps the circuit for a custom gate's *body*. The
 * store already distinguishes them — `documentId` counts swaps and nothing else
 * — and the bridge did not consult it, so opening the definition editor
 * published the definition's body as the shared circuit: every operation of the
 * host circuit deleted, the definition deleted with them (the body declares
 * none), and `validateCircuit` powerless to refuse it, because a definition body
 * *is* a legal circuit.
 *
 * So `documentId` is part of the guard, and the two kinds of swap are answered
 * differently:
 *
 *   - **Another circuit.** The session is about the circuit that was open, and
 *     this tab has left it. Nothing is written; the bridge stops (no writes, no
 *     adoption — adopting would overwrite what was just loaded) and tells the
 *     transport, whose job it is to leave the channel and, if it wants, join the
 *     new circuit's.
 *   - **A definition detour.** The tab comes *back* from it, so the session is
 *     suspended rather than abandoned: nothing is published while the body is on
 *     the canvas, and what is published on the way out is the one thing a
 *     definition session can change — `customGates` — applied to the document as
 *     it now stands. A peer's edits made during the detour are therefore kept,
 *     which writing the store's frozen host circuit would have deleted.
 *
 * =====================================================================
 * ATTACHING MUST NOT DELETE WORK THE SESSION HAS NEVER SEEN
 * =====================================================================
 *
 * The first version adopted the document and stopped there, and that lost work
 * in three different ways that were really one:
 *
 *   1. A gate placed in the second between the canvas painting and the join
 *      landing. The authorisation read alone measures 273–547 ms against this
 *      repository's own API on localhost, and a real join additionally reads a
 *      row and builds a Y.Doc.
 *   2. A reload of `/c/:slug?c=…`. `useUnsavedWork` rests on «the draft is the
 *      URL» being the only copy, and `routes/editor.tsx` states the precedence
 *      itself — the `?c=` payload «always wins, including over the version stored
 *      under the slug». The join arrived with the *saved* version and replaced the
 *      draft, after which `suppressed` stripped `?c=` from the address bar.
 *   3. A peer that edited while its socket was down, closed the tab, and reopened
 *      the address it had been left with.
 *
 * In all three the store held operations that were in no document at all, so
 * nothing anywhere held them once the adoption ran — no peer, no row, and no undo
 * step, because the `Y.UndoManager` did not exist when the edit was made.
 *
 * So attaching **carries** them. The rule is one sentence and it is deliberately
 * asymmetric:
 *
 *   **The document wins for everything it knows about; the store contributes
 *   only what the document has never held.**
 *
 * Additive, so nothing a peer wrote is deleted — which is what rules out the
 * obvious alternative of writing the store's circuit straight in, since
 * `writeCircuit` is a diff and would delete every operation the store happens not
 * to have. And filtered through `saved`, the version the store was seeded from,
 * so that an operation a *peer deleted* is not resurrected: absent from the
 * document and present in `saved` means somebody removed it, while absent from
 * both means this reader made it. Without that filter, joining a session would
 * undelete every gate deleted since the last save.
 *
 * The carry is written *after* the undo manager exists, so it lands as one
 * undoable step: the work is the reader's and a reader who does not want it in the
 * shared document can press undo once. A *seed* write into an empty document is
 * the opposite case and stays where it was, before the manager — that write is the
 * document's beginning, and `loadCircuit` gives the rule: «being able to undo past
 * the beginning of the document you just opened is how you lose the document you
 * just opened».
 */

import {
  applyCircuitUpdate,
  defaultQubitLabel,
  isEmptyDocument,
  projectCircuit,
  writeCircuit,
  type CircuitProjection,
  type UpdateResult,
} from '@qsim/collab'
import { MAX_COLLAB_STATE_BYTES } from '@qsim/contract'
import { qubitsOf, safeParseCircuit, type Circuit } from '@qsim/schema'
import * as Y from 'yjs'

import {
  sameCircuit,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import { createSharedUndo } from './sharedUndo'

export interface BridgeOptions {
  /** The store to bridge. Tests and previews build their own. */
  readonly store: CircuitStore
  /**
   * The document. The transport owns it — it is where the provider attaches —
   * and the bridge therefore never destroys it.
   *
   * It must already be synced. An unsynced document is indistinguishable from a
   * new one, and seeding a new one is what `seed` does below.
   */
  readonly doc?: Y.Doc
  /**
   * What wins when the bridge is attached.
   *
   * `'document'` (the default) adopts what the document says, and writes the
   * store's circuit in only when the document has never held one — which is the
   * right behaviour for joining a session and for starting one, in that order.
   * `'store'` writes regardless, for the caller that means "publish what I have
   * open" and knows the document is empty or expendable.
   */
  readonly seed?: 'document' | 'store'
  /**
   * The saved version the store was seeded from, when there is one.
   *
   * Read for exactly one question — see the header on carrying local work: an
   * operation the document does not hold is this reader's own if `saved` did not
   * hold it either, and a peer's deletion if it did. Omitting it makes the carry
   * unconditional, which is right for a caller that knows the store's circuit is
   * nobody else's (a test, a preview) and wrong for the editor.
   */
  readonly saved?: Circuit
  /** Called whenever the projection changes, for a view of the conflicts. */
  readonly onProjection?: (projection: CircuitProjection) => void
  /**
   * Called when the store opens and closes a gesture — a slider drag, a typing
   * session — which the store already groups into one undo step.
   *
   * It exists for presence and for nothing else. A gesture is dozens of commits,
   * so it is dozens of document updates, and `presence.ts` has to announce it as
   * *one* edit to a listener: a receiving client can only guess at that from the
   * rate, and guessing was measured getting it wrong in both directions. The
   * sender knows, so the sender says.
   */
  readonly onGesture?: (active: boolean) => void
  /**
   * Called once when this tab opens a *different* circuit while bridged.
   *
   * The bridge has stopped by the time this runs — it writes nothing more and
   * adopts nothing more — because the store is no longer showing the document the
   * session is about. Leaving the channel is the transport's decision and not
   * this file's, which is why it is a callback rather than a `detach()` from
   * inside a store subscription.
   */
  readonly onDocumentReplaced?: () => void
}

export interface CircuitDocumentBridge {
  readonly doc: Y.Doc
  /**
   * Whether attaching wrote work of this client's into the document.
   *
   * True when the store held operations, wires, parameters or definitions the
   * document had never seen — see the header. The transport needs it because the
   * consequence differs by access: a writer's carry travels in the reconnection
   * delta, and a *watcher's* cannot travel at all, which is the divergence
   * `CollabSessionSnapshot.reconciled` exists to report.
   */
  readonly carried: boolean
  /**
   * The origin the *editor's* writes carry.
   *
   * Exposed for a test or a debugger that wants to tell one kind of local write
   * from another. It is deliberately **not** the filter a transport should use:
   * an undo and an undo's repairs are equally this client's and carry different
   * origins. Use `onLocalUpdate`.
   */
  readonly origin: unknown
  /**
   * Every update this client *produced*, for the transport to broadcast.
   *
   * This and not `origin` is what a relay filters on, and the difference is not
   * cosmetic. `origin` is the origin the editor's own writes carry; an undo does
   * not carry it, because `Y.UndoManager` transacts under itself, and a repair
   * made by the per-user undo carries a third sentinel. A transport that
   * broadcast only `origin === bridge.origin` would forward Ana's placement and
   * swallow her undo, and the two peers would diverge with neither of them
   * having done anything wrong.
   *
   * What is *not* announced here is anything `receive` applied: those bytes came
   * from the session and echoing them back would be a loop. So the rule the
   * transport needs is the one this subscription already implements — send
   * everything it hears — and there is no filter left to get wrong.
   *
   * Returns the unsubscribe.
   */
  readonly onLocalUpdate: (listener: (update: Uint8Array) => void) => () => void
  /** What the document says, and what it holds that the circuit cannot carry. */
  readonly projection: () => CircuitProjection
  /**
   * Apply an update that arrived from the session.
   *
   * The single door for foreign bytes, so the size ceiling, the decode guard
   * and the origin discipline are in one place rather than at each call site.
   * A refusal is the transport's cue to drop the connection — the projection
   * cannot un-apply what a peer sent (see `@qsim/collab`'s `update.ts`).
   *
   * The ceiling is `MAX_COLLAB_STATE_BYTES` and not `applyCircuitUpdate`'s
   * default, because the relay serves whole documents up to that figure in
   * `collab:joined`: taking the smaller default meant a join the relay
   * considered ordinary was refused `too-large` here, and the bridge went on
   * holding an empty document after a join it believed had succeeded.
   */
  readonly receive: (update: Uint8Array) => UpdateResult
  /** Everything this document holds, for a joiner or for persistence. */
  readonly state: () => Uint8Array
  readonly detach: () => void
}

export function bridgeCircuitDocument(
  options: BridgeOptions
): CircuitDocumentBridge {
  const store = options.store
  const doc = options.doc ?? new Y.Doc()
  /*
   * Fresh objects, one per bridge. Identity is the whole mechanism, so a shared
   * constant would make two bridges over one document invisible to each other,
   * and a string would collide with whatever the transport happens to use.
   */
  const origin = { qsim: 'editor' }
  const remoteOrigin = { qsim: 'session' }

  let projection = projectCircuit(doc)
  let applying = false
  /** Set once this tab opened another circuit. The bridge does nothing after. */
  let orphaned = false
  /** The host circuit a definition detour was entered from, while one is open. */
  let detour: Circuit | null = null
  const listeners = new Set<(update: Uint8Array) => void>()

  const announce = (): void => {
    options.onProjection?.(projection)
  }

  /** Document → store. The only path that writes the store. */
  const adopt = (): void => {
    // Not while this tab is showing something else: the definition body on the
    // canvas, or a circuit it has loaded since. Adopting would overwrite it.
    if (orphaned || detour !== null) return
    if (sameCircuit(store.getState().circuit, projection.circuit)) return
    applying = true
    try {
      store.getState().adoptDocument(projection.circuit)
    } finally {
      applying = false
    }
  }

  /** Store → document, for one circuit. */
  const publish = (circuit: Circuit): void => {
    projection = writeCircuit(doc, circuit, { origin, baseline: projection })
    adopt()
    announce()
  }

  /**
   * What a definition detour publishes on the way out.
   *
   * `applyDefinition` changes exactly one thing about the host document — one
   * entry of `customGates` — and `cancelDefinition` changes nothing. So the
   * definitions the store came back with are laid over the document *as it now
   * stands*, which keeps whatever the peers wrote while the body was open.
   * Writing the store's own circuit instead would delete all of it: the host it
   * carries is a snapshot from before the detour.
   *
   * A merge the contract refuses is not published at all — reachable only if a
   * peer added a use of the definition with a different shape while the detour
   * was open, in which case the document is the truth and the detour's edit is
   * the thing to lose. `adopt` then puts the shared circuit back on the canvas,
   * so the loss is visible rather than silent.
   */
  const publishDefinitions = (circuit: Circuit): void => {
    const definitions = circuit.customGates
    const merged: Circuit =
      definitions === undefined
        ? withoutDefinitions(projection.circuit)
        : { ...projection.circuit, customGates: definitions }
    if (!safeParseCircuit(merged).ok) {
      adopt()
      announce()
      return
    }
    publish(merged)
  }

  /*
   * The document's beginning, when it has none: this tab's circuit becomes the
   * shared one. Before the undo manager exists on purpose — a seed is not an
   * editing move and undoing past it would delete the document.
   */
  const seeded = options.seed === 'store' || isEmptyDocument(doc)
  if (seeded) {
    projection = writeCircuit(doc, store.getState().circuit, {
      origin,
      baseline: projection,
    })
  }

  const undo = createSharedUndo({
    doc,
    origin,
    circuit: () => store.getState().circuit,
    selection: () => store.getState().selection,
    restoreSelection: (ids) => {
      store.getState().setSelection(ids)
    },
  })
  /*
   * The store's gesture boundaries, passed on. `beginGesture`/`endGesture` are the
   * only signal in the system that says "these dozens of commits are one thing a
   * person did", and presence needs it — see `onGesture`.
   */
  store.getState().attachHistory({
    ...undo,
    beginGesture: () => {
      undo.beginGesture()
      options.onGesture?.(true)
    },
    endGesture: () => {
      undo.endGesture()
      options.onGesture?.(false)
    },
  })

  /*
   * Work the session has never seen, carried in as one undoable step. See the
   * header: additive so nothing a peer wrote is deleted, and filtered through
   * `saved` so nothing a peer *deleted* comes back.
   */
  let carried = false
  if (!seeded) {
    const merged = withLocalWork(
      projection,
      store.getState().circuit,
      options.saved
    )
    if (merged !== null) {
      carried = true
      projection = writeCircuit(doc, merged, { origin, baseline: projection })
    }
  }

  adopt()
  announce()

  /** Store → document. */
  const unsubscribe = store.subscribe((next, previous) => {
    if (applying || orphaned) return

    /*
     * A definition detour, in both directions. Entering it publishes nothing;
     * leaving it publishes the definitions and nothing else. The store's own
     * `definitionEdit` is the signal, because it is the only one that says
     * *which* kind of swap this is.
     */
    if (next.definitionEdit !== null) {
      detour ??= next.definitionEdit.host
      return
    }
    const host = detour
    if (host !== null) {
      detour = null
      // Unless the tab left the detour by opening something else entirely, in
      // which case the circuit on screen is not the host with a definition
      // changed and none of it belongs to the peers.
      if (
        sameCircuit(withoutDefinitions(next.circuit), withoutDefinitions(host))
      ) {
        publishDefinitions(next.circuit)
        return
      }
      orphaned = true
      options.onDocumentReplaced?.()
      return
    }

    if (next.documentId !== previous.documentId) {
      // Another circuit is open in this tab. Nothing about it is an edit to the
      // document the session is about.
      orphaned = true
      options.onDocumentReplaced?.()
      return
    }

    // Identity is the store's own test for "the document changed": circuits are
    // immutable there and every real edit produces a new object, so a
    // selection-only change is not an edit and must not travel.
    if (next.circuit === previous.circuit) return
    undo.note(previous.selection)
    publish(next.circuit)
  })

  const onUpdate = (update: Uint8Array, updateOrigin: unknown): void => {
    if (updateOrigin !== remoteOrigin) {
      for (const listener of [...listeners]) listener(update)
    }
    if (updateOrigin === origin) return
    projection = projectCircuit(doc)
    adopt()
    announce()
  }
  doc.on('update', onUpdate)

  return {
    doc,
    carried,
    origin,
    onLocalUpdate: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    projection: () => projection,
    receive: (update) =>
      applyCircuitUpdate(doc, update, {
        origin: remoteOrigin,
        maxBytes: MAX_COLLAB_STATE_BYTES,
      }),
    state: () => Y.encodeStateAsUpdate(doc),
    detach: () => {
      unsubscribe()
      doc.off('update', onUpdate)
      listeners.clear()
      store.getState().attachHistory(null)
      undo.destroy()
    },
  }
}

/**
 * The document's circuit plus whatever the store holds that it has never held,
 * or `null` when there is nothing to carry.
 *
 * ── The two sets this walks, and why neither is `projection.circuit` alone ──
 *
 * "What the document holds" is *not* the projected circuit: an operation the
 * projection **deferred** is in the document and out of the circuit, and treating
 * it as absent would write a second copy of it into a second slot — one more
 * contender for a cell that is already contested. So the known set is the
 * projection's `slots` (the survivors) together with the ids of everything it
 * deferred.
 *
 * "What is this reader's own" is decided against `saved`, the version the store
 * was seeded from. Absent from the document and present in `saved` is a peer's
 * deletion and is left deleted; absent from both is work only this tab has. With
 * no `saved` the caller is asserting the store's circuit is nobody else's, so
 * everything missing is carried.
 *
 * The register is widened rather than replaced, for the reason `widenRegister`
 * gives about undo: a wire cannot be withdrawn from under somebody else's gate,
 * and narrowing to this tab's count would do exactly that. Labels, parameters and
 * definitions follow the same additive rule — the document's value stands, and
 * only a name it has never carried is added — because they are the keys
 * `writeCircuit` *deletes* when the circuit it is handed does not account for
 * them.
 */
function withLocalWork(
  projection: CircuitProjection,
  local: Circuit,
  saved: Circuit | undefined
): Circuit | null {
  const known = new Set<string>(projection.slots.keys())
  for (const entry of projection.deferred) {
    const id = entry.operation?.id
    if (id !== undefined) known.add(id)
  }
  const wasSaved =
    saved === undefined
      ? null
      : new Set(saved.operations.map((operation) => operation.id))

  const carried = local.operations.filter(
    (operation) =>
      !known.has(operation.id) && !(wasSaved?.has(operation.id) ?? false)
  )

  const projected = projection.circuit
  let qubits = projected.qubits
  let clbits = projected.clbits
  for (const operation of carried) {
    // `qubitsOf` rather than targets and controls read by hand: a control is a
    // `{ qubit, state }` as often as it is a number, and the contract owns which.
    for (const qubit of qubitsOf(operation)) {
      qubits = Math.max(qubits, qubit + 1)
    }
    for (const clbit of operation.clbitTargets ?? []) {
      clbits = Math.max(clbits, clbit + 1)
    }
    const condition = operation.condition
    if (condition !== undefined) clbits = Math.max(clbits, condition.clbit + 1)
  }
  /*
   * A wire this reader added since the save is theirs too, even with nothing on
   * it yet: they widened the register and the register is part of the document.
   *
   * Only with a `saved` to compare against. Without one there is no way to tell a
   * wire this reader added from one a peer removed, and guessing would restore a
   * register somebody deliberately narrowed — so an unknown store widens the
   * document only as far as the operations it is actually carrying require.
   */
  if (saved !== undefined) {
    if (local.qubits > saved.qubits) qubits = Math.max(qubits, local.qubits)
    if (local.clbits > saved.clbits) clbits = Math.max(clbits, local.clbits)
  }

  const labels = carriedLabels(projected, local, qubits)
  const parameters = carriedParameters(projected, local, saved)
  const gates = carriedGates(projected, local, saved)

  if (
    carried.length === 0 &&
    qubits === projected.qubits &&
    clbits === projected.clbits &&
    labels === undefined &&
    parameters === undefined &&
    gates === undefined
  ) {
    return null
  }

  const merged: Circuit = {
    ...projected,
    qubits,
    clbits,
    operations: [...projected.operations, ...carried],
    ...(labels === undefined ? {} : { qubitLabels: labels }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(gates === undefined ? {} : { customGates: gates }),
  }
  // A merge the contract refuses is not written at all — reachable by a document
  // already at `MAX_OPERATIONS` — and the document then wins outright, which is
  // the behaviour that shipped rather than a new way to lose anything.
  return safeParseCircuit(merged).ok ? merged : null
}

/**
 * The document's wire names, extended to cover the widened register.
 *
 * `undefined` when nothing has to change. A rename this tab made to a wire the
 * document already names is *not* carried: the document's name stands, exactly as
 * its operations do, and a lost rename is visible in a way a lost gate is not.
 */
function carriedLabels(
  projected: Circuit,
  local: Circuit,
  qubits: number
): string[] | undefined {
  const held = projected.qubitLabels
  const mine = local.qubitLabels
  if (held === undefined && mine === undefined) return undefined
  if (held !== undefined && qubits === projected.qubits) return undefined
  const labels: string[] = []
  for (let index = 0; index < qubits; index += 1) {
    labels.push(held?.[index] ?? mine?.[index] ?? defaultQubitLabel(index))
  }
  return labels
}

function carriedParameters(
  projected: Circuit,
  local: Circuit,
  saved: Circuit | undefined
): Circuit['parameters'] | undefined {
  const held = projected.parameters ?? []
  const names = new Set(held.map((parameter) => parameter.name))
  const savedNames = new Set(
    (saved?.parameters ?? []).map((parameter) => parameter.name)
  )
  const extra = (local.parameters ?? []).filter(
    (parameter) =>
      !names.has(parameter.name) &&
      !(saved !== undefined && savedNames.has(parameter.name))
  )
  if (extra.length === 0) return undefined
  return [...held, ...extra]
}

function carriedGates(
  projected: Circuit,
  local: Circuit,
  saved: Circuit | undefined
): Circuit['customGates'] | undefined {
  const held = projected.customGates ?? {}
  const mine = local.customGates ?? {}
  const savedGates = saved?.customGates ?? {}
  const extra = Object.entries(mine).filter(
    ([name]) =>
      !Object.hasOwn(held, name) &&
      !(saved !== undefined && Object.hasOwn(savedGates, name))
  )
  if (extra.length === 0) return undefined
  return { ...held, ...Object.fromEntries(extra) }
}

/**
 * The same circuit with no definitions.
 *
 * Used to ask "is this still the document the detour started from, apart from
 * its definitions" — the one question that separates coming back from the
 * definition editor from having opened something else while inside it.
 */
function withoutDefinitions(circuit: Circuit): Circuit {
  const { customGates: _definitions, ...rest } = circuit
  return rest
}
