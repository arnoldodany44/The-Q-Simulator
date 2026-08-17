/**
 * "You drew two gates and the device ran eleven" — the number, and the
 * accounting behind it.
 *
 * The important assertions here are not about the arithmetic, which is a sum.
 * They are about the two sides being counted the *same way*: a difference that
 * was partly an accounting change would be read as the transpiler's doing,
 * which is the one thing this figure must never invite.
 */

import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { compareProgram, costOfGate } from './program'

function circuit(input: Omit<CircuitInput, 'schemaVersion'>) {
  return parseCircuit({ schemaVersion: CIRCUIT_SCHEMA_VERSION, ...input })
}

/** A Bell pair, measured. Two gates on the page. */
const drawn = circuit({
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'x', targets: [1], controls: [0], column: 1 },
    { id: 'op_3', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
    { id: 'op_4', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
  ],
})

/**
 * What a Heron actually runs for it: an `h` is `rz · sx · rz`, and a `cx` is a
 * `cz` with basis changes either side. Written out as the transpiler emits it,
 * over hardware qubits.
 */
const executed = [
  'OPENQASM 3.0;',
  'include "stdgates.inc";',
  '',
  '// ibm_marrakesh, calibration 2026-08-15T04:11:00Z',
  '// qubit 0 -> $53, qubit 1 -> $54',
  '',
  'bit[2] c;',
  'rz(pi/2) $53;',
  'sx $53;',
  'rz(pi/2) $53;',
  'rz(pi/2) $54;',
  'sx $54;',
  'rz(pi/2) $54;',
  'cz $53, $54;',
  'rz(pi/2) $54;',
  'sx $54;',
  'rz(pi/2) $54;',
  'c[0] = measure $53;',
  'c[1] = measure $54;',
].join('\n')

describe('the drawn circuit against the program that ran', () => {
  const comparison = compareProgram(drawn, executed, [53, 54])

  it('counts the document s gates without its measurements', () => {
    expect(comparison.drawn.gates).toBe(2)
    expect(comparison.drawn.measurements).toBe(2)
    expect(comparison.drawn.qubits).toBe(2)
  })

  it('counts the program s gates on the same accounting', () => {
    // Seven rotations and pulses plus one cz. The two measurements are counted
    // apart, exactly as the drawn side counts its own.
    expect(comparison.executed.gates).toBe(10)
    expect(comparison.executed.measurements).toBe(2)
  })

  it('says how much bigger the program is, both ways', () => {
    expect(comparison.extra).toBe(8)
    expect(comparison.factor).toBe(5)
  })

  it('names the physical qubits it occupied, from the stored layout', () => {
    // Counting distinct operands out of the QASM would answer "how many qubits
    // appear in a statement", which is smaller on any circuit with an idle wire.
    expect(comparison.executed.qubits).toBe(2)
  })

  it('lists both sides gate by gate, most frequent first', () => {
    expect(comparison.drawn.tally).toEqual([
      { name: 'h', count: 1 },
      { name: 'x', count: 1 },
    ])
    expect(comparison.executed.tally).toEqual([
      { name: 'rz', count: 6 },
      { name: 'sx', count: 3 },
      { name: 'cz', count: 1 },
    ])
  })

  /**
   * Ten gates is not ten equal things, and this grouping is what keeps the
   * headline from overstating the damage: six of those ten are frame changes,
   * which play no pulse and cost no error.
   */
  it('groups the executed gates by what each one costs', () => {
    expect(comparison.cost).toEqual({
      frame: 6,
      pulse: 3,
      entangling: 1,
      other: 0,
    })
    expect(
      comparison.cost.frame +
        comparison.cost.pulse +
        comparison.cost.entangling +
        comparison.cost.other
    ).toBe(comparison.executed.gates)
  })

  it('finds the program flat, which every submitted one is', () => {
    expect(comparison.hasDefinitions).toBe(false)
  })
})

describe('the accounting the two sides share', () => {
  /**
   * A block counts as its body. If it counted as one gate, packaging two gates
   * would report "you drew 1, the device ran 10" and blame the transpiler for
   * the packaging — the same argument `@qsim/schema` makes about the
   * leaderboard.
   */
  it('counts a subcircuit as the gates inside it', () => {
    const packaged = circuit({
      qubits: 2,
      clbits: 2,
      customGates: {
        entangle: {
          qubits: 2,
          operations: [
            { id: 'inner_1', gate: 'h', targets: [0], column: 0 },
            {
              id: 'inner_2',
              gate: 'x',
              targets: [1],
              controls: [0],
              column: 1,
            },
          ],
        },
      },
      operations: [
        { id: 'op_1', gate: 'entangle', targets: [0, 1], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 1,
        },
      ],
    })

    const comparison = compareProgram(packaged, executed, [53, 54])

    expect(comparison.drawn.gates).toBe(2)
    expect(comparison.drawn.tally).toEqual([
      { name: 'h', count: 1 },
      { name: 'x', count: 1 },
    ])
    // Same document, same program, same difference as the unpackaged one.
    expect(comparison.extra).toBe(8)
  })

  it('counts neither side s barriers or resets as gates', () => {
    const structural = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'barrier', targets: [0, 1], column: 1 },
        { id: 'op_3', gate: 'reset', targets: [1], column: 2 },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 3,
        },
        {
          id: 'op_5',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
        },
      ],
    })

    const withStructure = compareProgram(
      structural,
      [
        'barrier $53, $54;',
        'reset $54;',
        'sx $53;',
        'c[0] = measure $53;',
      ].join('\n'),
      [53, 54]
    )

    expect(withStructure.drawn.gates).toBe(1)
    expect(withStructure.executed.gates).toBe(1)
  })

  it('has no expansion factor for a document with no gates in it', () => {
    const measurementOnly = circuit({
      qubits: 1,
      clbits: 1,
      operations: [
        {
          id: 'op_1',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
      ],
    })

    // Null rather than Infinity: printing a division by zero is not a reading.
    expect(
      compareProgram(measurementOnly, 'c[0] = measure $53;', [53]).factor
    ).toBeNull()
  })

  it('reports a program that is not flat instead of undercounting it', () => {
    const withDefinition = [
      'gate bell a, b {',
      '  h a;',
      '  cx a, b;',
      '}',
      'bell $53, $54;',
    ].join('\n')

    expect(compareProgram(drawn, withDefinition, [53, 54]).hasDefinitions).toBe(
      true
    )
  })
})

describe('what a gate costs on this hardware', () => {
  it('calls rz a frame change, which plays no pulse', () => {
    expect(costOfGate('rz')).toBe('frame')
  })

  it('calls the drives pulses', () => {
    expect(costOfGate('sx')).toBe('pulse')
    expect(costOfGate('x')).toBe('pulse')
    expect(costOfGate('rx')).toBe('pulse')
  })

  it('calls both two-qubit gates entangling', () => {
    expect(costOfGate('cz')).toBe('entangling')
    expect(costOfGate('rzz')).toBe('entangling')
  })

  it('does not guess at a gate it has never seen', () => {
    // A wrong group would be a claim about a device's error budget that nothing
    // supports, and the panel prints the group beside the count.
    expect(costOfGate('ecr')).toBe('other')
    expect(costOfGate('id')).toBe('other')
  })
})
