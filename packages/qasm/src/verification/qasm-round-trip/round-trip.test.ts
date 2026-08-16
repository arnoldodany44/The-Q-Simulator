/**
 * The round trip, judged against a simulator that shares no code with it.
 *
 * `import/roundtrip.test.ts` compares circuits with `equivalentCircuits`, a
 * structural fingerprint: it can see that a wire gained an operation and it
 * cannot see that the operation is the wrong matrix, the wrong way round, or
 * missing a phase. This suite therefore defines "the same circuit" as "the same
 * 2ⁿ × 2ⁿ unitary, global phase included" for unitary circuits, and as "the same
 * joint distribution over the classical register and the qubits" for circuits
 * that measure — both computed by `reference.ts`, written from the textbook
 * definitions, and both compared through `qasm-reader.ts`, a second reader of
 * the file written to the published language rather than to this repo's
 * choices.
 */

import { run } from '@qsim/core'
import { describe, expect, it } from 'vitest'
import { parseCircuit, type Circuit } from '@qsim/schema'

import { importOpenQasm } from '../../import/index.js'
import { toOpenQasm3 } from '../../qasm3.js'
import { randomCircuit, seeded } from '../../testing/random-circuits.js'
import { readQasm } from './qasm-reader.js'
import {
  distributionDistance,
  flatten,
  jointDistribution,
  jointDistributionOfOps,
  matrixDistance,
  unitaryOf,
  unitaryOfOps,
  type Vec,
} from './reference.js'

import presetsFixture from './presets.fixture.json' with { type: 'json' }

const TOLERANCE = 1e-10

const PRESETS = (presetsFixture as { id: string; circuit: unknown }[]).map(
  (entry) => [entry.id, parseCircuit(entry.circuit)] as const
)

function isUnitary(circuit: Circuit): boolean {
  return flatten(circuit).every(
    (op) => op.kind === 'gate' || op.kind === 'barrier'
  )
}

/** How far apart two circuits are, by whichever measure applies. */
function distance(left: Circuit, right: Circuit): number {
  if (left.qubits !== right.qubits) return Number.POSITIVE_INFINITY
  return isUnitary(left) && isUnitary(right)
    ? matrixDistance(unitaryOf(left), unitaryOf(right))
    : distributionDistance(jointDistribution(left), jointDistribution(right))
}

/** The same, between a circuit and a QASM file read by the second reader. */
function distanceToText(circuit: Circuit, text: string): number {
  const program = readQasm(text)
  if (program.qubits !== circuit.qubits) return Number.POSITIVE_INFINITY
  const unitary =
    isUnitary(circuit) &&
    program.ops.every((op) => op.kind === 'gate' || op.kind === 'barrier')
  return unitary
    ? matrixDistance(
        unitaryOf(circuit),
        unitaryOfOps(program.ops, program.qubits)
      )
    : distributionDistance(
        jointDistribution(circuit),
        jointDistributionOfOps(program.ops, program.qubits)
      )
}

/* ─────────────── the reference agrees with the engine at all ────────────── */

describe('the reference simulator and @qsim/core agree', () => {
  it.each(PRESETS)('on the %s preset', (_id, circuit) => {
    if (!isUnitary(circuit)) return
    const mine = unitaryOf(circuit)[0] as Vec
    const theirs = run(circuit)
    if (theirs.mode !== 'analytic') throw new Error('expected analytic')
    for (let index = 0; index < mine.re.length; index++) {
      expect(theirs.state.re[index] as number).toBeCloseTo(
        mine.re[index] as number,
        10
      )
      expect(theirs.state.im[index] as number).toBeCloseTo(
        mine.im[index] as number,
        10
      )
    }
  })

  it('on random circuits over the catalog', () => {
    const random = seeded(20260816)
    for (let trial = 0; trial < 40; trial++) {
      const circuit = randomCircuit(random, {
        qubits: 3,
        clbits: 0,
        operations: 8,
        without: ['measure', 'reset'],
      })
      const mine = unitaryOf(circuit)[0] as Vec
      const theirs = run(circuit)
      if (theirs.mode !== 'analytic') throw new Error('expected analytic')
      for (let index = 0; index < mine.re.length; index++) {
        expect(
          Math.abs(
            (theirs.state.re[index] as number) - (mine.re[index] as number)
          )
        ).toBeLessThan(1e-12)
        expect(
          Math.abs(
            (theirs.state.im[index] as number) - (mine.im[index] as number)
          )
        ).toBeLessThan(1e-12)
      }
    }
  })
})

/* ─────────────────────── circuit → QASM → circuit ───────────────────────── */

describe('every shipped preset survives the round trip', () => {
  it.each(PRESETS)('%s comes back computing the same thing', (_id, circuit) => {
    const text = toOpenQasm3(circuit)
    expect(distanceToText(circuit, text)).toBeLessThan(TOLERANCE)
    const back = importOpenQasm(text).circuit
    expect(distance(circuit, back)).toBeLessThan(TOLERANCE)
  })

  it.each(PRESETS)('%s reaches a text fixed point', (_id, circuit) => {
    const first = toOpenQasm3(importOpenQasm(toOpenQasm3(circuit)).circuit)
    const second = toOpenQasm3(importOpenQasm(first).circuit)
    const third = toOpenQasm3(importOpenQasm(second).circuit)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })
})

describe('random circuits over the whole catalog', () => {
  it('come back with the identical unitary, iswap included', () => {
    const random = seeded(7788991)
    for (let trial = 0; trial < 60; trial++) {
      const circuit = randomCircuit(random, {
        qubits: 1 + (trial % 4),
        clbits: 0,
        operations: 10,
        without: ['measure', 'reset'],
      })
      const text = toOpenQasm3(circuit)
      const seed = `trial ${String(trial)}`
      // Not exactly zero: `3*pi/4` read back by a second evaluator can differ
      // in the last bit from the double the exporter started with. D6's 1e-10
      // is the contract's own tolerance and this is four orders inside it.
      expect(
        `${seed}: ${(distanceToText(circuit, text) < 1e-12).toString()}`
      ).toBe(`${seed}: true`)
      const back = importOpenQasm(text).circuit
      expect(
        `${seed}: ${(distance(circuit, back) < TOLERANCE).toString()}`
      ).toBe(`${seed}: true`)
    }
  })

  it('come back with the identical joint distribution when they measure', () => {
    const random = seeded(31415926)
    for (let trial = 0; trial < 40; trial++) {
      const circuit = randomCircuit(random, {
        qubits: 3,
        clbits: 2,
        operations: 9,
      })
      const text = toOpenQasm3(circuit)
      const seed = `trial ${String(trial)}`
      expect(
        `${seed}: ${(distanceToText(circuit, text) < 1e-9).toString()}`
      ).toBe(`${seed}: true`)
      const back = importOpenQasm(text).circuit
      expect(`${seed}: ${(distance(circuit, back) < 1e-9).toString()}`).toBe(
        `${seed}: true`
      )
    }
  })

  it('reach a QASM fixed point', () => {
    const random = seeded(2718281)
    for (let trial = 0; trial < 40; trial++) {
      const circuit = randomCircuit(random, {
        qubits: 3,
        clbits: 2,
        operations: 9,
      })
      const first = toOpenQasm3(importOpenQasm(toOpenQasm3(circuit)).circuit)
      const second = toOpenQasm3(importOpenQasm(first).circuit)
      expect(`trial ${String(trial)}: ${String(second === first)}`).toBe(
        `trial ${String(trial)}: true`
      )
    }
  })
})
