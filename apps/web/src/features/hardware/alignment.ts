/**
 * Putting a device's answer on the chart's rows — the third place in this
 * project where an endianness mistake would be invisible, and the worst.
 *
 * ════════════════════════════════════════════════════════════════════════
 * TWO REGISTERS, AND THEY ARE NOT THE SAME REGISTER
 *
 * The histogram draws **basis states of the qubit register**: row `index` is
 * the state where qubit `q` is `(index >> q) & 1`, labelled highest qubit first
 * by `formatKet` — decision D1.
 *
 * A device answers with **the classical register**: a bitstring of `clbits`
 * characters, highest classical bit first, `c[0]` last (`@qsim/transpile`'s
 * `results.ts`, which is what folds the hexadecimal samples into these keys).
 *
 * Those two are the same picture only when the circuit's measurements make them
 * the same picture. `c[1] = measure q[0]` is a perfectly ordinary line — the
 * editor writes it whenever somebody drags a measurement to a bit that is not
 * the wire's own number — and under it the device's `10` is the chart's `01`.
 * Reading one as the other exchanges two bars, leaves the total probability
 * unchanged, leaves the fidelity plausible, and cannot be caught by looking at
 * the picture.
 *
 * ── AND A BELL PAIR CANNOT TELL YOU ──────────────────────────────────────
 *
 * The circuit everyone demonstrates with is symmetric under exactly the
 * relabelling being tested: `00` and `11` are fixed points of a bit swap, so a
 * Bell pair agrees with a mirrored implementation of itself. Every test below
 * therefore uses circuits that are asymmetric on purpose — an `x` on one wire
 * and nothing on the other, measured into deliberately crossed bits — which is
 * the same rule `@qsim/transpile`'s `verification/endianness.test.ts` follows
 * and the same one `asymmetricPair` exists for.
 *
 * ── WHAT THIS MODULE DOES *NOT* HAVE TO UNDO ─────────────────────────────
 *
 * The layout. The transpiler permutes **qubits** and not **classical bits**:
 * the document said `c[1] = measure q[0]` and the submitted program says
 * `c[1] = measure $53`, so the register that comes back is already in the
 * document's own order. `results.ts` argues this at length and its conversion
 * deliberately takes no layout. What is left for this module is the crossing
 * the *document itself* wrote, which no amount of care in the transpiler can
 * remove because it is what the author asked for.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHEN THE TWO REGISTERS CANNOT BE JOINED AT ALL, THAT IS SAID OUT LOUD
 *
 * A circuit that measures two of its three qubits produces a classical register
 * that is a *marginal* of the state the chart draws, not a relabelling of it.
 * Overlaying the two would put a device's four outcomes on a chart of eight
 * rows and silently attribute the missing half to noise — a difference that is
 * entirely an accounting artefact, printed in the column whose whole purpose is
 * to show what the hardware did to the circuit.
 *
 * So the join is refused by name in that case, and the panel says which circuit
 * property caused it. Refusing is the cheap outcome here: the comparison is a
 * teaching instrument, and a circuit whose ideal picture and whose device
 * picture are of different things has nothing to teach in one chart.
 */

import { finalClassicalRegister } from '@qsim/qasm'
import { safeExpandCircuit, type Circuit } from '@qsim/schema'

/** Why a device's register could not be laid over the chart's basis states. */
export type AlignmentRefusal =
  /** A qubit the chart draws is never measured, so the device never reports it. */
  | 'unmeasured-qubit'
  /** A classical bit no measurement fills. Its column is not an outcome. */
  | 'unwritten-clbit'
  /** One qubit measured into two bits: the register is not a relabelling. */
  | 'repeated-qubit'

export type CountsAlignment =
  | {
      readonly ok: true
      /**
       * `qubitOfClbit[c]` is the qubit whose value classical bit `c` holds.
       *
       * A total function over `0 … clbits-1` and a bijection onto the qubits —
       * that is exactly what `ok: true` asserts, and it is why the refusals
       * above are the three ways of failing to be one.
       */
      readonly qubitOfClbit: readonly number[]
    }
  | { readonly ok: false; readonly code: AlignmentRefusal }

/**
 * Which qubit each classical bit of this circuit ends up holding.
 *
 * Read from the **expanded** circuit, the same reading `gateCount` and `depth`
 * take: a measurement inside a subcircuit is a measurement, and a document
 * whose only measurements are packaged would otherwise look unmeasured. The
 * fallback for a circuit too large to expand is the unexpanded one, for the
 * reason `helpers.ts` gives — a view that cannot be drawn must not be a crash.
 *
 * A qubit measured **twice into different bits** is not a refusal: the last
 * measurement is what the register holds at the end, so the later bit wins and
 * the earlier one is then unwritten, which the bijection check catches on its
 * own if it leaves a hole. What is refused is one qubit occupying two bits of
 * the *final* register, because there is then no single qubit-register state a
 * key describes.
 *
 * ── "LATER" MEANS LATER IN THE PROGRAM, AND THE PROGRAM IS SORTED ────────
 *
 * The mapping itself comes from `@qsim/qasm`'s `finalClassicalRegister` rather
 * than from a loop here, and that is the fix for a real divergence: this module
 * used to walk `operations` in *array* order while the submitted program is
 * emitted in *column* order (`orderedOperations`). A document that stores a
 * later-column measurement earlier in the array — which nothing forbids — made
 * the two disagree about which qubit a classical bit holds, producing a
 * perfectly valid bijection that was not the register the device returned. One
 * definition, in the module that decides the program's order, is the only
 * arrangement in which they cannot drift.
 */
export function alignMeasurements(
  circuit: Circuit,
  clbits: number
): CountsAlignment {
  const flat = safeExpandCircuit(circuit)?.circuit ?? circuit
  const qubitOfClbit = finalClassicalRegister(flat.operations, clbits)

  const held = new Set<number>()
  for (const qubit of qubitOfClbit) {
    if (qubit === undefined) return { ok: false, code: 'unwritten-clbit' }
    if (held.has(qubit)) return { ok: false, code: 'repeated-qubit' }
    held.add(qubit)
  }
  for (let qubit = 0; qubit < circuit.qubits; qubit++) {
    if (!held.has(qubit)) return { ok: false, code: 'unmeasured-qubit' }
  }

  return { ok: true, qubitOfClbit: qubitOfClbit as readonly number[] }
}

/**
 * The statevector index a device's bitstring describes.
 *
 * `key` is highest classical bit first — `c[clbits-1] … c[0]` — so character
 * `i` is classical bit `clbits - 1 - i`. That bit holds qubit
 * `qubitOfClbit[bit]`, and bit `q` of a statevector index is qubit `q` (D1).
 * The three lines below are that sentence and nothing else; every temptation to
 * "simplify" one of them is a temptation to assume two of the three orders
 * agree, which is the mistake this module exists for.
 *
 * A key of the wrong width, or one carrying a character that is not `0` or `1`,
 * is refused rather than parsed loosely: it means the counts came from a job
 * other than the one being drawn, and every row after it would be wrong.
 */
export function basisIndexOf(
  key: string,
  qubitOfClbit: readonly number[]
): number {
  const clbits = qubitOfClbit.length
  if (key.length !== clbits) {
    throw new RangeError(
      `"${key}" is ${key.length} bits, but the register has ${clbits}. The ` +
        `counts do not belong to the circuit they are being drawn against.`
    )
  }

  let index = 0
  for (let position = 0; position < clbits; position++) {
    const character = key[position]
    if (character !== '0' && character !== '1') {
      throw new RangeError(
        `"${key}" is not a bitstring. A device's counts are keyed by one.`
      )
    }
    if (character === '0') continue
    const clbit = clbits - 1 - position
    const qubit = qubitOfClbit[clbit] as number
    index |= 1 << qubit
  }
  return index
}

/**
 * A device's counts as a distribution over the chart's basis states.
 *
 * Shares rather than counts, because that is what every other reading on the
 * chart is and what `distributionFidelity` requires — handing it raw counts
 * returns a number in the thousands, which is the kind of wrong nobody spots in
 * a UI.
 *
 * The denominator is the counts' own sum and never the job's requested shot
 * count. A device may return fewer shots than were asked for, and dividing by
 * the request would produce a distribution summing to less than one — which the
 * fidelity would then refuse outright, turning a slightly short run into an
 * empty panel.
 */
export function distributionFromCounts(
  counts: Readonly<Record<string, number>>,
  qubits: number,
  qubitOfClbit: readonly number[]
): Float64Array {
  const distribution = new Float64Array(1 << qubits)
  let total = 0
  for (const count of Object.values(counts)) total += count
  if (total === 0) return distribution

  for (const [key, count] of Object.entries(counts)) {
    const index = basisIndexOf(key, qubitOfClbit)
    // `+=` and not `=`: two keys can land on one state, and an assignment
    // would keep the last one and lose the shots of the others silently.
    distribution[index] = (distribution[index] ?? 0) + count / total
  }
  return distribution
}
