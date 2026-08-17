/**
 * What a program actually contains, counted from the program itself.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY THIS IS COUNTED FROM TEXT AND NOT FROM A CIRCUIT
 *
 * §3.7's three-column comparison has to say "you drew two gates and the device
 * ran eleven", and the eleven is not a number this system can recompute. The
 * program that ran was transpiled against the calibration the device published
 * *that day*, placed on the qubits that were good *that morning*, and then
 * stored — `HardwareJob.program` — precisely because re-deriving it later would
 * produce a different program from the one the samples came out of. The stored
 * OpenQASM 3 is therefore the record, and the only honest place to count is the
 * record.
 *
 * So this is a reader for a program somebody already has in hand, and it lives
 * beside the emitter rather than in the app that draws the number: a count of
 * gate calls is a statement about the *format*, and a browser feature that
 * parsed the format itself would be a second reading of it, free to disagree
 * with `toOpenQasm3` the day either changes.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT IS AND IS NOT A GATE, AND WHY THAT MATTERS MORE THAN IT SOUNDS
 *
 * `gateCalls` excludes `measure`, `reset` and `barrier`, which is the same cut
 * `@qsim/schema`'s `gateCount` makes — those three are `structural` in the
 * catalog, "not unitary: annotations, reset, measurement". That agreement is
 * the entire point of the exclusion. The comparison view prints this number
 * beside `gateCount(drawnCircuit)`, and two counts taken with different rules
 * would produce a headline like "you drew 2, the device ran 13" where two of
 * the thirteen are the measurements the reader also drew. A difference that is
 * partly an accounting change is worse than no difference at all: the reader
 * would attribute it to the transpiler.
 *
 * They are still counted, separately, because they are real work on real
 * hardware and the reader can see them in the listing.
 *
 * ════════════════════════════════════════════════════════════════════════
 * A LINE READER IS SOUND HERE, AND ONLY HERE
 *
 * This is not an OpenQASM parser and must not become one. It reads programs
 * *this project emitted* — `toOpenQasm3` and, through it, `@qsim/transpile`'s
 * `emitPhysicalQasm` — whose shape is fixed by those two files: one statement
 * per line, comments on whole lines and never mid-line, declarations at the
 * top, and blocks opened by a brace at the end of a line.
 *
 * Two of those blocks exist and they are opposite, which is the one thing a
 * naive tally gets wrong:
 *
 *   `if (c[0] == true) { … }`   a CONDITIONED statement. What is inside runs,
 *                               so what is inside is counted.
 *   `gate foo a, b { … }`       a DEFINITION. What is inside is the *body* of a
 *                               gate, executed once per call to `foo` and not
 *                               at all where it is written. Counting it would
 *                               report a circuit nobody ran.
 *
 * Only the second suppresses counting, and `definitions` reports how many were
 * seen so a caller can tell "flat program" from "program with a library at the
 * top" without re-reading the source. A submitted hardware program is always
 * flat — the transpiler expands every custom gate before it decomposes
 * anything — so a non-zero `definitions` on one of those is evidence that the
 * program is not what this system thinks it is.
 */

/** One gate name and how often the program calls it. */
export interface QasmGateTally {
  /** The name as written: `rz`, `sx`, `cz`. Lower case in every emitter here. */
  readonly name: string
  readonly count: number
}

export interface QasmTally {
  /**
   * Every gate call, most frequent first and ties broken by name.
   *
   * Sorted here rather than at the call site so that two renderings of one
   * program cannot list its gates in two orders — and by name on a tie so the
   * order is a property of the program rather than of a hash table's walk.
   */
  readonly gates: readonly QasmGateTally[]
  /** Gate calls in total. Excludes the three structural statements below. */
  readonly gateCalls: number
  readonly measurements: number
  readonly resets: number
  readonly barriers: number
  /**
   * Conditioned blocks — `if (c[0] == true) { … }`.
   *
   * Their contents are counted as calls, because they are calls. The number is
   * reported because a program with classical feed-forward in it ran on a
   * device that supports mid-circuit measurement, which is a fact about the run
   * worth being able to state.
   */
  readonly conditionals: number
  /**
   * `gate` definitions seen. Zero for every program this project submits; see
   * the header for why a non-zero value is a finding rather than a detail.
   */
  readonly definitions: number
}

/**
 * The gate modifiers OpenQASM 3 writes before a name, and this emitter uses.
 *
 * `ctrl @ ctrl @ h a, b, c;` is a Hadamard with two extra controls, and the
 * gate that ran is `h`. Reading the first identifier would tally it as `ctrl`,
 * which is not a gate — and would collapse `ctrl @ x` and `ctrl @ h` into one
 * row of a listing whose whole job is to say which gates the device ran.
 *
 * `pow` takes a parenthesised exponent, so the pattern allows one.
 */
const MODIFIER = /^(?:ctrl|negctrl|inv|pow)\s*(?:\([^)]*\))?\s*@\s*/

/** Statements that declare rather than do. */
const DECLARATION =
  /^(?:OPENQASM\b|include\b|qubit\b|qubit\[|bit\b|bit\[|creg\b|qreg\b|const\b|input\b|output\b|def\b|let\b)/

/**
 * The name of the operation a statement performs.
 *
 * The optional prefix is an assignment target, which is how a measurement is
 * written in OpenQASM 3 (`c[0] = measure $53;`) — without it every measurement
 * would tally under the name `c`.
 */
const CALL =
  /^(?:[A-Za-z_][A-Za-z0-9_]*(?:\[\d+])?\s*=\s*)?([A-Za-z_][A-Za-z0-9_]*)/

/** Block openers that are control flow rather than a call. */
const CONTROL = new Set(['if', 'else', 'for', 'while', 'switch', 'case'])

/**
 * Count what a program does.
 *
 * Never throws. A malformed line contributes nothing rather than taking down
 * the view that is trying to describe a job — this is a *reading* of a record
 * that already ran, and the reader's remedy for an unrecognisable one is to
 * look at the source, which the view shows in full beside these numbers.
 */
export function tallyQasm3(source: string): QasmTally {
  const counts = new Map<string, number>()
  let measurements = 0
  let resets = 0
  let barriers = 0
  let conditionals = 0
  let definitions = 0
  /** Brace depth inside a `gate` body; 0 means "counting". */
  let inDefinition = 0

  for (const raw of source.split('\n')) {
    const line = stripComment(raw)
    if (line === '') continue

    if (inDefinition > 0) {
      inDefinition += braceDelta(line)
      continue
    }

    if (/^gate\s/.test(line)) {
      definitions += 1
      // A definition whose brace is on a later line still opens exactly one
      // block, so the depth starts at one either way and `braceDelta` on this
      // line would double-count the `{` it usually carries.
      inDefinition = 1 + Math.max(0, braceDelta(line) - 1)
      continue
    }

    if (DECLARATION.test(line)) continue

    const name = CALL.exec(stripModifiers(line))?.[1]
    if (name === undefined) continue
    if (CONTROL.has(name)) {
      if (name === 'if') conditionals += 1
      continue
    }

    if (name === 'measure') measurements += 1
    else if (name === 'reset') resets += 1
    else if (name === 'barrier') barriers += 1
    else counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const gates = [...counts]
    .map(([name, count]): QasmGateTally => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    gates,
    gateCalls: gates.reduce((sum, gate) => sum + gate.count, 0),
    measurements,
    resets,
    barriers,
    conditionals,
    definitions,
  }
}

/**
 * A line with its comment removed and its whitespace trimmed.
 *
 * Whole-line comments only, which is not a shortcut but a property of the two
 * emitters this reads: both build comments with `wrapComment`, which produces
 * lines that begin with `//`. Stripping a `//` found anywhere would corrupt any
 * future statement carrying one inside a string literal, and OpenQASM has
 * strings.
 */
function stripComment(line: string): string {
  const trimmed = line.trim()
  return trimmed.startsWith('//') ? '' : trimmed
}

/** A statement with every leading modifier removed. See `MODIFIER`. */
function stripModifiers(line: string): string {
  let rest = line
  // Repeated rather than a global match: modifiers stack, and each one has to
  // be removed from the *front* — `ctrl @ inv @ s a, b;` is two of them.
  for (;;) {
    const shorter = rest.replace(MODIFIER, '')
    if (shorter === rest) return rest
    rest = shorter
  }
}

/** How much this line changes the brace depth. */
function braceDelta(line: string): number {
  let delta = 0
  for (const character of line) {
    if (character === '{') delta += 1
    else if (character === '}') delta -= 1
  }
  return delta
}
