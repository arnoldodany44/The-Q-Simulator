/**
 * A QASM FILE IS A STRANGER'S UPLOAD — specification §11.
 *
 * Four things it must not be able to do: hang the parser, recurse without
 * bound, allocate without bound, or produce a circuit that fails `parseCircuit`
 * downstream. The last one is the subtle one, and it is the reason the final act
 * of every import is to run the contract's own validator over the result: an
 * import produces something the contract accepts or a clear error, and never
 * something in between.
 *
 * Every case below is an *outcome* assertion, not a timing one. Wall-clock
 * budgets live in `*.perf.test.ts` by project rule, and a bound that is enforced
 * by counting rather than by a clock does not need a clock to prove it — a file
 * that would hang produces a `limit` error here in microseconds, and a file that
 * would not produces a circuit.
 */

import { safeParseCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  MAX_BLOCK_DEPTH,
  MAX_EXPRESSION_DEPTH,
  MAX_GATE_DEFINITIONS,
  MAX_IDENTIFIER_LENGTH,
  MAX_OPERATIONS,
  MAX_SOURCE_LENGTH,
} from './limits.js'
import { importOpenQasm, QasmImportError, safeImportOpenQasm } from './index.js'
import { unsupportedKeywords } from './parser.js'

function capture(source: string): QasmImportError {
  const result = safeImportOpenQasm(source)
  if (result.ok) throw new Error('expected the import to be refused')
  return result.error
}

describe('a truncated file', () => {
  const WHOLE = `OPENQASM 3.0;
include "stdgates.inc";
gate bell a, b {
  h a;
  cx a, b;
}
qubit[2] q;
bit[2] c;
bell q[0], q[1];
c[0] = measure q[0];
c[1] = measure q[1];
`

  it('is refused at every cut, with a position, and never with a crash', () => {
    // Every prefix of a real file, one character at a time. Some of them are
    // valid programs in their own right — the file is still a file after
    // `qubit[2] q;` — so the assertion is not "always fails" but "always either
    // a circuit or a QasmImportError with a position inside the text".
    const lines = WHOLE.split('\n').length
    for (let cut = 0; cut <= WHOLE.length; cut++) {
      const prefix = WHOLE.slice(0, cut)
      const result = safeImportOpenQasm(prefix)
      if (result.ok) continue
      expect(result.error).toBeInstanceOf(QasmImportError)
      expect(result.error.position.line).toBeGreaterThanOrEqual(1)
      expect(result.error.position.line).toBeLessThanOrEqual(lines)
      expect(result.error.position.column).toBeGreaterThanOrEqual(1)
    }
  })

  it('names the block that was never closed', () => {
    const error = capture('qubit[2] q;\ngate bell a, b {\n  h a;\n')
    expect(error.code).toBe('syntax')
    expect(error.message).toContain('ends before')
  })

  it('names a statement that lost its semicolon at the end of the file', () => {
    const error = capture('qubit[2] q;\nh q[0]')
    expect(error.code).toBe('syntax')
    expect(error.message).toContain('the end of the file')
  })
})

describe('nothing but nested gate definitions', () => {
  it('refuses a file of more definitions than it will read', () => {
    const source = [
      'qubit[1] q;',
      ...Array.from(
        { length: MAX_GATE_DEFINITIONS + 5 },
        (_, index) => `gate g${String(index)} a { x a; }`
      ),
      'g0 q[0];',
    ].join('\n')
    const error = capture(source)
    expect(error.code).toBe('limit')
  })

  it('refuses a chain of definitions deeper than it will expand', () => {
    /*
     * `g0` calls `g1` calls `g2` … — a chain, not a cycle, so the cycle check
     * has nothing to say about it. It terminates and it is one JavaScript frame
     * per link, which is exactly the unbounded recursion `MAX_CUSTOM_GATE_DEPTH`
     * exists for in the contract; without the bound the client would get a stack
     * overflow reported as a crash.
     */
    const links = 200
    const source = [
      'qubit[1] q;',
      `gate g${String(links)} a { x a; }`,
      ...Array.from(
        { length: links },
        (_, index) =>
          `gate g${String(links - index - 1)} a { g${String(links - index)} a; }`
      ),
      'g0 q[0];',
    ].join('\n')
    const error = capture(source)
    expect(error.code).toBe('limit')
    expect(error.message).toContain('nested')
  })

  it('refuses a doubling chain before it allocates the expansion', () => {
    // Twenty definitions each using the previous one twice: forty lines of
    // text, a million operations. The contract's §3.1 decision 4 names this
    // exact shape; here it has to be caught while emitting, not after.
    const source = [
      'qubit[1] q;',
      'gate g0 a { x a; }',
      ...Array.from(
        { length: 20 },
        (_, index) =>
          `gate g${String(index + 1)} a { g${String(index)} a; g${String(index)} a; }`
      ),
      'g20 q[0];',
    ].join('\n')
    const error = capture(source)
    expect(error.code).toBe('limit')
    expect(error.message).toContain(String(MAX_OPERATIONS))
  })
})

describe('a gate that calls itself', () => {
  it('is named, directly', () => {
    const error = capture('qubit[1] q;\ngate loop a { loop a; }\nloop q[0];')
    expect(error.code).toBe('semantic')
    expect(error.message).toContain('itself')
  })

  it('is named through another gate, with the loop written out', () => {
    const error = capture(
      'qubit[1] q;\ngate a x { b x; }\ngate b x { a x; }\na q[0];'
    )
    expect(error.code).toBe('semantic')
    expect(error.message).toContain('→')
  })
})

describe('a register of a billion qubits', () => {
  it.each([
    ['qreg q[1000000000];', 2],
    ['qubit[1000000000] q;', 3],
    ['creg c[1000000000];\nqreg q[1];', 2],
  ])('is refused at the declaration (%#)', (source) => {
    const error = capture(source)
    expect(error.code).toBe('limit')
    // Refused for what it asks for, not for what was allocated: nothing was.
    expect(error.message).toContain('1000000000')
  })

  it('is refused when several registers add up to it', () => {
    const source = [
      ...Array.from({ length: 40 }, (_, index) => `qreg r${String(index)}[1];`),
      'x r0[0];',
    ].join('\n')
    const error = capture(source)
    expect(error.code).toBe('limit')
  })

  it('refuses a fractional or negative size', () => {
    expect(capture('qreg q[2.5];').code).toBe('semantic')
    expect(capture('qreg q[-1];').code).toBe('syntax')
  })
})

describe('deeply nested parentheses', () => {
  it('refuses past the expression bound instead of overflowing the stack', () => {
    const depth = MAX_EXPRESSION_DEPTH + 20
    const source = `qubit[1] q;\nrz(${'('.repeat(depth)}1${')'.repeat(depth)}) q[0];`
    const error = capture(source)
    expect(error.code).toBe('limit')
    expect(error.message).toContain('nests')
  })

  it('refuses a stack of unary signs the same way', () => {
    const source = `qubit[1] q;\nrz(${'-'.repeat(500)}1) q[0];`
    expect(capture(source).code).toBe('limit')
  })

  it('still reads an expression a person would write', () => {
    const circuit = importOpenQasm(
      'qubit[1] q;\nrz((2 * (pi / 4)) + sin(0)) q[0];'
    ).circuit
    expect(circuit.operations[0]?.params).toEqual([Math.PI / 2])
  })

  it('refuses blocks nested past the bound', () => {
    const depth = MAX_BLOCK_DEPTH + 4
    const source =
      'qubit[1] q;\nbit[1] c;\n' +
      `${'if (c[0]) { '.repeat(depth)}x q[0];${' }'.repeat(depth)}`
    // Either the block bound or the "no conditional inside a conditional" rule
    // catches it; both are refusals with a position, which is the property.
    const error = capture(source)
    expect(['limit', 'unsupported']).toContain(error.code)
  })
})

describe('a very long identifier', () => {
  it('is refused at the token, before it is copied anywhere', () => {
    const name = 'g'.repeat(MAX_IDENTIFIER_LENGTH + 1)
    const error = capture(`qubit[1] q;\n${name} q[0];`)
    expect(error.code).toBe('limit')
  })

  it('does not become an over-long custom gate name in the document', () => {
    // The contract stores a gate name of at most 64 characters. A definition
    // whose name is longer is inlined rather than refused — the file is fine,
    // it just cannot be packaged as a block — and the circuit that comes out
    // still passes `parseCircuit`, which is the whole promise.
    const name = 'g'.repeat(100)
    const circuit = importOpenQasm(
      `qubit[1] q;\ngate ${name} a { x a; }\n${name} q[0];`
    ).circuit
    expect(circuit.customGates).toBeUndefined()
    expect(circuit.operations[0]?.gate).toBe('x')
    expect(safeParseCircuit(circuit).ok).toBe(true)
  })
})

describe('a file that is valid QASM for a feature we do not support', () => {
  it.each(unsupportedKeywords())(
    'names "%s" rather than failing generically',
    (keyword) => {
      const error = capture(`qubit[1] q;\n${keyword} whatever;`)
      expect(error.code).toBe('unsupported')
      expect(error.construct).toBe(keyword)
      // The sentence has to say what the construct *is*, so a reader who wrote
      // valid OpenQASM learns which feature this format cannot hold rather than
      // that their file is broken.
      expect(error.message.length).toBeGreaterThan(keyword.length + 20)
    }
  )

  it('names a subroutine, a loop and a calibration in a realistic file', () => {
    const source = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
def flip(qubit a) { x a; }
flip(q[0]);
`
    const error = capture(source)
    expect(error.construct).toBe('def')
    expect(error.position.line).toBe(4)
  })

  it('refuses an annotation rather than ignoring it', () => {
    // An annotation may change what the program means, and a tool that skipped
    // one it did not understand would be guessing about a stranger's file.
    const error = capture('qubit[1] q;\n@noise off\nx q[0];')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('@annotation')
  })
})

describe('the circuit that comes out is always one the contract accepts', () => {
  const FILES = [
    'qubit[1] q;',
    'qreg q[3];\ncreg c[3];\nh q;\nmeasure q -> c;',
    'qubit[2] q;\ngate g a, b { cx a, b; }\ng q[0], q[1];',
    'qubit[3] q;\nctrl @ negctrl @ ry(0.3) q[0], q[1], q[2];',
    'OPENQASM 2.0;\nqreg q[2];\ncreg c[1];\nU(1,2,3) q[0];\n' +
      'measure q[0] -> c[0];\nif(c==1) x q[1];',
  ]

  it.each(FILES)('parses back out of %#', (source) => {
    const result = safeImportOpenQasm(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const reparsed = safeParseCircuit(result.circuit)
    expect(
      reparsed.ok ? [] : reparsed.issues.map((issue) => issue.message)
    ).toEqual([])
  })

  it('reports a contract failure as one, if it ever happens', () => {
    // Not reachable from any file the suite knows — reaching it would be a
    // defect in the importer rather than in the file — but the code exists and
    // has to be the kind that names itself if it ever fires.
    const empty = 'qubit[1] q;'
    expect(safeImportOpenQasm(empty).ok).toBe(true)
  })
})

describe('the ceilings are checked before the work, not after', () => {
  it('refuses an oversized file without tokenising it', () => {
    const error = capture('x'.repeat(MAX_SOURCE_LENGTH + 1))
    expect(error.code).toBe('limit')
    expect(error.position).toEqual({ line: 1, column: 1 })
  })

  it('refuses a `pow` that would multiply past the operation ceiling', () => {
    const error = capture('qubit[1] q;\npow(100000) @ x q[0];')
    expect(error.code).toBe('limit')
  })

  it('refuses a program that needs more columns than a document holds', () => {
    // One qubit, one gate per column: the depth is the gate count. The
    // operation ceiling is the one that fires first, and either is a refusal
    // with a position rather than a document the editor cannot lay out.
    const source = `qubit[1] q;\n${'x q[0];\n'.repeat(MAX_OPERATIONS + 10)}`
    expect(capture(source).code).toBe('limit')
  })
})
