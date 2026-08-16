/**
 * The tokeniser — the first half of a real parser, and the reason there are no
 * regular expressions downstream of it.
 *
 * ── WHY NOT REGULAR EXPRESSIONS ──────────────────────────────────────────
 *
 * A reader built out of line-shaped patterns works on the files its author had
 * open and fails on the first one that is laid out differently. All of these
 * are the same program:
 *
 *     cx q[0],q[1];
 *     cx   q [ 0 ] , q [ 1 ] ;
 *     cx q[0], // the control
 *        q[1];
 *
 * and so is the same statement with a block comment wedged between the gate
 * name and its first operand. All of them mean the same thing, because OpenQASM
 * is free-form: a newline is whitespace, a comment may sit anywhere whitespace
 * may, and a statement ends at its semicolon and nowhere else. A tokeniser is
 * what makes that true by construction instead of by a pattern that happened to
 * anticipate it.
 *
 * ── WHAT THIS LAYER DECIDES, AND WHAT IT REFUSES TO ──────────────────────
 *
 * It knows characters and nothing else: no keywords, no statement shapes, no
 * versions. `qreg`, `qubit`, `measure` and `myGate` are all one kind of token
 * here, because whether `qreg` is a keyword depends on the dialect and the
 * dialect is the parser's business. Keeping that decision out of this file is
 * what lets one tokeniser serve OpenQASM 2 and 3 — which differ in their
 * *grammar*, not in what a number or an identifier looks like.
 *
 * Two exceptions, both about characters rather than meaning: `**` is one token
 * and not two (OpenQASM 3's exponent operator), and the Unicode spellings `π`,
 * `τ` and `ℇ` are identifier characters here so that `π/2` tokenises the way
 * `pi/2` does.
 *
 * ── POSITIONS ────────────────────────────────────────────────────────────
 *
 * Every token carries the line and column it starts at, one-based, counted in
 * code points so that a column number means what it means in an editor. This is
 * the whole reason the importer can point at a mistake: nothing below this file
 * ever has to guess where it is.
 */

import {
  MAX_IDENTIFIER_LENGTH,
  MAX_SOURCE_LENGTH,
  MAX_TOKENS,
} from './limits.js'
import { limitError, syntaxError, type QasmPosition } from './errors.js'

export type TokenKind =
  /** A name, a keyword, or one of the Unicode constants. */
  | 'identifier'
  /** A numeric literal, already converted. */
  | 'number'
  /** A double- or single-quoted string, already unescaped. */
  | 'string'
  /** Punctuation and operators, verbatim: `;` `,` `->` `**` … */
  | 'punct'
  /** One past the last character. Always present, exactly once, at the end. */
  | 'eof'

export interface Token {
  readonly kind: TokenKind
  /** The token's text; for `number`, the literal as written. */
  readonly text: string
  /** Set only for `number`. */
  readonly value: number
  readonly at: QasmPosition
}

/**
 * Multi-character punctuation, longest first.
 *
 * Order is load-bearing: `**` has to be tried before `*`, and `->` before `-`,
 * or the parser would see two tokens where the language has one.
 *
 * The comparison operators are here even though this contract can only express
 * `==` — a file using `>=` should be told that a conditional it wrote is not
 * supported, which needs the token to exist. Refusing it as an unreadable
 * character would blame the wrong thing.
 */
const PUNCTUATORS: readonly string[] = [
  '->',
  '**',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  ';',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '@',
  ':',
  '~',
  '!',
  '<',
  '>',
  '&',
  '|',
  '.',
  '#',
]

/**
 * Unicode constants OpenQASM 3 accepts as spellings of `pi`, `tau` and `euler`.
 *
 * Treated as identifier characters rather than as their own token kind, so that
 * the expression evaluator resolves them through the same name table as the
 * ASCII spellings and cannot disagree with itself about their value.
 */
const UNICODE_CONSTANTS = new Set(['π', 'τ', 'ℇ'])

function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    character === '_' ||
    character === '$' ||
    UNICODE_CONSTANTS.has(character)
  )
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || (character >= '0' && character <= '9')
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

/**
 * Whitespace, by code point rather than by literal.
 *
 * Space, tab, line feed, vertical tab, form feed and carriage return — the six
 * the C family calls whitespace, and the set OpenQASM inherits. Every other
 * control character falls through to the refusal at the end of the scan,
 * because a control character in a source file is either corruption or an
 * attempt to hide something, and neither should tokenise into nothing.
 *
 * Written as a numeric comparison for the reason `program.ts` gives about
 * control characters in source: a literal one inside a string literal is
 * invisible in a diff and easy to damage in an edit.
 */
function isWhitespace(character: string): boolean {
  const code = character.charCodeAt(0)
  return code === 0x20 || (code >= 0x09 && code <= 0x0d)
}

/**
 * Reads a whole file into tokens.
 *
 * Everything is read up front rather than on demand. A QASM file is bounded by
 * `MAX_SOURCE_LENGTH` and therefore small, and a token array the parser can
 * look ahead in freely is what keeps the parser from needing to push characters
 * back — the source of most one-token-off bugs in hand-written parsers.
 */
export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw limitError(
      { line: 1, column: 1 },
      `This file is ${String(source.length)} characters long; the importer ` +
        `reads at most ${String(MAX_SOURCE_LENGTH)}.`
    )
  }

  const tokens: Token[] = []
  let index = 0
  let line = 1
  let column = 1

  const here = (): QasmPosition => ({ line, column })

  /** Advances over `count` code units, keeping the position honest. */
  const advance = (count: number): void => {
    for (let step = 0; step < count; step++) {
      const character = source[index]
      index += 1
      if (character === '\n') {
        line += 1
        column = 1
        continue
      }
      // A surrogate pair is one character on screen and therefore one column.
      // Counting both halves would make every column after an emoji wrong.
      if (character !== undefined && isLowSurrogate(character)) continue
      column += 1
    }
  }

  while (index < source.length) {
    const character = source[index] as string

    if (isWhitespace(character)) {
      advance(1)
      continue
    }

    // `//` to end of line. The newline itself is left for `advance` above, so
    // the line counter never has to be adjusted in two places.
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') advance(1)
      continue
    }

    if (character === '/' && source[index + 1] === '*') {
      const opened = here()
      advance(2)
      for (;;) {
        if (index >= source.length) {
          // The truncated-file case, named precisely. A block comment that
          // swallows the rest of the file otherwise produces "unexpected end of
          // input" pointing at the last line, which sends the reader to the
          // wrong end of their mistake.
          throw syntaxError(
            opened,
            'This block comment is never closed: the file ends before its `*/`.'
          )
        }
        if (source[index] === '*' && source[index + 1] === '/') {
          advance(2)
          break
        }
        advance(1)
      }
      continue
    }

    const at = here()

    if (isIdentifierStart(character)) {
      const start = index
      while (
        index < source.length &&
        isIdentifierPart(source[index] as string)
      ) {
        advance(1)
      }
      const text = source.slice(start, index)
      if (text.length > MAX_IDENTIFIER_LENGTH) {
        throw limitError(
          at,
          `This name is ${String(text.length)} characters long; the ` +
            `importer reads names of at most ` +
            `${String(MAX_IDENTIFIER_LENGTH)}.`
        )
      }
      push(tokens, { kind: 'identifier', text, value: 0, at })
      continue
    }

    if (
      isDigit(character) ||
      (character === '.' && isDigit(nextOf(source, index)))
    ) {
      push(tokens, readNumber())
      continue
    }

    if (character === '"' || character === "'") {
      push(tokens, readString(character))
      continue
    }

    const punctuator = PUNCTUATORS.find((candidate) =>
      source.startsWith(candidate, index)
    )
    if (punctuator !== undefined) {
      advance(punctuator.length)
      push(tokens, { kind: 'punct', text: punctuator, value: 0, at })
      continue
    }

    throw syntaxError(
      at,
      `This character cannot appear in an OpenQASM program: ` +
        `${describeCharacter(character)}.`
    )
  }

  tokens.push({ kind: 'eof', text: '', value: 0, at: here() })
  return tokens

  function push(into: Token[], token: Token): void {
    if (into.length >= MAX_TOKENS) {
      throw limitError(
        token.at,
        `This file has more than ${String(MAX_TOKENS)} tokens, which is ` +
          `past what the importer reads.`
      )
    }
    into.push(token)
  }

  /**
   * A numeric literal.
   *
   * `1`, `1.`, `.5`, `1e-3`, `1_000` — the last because OpenQASM 3 allows
   * digit separators, and a file using them would otherwise tokenise as a
   * number followed by an identifier and produce a baffling message.
   *
   * Parsed with `Number` on the cleaned text rather than assembled digit by
   * digit: `Number` implements the same shortest-round-trip reading that
   * `angles.ts` relies on for the way *out*, so a decimal exported by this
   * package reads back as the identical double.
   */
  function readNumber(): Token {
    const at = here()
    const start = index
    let seenDot = false
    let seenExponent = false

    while (index < source.length) {
      const character = source[index] as string
      if (isDigit(character) || character === '_') {
        advance(1)
        continue
      }
      if (character === '.' && !seenDot && !seenExponent) {
        seenDot = true
        advance(1)
        continue
      }
      if ((character === 'e' || character === 'E') && !seenExponent) {
        const after = source[index + 1]
        const afterThat = source[index + 2]
        const exponentFollows =
          (after !== undefined && isDigit(after)) ||
          ((after === '+' || after === '-') &&
            afterThat !== undefined &&
            isDigit(afterThat))
        if (!exponentFollows) break
        seenExponent = true
        advance(after === '+' || after === '-' ? 2 : 1)
        continue
      }
      break
    }

    const text = source.slice(start, index)
    const value = Number(text.replace(/_/g, ''))
    if (!Number.isFinite(value)) {
      // `1e999` is a syntactically fine literal that is not a number the
      // document can carry: every angle in the contract is a finite Float64.
      throw syntaxError(
        at,
        `"${text}" is not a finite number, so it cannot be an angle.`
      )
    }
    return { kind: 'number', text, value, at }
  }

  /** A quoted string. Only `include` uses one, so the escapes are minimal. */
  function readString(quote: string): Token {
    const at = here()
    advance(1)
    let text = ''
    for (;;) {
      if (index >= source.length) {
        throw syntaxError(
          at,
          'This string is never closed: the file ends before its quote.'
        )
      }
      const character = source[index] as string
      if (character === '\n') {
        throw syntaxError(at, 'A string cannot run past the end of its line.')
      }
      if (character === quote) {
        advance(1)
        return { kind: 'string', text, value: 0, at }
      }
      if (character === '\\' && index + 1 < source.length) {
        text += source[index + 1] as string
        advance(2)
        continue
      }
      text += character
      advance(1)
    }
  }
}

function nextOf(source: string, index: number): string {
  return source[index + 1] ?? ''
}

function isLowSurrogate(character: string): boolean {
  const code = character.charCodeAt(0)
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * A character named in a way a reader can find it.
 *
 * Printing a control character verbatim into an error message puts it in a log
 * line, a DOM node and a translated sentence, which is how a NUL ends up
 * somewhere that refuses one (`text.ts` documents the Postgres case). The code
 * point is what identifies it anyway.
 */
function describeCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0
  const hex = code.toString(16).toUpperCase().padStart(4, '0')
  const printable = code > 0x20 && code !== 0x7f
  return printable ? `"${character}" (U+${hex})` : `U+${hex}`
}
