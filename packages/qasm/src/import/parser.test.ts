/**
 * The grammar: what parses, and what the refusal says when it does not.
 *
 * The messages are the subject here as much as the shapes. §3.5's promise is
 * that an import either works or explains itself, and every explanation this
 * importer gives is assembled from a position, a code and — for a construct the
 * language has and this format does not — the keyword itself. A test that only
 * asserted "it threw" would let all three rot.
 */

import { describe, expect, it } from 'vitest'

import { QasmImportError } from './errors.js'
import { parseProgram, unsupportedKeywords } from './parser.js'
import type { QasmGateCall, QasmIf } from './ast.js'

function capture(source: string): QasmImportError {
  try {
    parseProgram(source)
  } catch (cause) {
    if (cause instanceof QasmImportError) return cause
    throw cause
  }
  throw new Error('expected a QasmImportError')
}

describe('declarations', () => {
  it('reads a header, an include and both register spellings', () => {
    const program = parseProgram(
      'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nbit[2] c;'
    )
    expect(program.version).toBe(3)
    expect(program.includes).toEqual(['stdgates.inc'])
    expect(program.qubitRegisters).toEqual([
      { name: 'q', size: 2, at: { line: 3, column: 1 } },
    ])
    expect(program.clbitRegisters[0]?.size).toBe(2)
  })

  it('accepts the deprecated spellings in an OpenQASM 3 file', () => {
    // Still in the grammar, and refusing a file every other toolchain reads is
    // not strictness.
    const program = parseProgram('OPENQASM 3.0;\nqreg q[2];\ncreg c[1];')
    expect(program.qubitRegisters[0]?.size).toBe(2)
  })

  it('reads a gate definition with parameters and qubits', () => {
    const program = parseProgram('gate rzz(theta) a, b { rz(theta) b; }')
    expect(program.gates[0]).toMatchObject({
      name: 'rzz',
      params: ['theta'],
      qubits: ['a', 'b'],
    })
  })

  it('refuses a gate defined inside a gate', () => {
    const error = capture('gate a q { gate b r { x r; } }')
    expect(error.code).toBe('syntax')
    expect(error.message).toContain('inside another gate')
  })
})

describe('statements', () => {
  it('reads modifiers in the order they are written', () => {
    const program = parseProgram('ctrl(2) @ inv @ pow(3) @ x a, b, c;')
    const call = program.statements[0] as QasmGateCall
    expect(call.modifiers.map((modifier) => modifier.kind)).toEqual([
      'ctrl',
      'inv',
      'pow',
    ])
  })

  it('tells a modifier from a gate of the same name by the @', () => {
    const program = parseProgram('inv q[0];')
    const call = program.statements[0] as QasmGateCall
    expect(call.modifiers).toEqual([])
    expect(call.name).toBe('inv')
  })

  it('reads both measurement forms', () => {
    const arrow = parseProgram('measure q[0] -> c[0];').statements[0]
    const assigned = parseProgram('c[0] = measure q[0];').statements[0]
    expect(arrow).toMatchObject({ kind: 'measure' })
    expect(assigned).toMatchObject({ kind: 'measure' })
  })

  it('does not mistake a parameterised gate call for an assignment', () => {
    // `crz(pi) q[0], q[1];` and `c[0] = measure q[0];` both begin with a name;
    // only the `=` separates them, and the scan for it must stop at the
    // statement's semicolon.
    const program = parseProgram('crz(pi) q[0], q[1];')
    expect(program.statements[0]?.kind).toBe('gateCall')
  })

  it('reads an if with braces, without braces, and with an else', () => {
    const braced = parseProgram('if (c[0] == true) { x q[0]; }')
      .statements[0] as QasmIf
    expect(braced.body).toHaveLength(1)
    expect(braced.otherwise).toBeNull()

    const bare = parseProgram('if (c == 1) x q[0];').statements[0] as QasmIf
    expect(bare.bit).toBeNull()
    expect(bare.value).toBe(1)

    const withElse = parseProgram('if (c[0]) x q[0]; else y q[1];')
      .statements[0] as QasmIf
    expect(withElse.otherwise).toHaveLength(1)
  })

  it('reads a bare barrier and a barrier over named wires', () => {
    expect(parseProgram('barrier;').statements[0]).toMatchObject({
      kind: 'barrier',
      operands: [],
    })
    expect(parseProgram('barrier q, r[1];').statements[0]).toMatchObject({
      kind: 'barrier',
    })
  })

  it('skips a stray semicolon between statements', () => {
    // Files produced by string concatenation are full of them.
    expect(parseProgram(';;x q[0];;').statements).toHaveLength(1)
  })
})

describe('what a refusal says', () => {
  it('names the token it found and the one it wanted', () => {
    const error = capture('qubit[2] q\nx q[0];')
    expect(error.code).toBe('syntax')
    expect(error.message).toContain('";"')
  })

  it('points at the line and column of the mistake', () => {
    const error = capture('qubit[2] q;\nx q[0]\ny q[1];')
    // The statement's semicolon is missing, so the next statement's first token
    // is where the reader has to look.
    expect(error.position.line).toBe(3)
  })

  it.each(unsupportedKeywords())(
    'refuses "%s" by name rather than as a syntax error',
    (keyword) => {
      const error = capture(`${keyword} something;`)
      expect(error.code).toBe('unsupported')
      expect(error.construct).toBe(keyword)
    }
  )

  it('refuses a keyword used as a gate name', () => {
    // An `else` with no `if` in front of it reaches the gate-call rule, which
    // is where a name is checked against the keyword table — the alternative is
    // reading it as a call to a gate nobody could have defined.
    const error = capture('qubit[1] q;\nelse q[0];')
    expect(error.code).toBe('syntax')
    expect(error.message).toContain('keyword')
  })

  it('refuses an annotation and a pragma, naming which', () => {
    expect(capture('@noise off\nx q[0];').construct).toBe('@annotation')
    expect(capture('#pragma whatever\nx q[0];').construct).toBe('#pragma')
  })

  it('refuses a register given a starting value', () => {
    const error = capture('bit[2] c = "01";')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('register initialiser')
  })
})
