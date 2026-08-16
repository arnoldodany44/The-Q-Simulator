/**
 * Hostile files, judged by one rule with no exceptions.
 *
 * §11: a stranger's upload may not hang, recurse without bound, allocate
 * without bound, or produce a circuit `parseCircuit` refuses. So every case
 * below asserts the same three things — the call returns, it returns inside a
 * wall-clock budget, and what comes back is either a `QasmImportError` or a
 * circuit the contract accepts.
 *
 * A fourth rule is asserted with them, and it is the importer's own: `code`
 * may not be `contract`. `errors.ts` says of that code, in as many words, that
 * "reaching this is a defect in the importer rather than in the file" — so a
 * hostile file that provokes one has found a bug, not been refused.
 */

import { describe, expect, it } from 'vitest'
import { safeParseCircuit } from '@qsim/schema'

import { QasmImportError, safeImportOpenQasm } from '../../import/index.js'

/** Wall-clock budget per file. Generous: a refusal should be immediate. */
const BUDGET_MS = 2000

interface Verdict {
  readonly outcome: 'circuit' | 'refused'
  readonly code?: string
  readonly message?: string
  readonly ms: number
}

function probe(source: string): Verdict {
  const started = performance.now()
  let result: ReturnType<typeof safeImportOpenQasm>
  try {
    result = safeImportOpenQasm(source)
  } catch (cause) {
    throw new Error(
      `import threw something that is not a QasmImportError: ` +
        `${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`,
      { cause }
    )
  }
  const ms = performance.now() - started
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(QasmImportError)
    expect(result.error.position.line).toBeGreaterThanOrEqual(1)
    return {
      outcome: 'refused',
      code: result.error.code,
      message: result.error.message,
      ms,
    }
  }
  const reparsed = safeParseCircuit(result.circuit)
  expect(reparsed.ok ? 'accepted' : JSON.stringify(reparsed.issues)).toBe(
    'accepted'
  )
  return { outcome: 'circuit', ms }
}

/** The full rule, as one assertion, so a failure names which half broke. */
function survives(name: string, source: string): Verdict {
  const verdict = probe(source)
  expect(`${name}: ${String(verdict.ms < BUDGET_MS)}`).toBe(`${name}: true`)
  expect(`${name}: ${verdict.code ?? 'none'}`).not.toBe(`${name}: contract`)
  return verdict
}

const WHOLE = `OPENQASM 3.0;
include "stdgates.inc";

gate block(theta) a, b {
  rz(theta) a;
  cx a, b;
}

qubit[3] q;
bit[2] c;

h q[0];
block(pi/4) q[0], q[1];
ctrl @ negctrl @ x q[0], q[1], q[2];
barrier q[0], q[1], q[2];
c[0] = measure q[0];
if (c[0] == true) {
  x q[2];
}
c[1] = measure q[2];
`

describe('a truncated file, cut at every character', () => {
  it('never hangs, never crashes and never yields a bad circuit', () => {
    for (let cut = 0; cut <= WHOLE.length; cut++) {
      survives(`cut ${String(cut)}`, WHOLE.slice(0, cut))
    }
  })

  it('survives every cut of the tail as well', () => {
    for (let cut = 0; cut < WHOLE.length; cut++) {
      survives(`tail ${String(cut)}`, WHOLE.slice(cut))
    }
  })
})

describe('recursion and nesting without bound', () => {
  it('refuses a gate that calls itself', () => {
    const verdict = survives(
      'self',
      'OPENQASM 3.0;\ngate a q { a q; }\nqubit[1] r;\na r[0];\n'
    )
    expect(verdict.outcome).toBe('refused')
  })

  it('refuses a cycle through two other gates', () => {
    const verdict = survives(
      'cycle',
      'OPENQASM 3.0;\ngate a q { b q; }\ngate b q { c q; }\ngate c q { a q; }\n' +
        'qubit[1] r;\na r[0];\n'
    )
    expect(verdict.outcome).toBe('refused')
  })

  it('refuses a long chain of definitions', () => {
    const links = 400
    let source = 'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate g0 a { x a; }\n'
    for (let index = 1; index < links; index++) {
      source += `gate g${String(index)} a { g${String(index - 1)} a; }\n`
    }
    source += `qubit[1] q;\ng${String(links - 1)} q[0];\n`
    survives('chain', source)
  })

  it('refuses a doubling chain before it allocates', () => {
    let source = 'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate g0 a { x a; }\n'
    for (let index = 1; index < 60; index++) {
      source += `gate g${String(index)} a { g${String(index - 1)} a; g${String(index - 1)} a; }\n`
    }
    source += 'qubit[1] q;\ng59 q[0];\n'
    const verdict = survives('doubling', source)
    expect(verdict.outcome).toBe('refused')
  })

  it('refuses ten thousand nested parentheses', () => {
    const source = `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nrz(${'('.repeat(10_000)}1${')'.repeat(10_000)}) q[0];\n`
    expect(survives('parens', source).outcome).toBe('refused')
  })

  it('refuses ten thousand unary signs', () => {
    const source = `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nrz(${'-'.repeat(10_000)}1) q[0];\n`
    expect(survives('signs', source).outcome).toBe('refused')
  })

  it('refuses ten thousand nested braces', () => {
    survives('braces', `OPENQASM 3.0;\n${'{'.repeat(10_000)}`)
  })

  it('refuses ten thousand nested if statements', () => {
    let source =
      'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nbit[1] c;\n'
    source += 'if (c[0] == true) '.repeat(5_000)
    source += 'x q[0];\n'
    expect(survives('ifs', source).outcome).toBe('refused')
  })

  it('refuses ten thousand stacked modifiers', () => {
    const source = `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\n${'ctrl @ '.repeat(10_000)}x q[0], q[1];\n`
    expect(survives('modifiers', source).outcome).toBe('refused')
  })

  it('refuses a chain of pow that multiplies', () => {
    const source = `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\n${'pow(1024) @ '.repeat(8)}x q[0];\n`
    expect(survives('pow', source).outcome).toBe('refused')
  })

  it('refuses a long chain of binary operators', () => {
    /*
     * Roughly 9 500 operators used to be enough to overflow the stack: the
     * parser's iterative `additive`/`multiplicative` build a left-nested tree
     * that MAX_EXPRESSION_DEPTH never counted, and `evaluate` then walked it
     * one frame per operator. `MAX_EXPRESSION_NODES` counts the tree itself.
     */
    const source = `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nrz(${'1+'.repeat(50_000)}1) q[0];\n`
    expect(survives('operators', source).outcome).toBe('refused')
  })
})

describe('registers a machine could not hold', () => {
  const sizes = [
    '1000000000',
    '999999999999999999999',
    '1e9',
    '0x10',
    '-1',
    '1.5',
    '0',
    '28',
    '29',
  ]
  it.each(sizes)('refuses or accepts qreg q[%s] without crashing', (size) => {
    survives(size, `OPENQASM 2.0;\nqreg q[${size}];\n`)
  })

  it('refuses many registers that add up past the ceiling', () => {
    let source = 'OPENQASM 2.0;\n'
    for (let index = 0; index < 100; index++) {
      source += `qreg r${String(index)}[1];\n`
    }
    expect(survives('sum', source).outcome).toBe('refused')
  })
})

describe('identifiers and literals', () => {
  it('refuses a name a megabyte long', () => {
    const name = 'a'.repeat(500_000)
    expect(
      survives('long name', `OPENQASM 3.0;\nqubit[1] ${name};\n`).outcome
    ).toBe('refused')
  })

  it('refuses a name just past the token bound', () => {
    const name = `q${'a'.repeat(300)}`
    expect(survives('257', `OPENQASM 2.0;\nqreg ${name}[1];\n`).outcome).toBe(
      'refused'
    )
  })

  it('handles a gate name longer than the contract stores', () => {
    const name = `g${'x'.repeat(80)}`
    survives(
      'long gate',
      `OPENQASM 3.0;\ninclude "stdgates.inc";\ngate ${name} a { x a; }\nqubit[1] q;\n${name} q[0];\n`
    )
  })

  it('refuses a literal that is not a finite double', () => {
    expect(
      survives(
        '1e999',
        'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nrz(1e999) q[0];\n'
      ).outcome
    ).toBe('refused')
  })

  it('refuses an angle that evaluates to infinity', () => {
    expect(
      survives(
        'div0',
        'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nrz(1/0) q[0];\n'
      ).outcome
    ).toBe('refused')
  })

  it('refuses a source past the length ceiling quickly', () => {
    const verdict = survives('huge', 'x'.repeat(2 * 1024 * 1024))
    expect(verdict.outcome).toBe('refused')
    expect(`${String(verdict.ms < 200)}`).toBe('true')
  })

  it('refuses control characters rather than tokenising them away', () => {
    expect(
      survives('nul', 'OPENQASM 3.0;\nqubit[1] q;\n\u0000x q[0];\n').outcome
    ).toBe('refused')
  })
})

describe('valid OpenQASM this project cannot express', () => {
  const features: [string, string][] = [
    ['def', 'def add(int[32] a) -> int[32] { return a; }'],
    ['for', 'for int i in [0:3] { x q[0]; }'],
    ['while', 'while (true) { x q[0]; }'],
    ['box', 'box { x q[0]; }'],
    ['defcal', 'defcal x $0 { }'],
    ['input', 'input float[64] theta;'],
    ['const', 'const int[32] n = 3;'],
    ['let', 'let alias = q[0];'],
    ['array', 'array[int[32], 4] values;'],
    ['switch', 'switch (i) { case 1 { x q[0]; } }'],
    ['delay', 'delay[100ns] q[0];'],
    ['stretch', 'stretch s;'],
    ['pragma', 'pragma my.thing 1'],
    ['annotation', '@reversible\ngate g a { x a; }'],
  ]

  it.each(features)(
    'names %s rather than failing generically',
    (name, line) => {
      const verdict = survives(
        name,
        `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\n${line}\n`
      )
      expect(`${name}: ${verdict.outcome}`).toBe(`${name}: refused`)
      expect(`${name}: ${verdict.code ?? ''}`).toBe(`${name}: unsupported`)
    }
  )

  it('names a gate the standard libraries have and this catalog does not', () => {
    const verdict = survives(
      'rzz',
      'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nrzz(0.4) q[0], q[1];\n'
    )
    expect(verdict.code).toBe('unsupported')
  })
})

describe('a fuzzer over mutations of a valid file', () => {
  it('never crashes, never hangs and never yields a bad circuit', () => {
    let state = 987654321 >>> 0
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const alphabet = '{}[]()@;,*/+-.0123456789qcxhipetu \n"\'\\'
    for (let trial = 0; trial < 600; trial++) {
      let text = WHOLE
      const edits = 1 + Math.floor(random() * 6)
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * text.length)
        const roll = random()
        if (roll < 0.34) text = text.slice(0, at) + text.slice(at + 1)
        else if (roll < 0.67) {
          text =
            text.slice(0, at) +
            (alphabet[Math.floor(random() * alphabet.length)] as string) +
            text.slice(at)
        } else {
          text =
            text.slice(0, at) +
            (alphabet[Math.floor(random() * alphabet.length)] as string) +
            text.slice(at + 1)
        }
      }
      survives(`trial ${String(trial)}`, text)
    }
  })
})
