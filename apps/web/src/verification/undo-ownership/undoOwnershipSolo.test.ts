/**
 * Fourth batch: the same keystrokes, solo and shared.
 *
 * "A solo editor must be exactly as good as it is now" is the milestone's own
 * requirement, and the honest test of it is not that the old suite still
 * passes — it runs with nothing attached — but that attaching a document does
 * not change what a sequence of presses means.
 */

import { describe, expect, it } from 'vitest'

import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore'
import { cells, circuitOf, host, idOf, paramsOf } from './peers'

/** placeGate rz, set the angle, drag it out and back, then undo once. */
function dragOutAndBack(store: ReturnType<typeof createCircuitStore>): {
  ok: boolean
  cells: string[]
  params: readonly unknown[] | undefined
} {
  const placed = store.getState().placeGate('rz', [0], 0)
  const id = idOf(placed)
  store.getState().setParam(id, 0, 0.5)

  store.getState().beginTransaction()
  store.getState().setParam(id, 0, 1.5)
  store.getState().setParam(id, 0, 0.5)
  store.getState().endTransaction()

  const result = store.getState().undo()
  return {
    ok: result.ok,
    cells: cells(store.getState().circuit),
    params: paramsOf(store.getState().circuit),
  }
}

describe('undo ownership: the solo case must not change', () => {
  /**
   * FINDING 6, as a solo regression — fixed. One person, no peer, no merge: a
   * session open by itself used to change what a slider drag followed by undo
   * means. Solo the angle went back; shared the gate was deleted. §3.4's own
   * framing is that a circuit has exactly one writer today, so this is the
   * common case, and it now behaves the same either way.
   */
  it('N. a drag that ends where it began, solo and shared, agree', () => {
    const solo = dragOutAndBack(createCircuitStore())
    const shared = dragOutAndBack(host('ana').store)
    expect({ solo, shared }).toEqual({
      solo: { ok: true, cells: ['rz@0:0'], params: [0] },
      shared: { ok: true, cells: ['rz@0:0'], params: [0] },
    })
  })

  it('O. undoing an angle twice, solo and shared, must agree', () => {
    const walk = (store: ReturnType<typeof createCircuitStore>): unknown[] => {
      const placed = store.getState().placeGate('rz', [0], 0)
      const id = idOf(placed)
      store.getState().setParam(id, 0, 0.5)
      store.getState().beginTransaction()
      store.getState().setParam(id, 0, 1.5)
      store.getState().endTransaction()

      const trace: unknown[] = []
      for (let press = 0; press < 4; press += 1) {
        const result = store.getState().undo()
        trace.push({
          ok: result.ok,
          cells: cells(store.getState().circuit),
          params: paramsOf(store.getState().circuit),
        })
      }
      return trace
    }
    expect(walk(host('ana').store)).toEqual(walk(createCircuitStore()))
  })

  /** FINDING 6 again with `moveOperation`, so it is not about parameters. */
  it('N2. the same thing with a move, so it is not about angles', () => {
    const walk = (store: ReturnType<typeof createCircuitStore>): unknown => {
      const placed = store.getState().placeGate('h', [0], 0)
      const id = idOf(placed)
      store.getState().moveOperation(id, [0], 1)

      // A keyboard or pointer drag that wanders and comes back.
      store.getState().beginTransaction()
      store.getState().moveOperation(id, [0], 2)
      store.getState().moveOperation(id, [0], 1)
      store.getState().endTransaction()

      const result = store.getState().undo()
      return { ok: result.ok, cells: cells(store.getState().circuit) }
    }
    // One press must put the gate back at column 0, both ways.
    expect({
      solo: walk(createCircuitStore()),
      shared: walk(host('ana').store),
    }).toEqual({
      solo: { ok: true, cells: ['h@0:0'] },
      shared: { ok: true, cells: ['h@0:0'] },
    })
  })

  it('P. a lone editor in a session can still undo its own whole history', () => {
    const ana = host('ana')
    for (const [gate, column] of [
      ['h', 0],
      ['x', 1],
      ['z', 2],
    ] as const) {
      ana.store.getState().placeGate(gate, [0], column)
    }
    expect(cells(circuitOf(ana))).toEqual(['h@0:0', 'x@0:1', 'z@0:2'])

    expect(ana.store.getState().undo(3).ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual([])
    expect(ana.store.getState().redo(3).ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual(['h@0:0', 'x@0:1', 'z@0:2'])
  })
})
