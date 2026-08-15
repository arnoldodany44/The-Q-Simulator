// @vitest-environment node
import { emptyCircuit, parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  clampPosition,
  positionAt,
  stepPosition,
  stopCount,
  stopOf,
  timelineLength,
  type TimelinePosition,
} from './timeline'

/**
 * The scrubber's arithmetic (M0.8).
 *
 * Two things are worth pinning here and nowhere else. The bar and the engine
 * must count the same stops — a slider that is one out of step with
 * `stateAfterColumn` captions every state with its neighbour's column number,
 * and nothing about that looks like a bug. And the position must survive an
 * edit underneath it, which is the decision this module records: clamp, not
 * reset, and clamp on read so that undo brings the position back with the
 * circuit it belonged to.
 */

/** A circuit whose operations occupy columns `0 … columns - 1`. */
function ofLength(columns: number): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 1,
    operations: Array.from({ length: columns }, (_, column) => ({
      id: `g${column}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

describe('the stops of a timeline', () => {
  it('offers one stop per column plus the end', () => {
    // Five columns are six stops: before column 0, after each of the five,
    // and the last of those is the end of the circuit.
    expect(stopCount(5)).toBe(6)
    expect(stopCount(1)).toBe(2)
  })

  it('has exactly one stop when there are no columns', () => {
    // An empty circuit has no time in it to travel through, so the only
    // position is the end — which is also where the panel already was.
    expect(stopCount(0)).toBe(1)
    expect(positionAt(0, 0)).toBeNull()
    expect(clampPosition(3, 0)).toBeNull()
    expect(clampPosition(-1, 0)).toBeNull()
  })

  it('maps every stop to a position and back', () => {
    const columns = 4
    const positions: TimelinePosition[] = [-1, 0, 1, 2, null]
    positions.forEach((position, stop) => {
      expect(positionAt(stop, columns), `stop ${stop}`).toBe(position)
      expect(stopOf(position, columns), `position ${position}`).toBe(stop)
    })
  })

  it('spells the end of the circuit as an absence, not as the last column', () => {
    // The two are the same state, and spelling them the same way is what
    // stops them disagreeing: at the end the panel runs the whole circuit,
    // exactly as it did before this feature existed.
    expect(positionAt(4, 4)).toBeNull()
    expect(positionAt(3, 4)).toBe(2)
  })
})

describe('stepping', () => {
  it('moves one stop at a time in either direction', () => {
    expect(stepPosition(-1, 4, 1)).toBe(0)
    expect(stepPosition(0, 4, 1)).toBe(1)
    expect(stepPosition(1, 4, -1)).toBe(0)
  })

  it('reaches the end and stops dead there', () => {
    expect(stepPosition(2, 4, 1)).toBeNull()
    expect(stepPosition(null, 4, 1)).toBeNull()
    expect(stepPosition(null, 4, 5)).toBeNull()
  })

  it('reaches the start and stops dead there', () => {
    expect(stepPosition(0, 4, -1)).toBe(-1)
    expect(stepPosition(-1, 4, -1)).toBe(-1)
    expect(stepPosition(null, 4, -9)).toBe(-1)
  })

  it('walks a four-column circuit in exactly five steps', () => {
    // The walk playback makes, start to finish. It ends at the end and not
    // one stop short of it, and not one stop past it either.
    let position: TimelinePosition = -1
    const walked: TimelinePosition[] = [position]
    for (let step = 0; step < 4; step++) {
      position = stepPosition(position, 4, 1)
      walked.push(position)
    }
    expect(walked).toEqual([-1, 0, 1, 2, null])
  })
})

describe('a circuit that changes under the bar', () => {
  it('keeps a position the shorter circuit still has', () => {
    // The loop the feature exists for: park on column 1, edit the gate there,
    // and stay parked so the state at that column can be watched changing.
    expect(clampPosition(1, 12)).toBe(1)
    expect(clampPosition(1, 4)).toBe(1)
    expect(clampPosition(-1, 4)).toBe(-1)
  })

  it('clamps a position the circuit no longer reaches', () => {
    // Deleting the tail of a twelve-column circuit down to four leaves a
    // parked position of 9 naming a cut that does not exist. Kept, it would
    // caption the final state "after column 9"; clamped, it lands on the end,
    // which is where the circuit now finishes.
    expect(clampPosition(9, 4)).toBeNull()
    expect(clampPosition(3, 4)).toBeNull()
    expect(clampPosition(2, 4)).toBe(2)
  })

  it('is the clamp, not a reset', () => {
    // The distinction the whole policy turns on: an edit that leaves the
    // position reachable must leave it alone. A reset would send the reader
    // back to the end of the circuit on every keystroke.
    const parked: TimelinePosition = 2
    expect(clampPosition(parked, 12)).toBe(parked)
    expect(clampPosition(parked, 5)).toBe(parked)
  })

  it('restores the position when the circuit grows back', () => {
    // Clamping on read rather than on write is what makes undo whole: the
    // stored position outlives the shortened circuit, so restoring the
    // circuit restores where the reader was standing in it.
    const stored: TimelinePosition = 9
    expect(clampPosition(stored, 4)).toBeNull()
    expect(clampPosition(stored, 12)).toBe(9)
  })
})

describe('the length of a circuit', () => {
  it('counts the columns the operations occupy', () => {
    expect(timelineLength(ofLength(6))).toBe(6)
    expect(timelineLength(emptyCircuit(3))).toBe(0)
  })

  it('counts empty instants inside the circuit', () => {
    // A gap between two gates is an instant in which nothing happens, and it
    // is still an instant: the engine runs the columns in order and the
    // scrubber offers every one of them.
    const gapped = parseCircuit({
      schemaVersion: 1,
      qubits: 1,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'x', targets: [0], column: 9 },
      ],
    })
    expect(timelineLength(gapped)).toBe(10)
  })
})
