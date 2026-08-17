import { describe, expect, it } from 'vitest'
import {
  CIRCUIT_SCHEMA_VERSION,
  expandCircuit,
  type Circuit,
} from '@qsim/schema'
import { circuitUnitary, unitaryFidelity } from '@qsim/core'

import { decomposeCircuit } from './decompose.js'
import { isBasisGate, isPassthrough } from './basis.js'
import { TranspileRefusal } from './refusal.js'
import { bellPair, chain, gateCircuit, sequence } from './testing/circuits.js'

const gatesOf = (circuit: Circuit): string[] =>
  circuit.operations.map((operation) => operation.gate)

const pulsesOf = (circuit: Circuit): number =>
  circuit.operations.filter((op) => op.gate === 'sx' || op.gate === 'x').length

describe('fusion', () => {
  it('cancels two Hadamards to nothing', () => {
    const circuit = sequence(1, 0, [
      { gate: 'h', targets: [0] },
      { gate: 'h', targets: [0] },
    ])
    expect(decomposeCircuit(circuit).circuit.operations).toHaveLength(0)
  })

  it('cancels a gate against its own inverse', () => {
    for (const [gate, inverse] of [
      ['s', 'sdg'],
      ['t', 'tdg'],
      ['x', 'x'],
    ] as const) {
      const circuit = sequence(1, 0, [
        { gate, targets: [0] },
        { gate: inverse, targets: [0] },
      ])
      expect(decomposeCircuit(circuit).circuit.operations).toHaveLength(0)
    }
  })

  it('adds diagonal angles rather than routing them through a matrix', () => {
    // s then t is one frame change of 3pi/4, and it has to come out as the
    // *exact* double that `3 * Math.PI / 4` produces or `formatAngle` prints a
    // decimal — it recognises the pi form by === and by nothing else.
    const diagonal = sequence(1, 0, [
      { gate: 's', targets: [0] },
      { gate: 't', targets: [0] },
    ])
    const folded = decomposeCircuit(diagonal).circuit
    expect(gatesOf(folded)).toEqual(['rz'])
    expect(folded.operations[0]?.params?.[0]).toBe(Math.PI / 2 + Math.PI / 4)
    expect(folded.operations[0]?.params?.[0]).toBe((3 * Math.PI) / 4)
  })

  it('folds a run when the fold removes a pulse', () => {
    // h then s then h is three pulses' worth if left alone and one when
    // folded, so it folds.
    const worthIt = sequence(1, 0, [
      { gate: 'h', targets: [0] },
      { gate: 's', targets: [0] },
      { gate: 'h', targets: [0] },
    ])
    expect(pulsesOf(decomposeCircuit(worthIt).circuit)).toBeLessThan(2)
  })

  it('leaves a single gate alone, so its exact angles survive', () => {
    const single = decomposeCircuit(
      sequence(1, 0, [{ gate: 'h', targets: [0] }])
    )
    expect(single.circuit.operations.map((op) => op.params?.[0])).toEqual([
      Math.PI / 2,
      undefined,
      Math.PI / 2,
    ])
  })

  it('never folds across a cz', () => {
    const { circuit } = decomposeCircuit(bellPair())
    const positions = gatesOf(circuit)
    expect(positions).toContain('cz')
    // The two Hadamards of the CNOT sit either side of the cz and cannot be
    // combined; if they had been, the circuit would be wrong.
    const source = bellPair()
    const fidelity = unitaryFidelity(
      circuitUnitary(stripMeasurements(source)),
      circuitUnitary(stripMeasurements(circuit))
    )
    expect(1 - fidelity).toBeLessThan(1e-10)
  })

  it('never folds a gate that carries a classical condition', () => {
    const circuit = sequence(2, 1, [
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'h', targets: [1], condition: { clbit: 0, equals: 1 } },
      { gate: 'h', targets: [1], condition: { clbit: 0, equals: 1 } },
    ])
    const { circuit: decomposed } = decomposeCircuit(circuit)
    const conditioned = decomposed.operations.filter(
      (operation) => operation.condition !== undefined
    )
    // Two conditioned Hadamards are six conditioned basis gates. Folding them
    // to nothing would be right for the state and wrong for the condition,
    // which is why the pass declines to try.
    expect(conditioned).toHaveLength(6)
    for (const operation of conditioned) {
      expect(operation.condition).toEqual({ clbit: 0, equals: 1 })
    }
  })
})

function stripMeasurements(circuit: Circuit): Circuit {
  return {
    ...circuit,
    clbits: 0,
    operations: circuit.operations
      .filter((operation) => !isPassthrough(operation.gate))
      .map((operation) => {
        const {
          clbitTargets: _bits,
          condition: _condition,
          ...rest
        } = operation
        return rest
      }),
  }
}

describe('what passes through untouched', () => {
  it('keeps barrier, reset and measure with their wires and bits', () => {
    const circuit = sequence(2, 2, [
      { gate: 'barrier', targets: [0, 1] },
      { gate: 'reset', targets: [1] },
      { gate: 'measure', targets: [0], clbitTargets: [1] },
    ])
    const { circuit: decomposed } = decomposeCircuit(circuit)
    expect(gatesOf(decomposed).sort()).toEqual(['barrier', 'measure', 'reset'])
    const measure = decomposed.operations.find((op) => op.gate === 'measure')
    expect(measure?.targets).toEqual([0])
    expect(measure?.clbitTargets).toEqual([1])
    const barrier = decomposed.operations.find((op) => op.gate === 'barrier')
    expect(barrier?.targets).toEqual([0, 1])
  })

  it('reports which logical qubits are measured', () => {
    const { measured } = decomposeCircuit(chain())
    expect(measured).toEqual([0, 1, 2])
  })
})

describe('custom gates', () => {
  it('are expanded before anything else happens', () => {
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'b0', gate: 'h', targets: [0], column: 0 },
            { id: 'b1', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
      },
      operations: [{ id: 'o0', gate: 'bell', targets: [0, 1], column: 0 }],
    }
    const { circuit: decomposed, twoQubitGates } = decomposeCircuit(circuit)
    expect(twoQubitGates).toBe(1)
    for (const gate of gatesOf(decomposed)) {
      expect(isBasisGate(gate) || isPassthrough(gate)).toBe(true)
    }
    // The engine refuses a custom gate by name, which is the point: it only
    // ever sees primitives. So the comparison is against the expansion.
    const fidelity = unitaryFidelity(
      circuitUnitary(expandCircuit(circuit).circuit),
      circuitUnitary(decomposed)
    )
    expect(1 - fidelity).toBeLessThan(1e-10)
  })
})

describe('scheduling', () => {
  const shareNothing = (circuit: Circuit): void => {
    const seen = new Map<number, Set<string>>()
    for (const operation of circuit.operations) {
      const wires = seen.get(operation.column) ?? new Set<string>()
      for (const qubit of operation.targets) {
        expect(wires.has(`q${String(qubit)}`)).toBe(false)
        wires.add(`q${String(qubit)}`)
      }
      for (const control of operation.controls ?? []) {
        const qubit = typeof control === 'number' ? control : control.qubit
        expect(wires.has(`q${String(qubit)}`)).toBe(false)
        wires.add(`q${String(qubit)}`)
      }
      seen.set(operation.column, wires)
    }
  }

  it('never puts two operations that share a qubit in one column', () => {
    for (const circuit of [
      bellPair(),
      chain(),
      gateCircuit(3, 'ccx', [2], { controls: [0, 1] }),
    ]) {
      shareNothing(decomposeCircuit(circuit).circuit)
    }
  })

  it('keeps a condition after the measurement that fills its bit', () => {
    const circuit = sequence(2, 1, [
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'x', targets: [1], condition: { clbit: 0, equals: 1 } },
    ])
    const { circuit: decomposed } = decomposeCircuit(circuit)
    const measure = decomposed.operations.find((op) => op.gate === 'measure')
    const conditioned = decomposed.operations.find(
      (op) => op.condition !== undefined
    )
    expect((measure?.column ?? 0) < (conditioned?.column ?? 0)).toBe(true)
  })

  it('gives every operation a unique id', () => {
    const { circuit } = decomposeCircuit(chain())
    const ids = circuit.operations.map((operation) => operation.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('the interaction summary', () => {
  it('counts cz uses per logical pair, heaviest first', () => {
    const circuit = sequence(3, 0, [
      { gate: 'swap', targets: [0, 1] },
      { gate: 'cx', targets: [2], controls: [1] },
    ])
    const { interactions, twoQubitGates } = decomposeCircuit(circuit)
    expect(twoQubitGates).toBe(4)
    expect(interactions[0]).toMatchObject({ a: 0, b: 1, count: 3 })
    expect(interactions[1]).toMatchObject({ a: 1, b: 2, count: 1 })
  })

  it('counts pulses per logical qubit and ignores the free rotations', () => {
    const { pulses } = decomposeCircuit(
      sequence(2, 0, [
        { gate: 'h', targets: [0] },
        { gate: 'rz', targets: [1], params: [0.3] },
      ])
    )
    expect(pulses[0]).toBe(1)
    expect(pulses[1]).toBe(0)
  })
})

describe('what it refuses', () => {
  const refusalOf = (run: () => unknown): TranspileRefusal => {
    try {
      run()
    } catch (cause) {
      if (cause instanceof TranspileRefusal) return cause
      throw cause
    }
    throw new Error('expected a refusal')
  }

  it('refuses a gate that is not in the catalog', () => {
    const circuit = sequence(1, 0, [{ gate: 'fredkinish', targets: [0] }])
    expect(refusalOf(() => decomposeCircuit(circuit)).code).toBe(
      'unsupported-gate'
    )
  })

  it('refuses an angle the circuit never gave a value', () => {
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [
        { id: 'o0', gate: 'rz', targets: [0], params: ['missing'], column: 0 },
      ],
    }
    expect(refusalOf(() => decomposeCircuit(circuit)).code).toBe(
      'unsupported-parameter'
    )
  })

  it('refuses more than two controls, and says how many it saw', () => {
    const refusal = refusalOf(() =>
      decomposeCircuit(gateCircuit(4, 'x', [3], { controls: [0, 1, 2] }))
    )
    expect(refusal.code).toBe('too-many-controls')
    expect(refusal.detail.controls).toBe(3)
    expect(refusal.detail.limit).toBe(2)
  })
})
