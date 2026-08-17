/**
 * The hook, and the four ways the product legitimately has no session.
 *
 * The transport's own suite (`collabSession.test.ts`) drives the protocol. What
 * is asserted here is the part only a component can get wrong: that a session is
 * built exactly when all four preconditions hold, that it is *not* built
 * otherwise — no Y.Doc, no bridge, no socket, and above all no `attachHistory`
 * on the store — and that it is let go when the component or the tab does.
 *
 * The store is the real one, because the property this file protects is about
 * the store: a solo editor keeps the undo history that shipped in Phase 0.
 */

import { encodeFrame } from '@qsim/contract'
import type { ClientFrame, ServerFrame } from '@qsim/contract'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import type { CollabSocketLike } from './collabSession'
import { useCollabSession } from './useCollabSession'

afterEach(() => {
  cleanup()
})

interface FakeSocket extends CollabSocketLike {
  readonly sent: ClientFrame[]
  closedWith: number | null
  open(): void
  deliver(frame: ServerFrame): void
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closedWith: null,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.sent.push(JSON.parse(data) as ClientFrame),
    close: (code) => {
      socket.closedWith = code ?? 1000
    },
    open: () => socket.onopen?.({}),
    deliver: (frame) => socket.onmessage?.({ data: encodeFrame(frame) }),
  }
  return socket
}

/** A factory that is stable across renders, as the hook's contract requires. */
function transport(): {
  readonly create: () => CollabSocketLike
  readonly opened: FakeSocket[]
  readonly current: () => FakeSocket
} {
  const opened: FakeSocket[] = []
  return {
    create: () => {
      const created = fakeSocket()
      opened.push(created)
      return created
    },
    opened,
    current: () => {
      const last = opened.at(-1)
      if (last === undefined) throw new Error('nothing has connected')
      return last
    },
  }
}

describe('when there is nothing to join', () => {
  it('opens no socket for an unsaved document', () => {
    const socket = transport()
    const store = createCircuitStore()
    const { result } = renderHook(() =>
      useCollabSession({ circuitId: null, store, createSocket: socket.create })
    )

    expect(socket.opened).toEqual([])
    expect(result.current.status).toBe('off')
    expect(result.current.presence).toBeNull()
  })

  it('opens no socket when the caller has not asked for a session', () => {
    const socket = transport()
    const store = createCircuitStore()
    renderHook(() =>
      useCollabSession({
        circuitId: 'circuit1',
        enabled: false,
        store,
        createSocket: socket.create,
      })
    )

    expect(socket.opened).toEqual([])
  })

  it('opens no socket on a build with no API', () => {
    const store = createCircuitStore()
    // What `resolveApiBaseUrl` answering `null` reaches this hook as: there is
    // nowhere to point a socket, and the editor is perfectly happy about it.
    const { result } = renderHook(() =>
      useCollabSession({ circuitId: 'circuit1', store, createSocket: null })
    )

    expect(result.current.status).toBe('off')
  })

  it('leaves the editor’s own undo history exactly where it was', () => {
    const socket = transport()
    const store = createCircuitStore()
    renderHook(() =>
      useCollabSession({ circuitId: null, store, createSocket: socket.create })
    )

    store.getState().placeGate('h', [0], 0)
    expect(store.getState().circuit.operations).toHaveLength(1)
    expect(store.getState().undo().ok).toBe(true)
    expect(store.getState().circuit.operations).toHaveLength(0)
  })
})

describe('a session for a saved circuit', () => {
  it('connects, joins and reports the access it was granted', async () => {
    const socket = transport()
    const store = createCircuitStore()
    const { result } = renderHook(() =>
      useCollabSession({
        circuitId: 'circuit1',
        store,
        createSocket: socket.create,
      })
    )

    expect(socket.opened).toHaveLength(1)
    expect(result.current.status).toBe('connecting')

    await act(async () => {
      socket.current().open()
      await Promise.resolve()
    })
    expect(socket.current().sent).toEqual([
      { type: 'collab:join', circuitId: 'circuit1' },
    ])

    act(() => {
      socket.current().deliver({
        type: 'collab:joined',
        circuitId: 'circuit1',
        access: 'read',
        // An empty document: the relay always sends *something*, and a session
        // over an empty circuit is the least interesting thing it can send.
        update: '',
        vector: '',
        deferred: 0,
        overflow: 0,
      })
    })

    expect(result.current.status).toBe('open')
    expect(result.current.access).toBe('read')
    expect(result.current.presence).not.toBeNull()
  })

  it('says goodbye on unmount rather than leaving a caret behind', async () => {
    const socket = transport()
    const store = createCircuitStore()
    const view = renderHook(() =>
      useCollabSession({
        circuitId: 'circuit1',
        store,
        createSocket: socket.create,
      })
    )

    await act(async () => {
      socket.current().open()
      await Promise.resolve()
    })
    act(() => {
      socket.current().deliver({
        type: 'collab:joined',
        circuitId: 'circuit1',
        access: 'write',
        update: '',
        vector: '',
        deferred: 0,
        overflow: 0,
      })
    })

    view.unmount()

    expect(socket.current().sent.at(-1)).toEqual({
      type: 'collab:leave',
      circuitId: 'circuit1',
    })
    expect(socket.current().closedWith).not.toBeNull()
  })

  it('says goodbye when the tab goes away without unmounting', async () => {
    const socket = transport()
    const store = createCircuitStore()
    renderHook(() =>
      useCollabSession({
        circuitId: 'circuit1',
        store,
        createSocket: socket.create,
      })
    )

    await act(async () => {
      socket.current().open()
      await Promise.resolve()
    })
    act(() => {
      socket.current().deliver({
        type: 'collab:joined',
        circuitId: 'circuit1',
        access: 'write',
        update: '',
        vector: '',
        deferred: 0,
        overflow: 0,
      })
    })

    /*
     * A closed lid, a killed tab, a navigation away: none of them runs React's
     * cleanup, and without this the relay would hold this peer's caret until its
     * presence expired thirty seconds later.
     */
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    expect(socket.current().sent.at(-1)).toEqual({
      type: 'collab:leave',
      circuitId: 'circuit1',
    })
  })

  it('leaves one circuit’s session and opens another’s', () => {
    const socket = transport()
    const store = createCircuitStore()
    const view = renderHook(
      (props: { circuitId: string }) =>
        useCollabSession({
          circuitId: props.circuitId,
          store,
          createSocket: socket.create,
        }),
      { initialProps: { circuitId: 'circuit1' } }
    )

    const first = socket.current()
    view.rerender({ circuitId: 'circuit2' })

    expect(first.closedWith).not.toBeNull()
    expect(socket.opened).toHaveLength(2)
    expect(socket.current()).not.toBe(first)
  })
})
