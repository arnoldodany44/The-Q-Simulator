/**
 * The defects this lens found, now pinned as regressions.
 *
 * Every case below was written as an `it.fails` stating what SHOULD be true
 * while it was not. The `.fails` came off as each one was fixed, and the
 * assertions are the ones that were written against the *correct* behaviour —
 * none has been relaxed to meet the code. What remains as prose rather than as
 * a fix is recorded as such, with the current answer asserted exactly so a
 * change shows up as a diff instead of a silent flip.
 */

import { createRng, run, runTrajectory, trajectoriesMode } from '@qsim/core'
import { describe, expect, it } from 'vitest'
import {
  CIRCUIT_SCHEMA_VERSION,
  parseCircuit,
  type Circuit,
} from '@qsim/schema'

import { importOpenQasm, safeImportOpenQasm } from '../../import/index.js'
import { toOpenQasm3 } from '../../qasm3.js'
import { toQiskit } from '../../qiskit.js'
import { readQasm } from './qasm-reader.js'
import {
  distributionDistance,
  jointDistribution,
  jointDistributionOfOps,
} from './reference.js'

/* ── 1. an angle deep enough to overflow the evaluator's stack ──────────── */

describe('a long chain of binary operators (§11)', () => {
  const source = `OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[1] q;\nrz(${'1+'.repeat(
    20_000
  )}1) q[0];\n`

  it('is refused with a QasmImportError, not a RangeError', () => {
    /*
     * 40 KB of source — far inside MAX_SOURCE_LENGTH (1 MiB) and MAX_TOKENS
     * (200 000). MAX_EXPRESSION_DEPTH never fires because `additive` and
     * `multiplicative` iterate rather than recurse, so the parser builds a
     * left-nested tree 20 000 deep without counting a single level; the
     * overflow happened later, in `evaluate`, which walks that tree one frame
     * per operator, and `safeImportOpenQasm` threw instead of answering — the
     * one thing `errors.ts` promises it never does. `MAX_EXPRESSION_NODES`
     * counts the tree rather than the nesting.
     */
    const result = safeImportOpenQasm(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('limit')
    // A line and a column the reader can act on, and not 1:1.
    expect(result.error.position.line).toBe(4)
  })
})

/* ── 2. a conditioned measurement sharing the writer's column ───────────── */

const SAME_COLUMN: Circuit = parseCircuit({
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'h', targets: [1], column: 0 },
    { id: 'op_3', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    {
      id: 'op_4',
      gate: 'measure',
      targets: [1],
      clbitTargets: [1],
      column: 1,
      condition: { clbit: 0, equals: 1 },
    },
  ],
})

describe('a conditioned measurement in the column that writes its bit', () => {
  it('is exported above the measurement it reads', () => {
    /*
     * The engine reads the register as it entered the column (`runner.ts`), so
     * op_4's condition is false and c[1] is never written. `orderedOperations`
     * puts non-measurements before measurements to reproduce that — but op_4
     * *is* a measurement, so it ties with op_3 on both sort keys and the
     * document's own order decides. The file that comes out says the opposite
     * of what runs, and the comment the exporter emits beside it ("Before the
     * measurement below on purpose") describes an order that is not there.
     */
    const text = toOpenQasm3(SAME_COLUMN)
    const conditionLine = text
      .split('\n')
      .findIndex((line) => /^if /.test(line))
    const measureLine = text
      .split('\n')
      .findIndex((line) => line.trim() === 'c[0] = measure q[0];')
    expect(conditionLine).toBeLessThan(measureLine)
  })

  it('comes back from its own export computing the same thing', () => {
    const back = importOpenQasm(toOpenQasm3(SAME_COLUMN)).circuit
    const distance = distributionDistance(
      jointDistribution(SAME_COLUMN),
      jointDistribution(back)
    )
    expect(distance).toBeLessThan(1e-9)
  })

  it('runs the same in the engine before and after the round trip', () => {
    const before = run(SAME_COLUMN, trajectoriesMode(4000, createRng(11)))
    const after = run(
      importOpenQasm(toOpenQasm3(SAME_COLUMN)).circuit,
      trajectoriesMode(4000, createRng(11))
    )
    expect(after).toStrictEqual(before)
  })

  it('is exported to Qiskit in the order the engine runs it', () => {
    const python = toQiskit(SAME_COLUMN)
    const ifLine = python.split('\n').findIndex((line) => /if_test/.test(line))
    const measureLine = python
      .split('\n')
      .findIndex((line) => line.includes('circuit.measure(q[0], c[0])'))
    expect(ifLine).toBeLessThan(measureLine)
  })
})

/* ── 3. `else` when the then-branch rewrites the tested bit ─────────────── */

const ELSE_SOURCE = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[1] c;
x q[0];
c[0] = measure q[0];
if (c[0] == true) {
  c[0] = measure q[1];
} else {
  x q[1];
}
`

/** The same shape with the branches leaving the tested bit alone. */
const ORDINARY_ELSE = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
x q[0];
c[0] = measure q[0];
if (c[0] == true) {
  x q[1];
} else {
  h q[1];
}
c[1] = measure q[1];
`

describe('an else branch whose test the body rewrites', () => {
  it('is refused, rather than imported as a circuit that runs both', () => {
    /*
     * `else` is lowered as the same operations conditioned on the opposite
     * value of the same bit, and the two are equivalent only while nothing
     * between them writes that bit. Here the then-branch does: it measures
     * q[1] (which is |0>) into c[0], turning c[0] from 1 to 0 — and the
     * else-branch, scheduled into a later column, then read the *new* value
     * and fired as well. Both branches ran, silently, on ordinary OpenQASM 3.
     *
     * There is no faithful lowering — the contract has no way to say "the
     * value this bit had before the branch" — so the honest answer is the one
     * this importer gives every construct it has no shape for: a refusal that
     * names the construct, at the line.
     */
    const result = safeImportOpenQasm(ELSE_SOURCE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsupported')
    // The measurement inside the branch, not the top of the file.
    expect(result.error.position.line).toBe(8)
  })

  it('still imports an ordinary else, and runs exactly one branch', () => {
    // The property the refusal above protects, on a file that can carry it:
    // the imported circuit computes what the file says, joint over q and c.
    const circuit = importOpenQasm(ORDINARY_ELSE).circuit
    const program = readQasm(ORDINARY_ELSE)
    const distance = distributionDistance(
      jointDistributionOfOps(program.ops, program.qubits),
      jointDistribution(circuit)
    )
    expect(distance).toBeLessThan(1e-9)
  })

  it('leaves q[1] alone in the branch that was not taken', () => {
    const circuit = importOpenQasm(ORDINARY_ELSE).circuit
    const outcome = runTrajectory(circuit, createRng(7))
    // c[0] is 1, so the then-branch flips q[1]: |11>, index 3.
    expect(outcome.state.re[3] ?? 0).toBeCloseTo(1, 10)
  })
})

/* ── 4. gate bodies the importer used to build into a refused circuit ────── */

describe('gate bodies the contract cannot hold verbatim', () => {
  /*
   * `errors.ts` says of the `contract` code, in as many words, that "reaching
   * this is a defect in the importer rather than in the file". All four of
   * these reached it, at line 1 column 1 — the reader was told the format would
   * not accept their circuit, and not where the problem was. Two are valid
   * OpenQASM 3 that should import; two are malformed and now say so at a line.
   */
  const cases: [string, string, string][] = [
    [
      'a bare barrier inside a gate body',
      'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate g a, b { barrier; }\nqubit[2] q;\ng q[0], q[1];\n',
      'imported',
    ],
    [
      'a two-qubit gate on one formal twice',
      'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate g a, b { cx a, a; }\nqubit[2] q;\ng q[0], q[1];\n',
      'semantic at line 5',
    ],
    [
      'a barrier on one formal twice',
      'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate g a, b { barrier a, a; }\nqubit[2] q;\ng q[0], q[1];\n',
      'imported',
    ],
    [
      'a swap on one formal twice',
      'OPENQASM 3.0;\ninclude "stdgates.inc";\ngate g a, b { swap a, a; }\nqubit[2] q;\ng q[0], q[1];\n',
      'semantic at line 5',
    ],
  ]

  it.each(cases)('%s does not crash or hang', (_name, source) => {
    expect(() => safeImportOpenQasm(source)).not.toThrow()
  })

  it.each(cases)(
    '%s is answered with a position and not as an internal defect',
    (_name, source, expected) => {
      const result = safeImportOpenQasm(source)
      const verdict = result.ok
        ? 'imported'
        : `${result.error.code} at line ${String(result.error.position.line)}`
      expect(verdict).toBe(expected)
    }
  )

  it('reads a bare barrier as every qubit of the gate being defined', () => {
    // The same reading the top level gives it, which is the whole point: a
    // barrier across nothing is not what the file says.
    const result = safeImportOpenQasm(cases[0]?.[1] as string)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.circuit.customGates?.g?.operations[0]?.targets).toStrictEqual(
      [0, 1]
    )
  })
})

/* ── 5. two things the round trip loses that nothing documents ──────────── */

describe('losses the round trip is not documented to have', () => {
  it('drops the wire names a multi-register file carried', () => {
    /*
     * `equivalence.ts` names three legitimate differences across a round trip:
     * operation ids, column numbers, and custom gate packaging. Wire labels are
     * not among them, and they do not survive: the importer builds them from
     * the file's register names and the exporter writes one register `q`,
     * recording the names in a header comment that nothing reads back.
     */
    const first = importOpenQasm(
      'OPENQASM 2.0;\nqreg alice[2];\nqreg bob[1];\nh alice[0];\ncx alice[0], bob[0];\n'
    ).circuit
    expect(first.qubitLabels).toStrictEqual(['alice[0]', 'alice[1]', 'bob'])
    const again = importOpenQasm(toOpenQasm3(first)).circuit
    expect(again.qubitLabels).toBeUndefined()
  })

  it('drops a custom gate’s symbol', () => {
    // §3.1 calls a custom gate "a block with a name and an icon". The icon is
    // the `symbol` field, and a round trip through OpenQASM loses it.
    const circuit = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [{ id: 'op_1', gate: 'block', targets: [0, 1], column: 0 }],
      customGates: {
        block: {
          qubits: 2,
          symbol: 'B',
          operations: [
            { id: 'g_1', gate: 'h', targets: [0], column: 0 },
            { id: 'g_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
      },
    })
    const back = importOpenQasm(toOpenQasm3(circuit)).circuit
    expect(back.customGates?.block?.symbol).toBeUndefined()
  })
})
