/**
 * Do the three ceilings on one circuit agree with each other?
 *
 * A circuit passes three different limits on its way into a session, and they
 * were chosen in three files for three reasons:
 *
 *   - `MAX_CIRCUIT_JSON_BYTES` (256 KiB) — the largest circuit a *version* may
 *     be, enforced by `toCircuitJson` on every save.
 *   - `MAX_DOCUMENT_OPERATIONS` — the most operations a *document* will project,
 *     enforced by `projectCircuit`.
 *   - `MAX_COLLAB_STATE_BYTES` — the largest *session state* the relay will
 *     serve, seed or store.
 *
 * The two collaboration ceilings were originally justified by estimates of the
 * first, and both estimates were wrong in the same direction — they were *below*
 * what a saved circuit can be, which made truncation and refusal reachable for
 * an ordinary saved circuit rather than only for a hostile one:
 *
 *   - 4096 operations, on the estimate that "~3,300 operations fit in 256 KiB".
 *     About 4,780 do, so a circuit between those numbers joined a session and was
 *     handed back *shorter*, and a save from that session wrote the truncation
 *     into the head version and into `Circuit.gateCount`.
 *   - 512 KiB of state, on the reasoning "twice the 256 KiB a version may be". A
 *     Yjs state is about 2.3× the JSON, so a 229 KB circuit encoded to 526 KB and
 *     `collab:join` answered CIRCUIT_TOO_LARGE for a circuit every other feature
 *     handled.
 *
 * So this file measures instead of assuming, and the assertions now state the
 * property the three ceilings have to have: **no circuit a save accepts may be
 * one a session cannot carry.** Changing any of the three makes somebody read
 * this again rather than making a suite mysteriously red.
 *
 * No database, no socket, no Redis.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MAX_COLLAB_STATE_BYTES } from '@qsim/contract'
import {
  MAX_DOCUMENT_OPERATIONS,
  MAX_UPDATE_BYTES,
  documentOf,
  projectCircuit,
} from '@qsim/collab'
import { MAX_CIRCUIT_JSON_BYTES } from '@qsim/db'
import {
  CIRCUIT_SCHEMA_VERSION,
  MAX_QUBITS,
  validateCircuit,
  type Circuit,
  type Operation,
} from '@qsim/schema'

/** A legal circuit of `count` single-qubit gates, laid out without collisions. */
function dense(count: number): Circuit {
  const qubits = Math.min(MAX_QUBITS, 16)
  const operations: Operation[] = []
  for (let index = 0; index < count; index += 1) {
    operations.push({
      id: `op-${String(index)}`,
      gate: 'h',
      targets: [index % qubits],
      column: Math.floor(index / qubits),
    })
  }
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  }
}

const jsonBytes = (circuit: Circuit): number =>
  Buffer.byteLength(JSON.stringify(circuit), 'utf8')

const stateBytes = (circuit: Circuit): number =>
  Y.encodeStateAsUpdate(documentOf(circuit)).byteLength

/** The most operations of this shape that a single version may legally hold. */
function largestSaveable(): number {
  let count = 0
  for (let candidate = 1_000; candidate <= 8_000; candidate += 20) {
    if (jsonBytes(dense(candidate)) <= MAX_CIRCUIT_JSON_BYTES) count = candidate
    else break
  }
  return count
}

describe('the ceilings a circuit meets on its way into a session', () => {
  it('projects every operation of the largest circuit a version may hold', () => {
    const saveable = largestSaveable()
    const circuit = dense(saveable)
    expect(validateCircuit(circuit)).toStrictEqual([])
    expect(jsonBytes(circuit)).toBeLessThanOrEqual(MAX_CIRCUIT_JSON_BYTES)

    /*
     * The measurement that mattered: about 4,780 compact operations fit in a
     * version, not the ~3,300 the old constant was chosen against. The document
     * ceiling has to be above the measured figure, or the truncation below is
     * reachable by saving a circuit.
     */
    expect(saveable).toBeLessThan(MAX_DOCUMENT_OPERATIONS)

    const projection = projectCircuit(documentOf(circuit))
    expect(projection.overflow).toBe(0)
    expect(projection.circuit.operations).toHaveLength(saveable)
    expect(projection.circuit).toStrictEqual(circuit)
  })

  it('still truncates a document past the ceiling, which only a peer can build', () => {
    /*
     * The path is not gone, it is out of reach of the save surface: a document has
     * to be *grown* past the ceiling by a peer sending updates, because no circuit
     * anybody can save reaches it. Slots past the ceiling are counted and never
     * read, which is what bounds the work one projection costs.
     */
    const oversized = dense(MAX_DOCUMENT_OPERATIONS + 40)
    const projection = projectCircuit(documentOf(oversized))
    expect(projection.overflow).toBe(40)
    expect(projection.circuit.operations).toHaveLength(MAX_DOCUMENT_OPERATIONS)
    // And what comes out is still legal, which is the property the truncation
    // exists to preserve.
    expect(validateCircuit(projection.circuit)).toStrictEqual([])
  })

  it('serves a whole document at the ceiling the client will accept', () => {
    /*
     * `applyCircuitUpdate`'s default is `MAX_UPDATE_BYTES`, which the browser
     * bridge used to take for `receive` — while the relay sends whole states up to
     * `MAX_COLLAB_STATE_BYTES` in `collab:joined`. The bridge now passes the
     * relay's ceiling explicitly, and this is the measurement that says why it had
     * to: there are saveable circuits between the two figures.
     */
    let firstOverClientDefault = 0
    for (let count = 1_000; count <= 6_000; count += 20) {
      if (stateBytes(dense(count)) > MAX_UPDATE_BYTES) {
        firstOverClientDefault = count
        break
      }
    }
    expect(firstOverClientDefault).toBeGreaterThan(0)
    expect(firstOverClientDefault).toBeLessThan(largestSaveable())
    expect(MAX_UPDATE_BYTES).toBeLessThan(MAX_COLLAB_STATE_BYTES)
  })

  it('can seed a session for the largest circuit a save accepts', () => {
    /*
     * The Yjs encoding of a circuit is about 2.3× its JSON, so the state ceiling
     * has to be measured against that rather than reasoned about as a multiple of
     * the JSON ceiling. Every circuit a save accepts must fit, or `collab:join`
     * answers CIRCUIT_TOO_LARGE for a circuit the rest of the product handles.
     */
    const largest = dense(largestSaveable())
    expect(jsonBytes(largest)).toBeLessThanOrEqual(MAX_CIRCUIT_JSON_BYTES)
    expect(stateBytes(largest)).toBeLessThanOrEqual(MAX_COLLAB_STATE_BYTES)

    // With room left over for a session's worth of edits and tombstones on top,
    // which is what the ceiling is *for*.
    expect(stateBytes(largest) * 1.5).toBeLessThanOrEqual(
      MAX_COLLAB_STATE_BYTES
    )
  })
})
