/**
 * Recursive descent over the token stream — OpenQASM 2 and OpenQASM 3, from one
 * parser that knows which of them it is holding.
 *
 * ── THE TWO VERSIONS ARE NOT TWO SPELLINGS ───────────────────────────────
 *
 * §3.5 asks for both, and they differ in ways a shared reader has to decide
 * about rather than paper over. Everything this file branches on, in one place
 * so nobody has to hunt for it:
 *
 *  | | OpenQASM 2 | OpenQASM 3 |
 *  |---|---|---|
 *  | header      | `OPENQASM 2.0;`         | `OPENQASM 3.0;` or `3;`    |
 *  | library     | `include "qelib1.inc";` | `include "stdgates.inc";`  |
 *  | qubits      | `qreg q[3];`            | `qubit[3] q;`, `qubit q;`  |
 *  | bits        | `creg c[3];`            | `bit[3] c;`, `bit c;`      |
 *  | measurement | `measure q[0] -> c[0];` | also `c[0] = measure q[0];`|
 *  | conditional | `if (c == 3) x q[0];`   | `if (c[0] == true) { … }`  |
 *  | modifiers   | none                    | `ctrl @`, `inv @`, `pow(k) @` |
 *  | built-ins   | `U(θ,φ,λ)`, `CX`        | `U(θ,φ,λ)`, `gphase(γ)`    |
 *  | exponent    | `^`                     | `**`                       |
 *
 * The one that is a *semantic* difference and not a syntactic one is the
 * built-in `U`: OpenQASM 2 defines it with a global phase attached and
 * OpenQASM 3 does not, so the same three angles mean two different matrices in
 * the two dialects. That difference is invisible until somebody controls the
 * gate, at which point it is the whole answer, and it is handled in
 * `library.ts` where the gate is lowered rather than here where it is read.
 *
 * OpenQASM 3 still accepts `qreg`/`creg` as deprecated forms, and this parser
 * accepts them in both dialects for the same reason it accepts either
 * `include`: refusing a file every other toolchain reads is not strictness, it
 * is a bug report from a user.
 *
 * ── WHY THIS FILE REFUSES SO LITTLE ──────────────────────────────────────
 *
 * It refuses text that is not OpenQASM, and it refuses OpenQASM features by
 * name — `def`, `for`, `box` — because naming them needs the keyword and the
 * keyword is only visible here. Everything about *meaning* (does this gate
 * exist, does the contract have a shape for a controlled swap, is this register
 * index inside the register) belongs to `lower.ts`, which is the only file that
 * knows the gate catalog.
 */

import {
  MAX_BLOCK_DEPTH,
  MAX_CLBITS,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_NODES,
  MAX_GATE_DEFINITIONS,
  MAX_MODIFIERS,
  MAX_QUBITS,
} from './limits.js'
import {
  limitError,
  semanticError,
  syntaxError,
  unsupportedError,
} from './errors.js'
import { tokenize, type Token } from './lexer.js'
import type {
  QasmExpr,
  QasmGateDefinition,
  QasmModifier,
  QasmOperand,
  QasmProgram,
  QasmRegister,
  QasmStatement,
  QasmVersion,
} from './ast.js'

/**
 * OpenQASM 3 keywords this contract has no shape for.
 *
 * Every one of them is *valid* OpenQASM. A file using one is not broken, it is
 * asking for something a circuit document cannot hold — a subroutine, a loop, a
 * classical variable, a pulse calibration, a timing box — and the reader is
 * told which, by name. That is the difference between "your file uses `for`,
 * which this importer does not support" and "unexpected token", and it is the
 * whole of §3.5's promise that an import either works or explains itself.
 *
 * The value is the sentence's subject; the key is the keyword as the language
 * spells it, which is what `construct` carries to the UI untranslated (D2).
 */
const UNSUPPORTED_KEYWORDS: Readonly<Record<string, string>> = {
  def: 'a classical subroutine',
  defcal: 'a pulse-level calibration',
  defcalgrammar: 'a calibration grammar',
  cal: 'a calibration block',
  extern: 'an external function',
  for: 'a loop',
  while: 'a loop',
  end: 'an early end of program',
  box: 'a timing box',
  delay: 'a timed delay',
  duration: 'a duration value',
  durationof: 'a duration value',
  stretch: 'a stretchable delay',
  let: 'a register alias',
  input: 'a free input parameter',
  output: 'a declared output',
  int: 'a classical integer variable',
  uint: 'a classical integer variable',
  float: 'a classical float variable',
  angle: 'a classical angle variable',
  bool: 'a classical boolean variable',
  complex: 'a classical complex variable',
  array: 'a classical array',
  const: 'a classical constant',
  pragma: 'a pragma',
  opaque: 'an opaque gate declaration',
  switch: 'a switch statement',
  case: 'a switch statement',
  default: 'a switch statement',
}

/** Statement keywords that are not gate names, so a gate call cannot use them. */
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'OPENQASM',
  'include',
  'qreg',
  'creg',
  'qubit',
  'bit',
  'gate',
  'barrier',
  'reset',
  'measure',
  'if',
  'else',
  ...Object.keys(UNSUPPORTED_KEYWORDS),
])

/**
 * The version a file declares, or the one its syntax implies.
 *
 * §3.5 says "detect which you were handed rather than asking the user", so this
 * is never a parameter of the import. A file with an `OPENQASM` header is taken
 * at its word. A file without one — a fragment pasted out of a notebook, which
 * is the common case for a paste box — is read for the constructs that exist in
 * only one of the two dialects, and falls back to 3, the current language.
 */
export function detectVersion(tokens: readonly Token[]): {
  readonly version: QasmVersion
  readonly declared: boolean
} {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token
    if (token.kind !== 'identifier' || token.text !== 'OPENQASM') continue
    const number = tokens[index + 1]
    if (number === undefined || number.kind !== 'number') {
      throw syntaxError(
        token.at,
        'The OPENQASM header must be followed by a version number.'
      )
    }
    const major = Math.floor(number.value)
    if (major !== 2 && major !== 3) {
      throw unsupportedError(
        number.at,
        `OPENQASM ${number.text}`,
        `This file declares OpenQASM ${number.text}. Only versions 2 and 3 ` +
          `are supported.`
      )
    }
    return { version: major, declared: true }
  }

  for (const token of tokens) {
    if (token.kind !== 'identifier') continue
    // `qreg`/`creg` exist in both dialects, so they are not evidence on their
    // own — but a file that uses them and never uses a version-3 construct is
    // overwhelmingly a version-2 file, and reading it as one changes exactly
    // one thing: the meaning of the built-in `U`.
    if (token.text === 'qubit' || token.text === 'bit') {
      return { version: 3, declared: false }
    }
    if (token.text === 'qreg' || token.text === 'creg') {
      return { version: 2, declared: false }
    }
  }
  return { version: 3, declared: false }
}

/** Reads a whole OpenQASM file. Throws `QasmImportError` and nothing else. */
export function parseProgram(source: string): QasmProgram {
  const tokens = tokenize(source)
  const { version, declared } = detectVersion(tokens)
  return new Parser(tokens, version, declared).program()
}

class Parser {
  private readonly tokens: readonly Token[]
  private readonly version: QasmVersion
  private readonly versionDeclared: boolean
  private index = 0

  /** Guards the two recursive descents. See `limits.ts`. */
  private expressionDepth = 0
  private blockDepth = 0
  /**
   * Nodes read in the expression currently being parsed.
   *
   * Depth is not size: `1+1+1+…` never recurses here and builds a tree one
   * level deep per operator, which the *evaluator* then walks recursively. See
   * `MAX_EXPRESSION_NODES`.
   */
  private expressionNodes = 0

  constructor(
    tokens: readonly Token[],
    version: QasmVersion,
    versionDeclared: boolean
  ) {
    this.tokens = tokens
    this.version = version
    this.versionDeclared = versionDeclared
  }

  /* ─────────────────────────── the token cursor ──────────────────────── */

  private peek(offset = 0): Token {
    // The stream always ends with `eof`, so the last token is a safe answer for
    // any lookahead past the end and no call site needs a bounds check.
    return (
      this.tokens[Math.min(this.index + offset, this.tokens.length - 1)] ?? {
        kind: 'eof',
        text: '',
        value: 0,
        at: { line: 1, column: 1 },
      }
    )
  }

  private next(): Token {
    const token = this.peek()
    if (token.kind !== 'eof') this.index += 1
    return token
  }

  private atPunct(text: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token.kind === 'punct' && token.text === text
  }

  private atIdentifier(text: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token.kind === 'identifier' && token.text === text
  }

  private eatPunct(text: string): boolean {
    if (!this.atPunct(text)) return false
    this.index += 1
    return true
  }

  private expectPunct(text: string, context: string): Token {
    if (!this.atPunct(text)) {
      throw syntaxError(
        this.peek().at,
        `Expected "${text}" ${context}, but found ${this.describe(this.peek())}.`
      )
    }
    return this.next()
  }

  private expectIdentifier(context: string): Token {
    const token = this.peek()
    if (token.kind !== 'identifier') {
      throw syntaxError(
        token.at,
        `Expected a name ${context}, but found ${this.describe(token)}.`
      )
    }
    return this.next()
  }

  /** A token as a reader would refer to it, for a message. */
  private describe(token: Token): string {
    if (token.kind === 'eof') return 'the end of the file'
    if (token.kind === 'string') return 'a string'
    if (token.kind === 'number') return `the number ${token.text}`
    return `"${token.text}"`
  }

  /* ───────────────────────────── the program ─────────────────────────── */

  program(): QasmProgram {
    const includes: string[] = []
    const qubitRegisters: QasmRegister[] = []
    const clbitRegisters: QasmRegister[] = []
    const gates: QasmGateDefinition[] = []
    const statements: QasmStatement[] = []

    while (this.peek().kind !== 'eof') {
      // A stray semicolon between statements is an empty statement, which the
      // grammar allows and which files produced by string concatenation are
      // full of.
      if (this.eatPunct(';')) continue

      const token = this.peek()

      if (
        token.kind === 'punct' &&
        (token.text === '@' || token.text === '#')
      ) {
        throw unsupportedError(
          token.at,
          token.text === '@' ? '@annotation' : '#pragma',
          `This file carries ${
            token.text === '@' ? 'an annotation' : 'a pragma'
          }, which may change what the program means. The importer refuses ` +
            `rather than ignore it.`
        )
      }

      if (token.kind !== 'identifier') {
        throw syntaxError(
          token.at,
          `Expected a statement, but found ${this.describe(token)}.`
        )
      }

      switch (token.text) {
        case 'OPENQASM':
          this.versionStatement()
          continue
        case 'include':
          includes.push(this.includeStatement())
          continue
        case 'qreg':
        case 'creg':
        case 'qubit':
        case 'bit': {
          const register = this.registerDeclaration()
          const quantum = token.text === 'qreg' || token.text === 'qubit'
          ;(quantum ? qubitRegisters : clbitRegisters).push(register)
          continue
        }
        case 'gate':
          if (gates.length >= MAX_GATE_DEFINITIONS) {
            throw limitError(
              token.at,
              `This file declares more than ${String(MAX_GATE_DEFINITIONS)} ` +
                `gates, which is past what the importer reads.`
            )
          }
          gates.push(this.gateDefinition())
          continue
        default:
          break
      }

      const unsupported = UNSUPPORTED_KEYWORDS[token.text]
      if (unsupported !== undefined) {
        throw unsupportedError(
          token.at,
          token.text,
          `This file uses "${token.text}" — ${unsupported} — which a circuit ` +
            `document has no shape for.`
        )
      }

      statements.push(this.statement())
    }

    return {
      version: this.version,
      versionDeclared: this.versionDeclared,
      includes,
      qubitRegisters,
      clbitRegisters,
      gates,
      statements,
    }
  }

  private versionStatement(): void {
    this.next()
    const number = this.next()
    if (number.kind !== 'number') {
      throw syntaxError(number.at, 'The OPENQASM header needs a version.')
    }
    this.expectPunct(';', 'after the OPENQASM version')
  }

  private includeStatement(): string {
    this.next()
    const path = this.next()
    if (path.kind !== 'string') {
      throw syntaxError(
        path.at,
        'An include needs a quoted file name, as in include "stdgates.inc";.'
      )
    }
    this.expectPunct(';', 'after an include')
    return path.text
  }

  /**
   * `qreg q[3];` `creg c[3];` `qubit[3] q;` `bit c;`
   *
   * The size is checked here, against the register the *contract* can hold,
   * rather than after a register object exists. §11's rule about a malformed
   * circuit not being able to provoke a giant allocation is the reason: a file
   * containing `qreg q[1000000000];` is fifteen bytes, and the only defence
   * against it is refusing before anything is sized from that number.
   */
  private registerDeclaration(): QasmRegister {
    const keyword = this.next()
    const quantum = keyword.text === 'qreg' || keyword.text === 'qubit'
    const legacy = keyword.text === 'qreg' || keyword.text === 'creg'

    let size = 1
    let sizeAt = keyword.at
    let name: string

    if (legacy) {
      // OpenQASM 2, and the deprecated OpenQASM 3 form: name first, then size.
      name = this.expectIdentifier(`after "${keyword.text}"`).text
      this.expectPunct('[', 'after a register name')
      const literal = this.next()
      if (literal.kind !== 'number') {
        throw syntaxError(literal.at, 'A register size must be a number.')
      }
      size = literal.value
      sizeAt = literal.at
      this.expectPunct(']', 'after a register size')
    } else {
      // OpenQASM 3: the size is part of the type, and may be omitted for one.
      if (this.eatPunct('[')) {
        const literal = this.next()
        if (literal.kind !== 'number') {
          throw syntaxError(literal.at, 'A register size must be a number.')
        }
        size = literal.value
        sizeAt = literal.at
        this.expectPunct(']', 'after a register size')
      }
      name = this.expectIdentifier(`after "${keyword.text}"`).text
    }

    if (!Number.isInteger(size) || size < 1) {
      throw semanticError(
        sizeAt,
        `A register needs a whole number of bits, at least one; this one ` +
          `asks for ${String(size)}.`
      )
    }
    const ceiling = quantum ? MAX_QUBITS : MAX_CLBITS
    if (size > ceiling) {
      throw limitError(
        sizeAt,
        `This declares a register of ${String(size)} ` +
          `${quantum ? 'qubits' : 'classical bits'}; the circuit format holds ` +
          `at most ${String(ceiling)}.`
      )
    }

    if (this.atPunct('=')) {
      throw unsupportedError(
        this.peek().at,
        'register initialiser',
        'A register cannot be given a starting value on import: the circuit ' +
          'format begins every qubit in |0> and every classical bit at 0.'
      )
    }
    this.expectPunct(';', 'after a register declaration')
    return { name, size, at: keyword.at }
  }

  /**
   * `gate name(a, b) q0, q1 { … }`
   *
   * Identical in both dialects, which is worth knowing: a version-2 file's gate
   * definitions parse under version 3 unchanged, and the only thing that
   * changes is what the names inside the body resolve to.
   */
  private gateDefinition(): QasmGateDefinition {
    const at = this.next().at
    const name = this.expectIdentifier('after "gate"').text

    const params: string[] = []
    if (this.eatPunct('(')) {
      while (!this.atPunct(')')) {
        params.push(this.expectIdentifier('in a gate parameter list').text)
        if (!this.eatPunct(',')) break
      }
      this.expectPunct(')', 'after a gate parameter list')
    }

    const qubits: string[] = []
    do {
      qubits.push(this.expectIdentifier('in a gate qubit list').text)
    } while (this.eatPunct(','))

    if (qubits.length === 0) {
      throw syntaxError(at, `Gate "${name}" declares no qubits.`)
    }

    const body = this.block(`the body of gate "${name}"`)
    return { name, params, qubits, body, at }
  }

  /** `{ statement* }` with the nesting bound applied. */
  private block(context: string): QasmStatement[] {
    this.blockDepth += 1
    if (this.blockDepth > MAX_BLOCK_DEPTH) {
      throw limitError(
        this.peek().at,
        `Blocks are nested more than ${String(MAX_BLOCK_DEPTH)} deep, which ` +
          `is past what the importer reads.`
      )
    }
    try {
      this.expectPunct('{', `to open ${context}`)
      const statements: QasmStatement[] = []
      while (!this.atPunct('}')) {
        if (this.peek().kind === 'eof') {
          throw syntaxError(
            this.peek().at,
            `The file ends before ${context} is closed.`
          )
        }
        if (this.eatPunct(';')) continue
        const keyword = this.peek()
        if (keyword.kind === 'identifier') {
          const unsupported = UNSUPPORTED_KEYWORDS[keyword.text]
          if (unsupported !== undefined) {
            throw unsupportedError(
              keyword.at,
              keyword.text,
              `This block uses "${keyword.text}" — ${unsupported} — which a ` +
                `circuit document has no shape for.`
            )
          }
          if (keyword.text === 'gate') {
            throw syntaxError(
              keyword.at,
              'A gate cannot be defined inside another gate.'
            )
          }
        }
        statements.push(this.statement())
      }
      this.expectPunct('}', `to close ${context}`)
      return statements
    } finally {
      this.blockDepth -= 1
    }
  }

  /* ──────────────────────────── statements ───────────────────────────── */

  private statement(): QasmStatement {
    const token = this.peek()

    if (token.kind === 'identifier') {
      if (token.text === 'barrier') return this.barrier()
      if (token.text === 'reset') return this.reset()
      if (token.text === 'measure') return this.arrowMeasure()
      if (token.text === 'if') return this.conditional()
      if (this.looksLikeAssignment()) return this.assignedMeasure()
    }

    return this.gateCall()
  }

  /**
   * Whether the statement starting here is `target = measure source;`.
   *
   * Needs lookahead rather than a first-token test, because the statement
   * begins with an ordinary name and so does a gate call: `c[0] = measure q[0]`
   * and `crz(pi) q[0], q[1]` are distinguishable only at the `=`. The scan stops
   * at the statement's semicolon so a `==` on a later line can never be
   * mistaken for one, and `==` itself is one token, so a comparison cannot
   * match either.
   */
  private looksLikeAssignment(): boolean {
    for (let offset = 0; offset < 16; offset++) {
      const token = this.peek(offset)
      if (token.kind === 'eof') return false
      if (token.kind !== 'punct') continue
      if (token.text === ';' || token.text === '{') return false
      if (token.text === '=') return true
    }
    return false
  }

  private barrier(): QasmStatement {
    const at = this.next().at
    const operands: QasmOperand[] = []
    if (!this.atPunct(';')) {
      do {
        operands.push(this.operand())
      } while (this.eatPunct(','))
    }
    this.expectPunct(';', 'after a barrier')
    return { kind: 'barrier', operands, at }
  }

  private reset(): QasmStatement {
    const at = this.next().at
    const operands: QasmOperand[] = []
    do {
      operands.push(this.operand())
    } while (this.eatPunct(','))
    this.expectPunct(';', 'after a reset')
    return { kind: 'reset', operands, at }
  }

  /** `measure q[0] -> c[0];` — the only form OpenQASM 2 has. */
  private arrowMeasure(): QasmStatement {
    const at = this.next().at
    const source = this.operand()
    let target: QasmOperand | null = null
    if (this.eatPunct('->')) target = this.operand()
    this.expectPunct(';', 'after a measurement')
    return { kind: 'measure', source, target, at }
  }

  /** `c[0] = measure q[0];` — OpenQASM 3 only. */
  private assignedMeasure(): QasmStatement {
    const at = this.peek().at
    const target = this.operand()
    this.expectPunct('=', 'in an assignment')
    if (!this.atIdentifier('measure')) {
      throw unsupportedError(
        this.peek().at,
        'classical assignment',
        'The only assignment a circuit document can carry is a measurement, ' +
          'as in c[0] = measure q[0];.'
      )
    }
    if (this.version === 2) {
      throw unsupportedError(
        at,
        'c = measure q',
        'This is the OpenQASM 3 spelling of a measurement in a file declared ' +
          'as OpenQASM 2, which writes measure q[0] -> c[0]; instead.'
      )
    }
    this.next()
    const source = this.operand()
    this.expectPunct(';', 'after a measurement')
    return { kind: 'measure', source, target, at }
  }

  /**
   * `if (…) …`, in both dialects and with `else`.
   *
   * The condition's *shape* is read here and judged in `lower.ts`, because
   * whether `if (c == 1)` can be expressed depends on how wide `c` is and this
   * file does not know. What is decided here is only which spellings are
   * conditions at all: a comparison of a register or one of its bits against a
   * constant. An arbitrary boolean expression — `if (c[0] && c[1])` — is
   * refused by name, since it is a real OpenQASM 3 feature and the reader
   * deserves to be told that rather than shown a parse error.
   */
  private conditional(): QasmStatement {
    const at = this.next().at
    this.expectPunct('(', 'after "if"')

    const register = this.expectIdentifier('in an if condition').text
    let bit: number | null = null
    if (this.eatPunct('[')) {
      const literal = this.next()
      if (literal.kind !== 'number' || !Number.isInteger(literal.value)) {
        throw syntaxError(literal.at, 'A bit index must be a whole number.')
      }
      bit = literal.value
      this.expectPunct(']', 'after a bit index')
    }

    let value = 1
    if (this.eatPunct('==')) {
      const literal = this.next()
      if (literal.kind === 'number') {
        value = literal.value
      } else if (literal.kind === 'identifier' && literal.text === 'true') {
        value = 1
      } else if (literal.kind === 'identifier' && literal.text === 'false') {
        value = 0
      } else {
        throw unsupportedError(
          literal.at,
          'if condition',
          'A condition compares a classical bit or register against a ' +
            'constant. Anything richer has no shape in the circuit format.'
        )
      }
    } else if (!this.atPunct(')')) {
      // `if (c[0])` — a bit used directly as a truth value — reached the `)`
      // above. Anything else here is an operator the contract cannot express.
      throw unsupportedError(
        this.peek().at,
        'if condition',
        'A condition compares a classical bit or register against a ' +
          'constant with "==". Anything richer has no shape in the circuit ' +
          'format.'
      )
    }

    this.expectPunct(')', 'after an if condition')

    const body = this.conditionalBody('the body of an if')
    let otherwise: QasmStatement[] | null = null
    if (this.atIdentifier('else')) {
      this.next()
      otherwise = this.conditionalBody('the body of an else')
    }

    return { kind: 'if', register, bit, value, body, otherwise, at }
  }

  /**
   * The body of an `if` or an `else`: a braced block, or a single statement.
   *
   * OpenQASM 2 has only the single-statement form and OpenQASM 3 has both;
   * accepting both in both dialects costs nothing and reads every real file.
   */
  private conditionalBody(context: string): QasmStatement[] {
    if (this.atPunct('{')) return this.block(context)
    this.blockDepth += 1
    if (this.blockDepth > MAX_BLOCK_DEPTH) {
      throw limitError(
        this.peek().at,
        `Blocks are nested more than ${String(MAX_BLOCK_DEPTH)} deep.`
      )
    }
    try {
      return [this.statement()]
    } finally {
      this.blockDepth -= 1
    }
  }

  /**
   * A gate call, with any modifiers in front of it.
   *
   * `gphase(pi);` is a gate call with no qubits at all, which is why the operand
   * list is allowed to be empty here and rejected — where it matters — against
   * the gate's declared arity in `lower.ts`.
   */
  private gateCall(): QasmStatement {
    const at = this.peek().at
    const modifiers = this.modifiers()

    const name = this.expectIdentifier('at the start of a statement')
    if (STATEMENT_KEYWORDS.has(name.text)) {
      throw syntaxError(
        name.at,
        `"${name.text}" is a keyword and cannot be used as a gate name here.`
      )
    }

    const args: QasmExpr[] = []
    if (this.eatPunct('(')) {
      while (!this.atPunct(')')) {
        args.push(this.expression())
        if (!this.eatPunct(',')) break
      }
      this.expectPunct(')', 'after a gate argument list')
    }

    const operands: QasmOperand[] = []
    if (!this.atPunct(';')) {
      do {
        operands.push(this.operand())
      } while (this.eatPunct(','))
    }
    this.expectPunct(';', `after the call to "${name.text}"`)

    return { kind: 'gateCall', name: name.text, modifiers, args, operands, at }
  }

  /** `ctrl @`, `negctrl(2) @`, `inv @`, `pow(3) @` — OpenQASM 3 only. */
  private modifiers(): QasmModifier[] {
    const modifiers: QasmModifier[] = []
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'identifier') break
      const kind = token.text
      if (
        kind !== 'ctrl' &&
        kind !== 'negctrl' &&
        kind !== 'inv' &&
        kind !== 'pow'
      ) {
        break
      }
      // A gate may legitimately be *called* `pow` in a file that defines one,
      // so a modifier is only a modifier when an `@` follows it (possibly after
      // its parenthesised argument). Without this, `inv q[0];` — a call to a
      // user gate named `inv` — would be read as a modifier with no gate.
      if (!this.modifierFollows()) break

      if (modifiers.length >= MAX_MODIFIERS) {
        throw limitError(
          token.at,
          `More than ${String(MAX_MODIFIERS)} modifiers are stacked on one ` +
            `gate, which is past what the importer reads.`
        )
      }
      if (this.version === 2) {
        throw unsupportedError(
          token.at,
          `${kind} @`,
          `Gate modifiers are an OpenQASM 3 feature, and this file declares ` +
            `OpenQASM 2.`
        )
      }

      this.next()
      if (kind === 'inv') {
        this.expectPunct('@', 'after "inv"')
        modifiers.push({ kind, at: token.at })
        continue
      }
      if (kind === 'pow') {
        this.expectPunct('(', 'after "pow"')
        const exponent = this.expression()
        this.expectPunct(')', 'after a pow exponent')
        this.expectPunct('@', 'after "pow(…)"')
        modifiers.push({ kind, exponent, at: token.at })
        continue
      }
      let count: QasmExpr | null = null
      if (this.eatPunct('(')) {
        count = this.expression()
        this.expectPunct(')', `after "${kind}(…"`)
      }
      this.expectPunct('@', `after "${kind}"`)
      modifiers.push({ kind, count, at: token.at })
    }
    return modifiers
  }

  /** Whether an `@` follows the modifier keyword at the cursor. */
  private modifierFollows(): boolean {
    if (this.atPunct('@', 1)) return true
    if (!this.atPunct('(', 1)) return false
    let depth = 0
    for (let offset = 1; offset < 32; offset++) {
      const token = this.peek(offset)
      if (token.kind === 'eof') return false
      if (token.kind !== 'punct') continue
      if (token.text === '(') depth += 1
      else if (token.text === ')') {
        depth -= 1
        if (depth === 0) return this.atPunct('@', offset + 1)
      } else if (token.text === ';') return false
    }
    return false
  }

  /** `q` or `q[2]`. */
  private operand(): QasmOperand {
    const name = this.expectIdentifier('where a qubit or bit was expected')
    let index: number | null = null
    if (this.eatPunct('[')) {
      const literal = this.next()
      if (literal.kind !== 'number' || !Number.isInteger(literal.value)) {
        throw syntaxError(
          literal.at,
          'A register index must be a whole number.'
        )
      }
      if (literal.value < 0) {
        throw semanticError(literal.at, 'A register index cannot be negative.')
      }
      index = literal.value
      this.expectPunct(']', 'after a register index')
    }
    return { name: name.text, index, at: name.at }
  }

  /* ──────────────────────────── expressions ──────────────────────────── */

  /**
   * Precedence climbing, lowest first: `+ -`, then `* /`, then unary, then
   * `**`/`^` (right-associative, as in both dialects and in mathematics).
   *
   * `^` is OpenQASM 2's exponent operator and `**` is OpenQASM 3's. Both are
   * accepted in both dialects: they cannot be confused with anything else here,
   * because this contract has no integer type and therefore no bitwise xor for
   * `^` to mean.
   */
  private expression(): QasmExpr {
    // Reset only at the top: a parenthesised sub-expression and a function
    // argument are part of the same angle and share its budget, which is the
    // only reading under which the bound is a bound on the tree.
    if (this.expressionDepth === 0) this.expressionNodes = 0
    return this.additive()
  }

  private additive(): QasmExpr {
    let left = this.multiplicative()
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'punct') break
      if (token.text !== '+' && token.text !== '-') break
      this.next()
      const right = this.multiplicative()
      left = { kind: 'binary', op: token.text, left, right, at: token.at }
    }
    return left
  }

  private multiplicative(): QasmExpr {
    let left = this.unary()
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'punct') break
      if (token.text !== '*' && token.text !== '/') break
      this.next()
      const right = this.unary()
      left = { kind: 'binary', op: token.text, left, right, at: token.at }
    }
    return left
  }

  /**
   * Unary sign, and the one place the expression depth is counted.
   *
   * Every way this grammar nests passes through here exactly once per level —
   * a parenthesis reaches `primary`, which re-enters `expression`, which
   * reaches `unary` again; a chain of signs recurses here directly. Counting in
   * one place rather than at every entry point is what makes the bound a fact
   * about nesting rather than about which production happened to be involved.
   *
   * The operand recurses into `unary` and not into `expression`: `-1 + 2` is
   * `(-1) + 2` and not `-(1 + 2)`, and the two differ by 4.
   */
  private unary(): QasmExpr {
    this.expressionDepth += 1
    if (this.expressionDepth > MAX_EXPRESSION_DEPTH) {
      throw limitError(
        this.peek().at,
        `This expression nests more than ${String(MAX_EXPRESSION_DEPTH)} ` +
          `levels deep, which is past what the importer reads.`
      )
    }
    /*
     * Counted here for the same reason the depth is: every operand of every
     * production passes through `unary` exactly once, so one counter bounds the
     * whole tree however it was written. A binary node always has an operand,
     * so bounding operands bounds nodes.
     */
    this.expressionNodes += 1
    if (this.expressionNodes > MAX_EXPRESSION_NODES) {
      this.expressionDepth -= 1
      throw limitError(
        this.peek().at,
        `This expression has more than ${String(MAX_EXPRESSION_NODES)} ` +
          `terms, which is past what the importer evaluates.`
      )
    }
    try {
      const token = this.peek()
      if (
        token.kind === 'punct' &&
        (token.text === '-' || token.text === '+')
      ) {
        this.next()
        return {
          kind: 'unary',
          op: token.text,
          operand: this.unary(),
          at: token.at,
        }
      }
      return this.power()
    } finally {
      this.expressionDepth -= 1
    }
  }

  private power(): QasmExpr {
    const base = this.primary()
    const token = this.peek()
    if (token.kind === 'punct' && (token.text === '**' || token.text === '^')) {
      this.next()
      // Right-associative: `2 ** 3 ** 2` is 2 ** 9, and recursing through
      // `unary` rather than `power` is also what lets `2 ** -1` parse.
      return {
        kind: 'binary',
        op: '**',
        left: base,
        right: this.unary(),
        at: token.at,
      }
    }
    return base
  }

  private primary(): QasmExpr {
    const token = this.next()

    if (token.kind === 'number') {
      return { kind: 'number', value: token.value, at: token.at }
    }

    if (token.kind === 'punct' && token.text === '(') {
      const inner = this.expression()
      this.expectPunct(')', 'to close a parenthesised expression')
      return inner
    }

    if (token.kind === 'identifier') {
      if (this.atPunct('(')) {
        this.next()
        const args: QasmExpr[] = []
        while (!this.atPunct(')')) {
          args.push(this.expression())
          if (!this.eatPunct(',')) break
        }
        this.expectPunct(')', 'after a function argument list')
        return { kind: 'call', callee: token.text, args, at: token.at }
      }
      return { kind: 'name', name: token.text, at: token.at }
    }

    throw syntaxError(
      token.at,
      `Expected an angle, but found ${this.describe(token)}.`
    )
  }
}

/**
 * Every keyword this importer refuses by name.
 *
 * Exported so the test suite can assert the promise rather than a sample of it:
 * each one of these has to produce an `unsupported` error whose `construct` is
 * the keyword itself, because "say what the construct is rather than failing
 * generically" is the requirement, and a list is the only way to check it does
 * not rot.
 */
export function unsupportedKeywords(): readonly string[] {
  return Object.keys(UNSUPPORTED_KEYWORDS)
}
