/**
 * The shape the parser produces: OpenQASM as a tree, before anything has been
 * decided about what it means.
 *
 * ── WHY THERE IS A TREE AT ALL ───────────────────────────────────────────
 *
 * The parser could have emitted contract operations directly and saved a pass.
 * It does not, for two reasons that are both about being able to say no:
 *
 *  1. **Order of declaration is not order of execution.** A `gate` definition
 *     may be used before the reader has finished learning what is in it, a
 *     register's width is needed by every statement that mentions it, and the
 *     dialect is only known once the header has been read. Lowering as we parse
 *     would mean guessing, and a guess in an importer is how a file quietly
 *     imports as something else.
 *  2. **The refusals belong in one place.** Every construct this contract
 *     cannot carry — `for`, `def`, a conditional over a whole register, a
 *     controlled `swap` — is refused with a sentence naming it. Those sentences
 *     are about *meaning*, and a parser that had to produce them would be a
 *     parser that also knew the gate catalog.
 *
 * So this layer answers only "is this OpenQASM, and what does it say", and
 * `lower.ts` answers "can this contract hold it".
 *
 * Every node carries the position of its first token, because every refusal
 * downstream needs one and reconstructing it later is impossible.
 */

import type { QasmPosition } from './errors.js'

/** Which spelling of the language a file was written in. */
export type QasmVersion = 2 | 3

/* ────────────────────────────── expressions ──────────────────────────── */

/**
 * An angle, as written.
 *
 * Kept as a tree rather than evaluated in the parser because inside a `gate`
 * body an expression may name the definition's formal parameters, which have no
 * value until a call site supplies one — `rz(theta/2) a;` is meaningless until
 * somebody writes `myGate(pi/4) q[0];`.
 */
export type QasmExpr =
  | {
      readonly kind: 'number'
      readonly value: number
      readonly at: QasmPosition
    }
  | { readonly kind: 'name'; readonly name: string; readonly at: QasmPosition }
  | {
      readonly kind: 'unary'
      readonly op: '+' | '-'
      readonly operand: QasmExpr
      readonly at: QasmPosition
    }
  | {
      readonly kind: 'binary'
      readonly op: '+' | '-' | '*' | '/' | '**'
      readonly left: QasmExpr
      readonly right: QasmExpr
      readonly at: QasmPosition
    }
  | {
      readonly kind: 'call'
      readonly callee: string
      readonly args: readonly QasmExpr[]
      readonly at: QasmPosition
    }

/* ─────────────────────────────── operands ────────────────────────────── */

/**
 * A qubit or a classical bit, as named in the file: `q`, `q[2]`.
 *
 * `index === null` means the whole register, which is not a shorthand but a
 * language feature — `h q;` on a three-qubit register is three Hadamards, and
 * `cx a, b;` on two registers of the same width is a broadcast. Resolving that
 * needs the register's size, so it happens in `lower.ts`.
 */
export interface QasmOperand {
  readonly name: string
  readonly index: number | null
  readonly at: QasmPosition
}

/* ─────────────────────────────── modifiers ───────────────────────────── */

/**
 * An OpenQASM 3 gate modifier. Version 2 has none of these, which is one of the
 * real differences between the dialects rather than a matter of spelling.
 *
 * `ctrl(n) @` consumes `n` qubits from the front of the operand list; the count
 * is an expression because the language says so, even though every real file
 * writes a literal.
 */
export type QasmModifier =
  | {
      readonly kind: 'ctrl' | 'negctrl'
      readonly count: QasmExpr | null
      readonly at: QasmPosition
    }
  | { readonly kind: 'inv'; readonly at: QasmPosition }
  | {
      readonly kind: 'pow'
      readonly exponent: QasmExpr
      readonly at: QasmPosition
    }

/* ────────────────────────────── statements ───────────────────────────── */

export interface QasmGateCall {
  readonly kind: 'gateCall'
  readonly name: string
  readonly modifiers: readonly QasmModifier[]
  readonly args: readonly QasmExpr[]
  readonly operands: readonly QasmOperand[]
  readonly at: QasmPosition
}

export interface QasmBarrier {
  readonly kind: 'barrier'
  /** Empty means the whole machine, which the language allows. */
  readonly operands: readonly QasmOperand[]
  readonly at: QasmPosition
}

export interface QasmReset {
  readonly kind: 'reset'
  readonly operands: readonly QasmOperand[]
  readonly at: QasmPosition
}

export interface QasmMeasure {
  readonly kind: 'measure'
  readonly source: QasmOperand
  /**
   * Where the result goes. `null` for OpenQASM 3's `measure q;` as an
   * expression statement, which discards the bit — accepted so the file parses,
   * refused in lowering because a measurement the contract cannot record is a
   * measurement it cannot run.
   */
  readonly target: QasmOperand | null
  readonly at: QasmPosition
}

/**
 * A classical conditional.
 *
 * `bit === null` is a comparison against the *whole* register, which is the
 * only form OpenQASM 2 has (`if (c == 3)`), and `bit` is set for OpenQASM 3's
 * `if (c[0] == true)`. Both reach lowering, which is where the contract's own
 * shape — one bit against one value (§6) — decides which of them can be
 * expressed.
 *
 * `otherwise` is `else`. It is representable, and cheaply: the same operations
 * conditioned on the opposite value of the same bit.
 */
export interface QasmIf {
  readonly kind: 'if'
  readonly register: string
  readonly bit: number | null
  readonly value: number
  readonly body: readonly QasmStatement[]
  readonly otherwise: readonly QasmStatement[] | null
  readonly at: QasmPosition
}

export type QasmStatement =
  QasmGateCall | QasmBarrier | QasmReset | QasmMeasure | QasmIf

/* ───────────────────────────── declarations ──────────────────────────── */

export interface QasmRegister {
  readonly name: string
  readonly size: number
  readonly at: QasmPosition
}

export interface QasmGateDefinition {
  readonly name: string
  /** Formal parameter names, positional. */
  readonly params: readonly string[]
  /** Formal qubit names, positional. */
  readonly qubits: readonly string[]
  readonly body: readonly QasmStatement[]
  readonly at: QasmPosition
}

/** A whole file, read. */
export interface QasmProgram {
  readonly version: QasmVersion
  /** Whether an `OPENQASM` header said so, or the version was inferred. */
  readonly versionDeclared: boolean
  /** Include paths as written, in order. Never fetched — see `library.ts`. */
  readonly includes: readonly string[]
  readonly qubitRegisters: readonly QasmRegister[]
  readonly clbitRegisters: readonly QasmRegister[]
  readonly gates: readonly QasmGateDefinition[]
  readonly statements: readonly QasmStatement[]
}
