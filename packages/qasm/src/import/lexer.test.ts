/**
 * The tokeniser, on the inputs that break a reader built out of patterns.
 *
 * Layout is the theme: the same statement written four ways has to produce the
 * same tokens, and a comment has to be able to sit anywhere whitespace can. The
 * rest is positions — every message this importer produces names a line and a
 * column, and every one of those comes from here.
 */

import { describe, expect, it } from 'vitest'

import { QasmImportError } from './errors.js'
import { tokenize } from './lexer.js'
import { MAX_IDENTIFIER_LENGTH, MAX_SOURCE_LENGTH } from './limits.js'

/** Token texts, without the trailing `eof`. */
function texts(source: string): string[] {
  return tokenize(source)
    .filter((token) => token.kind !== 'eof')
    .map((token) => token.text)
}

describe('layout does not change the tokens', () => {
  const CANONICAL = texts('cx q[0], q[1];')

  it.each([
    ['tight', 'cx q[0],q[1];'],
    ['loose', 'cx   q [ 0 ] ,   q [ 1 ] ;'],
    ['split over lines', 'cx\n  q[0],\n  q[1]\n;'],
    ['with a line comment inside', 'cx q[0], // the control\n q[1];'],
    ['with a block comment inside', 'cx /* here */ q[0], q[1];'],
    ['with tabs', '\tcx\tq[0],\tq[1];'],
    ['with a carriage return', 'cx q[0],\r\nq[1];'],
  ])('reads the same statement %s', (_name, source) => {
    expect(texts(source)).toEqual(CANONICAL)
  })
})

describe('positions', () => {
  it('counts lines and columns from one', () => {
    const tokens = tokenize('h q[0];\n  cx q[0], q[1];')
    expect(tokens[0]?.at).toEqual({ line: 1, column: 1 })
    const cx = tokens.find((token) => token.text === 'cx')
    expect(cx?.at).toEqual({ line: 2, column: 3 })
  })

  it('counts a comment’s newlines', () => {
    const tokens = tokenize('/* one\ntwo\nthree */ h q[0];')
    expect(tokens[0]?.at).toEqual({ line: 3, column: 10 })
  })

  it('counts an astral character as one column', () => {
    // A surrogate pair is two code units and one character. Counting both would
    // make every column after an emoji in a comment wrong — and a column number
    // that is quietly off by one is worse than none.
    const tokens = tokenize('// 🙂\nh q[0];')
    expect(tokens[0]?.at).toEqual({ line: 2, column: 1 })
  })
})

describe('numbers', () => {
  it.each([
    ['1', 1],
    ['1.5', 1.5],
    ['.5', 0.5],
    ['2.', 2],
    ['1e3', 1000],
    ['1E-3', 0.001],
    ['1_000', 1000],
    ['0.30000000000000004', 0.30000000000000004],
  ])('reads %s', (source, value) => {
    expect(tokenize(source)[0]?.value).toBe(value)
  })

  it('refuses a literal that is not a finite double', () => {
    // Syntactically fine, and no angle in the catalog has a meaning at it.
    expect(() => tokenize('1e999')).toThrow(QasmImportError)
  })

  it('does not swallow an identifier that starts with e', () => {
    expect(texts('2 euler')).toEqual(['2', 'euler'])
  })
})

describe('what is refused, and where', () => {
  it('names the opening of an unclosed block comment', () => {
    const error = capture(() => tokenize('h q[0];\n/* and then'))
    expect(error.code).toBe('syntax')
    expect(error.position).toEqual({ line: 2, column: 1 })
    expect(error.message).toContain('never closed')
  })

  it('names an unclosed string', () => {
    const error = capture(() => tokenize('include "stdgates.inc'))
    expect(error.code).toBe('syntax')
    expect(error.message).toContain('never closed')
  })

  it('refuses a control character rather than skipping it', () => {
    const error = capture(() => tokenize(`h q[0];${String.fromCharCode(0)}`))
    expect(error.code).toBe('syntax')
    // Named by code point, never printed: a NUL in a message reaches a log
    // line, a DOM node and eventually a jsonb column that refuses one.
    expect(error.message).toContain('U+0000')
    expect(error.message).not.toContain(String.fromCharCode(0))
  })

  it('bounds the length of a name', () => {
    const long = 'a'.repeat(MAX_IDENTIFIER_LENGTH + 1)
    const error = capture(() => tokenize(`${long} q[0];`))
    expect(error.code).toBe('limit')
    expect(error.position).toEqual({ line: 1, column: 1 })
  })

  it('bounds the length of the file before reading a character of it', () => {
    const error = capture(() => tokenize('x'.repeat(MAX_SOURCE_LENGTH + 1)))
    expect(error.code).toBe('limit')
  })
})

describe('the pieces the grammar needs', () => {
  it('reads `->` and `**` as single tokens', () => {
    expect(texts('measure q -> c; pow(2) @ x q;')).toContain('->')
    expect(texts('a ** b')).toEqual(['a', '**', 'b'])
  })

  it('reads the Unicode constants as names', () => {
    // So `π/2` tokenises exactly as `pi/2` does and the evaluator resolves both
    // through one table.
    expect(texts('rz(π/2) q[0];')).toEqual([
      'rz',
      '(',
      'π',
      '/',
      '2',
      ')',
      'q',
      '[',
      '0',
      ']',
      ';',
    ])
  })

  it('unescapes a quoted include path', () => {
    expect(tokenize('include "std\\"gates.inc";')[1]?.text).toBe(
      'std"gates.inc'
    )
  })
})

function capture(action: () => unknown): QasmImportError {
  try {
    action()
  } catch (cause) {
    if (cause instanceof QasmImportError) return cause
    throw cause
  }
  throw new Error('expected a QasmImportError')
}
