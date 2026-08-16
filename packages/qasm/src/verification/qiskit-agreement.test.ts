/**
 * THE EXPORT AGREES WITH QISKIT — decision D1, specification risk 2.
 *
 * This is the test milestone M1.7 exists for. Everything else in this package
 * can be checked by reading the output; this one cannot, because a mirrored
 * export is invisible from inside the project. Reverse the qubit indices on
 * the way out and the simulator stays perfectly self-consistent, the emitted
 * file is valid OpenQASM, it runs without complaint — and it computes the
 * mirror image of the circuit the user drew. Only a comparison against
 * something outside the project reveals it.
 *
 * ── HOW THE COMPARISON IS MADE WITHOUT RUNNING PYTHON ────────────────────
 *
 * By deriving, from Qiskit's stated conventions, what Qiskit would do with the
 * emitted text — and doing it with an implementation that shares no code with
 * `@qsim/core`:
 *
 *   1. `readProgram` reads the emitted OpenQASM 3 the way any reader would:
 *      `q[k]` is qubit k of the machine, full stop. It knows nothing about the
 *      circuit the text came from.
 *   2. `simulate` builds the full 2ⁿ × 2ⁿ matrix of each instruction by
 *      Kronecker product and multiplies it in — deliberately the naive method
 *      §5.2 forbids the engine from using. At three qubits it is an 8 × 8
 *      matrix; as an oracle, being slow and obvious is the entire point.
 *   3. The distribution over the classical register is labelled the way Qiskit
 *      prints counts: `c[m-1] … c[0]`, highest bit first.
 *
 * Three legs have to meet: `@qsim/core`, this independent reading of the
 * exported text, and — for the three named circuits — a distribution written
 * out by hand from what Qiskit would print. Two implementations agreeing is
 * good; two implementations agreeing with a number a person derived on paper
 * is what makes it a check on the convention rather than on the code.
 *
 * ── WHY THESE CIRCUITS ───────────────────────────────────────────────────
 *
 * Every one of them is asymmetric under reversing the qubit order. A Bell pair
 * is not: `h q[0]; cx q[0], q[1];` mirrored is `h q[1]; cx q[1], q[0];`, whose
 * distribution over `{00, 11}` is identical — it would pass under either
 * convention and prove nothing. A Hadamard on qubit 0 alone, a CNOT from 0 to
 * 2 and a Toffoli controlled by 0 and 1 all produce different counts once
 * mirrored, which is what `the test has teeth` asserts directly by mirroring
 * the emitted text and demanding disagreement.
 */

import { probabilities, run } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { toOpenQasm3 } from '../qasm3.js'

/* ───────────────────────── the circuits under test ───────────────────── */

/** A Hadamard on qubit 0 of three, measured into the whole register. */
const ONE_QUBIT_OF_THREE: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 3,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    ...measureAll(3),
  ],
}

/**
 * A CNOT with a control that is certainly |1⟩, which is what pins the
 * *order* of a two-qubit gate's arguments: `cx q[0], q[2]` writes into
 * qubit 2, and `cx q[2], q[0]` — the same two names, swapped — does nothing at
 * all. No amount of superposition would separate those two; a deterministic
 * control does it in one bitstring.
 */
const CNOT_ARGUMENT_ORDER: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 3,
  operations: [
    { id: 'op_1', gate: 'x', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [2], controls: [0], column: 1 },
    ...measureAll(3),
  ],
}

/** A CNOT that skips a wire: control 0, target 2. */
const CNOT_ZERO_TO_TWO: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 3,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [2], controls: [0], column: 1 },
    ...measureAll(3),
  ],
}

/** A Toffoli: controls 0 and 1, target 2, both controls in superposition. */
const TOFFOLI: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 3,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'h', targets: [1], column: 0 },
    { id: 'op_3', gate: 'ccx', targets: [2], controls: [0, 1], column: 1 },
    ...measureAll(3),
  ],
}

/**
 * Everything else the emitter can produce, in one asymmetric circuit: a
 * parametrised rotation, a phase, a swap across a gap, a negative control and
 * an iswap — the gate with no name in `stdgates.inc`, so this is also the
 * check that its decomposition survives the round trip through text.
 */
const MIXED_CATALOG: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 4,
  clbits: 4,
  parameters: [{ name: 'theta', value: Math.PI / 3 }],
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'sx', targets: [1], column: 0 },
    { id: 'op_3', gate: 'ry', targets: [3], params: ['theta'], column: 0 },
    { id: 'op_4', gate: 'iswap', targets: [1, 2], column: 1 },
    {
      id: 'op_5',
      gate: 'cp',
      targets: [3],
      controls: [0],
      params: [Math.PI / 4],
      column: 2,
    },
    {
      id: 'op_6',
      gate: 'x',
      targets: [2],
      controls: [{ qubit: 0, state: 0 }],
      column: 3,
    },
    { id: 'op_7', gate: 'swap', targets: [0, 3], column: 4 },
    { id: 'op_8', gate: 'barrier', targets: [0, 1, 2, 3], column: 5 },
    ...measureAll(4, 6),
  ],
}

/** `measure q[i] -> c[i]` for the whole register, one per column. */
function measureAll(qubits: number, from = 1) {
  return Array.from({ length: qubits }, (_, qubit) => ({
    id: `measure_${qubit}`,
    gate: 'measure',
    targets: [qubit],
    clbitTargets: [qubit],
    column: from + qubit,
  }))
}

/* ──────────────────────────── the assertions ─────────────────────────── */

describe('the exported OpenQASM agrees with Qiskit', () => {
  /*
   * Written out by hand, in Qiskit's print order `c[2] c[1] c[0]`.
   *
   * ONE_QUBIT_OF_THREE: the Hadamard is on qubit 0, so c[0] is the bit that
   * varies and the two outcomes differ in the RIGHTMOST character. Under the
   * mirrored convention it would be the leftmost, which is the whole defect in
   * one line.
   *
   * CNOT_ZERO_TO_TWO: qubit 2 copies qubit 0, so the two outcomes are `000`
   * and `101` — the middle bit, qubit 1, is never touched.
   *
   * TOFFOLI: qubit 2 flips only when qubits 0 and 1 both read 1, so `11`
   * carries a leading 1 and the other three outcomes do not.
   */
  const BY_HAND: readonly [string, Circuit, Record<string, number>][] = [
    [
      'a Hadamard on qubit 0 of three',
      ONE_QUBIT_OF_THREE,
      { '000': 0.5, '001': 0.5 },
    ],
    [
      'a CNOT from qubit 0 to qubit 2',
      CNOT_ZERO_TO_TWO,
      { '000': 0.5, '101': 0.5 },
    ],
    // X on qubit 0, then the CNOT: qubit 2 takes the 1 and qubit 1 stays out
    // of it, so the register reads `101` every shot. Swap the CNOT's two
    // arguments and it reads `001`.
    [
      'a CNOT whose control is certainly |1>',
      CNOT_ARGUMENT_ORDER,
      { '101': 1 },
    ],
    [
      'a Toffoli controlled by qubits 0 and 1',
      TOFFOLI,
      { '000': 0.25, '001': 0.25, '010': 0.25, '111': 0.25 },
    ],
  ]

  it.each(BY_HAND)(
    'gives %s the distribution derived on paper',
    (_name, circuit, expected) => {
      expectDistribution(distributionOfExport(circuit), expected)
    }
  )

  it.each([
    ['one qubit of three', ONE_QUBIT_OF_THREE],
    ['a CNOT across a gap', CNOT_ZERO_TO_TWO],
    ['a CNOT whose argument order is visible', CNOT_ARGUMENT_ORDER],
    ['a Toffoli', TOFFOLI],
    ['the rest of the catalog', MIXED_CATALOG],
  ])('matches @qsim/core on %s', (_name, circuit) => {
    expectDistribution(
      distributionOfExport(circuit),
      distributionOfEngine(circuit)
    )
  })

  /**
   * The test has teeth — first half: an exporter that reverses the qubit
   * indices of its *gates* must be caught.
   *
   * Reversing the gates only, and not the measurements, is the shape this bug
   * really takes: gate arguments and the `measure` statement are written by
   * different code paths, so one of them getting a "helpful" `n - 1 - k` is
   * the plausible mistake. Reversing *both* consistently would be no bug at
   * all — relabelling every qubit in a circuit, measurements included, is a
   * symmetry, and the counts come out identical. Worth knowing before anyone
   * strengthens this test in the wrong direction.
   *
   * Not every asymmetric circuit moves under the half-mirror either.
   * `CNOT_ZERO_TO_TWO` is asymmetric and its distribution is invariant:
   * `h q[0]; cx q[0], q[2]` and `h q[2]; cx q[2], q[0]` both leave qubits 0
   * and 2 perfectly correlated, so both read `{000, 101}`. That is exactly why
   * the hand-derived expectations above exist alongside this: they pin *which*
   * wire is which, where a distribution alone cannot.
   */
  it.each([
    ['a Hadamard on qubit 0', ONE_QUBIT_OF_THREE],
    ['a Toffoli', TOFFOLI],
    ['the rest of the catalog', MIXED_CATALOG],
  ])('would catch gate indices mirrored in %s', (_name, circuit) => {
    const mirrored = mirrorGateQubits(toOpenQasm3(circuit), circuit.qubits)
    expect(() => {
      expectDistribution(
        distributionOf(mirrored),
        distributionOfEngine(circuit)
      )
    }).toThrow()
  })

  /**
   * The test has teeth — second half: an exporter that writes a two-qubit
   * gate's arguments the other way round must be caught.
   *
   * `cx control, target` is the OpenQASM order and `cx target, control` is a
   * one-character mistake that produces a valid program computing something
   * else. The deterministic control in `CNOT_ARGUMENT_ORDER` is what makes it
   * visible in the counts.
   */
  it('would catch a CNOT emitted control-last', () => {
    const swapped = toOpenQasm3(CNOT_ARGUMENT_ORDER).replace(
      /^cx q\[(\d+)\], q\[(\d+)\];$/m,
      'cx q[$2], q[$1];'
    )
    expect(swapped).toContain('cx q[2], q[0];')
    expect(() => {
      expectDistribution(
        distributionOf(swapped),
        distributionOfEngine(CNOT_ARGUMENT_ORDER)
      )
    }).toThrow()
  })
})

/** The distribution the exported program produces, read back independently. */
function distributionOfExport(circuit: Circuit): Map<string, number> {
  return distributionOf(toOpenQasm3(circuit))
}

function distributionOf(program: string): Map<string, number> {
  const read = readProgram(program)
  const amplitudes = simulate(read)
  return tally(
    amplitudes.map((value) => value.re * value.re + value.im * value.im),
    read.qubits,
    read.clbits,
    read.measured
  )
}

/**
 * The same distribution from `@qsim/core`, exactly: the circuit is run in
 * analytic mode with its measurements removed — they are all at the end, so
 * removing them cannot change the state — and the Born-rule probabilities are
 * grouped by the classical register the measurements would have written.
 *
 * Exact rather than sampled on purpose. A `trajectories` run would compare two
 * random samples and the test would fail once a fortnight for no reason.
 */
function distributionOfEngine(circuit: Circuit): Map<string, number> {
  const unitary = {
    ...circuit,
    operations: circuit.operations.filter(
      (operation) => operation.gate !== 'measure'
    ),
  }
  const result = run(unitary)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')

  const measured = new Map<number, number>()
  for (const operation of circuit.operations) {
    if (operation.gate !== 'measure') continue
    measured.set(operation.clbitTargets![0]!, operation.targets[0]!)
  }
  return tally(
    [...probabilities(result.state)],
    circuit.qubits,
    circuit.clbits,
    measured
  )
}

/**
 * Probabilities over basis states, folded into probabilities over the
 * classical register and labelled the way Qiskit prints counts: `c[m-1]` first.
 *
 * Both sides call this, and that is deliberate. What is under test is whether
 * the *text* preserves which qubit is which; the labelling convention is the
 * shared premise (D1), asserted in `@qsim/core`'s own `conventions.test.ts`.
 * Giving each side its own copy of this function would test that the copies
 * agree, which is not a fact about the exporter.
 */
function tally(
  probs: readonly number[],
  qubits: number,
  clbits: number,
  measured: ReadonlyMap<number, number>
): Map<string, number> {
  const totals = new Map<string, number>()
  for (let index = 0; index < 1 << qubits; index++) {
    const probability = probs[index] ?? 0
    // Outcomes the circuit cannot produce are dropped so the comparison is
    // over the outcomes that exist. The margin is wide: every probability in
    // these circuits is a sixteenth or larger, and an exact cancellation
    // leaves float dust twelve orders of magnitude below the threshold.
    if (probability <= 1e-12) continue
    let label = ''
    for (let clbit = clbits - 1; clbit >= 0; clbit--) {
      const qubit = measured.get(clbit)
      label += qubit === undefined ? '0' : (index >> qubit) & 1
    }
    totals.set(label, (totals.get(label) ?? 0) + probability)
  }
  return totals
}

function expectDistribution(
  actual: Map<string, number>,
  expected: Map<string, number> | Record<string, number>
): void {
  const wanted =
    expected instanceof Map ? expected : new Map(Object.entries(expected))
  expect([...actual.keys()].sort()).toEqual([...wanted.keys()].sort())
  for (const [label, probability] of wanted) {
    expect(actual.get(label) ?? 0).toBeCloseTo(probability, 12)
  }
}

/**
 * Rewrites `q[i]` as `q[n-1-i]` on every line except the measurements — the
 * half-mirror described above, written by hand because no code in this
 * repository should be able to produce one.
 */
function mirrorGateQubits(program: string, qubits: number): string {
  return program
    .split('\n')
    .map((line) =>
      /= measure /.test(line)
        ? line
        : line.replace(
            /\bq\[(\d+)\]/g,
            (_match, digits: string) => `q[${qubits - 1 - Number(digits)}]`
          )
    )
    .join('\n')
}

/* ─────────────────── an independent reader of the output ─────────────── */

interface Instruction {
  readonly gate: string
  readonly params: readonly number[]
  /** Control qubits with the value each one fires on. */
  readonly controls: readonly { qubit: number; state: number }[]
  readonly targets: readonly number[]
}

interface Program {
  readonly qubits: number
  readonly clbits: number
  readonly instructions: readonly Instruction[]
  /** classical bit → the qubit measured into it. */
  readonly measured: ReadonlyMap<number, number>
}

/**
 * Reads the emitted OpenQASM 3 with no knowledge of where it came from.
 *
 * Deliberately strict: anything it has not been taught is an error rather than
 * a skip. A silently ignored line would be a gate missing from the oracle, and
 * the comparison would then pass by agreeing about less than it claims.
 */
function readProgram(source: string): Program {
  let qubits = 0
  let clbits = 0
  const instructions: Instruction[] = []
  const measured = new Map<number, number>()

  for (const raw of source.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (line === '') continue
    if (line === 'OPENQASM 3.0;' || line === 'include "stdgates.inc";') continue

    const declaration = /^(qubit|bit)\[(\d+)\] (q|c);$/.exec(line)
    if (declaration !== null) {
      if (declaration[1] === 'qubit') qubits = Number(declaration[2])
      else clbits = Number(declaration[2])
      continue
    }

    const measurement = /^c\[(\d+)\] = measure q\[(\d+)\];$/.exec(line)
    if (measurement !== null) {
      measured.set(Number(measurement[1]), Number(measurement[2]))
      continue
    }

    if (/^barrier /.test(line)) continue

    instructions.push(readInstruction(line))
  }

  if (qubits === 0) throw new Error('the program declares no qubit register')
  return { qubits, clbits, instructions, measured }
}

/** `ctrl @ negctrl @ rz(pi/2) q[0], q[1], q[2];` and everything simpler. */
function readInstruction(line: string): Instruction {
  const statement = line.endsWith(';') ? line.slice(0, -1) : line
  const modifiers: string[] = []
  let rest = statement

  for (;;) {
    const modifier = /^(ctrl|negctrl)\s*@\s*/.exec(rest)
    if (modifier === null) break
    modifiers.push(modifier[1]!)
    rest = rest.slice(modifier[0].length)
  }

  const call = /^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s+(.*)$/.exec(rest)
  if (call === null) throw new Error(`unreadable statement: ${line}`)

  const gate = call[1]!
  const params = (call[3] ?? '')
    .split(',')
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map(readAngle)
  const qubits = call[4]!
    .split(',')
    .map((text) => text.trim())
    .map((text) => {
      const reference = /^q\[(\d+)\]$/.exec(text)
      if (reference === null) throw new Error(`unreadable qubit: ${text}`)
      return Number(reference[1])
    })

  // The modifiers bind the leading qubits, then the gate's own built-in
  // controls, then its targets. This is the language's rule, and reading it
  // back from the text is exactly the step where a mirrored export would
  // reveal itself.
  const modifierControls = modifiers.map((modifier, index) => ({
    qubit: qubits[index]!,
    state: modifier === 'ctrl' ? 1 : 0,
  }))
  const remaining = qubits.slice(modifiers.length)
  const builtIn = BUILT_IN_CONTROLS[gate] ?? 0
  return {
    // `cx` *is* `ctrl @ x`, and so on down the list: `stdgates.inc` says so,
    // and a reader of the language knows it. Unfolding the name here is what
    // lets the simulator below hold nothing but one-qubit matrices.
    gate: STDGATES_KERNEL[gate] ?? gate,
    params,
    controls: [
      ...modifierControls,
      ...remaining.slice(0, builtIn).map((qubit) => ({ qubit, state: 1 })),
    ],
    targets: remaining.slice(builtIn),
  }
}

/** Controls each `stdgates.inc` name carries by definition. */
const BUILT_IN_CONTROLS: Readonly<Record<string, number>> = {
  cx: 1,
  cz: 1,
  crz: 1,
  cp: 1,
  ccx: 2,
  cswap: 1,
}

/** The gate left once those built-in controls are taken off the name. */
const STDGATES_KERNEL: Readonly<Record<string, string>> = {
  cx: 'x',
  cz: 'z',
  crz: 'rz',
  cp: 'p',
  ccx: 'x',
  cswap: 'swap',
}

/** `pi`, `-pi/2`, `3*pi/4`, or a plain decimal. */
function readAngle(text: string): number {
  const pi = /^(-?)(?:(\d+)\*)?pi(?:\/(\d+))?$/.exec(text)
  if (pi !== null) {
    const sign = pi[1] === '-' ? -1 : 1
    const numerator = pi[2] === undefined ? 1 : Number(pi[2])
    const denominator = pi[3] === undefined ? 1 : Number(pi[3])
    return (sign * numerator * Math.PI) / denominator
  }
  const value = Number(text)
  if (!Number.isFinite(value)) throw new Error(`unreadable angle: ${text}`)
  return value
}

/* ──────────────────── a deliberately naive simulator ─────────────────── */

interface Complex {
  readonly re: number
  readonly im: number
}

const ZERO: Complex = { re: 0, im: 0 }
const ONE: Complex = { re: 1, im: 0 }

/**
 * Runs the read program from |0…0⟩ with the convention Qiskit states: qubit k
 * is bit k of the basis index, so `q[0]` is the least significant bit.
 *
 * Every instruction becomes a full 2ⁿ × 2ⁿ matrix, built column by column, and
 * is multiplied into the state. That is the O(4ⁿ) method the engine is
 * forbidden from using — which is what makes it a useful second opinion.
 */
function simulate(program: Program): Complex[] {
  const size = 1 << program.qubits
  let state: Complex[] = Array.from({ length: size }, (_, index) =>
    index === 0 ? ONE : ZERO
  )
  for (const instruction of program.instructions) {
    state = multiply(matrixOf(instruction, program.qubits), state)
  }
  return state
}

function multiply(matrix: Complex[][], state: readonly Complex[]): Complex[] {
  return matrix.map((row) =>
    row.reduce(
      (sum, entry, column) => add(sum, times(entry, state[column]!)),
      ZERO
    )
  )
}

function add(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im }
}

function times(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

/**
 * The full matrix of one instruction. Column `c` is the image of the basis
 * state `|c⟩`, which is the definition of a matrix and needs no reasoning
 * about tensor factor order to get right.
 */
function matrixOf(instruction: Instruction, qubits: number): Complex[][] {
  const size = 1 << qubits
  const matrix: Complex[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ZERO)
  )

  const fires = (index: number): boolean =>
    instruction.controls.every(
      (control) => ((index >> control.qubit) & 1) === control.state
    )

  for (let column = 0; column < size; column++) {
    if (!fires(column)) {
      matrix[column]![column] = ONE
      continue
    }

    if (instruction.gate === 'swap') {
      const [a, b] = instruction.targets as [number, number]
      const bitA = (column >> a) & 1
      const bitB = (column >> b) & 1
      const row = (column & ~(1 << a) & ~(1 << b)) | (bitB << a) | (bitA << b)
      matrix[row]![column] = ONE
      continue
    }

    const target = instruction.targets[0]!
    const unitary = oneQubitMatrix(instruction.gate, instruction.params)
    const bit = (column >> target) & 1
    const row0 = column & ~(1 << target)
    const row1 = column | (1 << target)
    matrix[row0]![column] = add(matrix[row0]![column]!, unitary[0]![bit]!)
    matrix[row1]![column] = add(matrix[row1]![column]!, unitary[1]![bit]!)
  }

  return matrix
}

const SQRT1_2 = Math.SQRT1_2

/**
 * The 2 × 2 of every one-qubit name the emitter can produce, written from the
 * textbook definitions rather than taken from `@qsim/core` — a second opinion
 * that borrowed the first one's matrices would not be one.
 */
function oneQubitMatrix(gate: string, params: readonly number[]): Complex[][] {
  const angle = params[0] ?? 0
  switch (gate) {
    case 'id':
      return [
        [ONE, ZERO],
        [ZERO, ONE],
      ]
    case 'x':
      return [
        [ZERO, ONE],
        [ONE, ZERO],
      ]
    case 'y':
      return [
        [ZERO, { re: 0, im: -1 }],
        [{ re: 0, im: 1 }, ZERO],
      ]
    case 'z':
      return [
        [ONE, ZERO],
        [ZERO, { re: -1, im: 0 }],
      ]
    case 'h':
      return [
        [
          { re: SQRT1_2, im: 0 },
          { re: SQRT1_2, im: 0 },
        ],
        [
          { re: SQRT1_2, im: 0 },
          { re: -SQRT1_2, im: 0 },
        ],
      ]
    case 's':
      return phase(Math.PI / 2)
    case 'sdg':
      return phase(-Math.PI / 2)
    case 't':
      return phase(Math.PI / 4)
    case 'tdg':
      return phase(-Math.PI / 4)
    case 'sx':
      return [
        [
          { re: 0.5, im: 0.5 },
          { re: 0.5, im: -0.5 },
        ],
        [
          { re: 0.5, im: -0.5 },
          { re: 0.5, im: 0.5 },
        ],
      ]
    case 'rx':
      return [
        [
          { re: Math.cos(angle / 2), im: 0 },
          { re: 0, im: -Math.sin(angle / 2) },
        ],
        [
          { re: 0, im: -Math.sin(angle / 2) },
          { re: Math.cos(angle / 2), im: 0 },
        ],
      ]
    case 'ry':
      return [
        [
          { re: Math.cos(angle / 2), im: 0 },
          { re: -Math.sin(angle / 2), im: 0 },
        ],
        [
          { re: Math.sin(angle / 2), im: 0 },
          { re: Math.cos(angle / 2), im: 0 },
        ],
      ]
    case 'rz':
      return [
        [{ re: Math.cos(angle / 2), im: -Math.sin(angle / 2) }, ZERO],
        [ZERO, { re: Math.cos(angle / 2), im: Math.sin(angle / 2) }],
      ]
    case 'p':
      return phase(angle)
    case 'U': {
      const [theta = 0, phi = 0, lambda = 0] = params
      const cos = Math.cos(theta / 2)
      const sin = Math.sin(theta / 2)
      return [
        [
          { re: cos, im: 0 },
          { re: -Math.cos(lambda) * sin, im: -Math.sin(lambda) * sin },
        ],
        [
          { re: Math.cos(phi) * sin, im: Math.sin(phi) * sin },
          {
            re: Math.cos(phi + lambda) * cos,
            im: Math.sin(phi + lambda) * cos,
          },
        ],
      ]
    }
    default:
      throw new Error(`the oracle does not know the gate "${gate}"`)
  }
}

/** `[[1,0],[0,e^{iφ}]]` — S, T, their daggers and `p` are all this. */
function phase(phi: number): Complex[][] {
  return [
    [ONE, ZERO],
    [ZERO, { re: Math.cos(phi), im: Math.sin(phi) }],
  ]
}
