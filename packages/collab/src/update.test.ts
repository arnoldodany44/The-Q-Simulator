import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { META_SCHEMA_VERSION, circuitRoots } from './document.js'
import { MAX_UPDATE_BYTES, applyCircuitUpdate } from './update.js'
import { documentOf } from './write.js'

const remote = { peer: 'remote' }

const circuit: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
}

describe('applyCircuitUpdate', () => {
  it('applies an update and answers with the projection', () => {
    const source = documentOf(circuit)
    const target = new Y.Doc()

    const result = applyCircuitUpdate(target, Y.encodeStateAsUpdate(source), {
      origin: remote,
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.projection.circuit).toEqual(circuit)
  })

  it('carries the caller’s origin, so a relay can avoid echoing', () => {
    const source = documentOf(circuit)
    const target = new Y.Doc()
    const origins: unknown[] = []
    target.on('update', (_update: Uint8Array, origin: unknown) => {
      origins.push(origin)
    })

    applyCircuitUpdate(target, Y.encodeStateAsUpdate(source), {
      origin: remote,
    })

    expect(origins).toEqual([remote])
  })

  it('refuses an oversized update without decoding it', () => {
    const target = new Y.Doc()
    let updates = 0
    target.on('update', () => {
      updates += 1
    })

    const result = applyCircuitUpdate(
      target,
      new Uint8Array(MAX_UPDATE_BYTES + 1),
      { origin: remote }
    )

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    expect(updates).toBe(0)
  })

  it('honours a tighter ceiling from the caller', () => {
    const source = documentOf(circuit)

    const result = applyCircuitUpdate(
      new Y.Doc(),
      Y.encodeStateAsUpdate(source),
      { origin: remote, maxBytes: 4 }
    )

    expect(result).toEqual({ ok: false, reason: 'too-large' })
  })

  it('reports bytes it cannot decode instead of throwing', () => {
    // A peer sending these is broken or hostile, and the relay's answer is to
    // close the connection — but it may not be an unhandled exception on the
    // way there, because that is one client taking the process down.
    const result = applyCircuitUpdate(
      new Y.Doc(),
      new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]),
      { origin: remote }
    )

    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses a document written at a schema version it does not know', () => {
    // Read as a v1 circuit it would be a confident misreading, and this peer
    // would then write v1 fields back into somebody's v2 document.
    const source = documentOf(circuit)
    circuitRoots(source).meta.set(META_SCHEMA_VERSION, 2)

    const result = applyCircuitUpdate(
      new Y.Doc(),
      Y.encodeStateAsUpdate(source),
      { origin: remote }
    )

    expect(result).toEqual({ ok: false, reason: 'incompatible-version' })
  })

  it('applies a hostile update and still answers with a legal circuit', () => {
    // The property that makes a relay possible at all: an update cannot be
    // un-applied, so validity is enforced on the read. The document ends up
    // holding a gate that does not exist; the projection does not.
    const source = documentOf(circuit)
    circuitRoots(source).operations.set(
      'x-1',
      new Y.Map<unknown>([
        ['id', 'op_9'],
        ['gate', 'not-a-gate'],
        ['targets', [1]],
        ['column', 0],
        ['seq', 9],
      ])
    )

    const result = applyCircuitUpdate(
      new Y.Doc(),
      Y.encodeStateAsUpdate(source),
      { origin: remote }
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.projection.circuit.operations).toEqual(
      circuit.operations
    )
    expect(result.ok && result.projection.deferred[0]?.reason).toBe('invalid')
  })
})
