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
 */

import {
  applyCircuitUpdate,
  isEmptyDocument,
  projectCircuit,
  writeCircuit,
  type CircuitProjection,
  type UpdateResult,
} from '@qsim/collab'
import { MAX_COLLAB_STATE_BYTES } from '@qsim/contract'
import { safeParseCircuit, type Circuit } from '@qsim/schema'
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
  /** Called whenever the projection changes, for a view of the conflicts. */
  readonly onProjection?: (projection: CircuitProjection) => void
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

  if (options.seed === 'store' || isEmptyDocument(doc)) {
    projection = writeCircuit(doc, store.getState().circuit, {
      origin,
      baseline: projection,
    })
  }
  adopt()
  announce()

  const undo = createSharedUndo({
    doc,
    origin,
    circuit: () => store.getState().circuit,
    selection: () => store.getState().selection,
    restoreSelection: (ids) => {
      store.getState().setSelection(ids)
    },
  })
  store.getState().attachHistory(undo)

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
