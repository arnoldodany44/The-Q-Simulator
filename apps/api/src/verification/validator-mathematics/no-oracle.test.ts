/**
 * The submit route must not be a target-extraction oracle — risk 5, §3.6.
 *
 * The target is the one thing the server holds and the client does not, and a
 * fidelity is a measurement of it. §3.6 allows that measurement because it is
 * legitimate feedback on the reader's *own answer*; what it never allowed is a
 * caller choosing an arbitrary probe circuit and reading the answer back.
 *
 * The validator used to permit exactly that: `allowedGates` decided `passed`
 * and nothing else, so a circuit built from gates the challenge forbids was
 * still simulated, still compared, and still answered with a full-precision
 * Float64 fidelity. That is enough to run textbook state tomography. This file
 * runs the attack — the same ten probes that recovered `ghz-three` exactly —
 * and requires it to come back with nothing.
 *
 * It also checks the property the attack rests on, rather than only the
 * attack: no verdict for a circuit using a disallowed gate carries a fidelity
 * or a diagnosis, on any of the nine seeded challenges.
 */

import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { CHALLENGES } from '../../challenges/catalog.js'
import { targetFor } from '../../challenges/seed.js'
import { parseChallengeTarget } from '../../challenges/target.js'
import { judgeSubmission } from '../../challenges/validate.js'

/** A challenge's seeded rules and target, exactly as the route reads them. */
function seeded(slug: string) {
  const definition = CHALLENGES.find((entry) => entry.slug === slug)
  if (definition === undefined) throw new Error(`No challenge "${slug}".`)
  const stored = targetFor(definition)
  return {
    definition,
    target: parseChallengeTarget({
      slug,
      targetType: stored.targetType,
      targetData: stored.targetData,
    }),
    constraints: {
      qubitCount: stored.qubitCount,
      allowedGates: definition.allowedGates,
      maxGates: definition.maxGates,
      fidelityThreshold: definition.fidelityThreshold,
    },
  }
}

function probe(qubits: number, operations: Operation[]): Circuit {
  return parseCircuit({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  })
}

/** The bits of `index` written as `x` gates, or one `i` for the zero index. */
function basisProbe(qubits: number, index: number): Circuit {
  const operations: Operation[] = []
  for (let qubit = 0; qubit < qubits; qubit++) {
    if (((index >> qubit) & 1) === 1) {
      operations.push({
        id: `x${String(qubit)}`,
        gate: 'x',
        targets: [qubit],
        column: 0,
      })
    }
  }
  if (operations.length === 0) {
    operations.push({ id: 'i0', gate: 'i', targets: [0], column: 0 })
  }
  return probe(qubits, operations)
}

describe('the eight basis probes that used to read a target out', () => {
  it('answer nothing about ghz-three', () => {
    const { target, constraints } = seeded('ghz-three')
    const readings: number[] = []

    for (let index = 0; index < 8; index++) {
      const verdict = judgeSubmission({
        slug: 'ghz-three',
        constraints,
        target,
        circuit: basisProbe(3, index),
      })
      readings.push(verdict.fidelity)

      const codes = verdict.feedback.map((entry) => entry.code)
      expect(codes).toContain('not-scored')
      // Every diagnosis is a comparison against the target, so none may be
      // here: the comparison is the thing being refused.
      expect(codes).not.toContain('solved')
      expect(codes).not.toContain('nearly-there')
      expect(codes).not.toContain('relative-phase')
      expect(codes).not.toContain('too-few-outcomes')
      expect(codes).not.toContain('too-many-outcomes')
      expect(codes).not.toContain('entanglement-missing')
      expect(codes).not.toContain('entanglement-unwanted')
    }

    /*
     * |a_0|² and |a_7|² are both ½ in the real target. The attack reads them
     * straight off this list, so a constant list is the property that matters:
     * there is no |a_i|² in it at all.
     */
    expect(readings).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('answer nothing about the interference probes either', () => {
    // The second half of the attack: (|0⟩ + e^{iθ}|7⟩)/√2 for two angles,
    // whose fidelities give the real and imaginary parts of the overlap.
    const { target, constraints } = seeded('ghz-three')
    for (const theta of [0, Math.PI / 2]) {
      const verdict = judgeSubmission({
        slug: 'ghz-three',
        constraints,
        target,
        circuit: probe(3, [
          { id: 'h', gate: 'h', targets: [0], column: 0 },
          { id: 'p', gate: 'p', targets: [0], params: [theta], column: 1 },
          { id: 'c1', gate: 'cx', targets: [1], controls: [0], column: 2 },
          { id: 'c2', gate: 'cx', targets: [2], controls: [0], column: 3 },
        ]),
      })
      expect(verdict.fidelity).toBe(0)
      expect(verdict.feedback.map((entry) => entry.code)).toContain(
        'not-scored'
      )
    }
  })
})

describe('allowedGates bounds the probe and not only the answer', () => {
  for (const definition of CHALLENGES) {
    it(definition.slug, () => {
      if (definition.allowedGates.length === 0) return
      const { target, constraints } = seeded(definition.slug)

      /*
       * One gate the challenge does not allow, chosen from the palette rather
       * than from the challenge — the point is that ANY foreign gate is
       * refused, not that a particular one is.
       */
      const foreign = ['y', 'sx', 'p', 'x', 'z'].find(
        (gate) => !definition.allowedGates.includes(gate)
      )
      expect(foreign, `${definition.slug} allows everything`).toBeDefined()

      const verdict = judgeSubmission({
        slug: definition.slug,
        constraints,
        target,
        circuit: probe(constraints.qubitCount, [
          {
            id: 'a',
            gate: foreign as string,
            targets: [0],
            ...(foreign === 'p' ? { params: [0.3] } : {}),
            column: 0,
          },
        ]),
      })

      expect(verdict.passed).toBe(false)
      expect(verdict.fidelity).toBe(0)
      const codes = verdict.feedback.map((entry) => entry.code)
      expect(codes).toContain('not-scored')
      expect(codes).toContain('gate-not-allowed')
    })
  }
})

describe('what refusing does NOT take away', () => {
  it('still says "right, and too long" for a legal circuit over budget', () => {
    /*
     * The pedagogy the old arrangement was written for, kept intact. A budget
     * violation is not a gate violation: the circuit is built from the tools
     * the puzzle handed out, so using them is the intended activity and the
     * fidelity is the reader's own reading of their own answer.
     */
    const { target, constraints } = seeded('superposition')
    const verdict = judgeSubmission({
      slug: 'superposition',
      constraints: { ...constraints, maxGates: 0 },
      target,
      circuit: probe(1, [{ id: 'a', gate: 'h', targets: [0], column: 0 }]),
    })
    expect(verdict.fidelity).toBeCloseTo(1, 9)
    expect(verdict.passed).toBe(false)
    const codes = verdict.feedback.map((entry) => entry.code)
    expect(codes).toContain('gate-budget-exceeded')
    expect(codes).toContain('solved')
  })
})
