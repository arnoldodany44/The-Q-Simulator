import { CIRCUIT_SCHEMA_VERSION, gateCount, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { toOpenQasm3 } from './qasm3.js'
import { tallyQasm3 } from './tally.js'

/**
 * The tally is read back off programs this project emits, so most of these
 * tests hand it `toOpenQasm3`'s own output rather than hand-written text. That
 * is deliberate: a fixture would keep passing on the day the emitter changed
 * its spelling, and the tally would silently start counting nothing.
 */

function circuit(partial: Partial<Circuit> & Pick<Circuit, 'operations'>) {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    ...partial,
  } satisfies Circuit
}

describe('tallyQasm3', () => {
  it('counts each gate name and totals the calls', () => {
    const tally = tallyQasm3(
      toOpenQasm3(
        circuit({
          operations: [
            { id: 'op_1', gate: 'h', targets: [0], column: 0 },
            { id: 'op_2', gate: 'h', targets: [1], column: 0 },
            {
              id: 'op_3',
              gate: 'cx',
              controls: [0],
              targets: [1],
              column: 1,
            },
          ],
        })
      )
    )

    expect(tally.gates).toEqual([
      { name: 'h', count: 2 },
      { name: 'cx', count: 1 },
    ])
    expect(tally.gateCalls).toBe(3)
  })

  it('orders equally frequent gates by name, not by discovery', () => {
    // `z` is written first, so a tally that kept insertion order would put it
    // first. The order has to be a property of the program rather than of the
    // walk, because two renderings of one job must list its gates alike.
    const tally = tallyQasm3(
      toOpenQasm3(
        circuit({
          operations: [
            { id: 'op_1', gate: 'z', targets: [0], column: 0 },
            { id: 'op_2', gate: 'x', targets: [1], column: 0 },
          ],
        })
      )
    )

    expect(tally.gates.map((gate) => gate.name)).toEqual(['x', 'z'])
  })

  it('ignores the language header and both register declarations', () => {
    const tally = tallyQasm3(
      toOpenQasm3(circuit({ clbits: 2, operations: [] }))
    )

    expect(tally.gateCalls).toBe(0)
    expect(tally.gates).toEqual([])
  })

  /**
   * The agreement this file exists for. The comparison view prints this number
   * beside `gateCount` of the circuit somebody drew, so the two have to be the
   * same *kind* of count — see the module header. A tally that folded the
   * measurements in would report a difference partly made of the reader's own
   * measurements, which they would read as the transpiler's doing.
   */
  it('counts structural statements apart, exactly as gateCount does', () => {
    const drawn = circuit({
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
    const tally = tallyQasm3(toOpenQasm3(drawn))

    expect(tally.gateCalls).toBe(gateCount(drawn))
    expect(tally.gateCalls).toBe(1)
    expect(tally.measurements).toBe(2)
    expect(tally.resets).toBe(1)
    expect(tally.barriers).toBe(1)
  })

  it('names a measurement by the verb, not by the register it writes', () => {
    // `c[0] = measure q[0];` starts with the assignment target, so a reader
    // that took the first identifier would tally every measurement as `c`.
    const tally = tallyQasm3(
      toOpenQasm3(
        circuit({
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
      )
    )

    expect(tally.measurements).toBe(1)
    expect(tally.gates).toEqual([])
  })

  /**
   * A gate carrying more controls than `stdgates.inc` has a name for is
   * written with the `ctrl @` modifier, which puts a word that is not a gate at
   * the front of the line. Reading it would tally every such statement as
   * `ctrl` and collapse `ctrl @ x` and `ctrl @ h` into one row.
   */
  it('names the gate under its modifiers, not the modifier', () => {
    const program = toOpenQasm3(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'h',
            controls: [0, 1],
            targets: [2],
            column: 0,
          },
        ],
      })
    )
    expect(program).toContain('ctrl @ ctrl @ h')

    expect(tallyQasm3(program).gates).toEqual([{ name: 'h', count: 1 }])
  })

  it('counts what a conditioned block runs, and says there was one', () => {
    const tally = tallyQasm3(
      toOpenQasm3(
        circuit({
          clbits: 1,
          operations: [
            {
              id: 'op_1',
              gate: 'measure',
              targets: [0],
              clbitTargets: [0],
              column: 0,
            },
            {
              id: 'op_2',
              gate: 'x',
              targets: [1],
              column: 1,
              condition: { clbit: 0, equals: 1 },
            },
          ],
        })
      )
    )

    expect(tally.conditionals).toBe(1)
    // The `x` runs when the bit is set, so it is a call. The `if` itself is not.
    expect(tally.gates).toEqual([{ name: 'x', count: 1 }])
  })

  /**
   * The opposite block, and the one a naive reader gets wrong. A definition's
   * body is executed once per *call*, never where it is written, so counting
   * it reports a circuit nobody ran.
   */
  it('does not count the body of a gate definition as calls', () => {
    const withDefinition = [
      'OPENQASM 3.0;',
      'include "stdgates.inc";',
      '',
      'gate bell a, b {',
      '  h a;',
      '  cx a, b;',
      '}',
      '',
      'qubit[2] q;',
      'bell q[0], q[1];',
    ].join('\n')

    const tally = tallyQasm3(withDefinition)

    expect(tally.definitions).toBe(1)
    expect(tally.gates).toEqual([{ name: 'bell', count: 1 }])
    expect(tally.gateCalls).toBe(1)
  })

  it('leaves a definition when its braces balance, not at the first one', () => {
    const nested = [
      'gate wrapper a {',
      '  if (c[0] == true) {',
      '    x a;',
      '  }',
      '}',
      'wrapper q[0];',
    ].join('\n')

    const tally = tallyQasm3(nested)

    // One call, after the definition closed. The inner `}` must not have been
    // read as the end of the body — that would have counted `wrapper`'s own
    // closing brace line and then `wrapper q[0];` differently.
    expect(tally.gates).toEqual([{ name: 'wrapper', count: 1 }])
    expect(tally.conditionals).toBe(0)
  })

  it('reads nothing out of comment lines', () => {
    const tally = tallyQasm3(
      ['// h q[0];', '// cx q[0], q[1];', 'x $3;'].join('\n')
    )

    expect(tally.gates).toEqual([{ name: 'x', count: 1 }])
  })

  it('answers for an empty program instead of failing on one', () => {
    const tally = tallyQasm3('')

    expect(tally).toEqual({
      gates: [],
      gateCalls: 0,
      measurements: 0,
      resets: 0,
      barriers: 0,
      conditionals: 0,
      definitions: 0,
    })
  })

  /**
   * A program over *hardware qubits* — `$53` rather than `q[0]` — which is the
   * only spelling a submitted job uses. `@qsim/transpile` emits it, and this
   * package must be able to read back what that package writes.
   */
  it('reads a program written over hardware qubits', () => {
    const placed = [
      'OPENQASM 3.0;',
      'include "stdgates.inc";',
      '',
      '// ibm_marrakesh, calibration 2026-08-15T04:00:00Z',
      '',
      'bit[2] c;',
      'rz(pi/2) $53;',
      'sx $53;',
      'rz(pi/2) $53;',
      'cz $53, $54;',
      'c[0] = measure $53;',
      'c[1] = measure $54;',
    ].join('\n')

    const tally = tallyQasm3(placed)

    expect(tally.gates).toEqual([
      { name: 'rz', count: 2 },
      { name: 'cz', count: 1 },
      { name: 'sx', count: 1 },
    ])
    expect(tally.gateCalls).toBe(4)
    expect(tally.measurements).toBe(2)
    expect(tally.definitions).toBe(0)
  })
})
