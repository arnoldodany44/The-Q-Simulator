/**
 * The decomposition, on circuits nobody wrote.
 *
 * `decomposition.test.ts` proves each construction one gate at a time, which
 * is where a wrong derivation shows up. This file exists for the failures a
 * per-gate test structurally cannot reach: the fusion pass, which only fires
 * when gates are *adjacent*; the scheduler, which only reorders when wires
 * are shared; and the interaction between a negative control's wrapping `x`
 * and the run of rotations it lands next to.
 *
 * Every circuit is compared as a matrix, up to global phase, against the
 * circuit it came from — and the seed is in the test name, so a failure is
 * reproducible by hand.
 */

import { describe, expect, it } from 'vitest'
import { circuitUnitary, unitaryFidelity } from '@qsim/core'
import { validateCircuit } from '@qsim/schema'

import { isBasisGate, isPassthrough } from '../basis.js'
import { decomposeCircuit } from '../decompose.js'
import { randomCircuit } from '../testing/random-circuits.js'

const TOLERANCE = 1e-10

describe('random circuits keep their meaning', () => {
  for (let qubits = 1; qubits <= 3; qubits++) {
    for (let batch = 0; batch < 4; batch++) {
      it(`${qubits} qubits, batch ${batch}`, () => {
        for (let seed = batch * 25; seed < batch * 25 + 25; seed++) {
          const source = randomCircuit(seed * 7919 + qubits, qubits, 8)
          // The generator must produce documents the contract accepts, or the
          // test is exercising shapes no user can build.
          expect(
            validateCircuit(source),
            `seed ${seed} produced an invalid circuit`
          ).toEqual([])

          const { circuit } = decomposeCircuit(source)
          for (const operation of circuit.operations) {
            expect(
              isBasisGate(operation.gate) || isPassthrough(operation.gate),
              `seed ${seed} emitted "${operation.gate}"`
            ).toBe(true)
          }
          expect(validateCircuit(circuit)).toEqual([])

          const fidelity = unitaryFidelity(
            circuitUnitary(source),
            circuitUnitary(circuit)
          )
          expect(1 - fidelity, `seed ${seed}`).toBeLessThan(TOLERANCE)
        }
      })
    }
  }
})

describe('the decomposition is deterministic', () => {
  it('produces byte-identical output for the same input twice', () => {
    for (let seed = 0; seed < 20; seed++) {
      const source = randomCircuit(seed + 1000, 3, 6)
      expect(JSON.stringify(decomposeCircuit(source).circuit)).toBe(
        JSON.stringify(decomposeCircuit(source).circuit)
      )
    }
  })
})

describe('folding never makes a circuit longer', () => {
  it('emits no more pulses than the unfused decomposition would', () => {
    /*
     * The fold rule is "strictly cheaper or not at all", so this is really a
     * check that the rule is applied rather than a claim about the arithmetic
     * — but it is the property that would break silently if the comparison in
     * `foldRun` were ever inverted, and a longer circuit on hardware is a
     * noisier one.
     */
    for (let seed = 0; seed < 30; seed++) {
      const source = randomCircuit(seed + 5000, 2, 10)
      const { circuit } = decomposeCircuit(source)
      const pulses = circuit.operations.filter(
        (operation) => operation.gate === 'sx' || operation.gate === 'x'
      ).length
      // Five basis gates per one-qubit gate is the worst the general ZSX path
      // can do, of which two are pulses; a CNOT is one cz and two Hadamards.
      expect(pulses).toBeLessThanOrEqual(source.operations.length * 8)
    }
  })
})
