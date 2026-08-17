/**
 * The catalog is the source of truth, and this file is what makes that true.
 *
 * Everything in this package that enumerates gates reads `GATES` rather than
 * listing them, so a gate added to the contract without a decomposition breaks
 * here — one test, with a name that says what to do — rather than in a user's
 * circuit at the moment they try to run it on hardware. `@qsim/qasm` keeps a
 * file of the same name for the same reason.
 */

import { describe, expect, it } from 'vitest'
import { GATES, type GateId } from '@qsim/schema'

import { BASIS_GATE_IDS, isBasisGate, isPassthrough } from './basis.js'
import { decomposableGateIds, decomposeCircuit } from './decompose.js'
import { eulerOf, isOneQubitCatalogId, oneQubitCatalogIds } from './euler.js'
import { gateCircuit } from './testing/circuits.js'

const ALL = Object.keys(GATES) as GateId[]

describe('every gate in the catalog is accounted for', () => {
  it('is either decomposable or structural, with nothing in between', () => {
    const decomposable = new Set(decomposableGateIds())
    for (const gate of ALL) {
      const structural = GATES[gate].category === 'structural'
      expect(decomposable.has(gate) !== structural, gate).toBe(true)
    }
  })

  it('has a passthrough for every structural gate and no others', () => {
    for (const gate of ALL) {
      expect(isPassthrough(gate), gate).toBe(
        GATES[gate].category === 'structural'
      )
    }
  })

  it('has an Euler row for every one-qubit gate', () => {
    for (const gate of oneQubitCatalogIds()) {
      expect(isOneQubitCatalogId(gate), gate).toBe(true)
      const params = Array.from({ length: GATES[gate].paramCount }, () => 0.3)
      expect(() => eulerOf(gate as never, params), gate).not.toThrow()
    }
  })

  it('decomposes every non-structural gate without refusing', () => {
    for (const gate of decomposableGateIds()) {
      const meta = GATES[gate]
      const arity = meta.arity as number
      const wires = arity + meta.controlCount
      const circuit = gateCircuit(
        wires,
        gate,
        Array.from({ length: arity }, (_unused, index) => index),
        {
          ...(meta.controlCount === 0
            ? {}
            : {
                controls: Array.from(
                  { length: meta.controlCount },
                  (_unused, index) => arity + index
                ),
              }),
          params: Array.from({ length: meta.paramCount }, () => 0.4),
        }
      )
      const { circuit: decomposed } = decomposeCircuit(circuit)
      for (const operation of decomposed.operations) {
        expect(
          isBasisGate(operation.gate) || isPassthrough(operation.gate),
          `${gate} emitted ${operation.gate}`
        ).toBe(true)
      }
    }
  })
})

describe('the basis is a subset of what the hardware runs', () => {
  it('emits only gates a Heron backend reports', () => {
    // `i` is the contract's name and `id` is the backend's; the serialiser
    // renames it, which is why the check allows both spellings of that one.
    const native = new Set(['cz', 'id', 'rx', 'rz', 'rzz', 'sx', 'x'])
    for (const gate of BASIS_GATE_IDS) {
      expect(native.has(gate === 'i' ? 'id' : gate), gate).toBe(true)
    }
  })

  it('leaves the fractional gates alone', () => {
    // rx and rzz are in the reported basis and are served only to a session
    // that opted in. Emitting them would trade a program that always runs for
    // one that sometimes does.
    expect(BASIS_GATE_IDS).not.toContain('rx')
    expect(BASIS_GATE_IDS).not.toContain('rzz')
  })
})
