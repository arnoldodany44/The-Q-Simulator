import {
  CIRCUIT_SCHEMA_VERSION,
  GATES,
  GATE_IDS,
  VARIABLE_ARITY,
  validateCircuit,
  type Circuit,
  type GateId,
  type GateMeta,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { toCircuitJson } from './json.js'
import { toOpenQasm3 } from './qasm3.js'
import { toQiskit } from './qiskit.js'

/**
 * EVERY GATE IN THE CATALOG REACHES EVERY FORMAT.
 *
 * The brief for M1.7 is "map every gate in the catalog", and the way that
 * requirement decays is not a wrong mapping — it is a gate added to
 * `@qsim/schema`'s catalog later and never given a form here. That failure is
 * invisible until somebody places the new gate and presses export, at which
 * point they get an exception instead of a file.
 *
 * So the fixtures are *generated from the catalog itself* rather than listed:
 * `GATE_IDS` drives the loop, and a new entry there fails this file on the
 * commit that adds it. Each fixture is built from the gate's own metadata —
 * arity, control count, parameter count, classical writes — and is asserted to
 * be a valid circuit first, so a fixture that stopped making sense is reported
 * as a broken fixture rather than as a broken exporter.
 */

describe.each(GATE_IDS)('the gate "%s"', (id) => {
  const meta = GATES[id]
  const circuit = circuitFor(id, meta)

  it('is a valid circuit to begin with', () => {
    expect(validateCircuit(circuit)).toEqual([])
  })

  it('has an OpenQASM 3 form', () => {
    const program = toOpenQasm3(circuit)
    expectSaneProgram(program, '//')
    // Every fixture places exactly one operation, so the program has to say
    // something beyond its header and its declarations.
    expect(statements(program, '//')).not.toEqual([])
  })

  it('has a Qiskit form', () => {
    const program = toQiskit(circuit)
    expectSaneProgram(program, '#')
    expect(statements(program, '#')).not.toEqual([])
  })

  it('survives the native JSON export unchanged', () => {
    expect(JSON.parse(toCircuitJson(circuit))).toEqual(circuit)
  })
})

/**
 * A one-operation circuit exercising a gate at exactly the shape the catalog
 * declares for it: its controls on the lowest wires, its targets above them,
 * one classical bit if it writes one.
 */
function circuitFor(id: GateId, meta: GateMeta): Circuit {
  const arity = meta.arity === VARIABLE_ARITY ? 2 : meta.arity
  const controls = Array.from({ length: meta.controlCount }, (_, i) => i)
  const targets = Array.from({ length: arity }, (_, i) => meta.controlCount + i)
  const params = [Math.PI / 4, 0.5, 1.25].slice(0, meta.paramCount)

  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: meta.controlCount + arity,
    clbits: meta.clbitCount,
    operations: [
      {
        id: `op_${id}`,
        gate: id,
        targets,
        column: 0,
        ...(controls.length > 0 ? { controls } : {}),
        ...(params.length > 0 ? { params } : {}),
        ...(meta.clbitCount > 0 ? { clbitTargets: [0] } : {}),
      },
    ],
  }
}

/**
 * The checks that catch a generated file nobody would trust: a stray
 * `undefined` or `NaN` where a value should be, a tab, trailing whitespace, a
 * missing final newline. None of them is a physics bug and all of them are a
 * bad first impression of everything else in the project.
 */
function expectSaneProgram(program: string, comment: string): void {
  expect(program.endsWith('\n')).toBe(true)
  expect(program).not.toMatch(/undefined|NaN|Infinity|\[object /)
  expect(program).not.toMatch(/\t/)
  expect(program).not.toMatch(/[ ]+$/m)
  // No blank line may carry spaces, and no run of two blank lines survives.
  expect(program).not.toMatch(/\n{3}/)
  expect(statements(program, comment).every((line) => line.trim() !== '')).toBe(
    true
  )
}

/** The lines that are neither blank nor a comment. */
function statements(program: string, comment: string): string[] {
  return program
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' &&
        !line.trimStart().startsWith(comment) &&
        !isPreamble(line)
    )
}

/** Declarations and imports, which every program has whatever it contains. */
function isPreamble(line: string): boolean {
  return (
    /^(OPENQASM|include|qubit\[|bit\[)/.test(line) ||
    /^(from|import) /.test(line) ||
    /^(q|c|circuit) = /.test(line)
  )
}
