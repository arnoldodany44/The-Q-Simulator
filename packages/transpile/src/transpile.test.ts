import { describe, expect, it } from 'vitest'
import { circuitUnitary, unitaryFidelity } from '@qsim/core'
import { validateCircuit } from '@qsim/schema'

import { deviceGraph } from './device.js'
import { safeTranspile, transpile } from './transpile.js'
import { TranspileRefusal } from './refusal.js'
import { HERON } from './testing/heron.js'
import { bellPair, chain, sequence, star } from './testing/circuits.js'

const heron = deviceGraph(HERON)

describe('what a plan carries', () => {
  const plan = transpile(bellPair(), heron, { title: 'Bell pair' })

  it('names the device and the calibration it was placed against', () => {
    expect(plan.device).toBe('ibm_marrakesh')
    expect(plan.calibrated).toBe(true)
    expect(plan.calibratedAt).toBe(HERON.calibratedAt)
  })

  it('gives both circuits as documents the contract accepts', () => {
    expect(validateCircuit(plan.basis)).toEqual([])
    expect(validateCircuit(plan.placed)).toEqual([])
    expect(plan.basis.qubits).toBe(2)
    expect(plan.placed.qubits).toBe(2)
  })

  it('keeps the placed circuit inside the contract s register ceiling', () => {
    // Compact rather than device-wide: a 156-qubit document would not
    // validate, and a circuit that cannot be validated cannot be simulated
    // either, which is what makes the placed program checkable at all.
    expect(plan.placed.qubits).toBeLessThan(28)
    expect(plan.physicalQubits.some((qubit) => qubit > 27)).toBe(true)
  })

  it('lines the layout up with the compact circuit', () => {
    for (const [logical, physical] of plan.layout.entries()) {
      const compact = plan.physicalQubits.indexOf(physical)
      expect(compact).toBeGreaterThanOrEqual(0)
      // Logical qubit `logical` is qubit `compact` of `plan.placed`.
      expect(plan.physicalQubits[compact]).toBe(plan.layout[logical])
    }
  })

  it('counts pulses apart from the free frame changes', () => {
    // A Bell pair is three Hadamards' worth of pulse — one for the h, two for
    // the CNOT — and one cz.
    expect(plan.stats.pulses).toBe(3)
    expect(plan.stats.twoQubitGates).toBe(1)
    expect(plan.stats.frameChanges).toBeGreaterThan(0)
    expect(plan.stats.operations).toBe(
      plan.stats.pulses + plan.stats.frameChanges + plan.stats.twoQubitGates + 2 // the two measurements
    )
  })

  it('summarises the decomposition without repeating the circuit', () => {
    expect(plan.decomposition.measured).toEqual([0, 1])
    expect(plan.decomposition.interactions).toEqual([
      { a: 0, b: 1, count: 1, operationIds: expect.any(Array) },
    ])
    expect(plan.decomposition.pulses).toHaveLength(2)
  })
})

describe('the placed circuit is the circuit', () => {
  it('is the source, renumbered, up to global phase', () => {
    for (const circuit of [bellPair(), chain()]) {
      const plan = transpile(circuit, heron)
      // Compare the *basis* circuit, which is on the source's own numbering,
      // so this is a statement about the decomposition. The renumbering is
      // covered by `verification/endianness.test.ts`, which compares
      // distributions rather than matrices because a measured circuit is not
      // a matrix.
      const unitaryOf = (input: typeof circuit) => ({
        ...input,
        clbits: 0,
        operations: input.operations
          .filter((operation) => operation.gate !== 'measure')
          .map((operation) => {
            const { clbitTargets: _bits, ...rest } = operation
            return rest
          }),
      })
      const fidelity = unitaryFidelity(
        circuitUnitary(unitaryOf(circuit)),
        circuitUnitary(unitaryOf(plan.basis))
      )
      expect(1 - fidelity).toBeLessThan(1e-10)
    }
  })
})

describe('the measurement guard', () => {
  it('refuses a circuit that would return an empty register', () => {
    const nothing = sequence(2, 0, [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [0] },
    ])
    const outcome = safeTranspile(nothing, heron)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('no-measurement')
      expect(outcome.refusal.message).toContain('no state vector to read')
    }
  })

  it('can be waived for a circuit transpiled to be looked at', () => {
    const nothing = sequence(2, 0, [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [0] },
    ])
    expect(() =>
      transpile(nothing, heron, { requireMeasurement: false })
    ).not.toThrow()
  })
})

describe('safeTranspile', () => {
  it('answers a refusal rather than throwing one', () => {
    const outcome = safeTranspile(star(4), heron)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.refusal).toBeInstanceOf(TranspileRefusal)
  })

  it('lets a real error through, because a bug is not a refusal', () => {
    const broken = { ...bellPair(), qubits: 0 }
    // A circuit with no qubits is not something the transpiler refuses on
    // physical grounds; it is a document that never passed validation.
    expect(() => safeTranspile(broken, heron)).toThrow()
  })

  it('answers a value on the happy path', () => {
    const outcome = safeTranspile(bellPair(), heron)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value.qasm).toContain('cz')
  })
})

describe('a device with no calibration', () => {
  it('says so in the header instead of quoting a fidelity', () => {
    const bare = deviceGraph({
      name: 'topology-only',
      qubits: 4,
      coupling: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
        { a: 2, b: 3 },
      ],
    })
    const plan = transpile(bellPair(), bare)
    expect(plan.calibrated).toBe(false)
    expect(plan.qasm).toContain('No calibration was supplied')
    expect(plan.qasm).not.toContain('success probability')
  })
})
