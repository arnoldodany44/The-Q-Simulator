// @vitest-environment node
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_THROTTLE_MS,
  PRESENCE_TIMEOUT_MS,
  MAX_PRESENCE_SELECTION,
} from '@qsim/contract'
import type { PresencePosition, PresenceState } from '@qsim/contract'
import { describe, expect, it } from 'vitest'

import { EDIT_ANNOUNCE_QUIET_MS, createPresenceStore } from './presence'
import type { PresenceEvent, PresenceStore } from './presence'
import { createPresenceChannel } from './presenceChannel'

/**
 * The store and the channel, with no React and no clock.
 *
 * Every interesting behaviour here is timing — a throttle that must not swallow the
 * first movement, a heartbeat that must not stop, an expiry that must fire without
 * anybody sending anything — so the clock is a variable and the timers are a list.
 */

function state(overrides: Partial<PresenceState> = {}): PresenceState {
  return {
    name: 'Ada',
    access: 'write',
    cursor: { qubit: 0, column: 2 },
    selection: [],
    edits: 0,
    ...overrides,
  }
}

describe('the roster', () => {
  it('is empty, and identically empty, before anybody arrives', () => {
    // `useSyncExternalStore` compares snapshots by identity on every render: a
    // fresh object per call is an infinite render loop.
    const store = createPresenceStore()
    expect(store.snapshot().peers).toEqual([])
    expect(store.snapshot()).toBe(store.snapshot())
  })

  it('replaces a peer’s position and keeps its place in the list', () => {
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    store.receive('p2', state({ name: 'Beto' }), 1_000)
    store.receive('p1', state({ cursor: { qubit: 1, column: 9 } }), 1_100)

    const { peers } = store.snapshot()
    expect(peers.map((peer) => peer.peerId)).toEqual(['p1', 'p2'])
    expect(peers[0]?.cursor).toEqual({ qubit: 1, column: 9 })
  })

  it('hands out a new snapshot only when something changed', () => {
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    const first = store.snapshot()
    store.expire(1_000)
    expect(store.snapshot()).toBe(first)
  })

  it('notifies its subscribers, and stops when they unsubscribe', () => {
    const store = createPresenceStore()
    let calls = 0
    const off = store.subscribe(() => {
      calls += 1
    })
    store.receive('p1', state(), 1_000)
    expect(calls).toBe(1)
    off()
    store.receive('p1', state({ cursor: null }), 1_100)
    expect(calls).toBe(1)
  })

  it('keeps a peer with no name, and says nothing about who they are', () => {
    // An anonymous watcher of a PUBLIC circuit. The *word* for that is the UI's,
    // because D2 puts every user-facing string in three catalogs.
    const store = createPresenceStore()
    store.receive('p1', state({ name: null, access: 'read' }), 1_000)
    expect(store.snapshot().peers[0]).toMatchObject({
      name: null,
      access: 'read',
    })
  })
})

/** The newest thing the store said, which is what a one-slot region showed. */
function latest(store: PresenceStore): PresenceEvent | null {
  const events = store.snapshot().events
  return events[events.length - 1] ?? null
}

describe('what reaches a live region, and what must not', () => {
  it('announces an arrival', () => {
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    expect(latest(store)).toMatchObject({
      kind: 'joined',
      name: 'Ada',
      seq: 1,
    })
  })

  it('announces a departure, with the name the peer had', () => {
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    store.receive('p1', null, 1_100)

    expect(latest(store)).toMatchObject({ kind: 'left', name: 'Ada' })
    expect(store.snapshot().peers).toEqual([])
  })

  it('says nothing about a departure it never saw arrive', () => {
    const store = createPresenceStore()
    store.receive('p1', null, 1_000)
    expect(store.snapshot().events).toEqual([])
  })

  /**
   * THE REQUIREMENT THIS FILE EXISTS FOR. A live region that announced every
   * cursor movement would be unusable — a peer crossing a twenty-column circuit is
   * dozens of updates, and a screen reader would read coordinates over everything
   * else the listener was trying to do.
   */
  it('says nothing at all about movement', () => {
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    const arrival = latest(store)

    for (let column = 0; column < 20; column += 1) {
      store.receive(
        'p1',
        state({ cursor: { qubit: 0, column } }),
        1_100 + column
      )
    }
    store.receive('p1', state({ selection: ['op-1', 'op-2'] }), 1_200)

    // Nothing new was said: the arrival is still the only sentence, and an
    // unchanged region is a silent one.
    expect(arrival).toMatchObject({ kind: 'joined' })
    expect(store.snapshot().events).toEqual([arrival])
  })

  it('announces an edit, because the count grew', () => {
    const store = createPresenceStore()
    store.receive('p1', state({ edits: 3 }), 1_000)
    store.receive(
      'p1',
      state({ edits: 4, cursor: { qubit: 1, column: 4 } }),
      1_100
    )

    expect(latest(store)).toMatchObject({
      kind: 'edited',
      name: 'Ada',
      cursor: { qubit: 1, column: 4 },
    })
  })

  it('does not announce an edit for a peer that started counting again', () => {
    // A reconnect: same peer id, fresh counter. Not news.
    const store = createPresenceStore()
    store.receive('p1', state({ edits: 9 }), 1_000)
    const arrival = latest(store)
    expect(arrival).toMatchObject({ kind: 'joined' })
    store.receive('p1', state({ edits: 0 }), 1_100)
    expect(store.snapshot().events).toEqual([arrival])
  })

  it('gives every event a sequence number, so two identical ones both speak', () => {
    const store = createPresenceStore()
    store.receive('p1', state({ edits: 1 }), 1_000)
    store.receive('p1', state({ edits: 2 }), 1_100)
    const first = latest(store)
    // Past the quiet period, so this is a second *edit* rather than one more frame
    // of the same gesture.
    store.receive('p1', state({ edits: 3 }), 1_100 + EDIT_ANNOUNCE_QUIET_MS)
    const second = latest(store)

    expect(second?.kind).toBe(first?.kind)
    expect(second?.seq).toBe((first?.seq ?? 0) + 1)
  })

  /**
   * A slider drag is dozens of commits a second, and every one of them grew the
   * count — so the region re-read the identical sentence about eight times a second
   * for as long as the drag lasted. The throttle bounds bytes; this bounds speech.
   */
  it('says an edit once per gesture, not once per frame of it', () => {
    const store = createPresenceStore()
    store.receive('p1', state({ edits: 1 }), 1_000)
    let spoken = 0
    let frameBase = latest(store)?.seq ?? 0
    for (let frame = 1; frame <= 16; frame += 1) {
      // One frame every 120 ms — what `presenceChannel.ts` emits during a drag.
      store.receive('p1', state({ edits: 1 + frame }), 1_000 + frame * 120)
      spoken += store
        .snapshot()
        .events.filter(
          (event) => event.kind === 'edited' && event.seq > frameBase
        ).length
      frameBase = Math.max(
        frameBase,
        ...store.snapshot().events.map((event) => event.seq)
      )
    }
    // Two seconds of drag is one sentence, not sixteen.
    expect(spoken).toBe(1)

    // And a deliberate edit after the quiet period is its own sentence.
    store.receive('p1', state({ edits: 99 }), 1_000 + 16 * 120 + 3_000)
    expect(latest(store)).toMatchObject({ kind: 'edited' })
  })

  /**
   * One dropped network takes two peers with it, so one sweep removes both. A
   * single event slot announced only the last of them, and a listener was left
   * believing somebody who had gone was still in the document.
   */
  it('announces every departure of one sweep, not just the last', () => {
    const store = createPresenceStore()
    store.receive('ana', state({ name: 'Ana' }), 1_000)
    store.receive('beto', state({ name: 'Beto' }), 1_000)

    store.expire(1_000 + PRESENCE_TIMEOUT_MS)

    const events = store.snapshot().events
    expect(events.map((event) => event.kind)).toEqual(['left', 'left'])
    expect(events.map((event) => event.name).sort()).toEqual(['Ana', 'Beto'])
    expect(store.snapshot().peers).toEqual([])
  })
})

describe('a peer that stopped saying anything', () => {
  it('is dropped once the timeout passes, and announced as gone', () => {
    const store = createPresenceStore()
    store.receive('ghost', state(), 1_000)
    store.receive('live', state({ name: 'Beto' }), 1_000)
    store.receive('live', state({ name: 'Beto' }), 1_000 + PRESENCE_TIMEOUT_MS)

    store.expire(1_000 + PRESENCE_TIMEOUT_MS)

    expect(store.snapshot().peers.map((peer) => peer.peerId)).toEqual(['live'])
    expect(latest(store)).toMatchObject({ kind: 'left', name: 'Ada' })
  })

  it('survives one millisecond short of the timeout', () => {
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    store.expire(1_000 + PRESENCE_TIMEOUT_MS - 1)
    expect(store.snapshot().peers).toHaveLength(1)
  })
})

describe('losing the session', () => {
  it('forgets everybody without announcing four departures', () => {
    /*
     * The connection dropped, or this tab left. The peers did not go anywhere —
     * this tab did — and announcing their departure would be describing the wrong
     * event to the one person who cannot see what happened.
     */
    const store = createPresenceStore()
    store.receive('p1', state(), 1_000)
    store.receive('p2', state({ name: 'Beto' }), 1_000)

    store.clear()

    expect(store.snapshot().peers).toEqual([])
    expect(latest(store)).toBeNull()
  })
})

/* ── the channel ─────────────────────────────────────────────────────────── */

interface Timer {
  readonly run: () => void
  readonly at: number
  cancelled: boolean
}

function channelHarness() {
  const sent: PresencePosition[] = []
  const timers: Timer[] = []
  let clock = 10_000

  const channel = createPresenceChannel({
    send: (position) => sent.push(position),
    now: () => clock,
    schedule: (run, ms) => {
      const timer: Timer = { run, at: clock + ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })

  return {
    channel,
    sent,
    advance(ms: number) {
      clock += ms
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.at > clock) continue
        timer.cancelled = true
        timer.run()
      }
    },
    /** Timers that are still armed — for asserting nothing leaked. */
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  }
}

describe('what leaves this tab', () => {
  it('sends the first movement at once', () => {
    // A caret that takes 120 ms to appear where somebody just clicked is a caret
    // that reads as broken.
    const h = channelHarness()
    h.channel.moved({ cursor: { qubit: 0, column: 1 }, selection: [] })
    expect(h.sent).toEqual([
      { cursor: { qubit: 0, column: 1 }, selection: [], edits: 0 },
    ])
  })

  it('collapses a burst into one trailing frame carrying the newest position', () => {
    const h = channelHarness()
    h.channel.moved({ cursor: { qubit: 0, column: 1 }, selection: [] })
    for (let column = 2; column < 12; column += 1) {
      h.advance(5)
      h.channel.moved({ cursor: { qubit: 0, column }, selection: [] })
    }

    expect(h.sent).toHaveLength(1)
    h.advance(PRESENCE_THROTTLE_MS)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.cursor).toEqual({ qubit: 0, column: 11 })
  })

  it('ignores a re-render that moved nothing', () => {
    const h = channelHarness()
    h.channel.moved({ cursor: { qubit: 0, column: 1 }, selection: ['op-1'] })
    h.channel.moved({ cursor: { qubit: 0, column: 1 }, selection: ['op-1'] })
    expect(h.sent).toHaveLength(1)
  })

  it('truncates a selection to what can be drawn', () => {
    const h = channelHarness()
    const many = Array.from({ length: 40 }, (_, index) => `op-${index}`)
    h.channel.moved({ cursor: null, selection: many })

    expect(h.sent[0]?.selection).toHaveLength(MAX_PRESENCE_SELECTION)
    expect(h.sent[0]?.selection[0]).toBe('op-0')
  })

  it('counts an edit and sends it, because an update has no author', () => {
    const h = channelHarness()
    h.channel.noteEdit()
    h.advance(PRESENCE_THROTTLE_MS)
    h.channel.noteEdit()
    h.advance(PRESENCE_THROTTLE_MS)

    expect(h.sent.map((position) => position.edits)).toEqual([1, 2])
  })

  it('restates its position on the heartbeat, unprompted', () => {
    // A closed tab sends nothing, including a goodbye. Presence is a lease.
    const h = channelHarness()
    h.channel.moved({ cursor: { qubit: 0, column: 3 }, selection: [] })
    h.advance(PRESENCE_HEARTBEAT_MS)
    h.advance(PRESENCE_HEARTBEAT_MS)

    expect(h.sent).toHaveLength(3)
    expect(h.sent.at(-1)?.cursor).toEqual({ qubit: 0, column: 3 })
  })

  it('expires a ghost on the same timer, with nothing arriving', () => {
    /*
     * The sweep is armed at construction rather than by the first movement, and
     * this is the peer it exists for: somebody who joined to read, whose cursor is
     * null and who therefore never triggers a send at all. Nothing else in this
     * client is driven by a clock, so without it a ghost's caret would sit on that
     * reader's screen for as long as the tab was open.
     */
    const h = channelHarness()
    h.channel.receive('ghost', state())

    for (
      let tick = 0;
      tick * PRESENCE_HEARTBEAT_MS < PRESENCE_TIMEOUT_MS;
      tick += 1
    ) {
      h.advance(PRESENCE_HEARTBEAT_MS)
    }

    expect(h.channel.store.snapshot().peers).toEqual([])
  })

  it('sends on the leading edge again after a reset', () => {
    const h = channelHarness()
    h.channel.moved({ cursor: { qubit: 0, column: 1 }, selection: [] })
    h.channel.reset()
    h.channel.moved({ cursor: { qubit: 0, column: 2 }, selection: [] })

    // Not queued behind a throttle window opened by a send the server never got.
    expect(h.sent).toHaveLength(2)
    expect(h.channel.store.snapshot().peers).toEqual([])
  })

  it('states where it is as soon as the session opens', () => {
    // A peer that joined to read has a null cursor and nothing to report, and
    // `moved` is a no-op when nothing moved. Without `announce` it would be
    // invisible until its first heartbeat.
    const h = channelHarness()
    h.channel.announce()
    expect(h.sent).toEqual([{ cursor: null, selection: [], edits: 0 }])
  })

  it('leaves no timer behind when it stops', () => {
    const h = channelHarness()
    h.channel.moved({ cursor: { qubit: 0, column: 1 }, selection: [] })
    h.channel.receive('p1', state())
    h.channel.stop()

    expect(h.pending()).toBe(0)
    expect(h.channel.store.snapshot().peers).toEqual([])
    h.advance(PRESENCE_HEARTBEAT_MS * 3)
    expect(h.sent).toHaveLength(1)
  })

  it('says nothing more once stopped, however much moves', () => {
    const h = channelHarness()
    h.channel.stop()
    h.channel.moved({ cursor: { qubit: 1, column: 1 }, selection: [] })
    h.channel.noteEdit()
    expect(h.sent).toEqual([])
  })
})
