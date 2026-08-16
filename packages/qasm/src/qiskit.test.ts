import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { CircuitExportError } from './program.js'
import { toQiskit } from './qiskit.js'

/**
 * The Qiskit export, as text a person will paste into a notebook.
 *
 * Two kinds of assertion here, and the second is the unusual one:
 *
 *  - the gate calls are the ones a Qiskit user expects to read;
 *  - the file is *plausible Python*. There is no Python in this toolchain to
 *    check it with, so the structural rules below stand in for a parser:
 *    every line is an import, a comment, an assignment, a `with`, or a call on
 *    a known object; indentation is four spaces and only inside a block; no
 *    tabs, no trailing whitespace, balanced brackets. A stray character in a
 *    generated file is a bad first impression of the whole project, and this
 *    is the cheapest guard that catches one.
 */

function circuit(partial: Partial<Circuit> & Pick<Circuit, 'operations'>) {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    ...partial,
  } satisfies Circuit
}

/** The lines that are neither blank nor a comment. */
function code(program: string): string[] {
  return program
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

/** Only the gate calls: no imports, no register construction. */
function calls(program: string): string[] {
  return code(program).filter(
    (line) => !/^(from |import |q = |c = |circuit = )/.test(line)
  )
}

describe('toQiskit', () => {
  it('imports exactly what it uses and builds the registers by name', () => {
    const program = toQiskit(
      circuit({
        clbits: 2,
        operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
      })
    )
    expect(code(program)).toEqual([
      'from qiskit import ClassicalRegister, QuantumCircuit, QuantumRegister',
      'q = QuantumRegister(3, "q")',
      'c = ClassicalRegister(2, "c")',
      'circuit = QuantumCircuit(q, c)',
      'circuit.h(q[0])',
    ])
  })

  it('leaves the classical register out when the circuit has none', () => {
    const program = toQiskit(
      circuit({
        operations: [{ id: 'op_1', gate: 'x', targets: [1], column: 0 }],
      })
    )
    expect(program).toContain('circuit = QuantumCircuit(q)')
    expect(program).not.toContain('ClassicalRegister')
  })

  it('imports pi only when an angle is written with it', () => {
    const withPi = toQiskit(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'rz',
            targets: [0],
            params: [Math.PI / 2],
            column: 0,
          },
        ],
      })
    )
    expect(withPi).toContain('from math import pi')
    expect(withPi).toContain('circuit.rz(pi/2, q[0])')

    const withoutPi = toQiskit(
      circuit({
        operations: [
          { id: 'op_1', gate: 'rz', targets: [0], params: [0.75], column: 0 },
        ],
      })
    )
    expect(withoutPi).not.toContain('from math import pi')
    expect(withoutPi).toContain('circuit.rz(0.75, q[0])')
  })

  it('writes each multi-qubit gate with the method a Qiskit user knows', () => {
    const program = toQiskit(
      circuit({
        operations: [
          { id: 'op_1', gate: 'cx', targets: [2], controls: [0], column: 0 },
          {
            id: 'op_2',
            gate: 'ccx',
            targets: [2],
            controls: [0, 1],
            column: 1,
          },
          { id: 'op_3', gate: 'swap', targets: [0, 1], column: 2 },
          { id: 'op_4', gate: 'iswap', targets: [0, 1], column: 3 },
          {
            id: 'op_5',
            gate: 'cp',
            targets: [1],
            controls: [0],
            params: [Math.PI / 4],
            column: 4,
          },
        ],
      })
    )
    expect(calls(program)).toEqual([
      'circuit.cx(q[0], q[2])',
      'circuit.ccx(q[0], q[1], q[2])',
      'circuit.swap(q[0], q[1])',
      // Native here, decomposed in OpenQASM: Qiskit has the gate and
      // stdgates.inc does not.
      'circuit.iswap(q[0], q[1])',
      'circuit.cp(pi/4, q[0], q[1])',
    ])
  })

  it('builds a controlled gate through .control when no method fits', () => {
    const program = toQiskit(
      circuit({
        operations: [
          { id: 'op_1', gate: 'h', targets: [2], controls: [0, 1], column: 0 },
        ],
      })
    )
    expect(program).toContain('from qiskit.circuit.library import HGate')
    expect(calls(program)).toEqual([
      'circuit.append(HGate().control(2), [q[0], q[1], q[2]])',
    ])
  })

  it('spells a negative control as ctrl_state and explains the order', () => {
    const program = toQiskit(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'x',
            targets: [2],
            controls: [
              { qubit: 0, state: 1 },
              { qubit: 1, state: 0 },
            ],
            column: 0,
          },
        ],
      })
    )
    // Control 0 fires on |1> and control 1 on |0>. `ctrl_state` is read right
    // to left over the control list, so that is "01".
    expect(calls(program)).toEqual([
      'circuit.append(XGate().control(2, ctrl_state="01"), [q[0], q[1], q[2]])',
    ])
    expect(program).toContain('Fires when q[1] reads |0>')
  })

  it('uses if_test for a classical condition, not the removed c_if', () => {
    const program = toQiskit(
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
    expect(calls(program)).toEqual([
      'circuit.measure(q[0], c[0])',
      'with circuit.if_test((c[0], 1)):',
      '    circuit.x(q[1])',
    ])
    expect(program).not.toContain('c_if')
  })

  it('shows how to run it once there is something to count', () => {
    const withMeasure = toQiskit(
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
    expect(withMeasure).toContain('AerSimulator')

    const withoutMeasure = toQiskit(
      circuit({
        operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
      })
    )
    expect(withoutMeasure).not.toContain('AerSimulator')
  })

  it('defines a custom gate as a sub-circuit and appends it', () => {
    const program = toQiskit(
      circuit({
        qubits: 2,
        operations: [
          { id: 'op_1', gate: 'bellPair', targets: [0, 1], column: 0 },
        ],
        customGates: {
          bellPair: {
            qubits: 2,
            operations: [
              { id: 'g_1', gate: 'h', targets: [0], column: 0 },
              { id: 'g_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
            ],
          },
        },
      })
    )
    expect(calls(program)).toEqual([
      'bellPair_definition = QuantumCircuit(2, name="bellPair")',
      'bellPair_definition.h(0)',
      'bellPair_definition.cx(0, 1)',
      'bellPair = bellPair_definition.to_gate()',
      'circuit.append(bellPair, [q[0], q[1]])',
    ])
  })

  it('builds a custom gate before the one that appends it', () => {
    /*
     * The Python half of the same defect the OpenQASM emitter had: definitions
     * came out in `Object.entries` order, so a gate whose body appended one
     * declared later produced `NameError: name 'inner' is not defined`. The
     * keys here are deliberately in the broken order.
     */
    const program = toQiskit(
      circuit({
        qubits: 3,
        operations: [{ id: 'op_1', gate: 'outer', targets: [2, 0], column: 0 }],
        customGates: {
          outer: {
            qubits: 2,
            operations: [
              { id: 'i2', gate: 'inner', targets: [1], column: 0 },
              { id: 'i3', gate: 'cx', targets: [0], controls: [1], column: 1 },
            ],
          },
          inner: {
            qubits: 1,
            operations: [{ id: 'i1', gate: 'h', targets: [0], column: 0 }],
          },
        },
      })
    )

    expect(program.indexOf('inner = inner_definition.to_gate()')).toBeLessThan(
      program.indexOf('outer_definition.append(inner')
    )
    expect(
      program.indexOf('inner = inner_definition.to_gate()')
    ).toBeGreaterThan(-1)
  })

  it('does not let a custom gate shadow a name the module binds', () => {
    const program = toQiskit(
      circuit({
        qubits: 1,
        operations: [],
        customGates: {
          circuit: {
            qubits: 1,
            operations: [{ id: 'g_1', gate: 'x', targets: [0], column: 0 }],
          },
        },
      })
    )
    expect(program).toContain('circuit__definition = QuantumCircuit(1')
    expect(program).toContain('circuit_ = circuit__definition.to_gate()')
    // The circuit under construction still answers to its own name.
    expect(program).toContain('circuit = QuantumCircuit(q)')
  })

  it('refuses a gate nothing declares, naming the operation', () => {
    const failing = () =>
      toQiskit(
        circuit({
          operations: [
            { id: 'op_bad', gate: 'flubber', targets: [0], column: 0 },
          ],
        })
      )
    expect(failing).toThrow(CircuitExportError)
    expect(failing).toThrow(/op_bad/)
  })
})

describe('the emitted Python is plausible', () => {
  const program = toQiskit(
    circuit({
      qubits: 3,
      clbits: 2,
      parameters: [{ name: 'theta', value: Math.PI / 3 }],
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'ry', targets: [1], params: ['theta'], column: 0 },
        { id: 'op_3', gate: 'cx', targets: [2], controls: [0], column: 1 },
        { id: 'op_4', gate: 'h', targets: [1], controls: [0, 2], column: 2 },
        { id: 'op_5', gate: 'barrier', targets: [0, 1, 2], column: 3 },
        {
          id: 'op_6',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 4,
        },
        {
          id: 'op_7',
          gate: 'z',
          targets: [2],
          column: 5,
          condition: { clbit: 0, equals: 1 },
        },
      ],
    }),
    { title: 'A little of everything' }
  )

  it('ends in a newline and carries no tab or trailing space', () => {
    expect(program.endsWith('\n')).toBe(true)
    expect(program).not.toMatch(/\t/)
    expect(program).not.toMatch(/[ ]+$/m)
    expect(program).not.toMatch(/\n{3}/)
  })

  it('indents only inside a block, four spaces at a time', () => {
    const lines = program.split('\n')
    lines.forEach((line, index) => {
      const indent = /^ */.exec(line)![0].length
      if (indent === 0) return
      expect(indent % 4).toBe(0)
      // Something has to open the block this line is inside.
      const opener = lines
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.trim() !== '')
      expect(opener?.trimEnd().endsWith(':')).toBe(true)
    })
  })

  it('balances its brackets on every line', () => {
    for (const line of program.split('\n')) {
      if (line.trimStart().startsWith('#')) continue
      for (const [open, close] of [
        ['(', ')'],
        ['[', ']'],
      ] as const) {
        expect(count(line, open), line).toBe(count(line, close))
      }
      expect(count(line, '"') % 2, line).toBe(0)
    }
  })

  it('is made of statements Python could parse', () => {
    for (const line of code(program)) {
      expect(line, line).toMatch(
        /^(from \w[\w.]* import [\w, ]+|import \w+|\s*with [\w.]+\(.*\):|\s*\w+ = .+|\s*\w+\.\w+\(.*\))$/
      )
    }
  })
})

function count(text: string, character: string): number {
  return [...text].filter((entry) => entry === character).length
}
