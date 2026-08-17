import { describe, expect, it } from 'vitest'

import { deviceGraph } from './device.js'
import { deviceTargetFromIbm } from './ibm.js'

/**
 * A miniature of the documents the Quantum API answers with, keeping the field
 * names and the nesting exactly as they arrive — including the part that
 * matters most, which is that `coupling_map` lists every pair twice, once per
 * direction, and `gates` lists a `cz` twice for the same reason.
 */
const configuration = {
  backend_name: 'ibm_tiny',
  n_qubits: 3,
  basis_gates: ['cz', 'id', 'rx', 'rz', 'rzz', 'sx', 'x'],
  coupling_map: [
    [0, 1],
    [1, 0],
    [1, 2],
    [2, 1],
  ],
}

const properties = {
  last_update_date: '2026-08-14T15:04:18Z',
  qubits: [
    [
      { name: 'T1', unit: 'us', value: 213.7 },
      { name: 'readout_error', unit: '', value: 0.0035 },
    ],
    [{ name: 'readout_error', unit: '', value: 0.5 }],
    [{ name: 'readout_error', unit: '', value: 0.01 }],
  ],
  gates: [
    {
      gate: 'sx',
      qubits: [0],
      parameters: [{ name: 'gate_error', value: 0.0002 }],
    },
    { gate: 'sx', qubits: [1], parameters: [{ name: 'gate_error', value: 1 }] },
    {
      gate: 'sx',
      qubits: [2],
      parameters: [{ name: 'gate_error', value: 0.0004 }],
    },
    { gate: 'rz', qubits: [0], parameters: [{ name: 'gate_error', value: 0 }] },
    {
      gate: 'cz',
      qubits: [0, 1],
      parameters: [{ name: 'gate_error', value: 0.003 }],
    },
    {
      gate: 'cz',
      qubits: [1, 0],
      parameters: [{ name: 'gate_error', value: 0.003 }],
    },
    {
      gate: 'cz',
      qubits: [1, 2],
      parameters: [{ name: 'gate_error', value: 0.009 }],
    },
    {
      gate: 'cz',
      qubits: [2, 1],
      parameters: [{ name: 'gate_error', value: 0.009 }],
    },
  ],
}

describe('deviceTargetFromIbm', () => {
  const target = deviceTargetFromIbm(configuration, properties, {
    queueLength: 5,
  })

  it('folds the two directions of a pair into one undirected edge', () => {
    expect(target.coupling).toEqual([
      { a: 0, b: 1, error: 0.003 },
      { a: 1, b: 2, error: 0.009 },
    ])
  })

  it('takes the one-qubit error from sx, which is the calibrated pulse', () => {
    expect(target.qubitProperties?.[0]).toEqual({
      gateError: 0.0002,
      readoutError: 0.0035,
    })
  })

  it('carries the calibration timestamp and the queue depth', () => {
    // Queue depth is the difference between a result today and a result next
    // month: the three backends this account can see differ by four orders of
    // magnitude, so it belongs beside the device rather than in a log line.
    expect(target.calibratedAt).toBe('2026-08-14T15:04:18Z')
    expect(target.queueLength).toBe(5)
  })

  it('keeps the backend s own basis list, so it can be checked', () => {
    expect(target.basisGates).toEqual(configuration.basis_gates)
    expect(() => deviceGraph(target)).not.toThrow()
  })

  it('excludes the qubit whose sx calibration failed, and its pairs', () => {
    const graph = deviceGraph(target)
    expect(graph.excludedQubits).toEqual([1])
    expect(graph.edges).toHaveLength(0)
    expect(graph.usableQubits).toEqual([0, 2])
  })
})

describe('deviceTargetFromIbm on partial input', () => {
  it('works with a configuration and no properties at all', () => {
    const target = deviceTargetFromIbm(configuration)
    expect(target.qubitProperties).toBeUndefined()
    expect(target.coupling).toEqual([
      { a: 0, b: 1 },
      { a: 1, b: 2 },
    ])
    expect(deviceGraph(target).calibrated).toBe(false)
  })

  it('leaves an unknown error undefined rather than calling it zero', () => {
    // Zero would claim a perfect gate, and the placement search would then
    // prefer exactly the qubits it knows least about.
    const target = deviceTargetFromIbm(configuration, {
      ...properties,
      gates: [],
    })
    expect(target.coupling[0]?.error).toBeUndefined()
    expect(target.qubitProperties?.[0]?.gateError).toBeUndefined()
    expect(target.qubitProperties?.[0]?.readoutError).toBe(0.0035)
  })

  it('survives an empty document without inventing a device', () => {
    const target = deviceTargetFromIbm({})
    expect(target.name).toBe('unknown')
    expect(target.qubits).toBe(0)
    expect(target.coupling).toEqual([])
    expect(() => deviceGraph(target)).toThrowError(/reports 0 qubits/)
  })

  it('ignores a non-numeric or non-finite value', () => {
    const target = deviceTargetFromIbm(configuration, {
      gates: [
        {
          gate: 'cz',
          qubits: [0, 1],
          parameters: [{ name: 'gate_error', value: Number.NaN }],
        },
      ],
    })
    expect(target.coupling[0]?.error).toBeUndefined()
  })
})
