/**
 * Angles, evaluated.
 *
 * ── WHY THERE ARE TWO WAYS TO EVALUATE THE SAME TREE ─────────────────────
 *
 * At a call site, every angle is a number: `rz(pi/4) q[0];` has one value and
 * this file computes it. Inside a `gate` definition, an angle may name a formal
 * parameter that has no value yet — `gate rzz(theta) a, b { rz(theta) b; }` —
 * and the contract can carry that, because a custom gate declares its own
 * `params` (M2.3) and an operation inside the body may reference one by name.
 *
 * So `evaluate` answers a number, and `evaluateSymbolic` answers either a
 * number or the *name* of a formal, refusing anything in between. The refusal
 * is the interesting half: `rz(theta/2) b;` has no shape in the contract, whose
 * parameter is a name or a literal and never an expression. Rather than fail,
 * the caller catches `NotRepresentable` and inlines that definition at each of
 * its call sites, where `theta` does have a value and this file's first half
 * applies. Nothing is lost and nothing is approximated; the block simply stops
 * being a block.
 *
 * ── WHY EVERY RESULT IS CHECKED FOR FINITENESS ───────────────────────────
 *
 * `1/0`, `ln(0)` and `sqrt(-1)` are all writable, and all three produce a
 * double the gate catalog has no meaning at: `formatAngle` throws on one, and
 * `matrixFor` refuses one a layer below that. Catching it here means the reader
 * is told which sub-expression it was and on which line, rather than meeting a
 * `RangeError` from three files away.
 */

import { semanticError, unsupportedError } from './errors.js'
import type { QasmExpr } from './ast.js'

/**
 * Named constants, in every spelling either dialect offers.
 *
 * `π`, `τ` and `ℇ` are OpenQASM 3's Unicode forms and the lexer already treats
 * them as identifier characters, so they arrive here as ordinary names and
 * resolve through the same table as `pi` — which is what makes it impossible
 * for the two spellings to end up meaning different doubles.
 */
const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  π: Math.PI,
  tau: 2 * Math.PI,
  τ: 2 * Math.PI,
  euler: Math.E,
  ℇ: Math.E,
}

/**
 * The functions both dialects define, plus OpenQASM 3's additions.
 *
 * Deliberately a closed list. A file calling `popcount` or `rotl` is doing
 * integer arithmetic, which this contract has no values for, and being told the
 * function is unsupported by name is more use than being told an angle would
 * not evaluate.
 */
const FUNCTIONS: Readonly<Record<string, (x: number) => number>> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  sqrt: Math.sqrt,
  abs: Math.abs,
  ceiling: Math.ceil,
  floor: Math.floor,
}

/** Thrown when an expression cannot be carried symbolically. Never escapes. */
export class NotRepresentable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotRepresentable'
  }
}

/** A value the contract can hold in `params`: a literal, or a parameter name. */
export type SymbolicValue = number | { readonly formal: string }

/** Evaluates an angle to a number. Every name must be a constant. */
export function evaluate(
  expr: QasmExpr,
  scope: ReadonlyMap<string, number>
): number {
  switch (expr.kind) {
    case 'number':
      return expr.value

    case 'name': {
      const constant = CONSTANTS[expr.name]
      if (constant !== undefined) return constant
      const bound = scope.get(expr.name)
      if (bound !== undefined) return bound
      throw semanticError(
        expr.at,
        `"${expr.name}" is not a known constant and is not a parameter of ` +
          `the gate being defined, so it has no value here.`
      )
    }

    case 'unary': {
      const operand = evaluate(expr.operand, scope)
      return expr.op === '-' ? -operand : operand
    }

    case 'binary': {
      const left = evaluate(expr.left, scope)
      const right = evaluate(expr.right, scope)
      const value =
        expr.op === '+'
          ? left + right
          : expr.op === '-'
            ? left - right
            : expr.op === '*'
              ? left * right
              : expr.op === '/'
                ? left / right
                : left ** right
      return finite(
        value,
        expr,
        `${expr.op} on ${String(left)} and ${String(right)}`
      )
    }

    case 'call': {
      const fn = FUNCTIONS[expr.callee]
      if (fn === undefined) {
        throw unsupportedError(
          expr.at,
          expr.callee,
          `"${expr.callee}" is not one of the functions an angle may use ` +
            `(${Object.keys(FUNCTIONS).join(', ')}).`
        )
      }
      if (expr.args.length !== 1) {
        throw semanticError(
          expr.at,
          `"${expr.callee}" takes exactly one argument, and this call ` +
            `passes ${String(expr.args.length)}.`
        )
      }
      const argument = evaluate(expr.args[0] as QasmExpr, scope)
      return finite(fn(argument), expr, `${expr.callee}(${String(argument)})`)
    }
  }
}

/**
 * Evaluates an angle that may name a formal parameter of the gate being
 * defined.
 *
 * Answers the formal's *name* when the expression is exactly that name, a
 * number when it involves no formal at all, and throws `NotRepresentable` for
 * everything else — which is not an error, only the answer "this definition
 * cannot be a block".
 */
export function evaluateSymbolic(
  expr: QasmExpr,
  formals: ReadonlySet<string>
): SymbolicValue {
  if (expr.kind === 'name' && formals.has(expr.name)) {
    // A formal shadows a constant, which is the language's own scoping rule and
    // also the only reading that lets a definition be copied between documents
    // (§3.1 decision 1): `gate g(pi) q { rz(pi) q; }` means the argument.
    return { formal: expr.name }
  }
  if (mentions(expr, formals)) {
    throw new NotRepresentable(
      'This angle computes with a gate parameter, and a circuit operation ' +
        'holds either a literal angle or a parameter name.'
    )
  }
  return evaluate(expr, new Map())
}

/** Whether any name in `formals` appears anywhere in the expression. */
function mentions(expr: QasmExpr, formals: ReadonlySet<string>): boolean {
  switch (expr.kind) {
    case 'number':
      return false
    case 'name':
      return formals.has(expr.name)
    case 'unary':
      return mentions(expr.operand, formals)
    case 'binary':
      return mentions(expr.left, formals) || mentions(expr.right, formals)
    case 'call':
      return expr.args.some((argument) => mentions(argument, formals))
  }
}

function finite(value: number, expr: QasmExpr, what: string): number {
  if (Number.isFinite(value)) return value
  throw semanticError(
    expr.at,
    `${what} is ${String(value)}, and an angle must be a finite number.`
  )
}
