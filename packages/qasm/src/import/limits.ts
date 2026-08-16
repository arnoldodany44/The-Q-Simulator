/**
 * The ceilings, in one file — specification §11.
 *
 * ── WHY AN IMPORTER NEEDS THESE AT ALL ───────────────────────────────────
 *
 * A QASM file is a stranger's upload, and §11 says a malformed circuit must not
 * be able to provoke an infinite loop or a giant allocation. The circuit
 * contract already bounds what a *circuit* may be (28 qubits, 64 classical
 * bits, 4096 columns, 16384 expanded operations), and `parseCircuit` enforces
 * all of it — but only once a circuit exists. Everything between the first
 * character and that call is unguarded unless it is guarded here:
 *
 *   - `qreg q[1000000000];` is eleven characters and, without a check at the
 *     declaration, an array of a billion.
 *   - `gate a q { b q; } gate b q { a q; } …` terminates the parser and hangs
 *     the expander.
 *   - `((((((…))))))` is one statement and one stack frame per parenthesis.
 *   - `pow(4) @ pow(4) @ pow(4) @ … @ x q[0];` is linear in the file and
 *     exponential in operations.
 *
 * Each number below therefore guards a *specific* unbounded quantity, and says
 * which one. None of them is a guess about what a person writes: every one is
 * far past any real file and far below anything that costs memory.
 *
 * ── WHY THEY ARE NOT ALL THE CONTRACT'S OWN NUMBERS ──────────────────────
 *
 * Where the contract already has the right ceiling, this file re-exports it
 * rather than restating it: a second copy of `MAX_QUBITS` is a second thing to
 * update. The rest are limits on the *text*, which the contract has no opinion
 * about because it never sees any.
 */

import {
  MAX_CLBITS,
  MAX_COLUMNS,
  MAX_CUSTOM_GATE_DEPTH,
  MAX_EXPANDED_OPERATIONS,
  MAX_QUBITS,
} from '@qsim/schema'

export { MAX_CLBITS, MAX_COLUMNS, MAX_QUBITS }

/**
 * Longest source accepted, in UTF-16 code units.
 *
 * One mebibyte is the API's own body limit, so a file this importer accepts is
 * a file the rest of the system would have accepted anyway. Checked before the
 * first character is read, because every later bound is per-token and a
 * hundred-megabyte file would be tokenised before any of them fired.
 */
export const MAX_SOURCE_LENGTH = 1024 * 1024

/**
 * Most tokens read from one file.
 *
 * The token array is the only structure that grows with the *whole* file rather
 * than with one statement, so it is the one that has to be bounded
 * independently of `MAX_SOURCE_LENGTH`. Two hundred thousand tokens is roughly
 * a fifty-thousand-line program.
 */
export const MAX_TOKENS = 200_000

/**
 * Longest identifier.
 *
 * The contract allows 64 characters in a name it stores (`IdentifierSchema`),
 * and this is deliberately larger: a register called something enormous is
 * perfectly legal QASM and never reaches the contract, because registers are
 * flattened away on import. Only a custom gate's name has to survive into the
 * document, and that one is checked against the contract's own limit where it
 * is built, with a message that says so.
 *
 * The bound exists at all so that a file consisting of one identifier a
 * megabyte long fails at the token rather than after the parser has copied it
 * into a symbol table, an error message and a stack trace.
 */
export const MAX_IDENTIFIER_LENGTH = 256

/**
 * Deepest nesting of parentheses and operators in one expression.
 *
 * The expression parser is recursive descent, so this is one JavaScript frame
 * per level and the thing that turns `(((((…)))))` from a stack overflow —
 * which surfaces as a 500 nobody can act on — into a sentence naming the line.
 * Thirty-two is far past `sin(pi/2 + (a*b))`.
 */
export const MAX_EXPRESSION_DEPTH = 32

/**
 * Most nodes one expression may contain.
 *
 * `MAX_EXPRESSION_DEPTH` bounds *nesting*, and nesting is not the only way an
 * expression grows: `1+1+1+…` is a flat chain the parser reads in a loop, so it
 * never recurses and the depth stays at one — while the tree it builds is
 * left-nested one level per operator. The evaluator walks that tree
 * recursively, so about nine and a half thousand operators (a 19 KB file, far
 * inside `MAX_SOURCE_LENGTH`) overflowed the JavaScript stack and threw a
 * `RangeError` out of `safeImportOpenQasm` — the one thing it promises never to
 * do, and §11's rule that an untrusted upload may not recurse without bound.
 *
 * Counted per expression rather than per file, so it says something a reader
 * can act on: this angle is too complicated, at this line. Two hundred and
 * fifty-six is orders of magnitude past `sin(pi/2 + a*b)` and two orders below
 * any stack this runs on.
 */
export const MAX_EXPRESSION_NODES = 256

/**
 * Deepest nesting of blocks: `if` inside a gate body inside … .
 *
 * The statement parser recurses once per block. Small because the language
 * offers very little nesting to begin with and this contract offers less: a
 * gate body may not contain a conditional at all.
 */
export const MAX_BLOCK_DEPTH = 8

/** Most `gate` definitions in one file. */
export const MAX_GATE_DEFINITIONS = 512

/**
 * Deepest chain of gate definitions calling gate definitions.
 *
 * The same number the contract uses for custom gates, and for the same reason
 * (`MAX_CUSTOM_GATE_DEPTH`): the lowering walks the definition graph one frame
 * per level, and a file may declare a chain thousands of links long inside a
 * megabyte. Cycle detection proves the graph terminates and says nothing about
 * how deep it is.
 */
export const MAX_DEFINITION_DEPTH = MAX_CUSTOM_GATE_DEPTH

/**
 * Most primitive operations one file may produce.
 *
 * The contract's own expansion ceiling, because that is what the produced
 * circuit will be measured against downstream: a document that expands past it
 * is refused by `parseCircuit`, so producing more here would only mean building
 * a large object in order to throw it away. It also bounds the one construct
 * that multiplies without growing the file — `pow(k) @` — since every repeat
 * is counted as it is emitted.
 */
export const MAX_OPERATIONS = MAX_EXPANDED_OPERATIONS

/**
 * Largest exponent accepted by `pow(k) @`.
 *
 * `pow` repeats its operand, so the exponent is a multiplier on the operation
 * count. `MAX_OPERATIONS` already bounds the product, but a bound on the
 * factor gives the reader a message about the exponent they wrote rather than
 * about a total they did not.
 */
export const MAX_POW_EXPONENT = 1024

/**
 * Most control modifiers stacked on one gate.
 *
 * `ctrl @` may be repeated, and each one consumes a qubit, so the register
 * bounds this in practice — but only after the modifier list has been built.
 */
export const MAX_MODIFIERS = MAX_QUBITS
