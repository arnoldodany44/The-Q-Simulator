/**
 * THE ROUND TRIP — the strongest test this pair of halves can be given.
 *
 * ── WHAT IS BEING CLAIMED, AND IN WHICH SENSE ────────────────────────────
 *
 * Two directions, and they are checked in two different senses because they are
 * two different claims:
 *
 *  1. `circuit → OpenQASM 3 → circuit` produces an **equivalent** circuit. Not
 *     an identical one: ids are reinvented, columns are reconstructed from a
 *     text that carries none, and a definition may be repackaged. `equivalence.
 *     ts` defines what survives and argues for it — the sequence of operations
 *     each wire sees, which is the circuit's dependency graph and therefore what
 *     it computes.
 *
 *  2. `OpenQASM → circuit → OpenQASM` produces **equivalent QASM**, checked as a
 *     fixed point: the first pass normalises (comments go, registers flatten,
 *     the statement order becomes the contract's), and every pass after it must
 *     be byte-identical. An importer that drifted by one gate per trip would
 *     pass any single comparison and fail this immediately.
 *
 * ── AND ONE THING THAT IS NOT CLAIMED ────────────────────────────────────
 *
 * `iswap` has no name in `stdgates.inc`. The exporter writes it out as the exact
 * six-gate decomposition Qiskit uses, under a comment saying so — a deliberate,
 * documented loss on the way out — so a circuit containing one comes back as six
 * gates and is *not* structurally equivalent. That case is pinned by name below
 * rather than excused, and it is checked the only way left: by simulating both
 * and comparing amplitudes.
 *
 * The semantic half of the suite therefore covers the whole catalog including
 * `iswap`, and the structural half covers the catalog without it. Neither is
 * redundant. A structural match cannot see a wrong angle sign that the fingerprint
 * records faithfully on both sides; an amplitude match cannot see a `cx` and its
 * mirror image on a symmetric circuit. Together they can.
 */

import { probabilities, run, type Statevector } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, gateCount, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { randomCircuit, seeded } from '../testing/random-circuits.js'
import { toOpenQasm3 } from '../qasm3.js'
import { equivalentCircuits } from './equivalence.js'
import { importOpenQasm } from './index.js'

/** Enough seeds to cover the catalog many times over; cheap and deterministic. */
const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1)

function reimport(circuit: Circuit): Circuit {
  return importOpenQasm(toOpenQasm3(circuit)).circuit
}

function expectEquivalent(left: Circuit, right: Circuit): void {
  const verdict = equivalentCircuits(left, right)
  expect(verdict.ok ? 'equivalent' : verdict.reason).toBe('equivalent')
}

describe('circuit → OpenQASM 3 → circuit, structurally', () => {
  it.each(SEEDS)('is equivalent for the random circuit of seed %i', (seed) => {
    const random = seeded(seed)
    const circuit = randomCircuit(random, {
      qubits: 2 + Math.floor(random() * 4),
      clbits: 1 + Math.floor(random() * 3),
      operations: 6 + Math.floor(random() * 14),
      // See the header: the exporter decomposes `iswap` on purpose.
      without: ['iswap'],
    })
    expectEquivalent(circuit, reimport(circuit))
  })

  it('keeps a negative control negative', () => {
    // Singled out because it is the one attribute of a control that a lazy
    // reader of `ctrl @`/`negctrl @` would drop, and dropping it produces a
    // circuit that is valid, runs, and computes the complement.
    const circuit = parsed({
      qubits: 3,
      operations: [
        { id: 'op_1', gate: 'x', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'y',
          targets: [2],
          controls: [
            { qubit: 0, state: 0 },
            { qubit: 1, state: 1 },
          ],
          column: 1,
        },
      ],
    })
    const text = toOpenQasm3(circuit)
    expect(text).toContain('negctrl @ ctrl @ y q[0], q[1], q[2];')
    expectEquivalent(circuit, reimport(circuit))
  })

  it('keeps a measurement writing the bit it wrote', () => {
    const circuit = parsed({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [1],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'x',
          targets: [1],
          column: 2,
          condition: { clbit: 1, equals: 0 },
        },
      ],
    })
    expectEquivalent(circuit, reimport(circuit))
  })

  it('keeps a conditional reading the value the original read', () => {
    /*
     * The awkward case the exporter documents. Both operations sit in column 1;
     * the engine resolves a condition against the register **as it entered the
     * column**, so the `x` reads the value from *before* the measurement — and a
     * sequential language has no way to say "at the same time". The exporter
     * therefore writes the conditional first.
     *
     * What the importer has to preserve is the value read, not the column
     * number. Its as-soon-as-possible schedule puts the conditional in column 0
     * and the measurement in column 1, which reads the same pre-measurement
     * value; the column moved and the meaning did not. The assertion is
     * therefore `<=` — the conditional must not end up *after* the write, which
     * is the mistake that would silently change the circuit.
     */
    const circuit = parsed({
      qubits: 2,
      clbits: 1,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'x',
          targets: [1],
          column: 1,
          condition: { clbit: 0, equals: 1 },
        },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
      ],
    })
    const returned = reimport(circuit)
    expectEquivalent(circuit, returned)
    expect(columnOfConditional(returned)).toBeLessThanOrEqual(
      columnOfMeasure(returned)
    )
  })

  it('puts a conditional after the measurement that must precede it', () => {
    // The other direction, and the one where getting it wrong is silent: here
    // the `x` really does depend on the outcome, so a schedule that packed it
    // into the measurement's own column would make it read a zero the file
    // never meant.
    const circuit = parsed({
      qubits: 2,
      clbits: 1,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'x',
          targets: [1],
          column: 2,
          condition: { clbit: 0, equals: 1 },
        },
      ],
    })
    const returned = reimport(circuit)
    expectEquivalent(circuit, returned)
    expect(columnOfConditional(returned)).toBeGreaterThan(
      columnOfMeasure(returned)
    )
  })
})

describe('circuit → OpenQASM 3 → circuit, semantically', () => {
  it.each(SEEDS)(
    'reproduces the state exactly for the random circuit of seed %i',
    (seed) => {
      const random = seeded(seed)
      const circuit = randomCircuit(random, {
        qubits: 2 + Math.floor(random() * 3),
        clbits: 0,
        operations: 6 + Math.floor(random() * 12),
        // Analytic mode refuses a mid-circuit measurement and a condition, and
        // `reset` is not a unitary — the structural half above is what covers
        // those three. What this half adds is `iswap`.
        without: ['measure', 'reset'],
      })
      expectSameState(state(circuit), state(reimport(circuit)))
    }
  )

  it('brings iswap back as its six-gate decomposition, exactly', () => {
    const circuit = parsed({
      qubits: 3,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 't', targets: [2], column: 0 },
        { id: 'op_3', gate: 'iswap', targets: [0, 2], column: 1 },
      ],
    })
    const returned = reimport(circuit)

    // The loss is real and is recorded here rather than assumed: one gate
    // became six, and the gate count a gallery card prints changes with it.
    expect(gateCount(circuit)).toBe(3)
    expect(gateCount(returned)).toBe(8)
    expect(returned.operations.map((operation) => operation.gate)).toEqual([
      'h',
      't',
      's',
      's',
      'h',
      'cx',
      'cx',
      'h',
    ])

    // What is not lost: the unitary. The exporter's decomposition is an
    // equality and not an equivalence up to phase, so the amplitudes match to
    // the last bits rather than merely the probabilities.
    expectSameState(state(circuit), state(returned))
  })
})

describe('OpenQASM → circuit → OpenQASM', () => {
  /**
   * A file nobody in this repository wrote, in the layout a person writes:
   * lowercase header, comments, whitespace that lines nothing up, a gate
   * definition, register broadcast, and OpenQASM 2's conditional.
   */
  const HAND_WRITTEN = `
    // Grover on two qubits, as somebody would type it.
    OPENQASM 2.0;
    include "qelib1.inc";

    gate oracle ( ) a , b { cz a , b ; }

    qreg q[2];
    creg c[2];
    creg flag[1];

    h q;              /* both wires at once */
    oracle q[0], q[1];
    h q;
    x q;
    cz q[0], q[1];
    x q;
    h q;
    measure q -> c;
    measure q[0] -> flag[0];
    if (flag == 1) barrier q;
  `

  it('reaches a fixed point after one normalising pass', () => {
    const once = toOpenQasm3(importOpenQasm(HAND_WRITTEN).circuit)
    const twice = toOpenQasm3(importOpenQasm(once).circuit)
    const thrice = toOpenQasm3(importOpenQasm(twice).circuit)
    expect(twice).toBe(once)
    expect(thrice).toBe(once)
  })

  it('reaches a fixed point for every random circuit', () => {
    for (const seed of SEEDS) {
      const random = seeded(seed)
      const circuit = randomCircuit(random, {
        qubits: 2 + Math.floor(random() * 4),
        clbits: 1 + Math.floor(random() * 3),
        operations: 6 + Math.floor(random() * 14),
      })
      // The first pass is the one allowed to change things — `iswap` becomes
      // its decomposition here. From the second on, nothing may move.
      const once = toOpenQasm3(reimport(circuit))
      const twice = toOpenQasm3(reimport(importOpenQasm(once).circuit))
      expect(twice, `seed ${String(seed)}`).toBe(once)
    }
  })
})

describe('custom gates survive the round trip', () => {
  it('comes back as a block, not as its contents', () => {
    const circuit = parsed({
      qubits: 3,
      operations: [
        { id: 'op_1', gate: 'bellPair', targets: [0, 1], column: 0 },
        { id: 'op_2', gate: 'bellPair', targets: [1, 2], column: 1 },
      ],
      customGates: {
        bellPair: {
          qubits: 2,
          operations: [
            { id: 'g_1', gate: 'h', targets: [0], column: 0 },
            {
              id: 'g_2',
              gate: 'cx',
              targets: [1],
              controls: [0],
              column: 1,
            },
          ],
        },
      },
    })
    const returned = reimport(circuit)
    expect(Object.keys(returned.customGates ?? {})).toEqual(['bellPair'])
    expect(returned.operations.map((operation) => operation.gate)).toEqual([
      'bellPair',
      'bellPair',
    ])
    expectEquivalent(circuit, returned)
  })

  it('keeps a definition’s own parameters as parameters', () => {
    // M2.3 widened custom gates to formal parameters, and this is the whole
    // point of that: one definition, two angles, rather than two definitions.
    const circuit = parsed({
      qubits: 2,
      operations: [
        {
          id: 'op_1',
          gate: 'rzz',
          targets: [0, 1],
          params: [Math.PI / 4],
          column: 0,
        },
        {
          id: 'op_2',
          gate: 'rzz',
          targets: [0, 1],
          params: [-1.25],
          column: 1,
        },
      ],
      customGates: {
        rzz: {
          qubits: 2,
          params: ['theta'],
          operations: [
            { id: 'g_1', gate: 'cx', targets: [1], controls: [0], column: 0 },
            {
              id: 'g_2',
              gate: 'rz',
              targets: [1],
              params: ['theta'],
              column: 1,
            },
            { id: 'g_3', gate: 'cx', targets: [1], controls: [0], column: 2 },
          ],
        },
      },
    })

    const text = toOpenQasm3(circuit)
    expect(text).toContain('gate rzz(theta) a0, a1 {')
    expect(text).toContain('rz(theta) a1;')
    expect(text).toContain('rzz(pi/4) q[0], q[1];')

    const returned = reimport(circuit)
    expect(returned.customGates?.rzz?.params).toEqual(['theta'])
    expectEquivalent(circuit, returned)
  })

  it('renames a definition that collides with a catalog gate, both ways', () => {
    /*
     * A definition called `h` is legal in the contract and unreachable in
     * OpenQASM, because `stdgates.inc` already binds the name — so the exporter
     * emits it as `h_` under a comment saying why. Coming back, `h_` is a name
     * nothing holds and stays `h_`: the definition survives the trip under a
     * name it can be called by, rather than being dropped.
     *
     * The circuit calls `x` and never the definition, and that is on purpose.
     * `validateCircuit`, `orderedCustomGates` and both exporters resolve a
     * catalog name to the catalog and never to `customGates`, while
     * `expandCircuit` resolves it the other way round — so a document that
     * *called* `h` here would mean two different things depending on which of
     * them read it. That disagreement is in `@qsim/schema` and is not this
     * milestone's to settle; what this test needs is the name collision, which
     * an uncalled definition exercises exactly as well.
     */
    const circuit = parsed({
      qubits: 1,
      operations: [{ id: 'op_1', gate: 'x', targets: [0], column: 0 }],
      customGates: {
        h: {
          qubits: 1,
          operations: [{ id: 'g_1', gate: 'y', targets: [0], column: 0 }],
        },
      },
    })
    const text = toOpenQasm3(circuit)
    expect(text).toContain('gate h_ a0 {')

    const returned = reimport(circuit)
    expect(Object.keys(returned.customGates ?? {})).toEqual(['h_'])
    expect(returned.operations.map((operation) => operation.gate)).toEqual([
      'x',
    ])
    expectEquivalent(circuit, returned)
  })
})

/* ─────────────────────────────── helpers ─────────────────────────────── */

function parsed(
  circuit: Omit<Circuit, 'schemaVersion' | 'clbits'> & {
    clbits?: number
  }
): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    clbits: 0,
    ...circuit,
  }
}

function columnOfConditional(circuit: Circuit): number {
  return (
    circuit.operations.find((operation) => operation.condition !== undefined)
      ?.column ?? -1
  )
}

function columnOfMeasure(circuit: Circuit): number {
  return (
    circuit.operations.find((operation) => operation.gate === 'measure')
      ?.column ?? -1
  )
}

function state(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function expectSameState(left: Statevector, right: Statevector): void {
  expect(right.qubits).toBe(left.qubits)
  for (let index = 0; index < left.size; index++) {
    expect(right.re[index] ?? 0).toBeCloseTo(left.re[index] ?? 0, 10)
    expect(right.im[index] ?? 0).toBeCloseTo(left.im[index] ?? 0, 10)
  }
  // Cheap independent check that the two are the same distribution as well as
  // the same amplitudes, so a sign error in the loop above cannot hide.
  const one = [...probabilities(left)]
  const other = [...probabilities(right)]
  for (let index = 0; index < one.length; index++) {
    expect(other[index] ?? 0).toBeCloseTo(one[index] ?? 0, 10)
  }
}
