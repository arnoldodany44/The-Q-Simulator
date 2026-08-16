/**
 * THE IMPORT AGREES WITH QISKIT — decision D1, specification risk 2.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE ROUND TRIP ──────────────────
 *
 * Import is where a mirrored convention hides best. Reverse the qubit indices on
 * the way in *and* on the way out and every test in `roundtrip.test.ts` still
 * passes: a file imported and re-exported by a mirrored pair agrees with itself
 * perfectly. It agrees with nothing else on earth — the circuit on screen is the
 * mirror image of the file, `q[0]` in the source is the last wire of the canvas,
 * and a bitstring read here means the reverse of what it means in the notebook
 * the file came from.
 *
 * Only a comparison against something outside the pair can see it. So this file
 * writes OpenQASM **by hand**, states what Qiskit would print for it — derived
 * on paper from Qiskit's stated conventions, not computed here — imports it, and
 * runs the result through `@qsim/core`. Three legs: the text, a number a person
 * worked out, and the engine.
 *
 * ── WHY THESE CIRCUITS ───────────────────────────────────────────────────
 *
 * Every one is asymmetric under reversing the qubit order. A Bell pair is not:
 * `h q[0]; cx q[0], q[1];` mirrored is `h q[1]; cx q[1], q[0];`, whose
 * distribution over {00, 11} is identical, so it would pass under either
 * convention and prove nothing. The teeth are at the bottom of the file: the
 * same programs with their indices mirrored must *disagree*, which is what makes
 * the agreements above mean something.
 *
 * The sibling `qiskit-agreement.test.ts` does the same for the export. Between
 * them the convention is pinned on both sides of the text.
 */

import { probabilities, run } from '@qsim/core'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { importOpenQasm } from '../import/index.js'

/* ─────────────────── programs written by hand, not emitted ───────────── */

/**
 * A Hadamard on qubit 0 of three, every wire measured into its own bit.
 *
 * The one outcome bit that varies is `c[0]`, so in Qiskit's print order —
 * `c[2] c[1] c[0]`, highest bit leftmost — the two readings differ in the
 * RIGHTMOST character. Under a mirrored import it would be the leftmost, which
 * is the entire defect in one line.
 */
const ONE_QUBIT_OF_THREE = `OPENQASM 3.0;
include "stdgates.inc";
qubit[3] q;
bit[3] c;
h q[0];
c[0] = measure q[0];
c[1] = measure q[1];
c[2] = measure q[2];
`

/**
 * A CNOT whose control is certainly |1⟩.
 *
 * This is what pins the *order* of a two-qubit gate's arguments rather than
 * merely which wires it touches: `cx q[0], q[2]` writes into qubit 2, and
 * `cx q[2], q[0]` — the same two names, swapped — does nothing at all. No amount
 * of superposition separates those; a deterministic control does it in one
 * bitstring.
 */
const CNOT_ARGUMENT_ORDER = `OPENQASM 2.0;
include "qelib1.inc";
qreg q[3];
creg c[3];
x q[0];
cx q[0],q[2];
measure q -> c;
`

/** A Toffoli controlled by qubits 0 and 1, both in superposition. */
const TOFFOLI = `OPENQASM 3.0;
include "stdgates.inc";
qubit[3] q;
bit[3] c;
h q[0];
h q[1];
ccx q[0], q[1], q[2];
c[0] = measure q[0];
c[1] = measure q[1];
c[2] = measure q[2];
`

/**
 * Two registers, so the concatenation is under test as well as the order.
 *
 * `alice` is qubits 0–1 and `bob` is qubit 2. The X is on `bob[0]`, which is
 * qubit 2, so the register reads `100` — and a reader that concatenated the
 * registers the other way round would say `001`.
 */
const TWO_REGISTERS = `OPENQASM 2.0;
include "qelib1.inc";
qreg alice[2];
qreg bob[1];
creg c[3];
x bob[0];
measure alice[0] -> c[0];
measure alice[1] -> c[1];
measure bob[0] -> c[2];
`

/**
 * A negative control, which is the attribute a careless reader of `negctrl @`
 * drops — producing a circuit that runs and computes the complement.
 *
 * Qubit 0 is left in |0⟩, so the negative control fires and qubit 1 flips: the
 * register reads `10`.
 */
const NEGATIVE_CONTROL = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
negctrl @ x q[0], q[1];
c[0] = measure q[0];
c[1] = measure q[1];
`

/* ──────────────────────────── the assertions ─────────────────────────── */

describe('an imported program means what Qiskit says it means', () => {
  const BY_HAND: readonly [string, string, Record<string, number>][] = [
    [
      'a Hadamard on qubit 0 of three',
      ONE_QUBIT_OF_THREE,
      { '000': 0.5, '001': 0.5 },
    ],
    // X on qubit 0, then the CNOT: qubit 2 takes the 1 and qubit 1 stays out of
    // it, so the register reads `101` every shot. Swap the CNOT's arguments and
    // it reads `001`.
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
    ['two registers concatenated in order', TWO_REGISTERS, { '100': 1 }],
    ['a negative control that fires', NEGATIVE_CONTROL, { '10': 1 }],
  ]

  it.each(BY_HAND)(
    'gives %s the distribution derived on paper',
    (_name, source, expected) => {
      expectDistribution(distributionOf(source), expected)
    }
  )

  /**
   * The test has teeth: the same programs with every gate's indices mirrored
   * must produce a different answer.
   *
   * The measurements are deliberately left alone. Mirroring *everything* —
   * gates and measurements together — is a relabelling of the whole circuit and
   * therefore a symmetry: the counts come out identical and the test would be
   * vacuous. The bug this guards against is one half of the reader applying a
   * helpful `n - 1 - k`, which is what mirroring only the gates reproduces.
   */
  it.each([
    [
      'a Hadamard on qubit 0',
      ONE_QUBIT_OF_THREE,
      3,
      { '000': 0.5, '001': 0.5 },
    ],
    [
      'a Toffoli',
      TOFFOLI,
      3,
      { '000': 0.25, '001': 0.25, '010': 0.25, '111': 0.25 },
    ],
    ['a negative control', NEGATIVE_CONTROL, 2, { '10': 1 }],
  ])('would catch %s read mirrored', (_name, source, qubits, expected) => {
    expect(() => {
      expectDistribution(
        distributionOf(mirrorGateQubits(source, qubits)),
        expected
      )
    }).toThrow()
  })

  it('would catch a CNOT read control-last', () => {
    const swapped = CNOT_ARGUMENT_ORDER.replace(
      'cx q[0],q[2];',
      'cx q[2],q[0];'
    )
    expect(() => {
      expectDistribution(distributionOf(swapped), { '101': 1 })
    }).toThrow()
  })
})

/* ─────────────────────────────── plumbing ────────────────────────────── */

/**
 * The distribution over the classical register, labelled the way Qiskit prints
 * counts: `c[m-1] … c[0]`, highest bit first.
 *
 * Computed exactly rather than sampled: the measurements are all at the end, so
 * removing them cannot change the state, and the Born-rule probabilities are
 * then grouped by the register the measurements would have written. A sampled
 * comparison would fail once a fortnight for no reason.
 */
function distributionOf(source: string): Map<string, number> {
  const circuit = importOpenQasm(source).circuit
  const unitary: Circuit = {
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
    measured.set(operation.clbitTargets?.[0] ?? 0, operation.targets[0] ?? 0)
  }

  const probs = [...probabilities(result.state)]
  const totals = new Map<string, number>()
  for (let index = 0; index < 1 << circuit.qubits; index++) {
    const probability = probs[index] ?? 0
    if (probability <= 1e-12) continue
    let label = ''
    for (let clbit = circuit.clbits - 1; clbit >= 0; clbit--) {
      const qubit = measured.get(clbit)
      label += qubit === undefined ? '0' : (index >> qubit) & 1
    }
    totals.set(label, (totals.get(label) ?? 0) + probability)
  }
  return totals
}

function expectDistribution(
  actual: Map<string, number>,
  expected: Record<string, number>
): void {
  expect([...actual.keys()].sort()).toEqual(Object.keys(expected).sort())
  for (const [label, probability] of Object.entries(expected)) {
    expect(actual.get(label) ?? 0).toBeCloseTo(probability, 12)
  }
}

/**
 * Rewrites `<register>[i]` as `[n-1-i]` on every line except the measurements —
 * the half-mirror described above, written by hand because no code in this
 * repository should be able to produce one.
 */
function mirrorGateQubits(source: string, qubits: number): string {
  return source
    .split('\n')
    .map((line) =>
      /measure/.test(line) ||
      /^(qubit|bit|qreg|creg|include|OPENQASM)/.test(line)
        ? line
        : line.replace(
            /\bq\[(\d+)\]/g,
            (_match, digits: string) =>
              `q[${String(qubits - 1 - Number(digits))}]`
          )
    )
    .join('\n')
}
