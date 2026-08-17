/**
 * The roster, driven with no clock and no socket.
 *
 * Everything here is a sequence, which is why the module takes `now` as an
 * argument rather than reading one: a heartbeat that arrives after the expiry
 * that removed its sender, a peer that leaves and comes back, a thirty-third
 * cursor on a full roster. None of those is reproducible on demand against a
 * real timer.
 */

import { PRESENCE_TIMEOUT_MS } from '@qsim/contract'
import type { PresenceState } from '@qsim/contract'
import { describe, expect, it } from 'vitest'
import { MAX_PRESENCE_RECORDS, createPresenceRoster } from './presence.js'

function at(column: number, name = 'Ada'): PresenceState {
  return {
    name,
    access: 'write',
    cursor: { qubit: 0, column },
    selection: [],
    edits: 0,
  }
}

describe('what the roster holds', () => {
  it('keeps the newest position and not a history of them', () => {
    const roster = createPresenceRoster()
    roster.publish('p1', at(1), 1_000)
    roster.publish('p1', at(2), 1_100)

    expect(roster.size()).toBe(1)
    expect(roster.entries()[0]?.state.cursor).toEqual({ qubit: 0, column: 2 })
  })

  it('does not reshuffle when somebody moves their cursor', () => {
    // A roster is read by a person. Re-publishing must keep a peer's place, or
    // the list of who is here reorders itself every time anybody moves.
    const roster = createPresenceRoster()
    roster.publish('p1', at(0), 1_000)
    roster.publish('p2', at(0), 1_000)
    roster.publish('p1', at(5), 1_100)

    expect(roster.entries().map((record) => record.peerId)).toEqual([
      'p1',
      'p2',
    ])
  })

  it('forgets a peer that left, and says whether there was one', () => {
    const roster = createPresenceRoster()
    roster.publish('p1', at(0), 1_000)

    expect(roster.remove('p1')).toBe(true)
    expect(roster.remove('p1')).toBe(false)
    expect(roster.entries()).toEqual([])
  })
})

describe('a peer expires rather than waiting to be collected', () => {
  it('drops a record that has not been restated, and names it', () => {
    const roster = createPresenceRoster()
    roster.publish('ghost', at(0), 1_000)
    roster.publish('live', at(0), 1_000)

    // The live peer heartbeats; the ghost's tab was killed and says nothing.
    roster.publish('live', at(0), 1_000 + PRESENCE_TIMEOUT_MS - 1)
    const expired = roster.prune(1_000 + PRESENCE_TIMEOUT_MS)

    expect(expired).toEqual(['ghost'])
    expect(roster.entries().map((record) => record.peerId)).toEqual(['live'])
  })

  it('keeps a record that is exactly one millisecond short of the timeout', () => {
    const roster = createPresenceRoster()
    roster.publish('p1', at(0), 1_000)

    expect(roster.prune(1_000 + PRESENCE_TIMEOUT_MS - 1)).toEqual([])
    expect(roster.size()).toBe(1)
  })

  it('lets a heartbeat that arrives late resurrect nothing it should not', () => {
    /*
     * The sequence: a peer expires, is pruned, and then a heartbeat it sent
     * before it died finally arrives. It comes back — which is correct, and worth
     * pinning: the record is one *statement*, so a statement with a current
     * timestamp is a peer that is here. The client's own timeout is what removes
     * it again if nothing follows.
     */
    const roster = createPresenceRoster()
    roster.publish('p1', at(0), 1_000)
    roster.prune(1_000 + PRESENCE_TIMEOUT_MS)
    expect(roster.size()).toBe(0)

    roster.publish('p1', at(3), 1_000 + PRESENCE_TIMEOUT_MS)
    expect(roster.entries()[0]?.state.cursor).toEqual({ qubit: 0, column: 3 })
  })
})

describe('what a stranger can make one document hold', () => {
  it('refuses a new peer past the ceiling', () => {
    const roster = createPresenceRoster()
    for (let index = 0; index < MAX_PRESENCE_RECORDS; index += 1) {
      expect(roster.publish(`p${index}`, at(0), 1_000)).toBe(true)
    }

    expect(roster.publish('one-too-many', at(0), 1_000)).toBe(false)
    expect(roster.size()).toBe(MAX_PRESENCE_RECORDS)
  })

  it('never refuses a peer already in the roster', () => {
    /*
     * THE DEFECT THIS EXISTS FOR. A full roster that refused a *heartbeat* would
     * stop renewing a peer who is plainly present, and thirty seconds later that
     * peer would be pruned as a ghost — the cap would delete the very peers it
     * was holding.
     */
    const roster = createPresenceRoster()
    for (let index = 0; index < MAX_PRESENCE_RECORDS; index += 1) {
      roster.publish(`p${index}`, at(0), 1_000)
    }

    expect(roster.publish('p0', at(7), 1_000 + PRESENCE_TIMEOUT_MS / 2)).toBe(
      true
    )
    expect(roster.entries()[0]?.state.cursor).toEqual({ qubit: 0, column: 7 })
  })

  it('makes room as records expire', () => {
    const roster = createPresenceRoster()
    for (let index = 0; index < MAX_PRESENCE_RECORDS; index += 1) {
      roster.publish(`p${index}`, at(0), 1_000)
    }
    const later = 1_000 + PRESENCE_TIMEOUT_MS

    expect(roster.prune(later)).toHaveLength(MAX_PRESENCE_RECORDS)
    expect(roster.publish('newcomer', at(0), later)).toBe(true)
  })
})
