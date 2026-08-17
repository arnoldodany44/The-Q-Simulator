/**
 * The third place in this project where an endianness mistake would be
 * invisible — and the worst of the three, because a real device gives you
 * nothing to compare against.
 *
 * ── THE THREE THINGS THAT COULD BE BACKWARDS ─────────────────────────────
 *
 *   1. The **qubit permutation**. Logical qubit 0 runs on physical qubit 53,
 *      and the program says so; a transpiler that applied the layout to the
 *      wrong end would produce a circuit that computes the mirror image of
 *      what was drawn. Tested by simulating the placed circuit and comparing
 *      its distribution against the original's, on circuits chosen so that the
 *      mirror image is a *different* distribution.
 *
 *   2. The **classical register**. Transpilation moves qubits, not bits, so
 *      the returned register is already in the document's order — and the
 *      instinct to "undo the layout" on it introduces a permutation instead of
 *      removing one. Tested by measuring into deliberately crossed classical
 *      bits, so that a plan which mixed the two up answers differently.
 *
 *   3. The **bit order inside a sample**. IBM returns hexadecimal integers;
 *      bit k is c[k]; a label is written highest bit first. Tested against
 *      `@qsim/core`'s own `formatRegister` convention by round-tripping real
 *      simulated shots through a synthetic hexadecimal encoder.
 *
 * ── EVERY CIRCUIT HERE IS ASYMMETRIC ON PURPOSE ──────────────────────────
 *
 * A Bell pair is invariant under swapping its two wires *and* under reversing
 * the bit order, so it agrees with a mirrored implementation of itself and
 * would pass all three tests while all three were wrong. So the fixtures are
 * `x` on one wire and not the other, crossed measurement targets, and a
 * three-qubit chain whose ends are distinguishable.
 */

import { describe, expect, it } from 'vitest'
import { createRng, orderedCounts, run, trajectoriesMode } from '@qsim/core'
import { type Circuit } from '@qsim/schema'

import { countsFromSamples, invertLayout } from '../results.js'
import { deviceGraph } from '../device.js'
import { transpile } from '../transpile.js'
import { HERON } from '../testing/heron.js'
import { asymmetricPair, sequence } from '../testing/circuits.js'

const heron = deviceGraph(HERON)
const SHOTS = 4096

function counts(circuit: Circuit, seed: number): Record<string, number> {
  const result = run(circuit, trajectoriesMode(SHOTS, createRng(seed)))
  if (result.mode !== 'trajectories') throw new Error('expected shots')
  return { ...result.counts }
}

/** The labels a distribution puts weight on, sorted. Ignores shot noise. */
function support(distribution: Record<string, number>): readonly string[] {
  return orderedCounts(distribution)
    .filter(([, count]) => count > SHOTS / 100)
    .map(([label]) => label)
}

/** Shots re-encoded the way a backend would send them: hexadecimal per shot. */
function asHexSamples(distribution: Record<string, number>): readonly string[] {
  const samples: string[] = []
  for (const [label, count] of orderedCounts(distribution)) {
    // The label is highest classical bit first, so reading it as a binary
    // numeral recovers exactly the integer a backend would report.
    const hex = `0x${BigInt(`0b${label}`).toString(16)}`
    for (let shot = 0; shot < count; shot++) samples.push(hex)
  }
  return samples
}

describe('the qubit permutation', () => {
  const fixtures: readonly (readonly [string, Circuit])[] = [
    ['x on qubit 0 only, measured into crossed bits', asymmetricPair()],
    [
      'a chain whose two ends are distinguishable',
      sequence(3, 3, [
        { gate: 'x', targets: [0] },
        { gate: 'h', targets: [1] },
        { gate: 'cx', targets: [2], controls: [1] },
        { gate: 'measure', targets: [0], clbitTargets: [0] },
        { gate: 'measure', targets: [1], clbitTargets: [1] },
        { gate: 'measure', targets: [2], clbitTargets: [2] },
      ]),
    ],
    [
      'a controlled rotation, which is not symmetric in its two wires',
      sequence(2, 2, [
        { gate: 'h', targets: [0] },
        { gate: 'x', targets: [1] },
        { gate: 'crz', targets: [1], controls: [0], params: [0.9] },
        { gate: 'h', targets: [0] },
        { gate: 'measure', targets: [0], clbitTargets: [0] },
        { gate: 'measure', targets: [1], clbitTargets: [1] },
      ]),
    ],
    [
      'a teleportation-shaped circuit with a classical condition',
      /*
       * Three wires rather than two, and qubit 2 flipped unconditionally, so
       * that the outcomes are {100, 111} rather than the mirror-symmetric
       * {00, 11} a two-wire version would give — the whole point of the second
       * assertion below.
       */
      sequence(3, 3, [
        { gate: 'h', targets: [0] },
        { gate: 'x', targets: [2] },
        { gate: 'measure', targets: [0], clbitTargets: [0] },
        { gate: 'x', targets: [1], condition: { clbit: 0, equals: 1 } },
        { gate: 'measure', targets: [1], clbitTargets: [1] },
        { gate: 'measure', targets: [2], clbitTargets: [2] },
      ]),
    ],
  ]

  for (const [name, circuit] of fixtures) {
    it(`survives transpilation: ${name}`, () => {
      const plan = transpile(circuit, heron)
      const before = counts(circuit, 20260816)
      const after = counts(plan.placed, 20260816)
      // The placed circuit is the source circuit's qubits renumbered into
      // placement order. Its classical register is untouched, so the two
      // distributions must agree label for label.
      expect(support(after)).toEqual(support(before))
      for (const label of support(before)) {
        expect(after[label] ?? 0).toBeGreaterThan(0)
      }
    })

    it(`is asymmetric enough for the test to mean something: ${name}`, () => {
      // If reversing the label were a symmetry of this distribution, the
      // check above would pass under a mirrored implementation too.
      const distribution = counts(circuit, 7)
      const mirrored = support(distribution).map((label) =>
        [...label].reverse().join('')
      )
      expect(mirrored.sort()).not.toEqual([...support(distribution)].sort())
    })
  }
})

describe('the classical register is not permuted', () => {
  it('reads a hardware sample home without touching the layout', () => {
    const circuit = asymmetricPair()
    const plan = transpile(circuit, heron)

    const simulated = counts(plan.placed, 4242)
    const samples = asHexSamples(simulated)
    const returned = countsFromSamples(samples, circuit.clbits)

    expect(returned).toEqual(counts(circuit, 4242))
    // And the actual value: `x` on qubit 0, measured into c[1]. So c[1] = 1
    // and c[0] = 0, which prints highest bit first as "10".
    expect(Object.keys(returned)).toEqual(['10'])
  })

  it('would give a different answer if the layout were applied to the bits', () => {
    /*
     * The counter-test. Deliberately undo the layout on the classical
     * register, which is the mistake this file exists to prevent, and check
     * that it produces a different histogram — otherwise the test above would
     * pass whether or not the code was right.
     */
    const circuit = sequence(3, 3, [
      { gate: 'x', targets: [0] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'measure', targets: [1], clbitTargets: [1] },
      { gate: 'measure', targets: [2], clbitTargets: [2] },
    ])
    const plan = transpile(circuit, heron)
    const honest = countsFromSamples(asHexSamples(counts(plan.placed, 5)), 3)

    const inverse = invertLayout(plan.layout)
    const permuted: Record<string, number> = {}
    for (const [label, count] of Object.entries(honest)) {
      // Rewrite bit `k` as though it belonged to physical qubit `k`.
      const bits = [...label].reverse()
      const moved = plan.physicalQubits.map(
        (physical) => bits[inverse.get(physical) as number] as string
      )
      const key = moved.reverse().join('')
      permuted[key] = (permuted[key] ?? 0) + count
    }
    expect(permuted).not.toEqual(honest)
  })
})

describe('the bit order inside a sample', () => {
  it('matches @qsim/core, which is what the comparison view overlays', () => {
    const circuit = sequence(3, 3, [
      { gate: 'x', targets: [0] },
      { gate: 'x', targets: [2] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'measure', targets: [1], clbitTargets: [1] },
      { gate: 'measure', targets: [2], clbitTargets: [2] },
    ])
    // Qubits 0 and 2 flipped, qubit 1 not: c[0] = 1, c[1] = 0, c[2] = 1, and
    // the label reads highest bit first as "101" — value 0b101 = 0x5.
    expect(Object.keys(counts(circuit, 1))).toEqual(['101'])
    expect(countsFromSamples(['0x5', '0x5'], 3)).toEqual({ '101': 2 })

    const plan = transpile(circuit, heron)
    expect(countsFromSamples(asHexSamples(counts(plan.placed, 1)), 3)).toEqual({
      '101': SHOTS,
    })
  })
})
