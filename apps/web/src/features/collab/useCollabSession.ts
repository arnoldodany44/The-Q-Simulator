/**
 * `useCollabSession` — one component's worth of a shared session (M5.5).
 *
 * The transport is `collabSession.ts`, which is a plain object over ports for
 * the reason the API's `ws/session.ts` is: everything in it is a sequence, and a
 * sequence needs a test that can drive a clock. What is left here is the part
 * only React can do — tie that object's lifetime to a component, and let a
 * render read its state — and one decision that is not about React at all.
 *
 * ── THE DECISION: WHEN THERE IS NO SESSION, THERE IS NO SESSION ───────────
 *
 * Four things have to be true before a channel is opened, and every one of them
 * is a way the product legitimately runs:
 *
 *   1. **A saved circuit.** `circuit:<id>` is addressed by a circuit's handle,
 *      and an unsaved document has none — `/new`, a `?c=` payload somebody was
 *      sent, a draft nobody has stored. There is nothing to join.
 *   2. **A caller that wants one.** `enabled` is the product's policy, not this
 *      hook's. Since M5.6 there *is* a roster to put a watcher in, so the editor
 *      opens a session for anybody the relay will admit — the owner, who may
 *      write, and a reader of a PUBLIC or UNLISTED circuit, who may not. §3.4's
 *      decision 3 is the argument: presence writes nothing that outlives the
 *      connection, and an invisible watcher would leave shared cursors as a
 *      feature only the circuit's single writer could ever use. What `enabled` is
 *      still for is a page showing something that is not the live document — a
 *      `?v=` version preview, which touches no store and has no session to be in.
 *   3. **An API.** `resolveApiBaseUrl` answers `null` on a build compiled with
 *      no `VITE_API_URL`, and that build's editor is perfectly happy: circuits
 *      run in the tab and travel in the link. A socket cannot be pointed
 *      anywhere, so none is opened.
 *   4. **A provider.** `useContext(ApiContext)` rather than `useApiClient`, for
 *      the reason `useSimulation` gives: this hook must work with no provider at
 *      all — the editor renders in tests and on pages that never booted the API
 *      layer — and a throw there would take down the editor over a feature the
 *      reader may never use.
 *
 * When any of them is false the hook returns `status: 'off'` and **builds
 * nothing**: no Y.Doc, no bridge, no presence heartbeat, no store subscription.
 * That is what makes the promise in the transport's header enforceable — a solo
 * editor is the editor that shipped, with its own zundo history, because
 * `attachHistory` is only ever reached by a bridge and a bridge is only ever
 * built by a join.
 *
 * ── WHAT A CALLER DOES WITH WHAT COMES BACK ───────────────────────────────
 *
 * `presence` is the store the roster and the caret layer subscribe to
 * themselves, so a peer moving eight times a second re-renders a positioned
 * layer and not the two thousand cells of the grid. `setCursor` is the other
 * direction and the one the editor owns: a selection is document state and the
 * transport reads it from the store, while a cursor is a way of looking at the
 * document and only the grid knows where it is.
 *
 * `status` and `ended` are what the reader is told, and `collab.session.*` is
 * where the words are. Nothing in this file is a string: a hook that translated
 * would be a hook that had to be re-rendered by a language change, and D2's
 * catalogs belong to the components that paint.
 */

import type { Circuit } from '@qsim/schema'
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { ApiContext, resolveSocketUrl } from '../../lib/api'
import { currentAccessTokenProvider } from '../../lib/api/session'
import {
  useCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import { createCollabSession } from './collabSession'
import type {
  CollabSession,
  CollabSessionSnapshot,
  CollabSocketLike,
} from './collabSession'
import type { PresenceStore } from './presence'

export interface UseCollabSessionOptions {
  /**
   * The saved circuit's handle, or `null` for a document with no home.
   *
   * An id or a slug — the relay resolves both to one document, one row and one
   * channel, so a caller may pass whichever it already has.
   */
  readonly circuitId: string | null
  /**
   * Whether to open a session at all. The caller's policy; see the header.
   *
   * Defaults to true so that "there is a saved circuit" is the only thing a
   * simple caller has to decide.
   */
  readonly enabled?: boolean
  readonly store?: CircuitStore
  /** See `CollabSessionPorts.seed`. */
  readonly seed?: 'document' | 'store'
  /**
   * The saved version the store was seeded from — see `BridgeOptions.saved`.
   *
   * Read at join time rather than captured, so it is not a dependency of the
   * effect: a save that mints a new version must not tear the session down.
   */
  readonly saved?: Circuit | null
  /**
   * Who this session belongs to, as anything that changes when the credential
   * does — a user id is what the editor passes.
   *
   * It is an effect dependency, and that is the whole reason it exists. The
   * relay decides `access` from the identity presented at join time, and a page
   * whose Supabase session had not been restored yet joined *anonymously*: the
   * relay granted `read` on an UNLISTED or PUBLIC circuit rather than refusing,
   * and the circuit's own owner was told «You are watching this session. Only the
   * owner may edit.» with no path back but a reload, because nothing re-presented
   * the credential when it arrived. A change of identity reopens the session,
   * which presents it.
   */
  readonly identity?: string | null
  /**
   * How to obtain the socket. Must be stable across renders, for the reason
   * `useSimulation` gives about its own two transports: a fresh function every
   * render would tear the connection down and rejoin on every keystroke.
   *
   * A test passes a stand-in it can open, drop and reopen on demand. `null` is
   * legitimate and is what a build with no API looks like.
   */
  readonly createSocket?: (() => CollabSocketLike) | null
}

export interface CollabSessionView extends CollabSessionSnapshot {
  /** Who else is here, or `null` when there is no session to be here in. */
  readonly presence: PresenceStore | null
  /** Where this client is looking. A no-op when there is no session. */
  readonly setCursor: CollabSession['setCursor']
}

const OFF: CollabSessionSnapshot = {
  status: 'off',
  access: null,
  ended: null,
  error: null,
  deferred: 0,
  deferredOperations: [],
  overflow: 0,
  reconciled: true,
}

const NOTHING: CollabSessionView = {
  ...OFF,
  presence: null,
  setCursor: () => undefined,
}

export function useCollabSession(
  options: UseCollabSessionOptions
): CollabSessionView {
  const {
    circuitId,
    enabled = true,
    identity = null,
    seed,
    createSocket,
  } = options
  const store = options.store ?? useCircuitStore
  const client = useContext(ApiContext)

  /*
   * The saved version, read at join time rather than closed over.
   *
   * A ref and not a dependency: saving a new version replaces it, and a session
   * that tore itself down and rejoined on every save would drop every caret in
   * the room to learn something the join does not need until the *next* join. The
   * ref is written in its own effect, which runs before the one below because
   * React runs effects in hook order.
   */
  const savedVersion = options.saved ?? null
  const saved = useRef(savedVersion)
  useEffect(() => {
    saved.current = savedVersion
  }, [savedVersion])

  /**
   * The socket factory, or `null` for a deployment that has nowhere to connect.
   *
   * Memoised on the origin rather than rebuilt per render, because a fresh
   * factory is a fresh session — see `createSocket`. `createSocket` being
   * `undefined` means "work it out"; being `null` means "there is none", which is
   * how a test switches the transport off without switching the hook off.
   */
  const baseUrl = client?.baseUrl ?? null
  const connect = useMemo<(() => CollabSocketLike) | null>(() => {
    if (createSocket !== undefined) return createSocket
    if (baseUrl === null) return null
    const url = resolveSocketUrl(baseUrl)
    return () => new WebSocket(url) as unknown as CollabSocketLike
  }, [baseUrl, createSocket])

  /**
   * Where the live session is kept, and how a render sees it.
   *
   * Not `useState`, and the reason is worth stating because the obvious shape is
   * the one React now warns about: a session is created *in an effect* — it opens
   * a socket, which a render may not do and which React may throw away — and
   * `setSession(live)` from inside that effect is a synchronous setState in an
   * effect body, the cascading-render pattern `react-hooks` refuses.
   *
   * The holder is the same thing said correctly. It is a tiny external store, it
   * is created once by a pure initialiser, the effect *writes* to it as effects
   * are supposed to write to external systems, and `useSyncExternalStore`
   * subscribes to it — which is also how the roster and the caret layer already
   * read presence. One mechanism, no cascade.
   */
  const [holder] = useState(createSessionHolder)

  useEffect(() => {
    if (circuitId === null || !enabled || connect === null) return

    const live = createCollabSession({
      circuitId,
      store,
      connect,
      ...(seed === undefined ? {} : { seed }),
      saved: () => saved.current,
      // Read per connection and never captured: a reconnect an hour later must
      // not present the credential this session was opened with, and the reader
      // may have signed in or out in between.
      getToken: async () => (await currentAccessTokenProvider()()) ?? null,
    })
    holder.hold(live)

    /*
     * The tab going away is not an unmount. A closed lid, a killed tab and a
     * navigation to another site all skip React's cleanup entirely, and the
     * relay would then hold this peer's caret until its presence expired
     * thirty seconds later. `pagehide` is the event that fires in all three —
     * `beforeunload` does not on mobile Safari, and it disqualifies the page
     * from the back/forward cache, which would be a real regression for a
     * reader who pressed Back by accident.
     */
    const leave = (): void => {
      live.stop()
    }
    window.addEventListener('pagehide', leave)

    return () => {
      window.removeEventListener('pagehide', leave)
      live.stop()
      holder.hold(null)
    }
    /*
     * `identity` is here and nowhere else in the body: a change of credential is
     * a change of session, because the relay decides `access` from the identity
     * presented at join time and there is no frame that revises it. See the
     * option's own comment.
     */
  }, [circuitId, connect, enabled, holder, identity, seed, store])

  return useSyncExternalStore(holder.subscribe, holder.snapshot)
}

interface SessionHolder {
  readonly subscribe: (listener: () => void) => () => void
  readonly snapshot: () => CollabSessionView
  /** Adopts a session, or lets go of one. Written to by the effect. */
  readonly hold: (session: CollabSession | null) => void
}

/**
 * The external store a render reads a session through.
 *
 * The view is rebuilt when it changes and cached until the next change, because
 * `useSyncExternalStore` calls `getSnapshot` on every render and compares by
 * identity — a fresh object each time is an infinite render loop. It is the same
 * arrangement, and the same reason, as `presence.ts`'s own cached snapshot.
 */
function createSessionHolder(): SessionHolder {
  const listeners = new Set<() => void>()
  let session: CollabSession | null = null
  let release: (() => void) | null = null
  let cached: CollabSessionView = NOTHING

  function rebuild(): void {
    const live = session
    cached =
      live === null
        ? NOTHING
        : {
            ...live.snapshot(),
            presence: live.presence,
            setCursor: live.setCursor,
          }
    for (const listener of [...listeners]) listener()
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => cached,
    hold: (next) => {
      release?.()
      release = next === null ? null : next.subscribe(rebuild)
      session = next
      rebuild()
    },
  }
}
