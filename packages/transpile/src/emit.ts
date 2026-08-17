/**
 * The program that is actually submitted.
 *
 * The statements come from `@qsim/qasm`, unchanged and for the usual reason: a
 * format understood in one place is a format that cannot disagree with itself.
 * What happens here is the one thing that serialiser cannot do, which is to
 * say *which physical qubit* each statement runs on.
 *
 * ── WHY THE INDICES CANNOT SIMPLY BE THE REGISTER'S ──────────────────────
 *
 * `toOpenQasm3` writes `qubit[k] q;` and then `q[0]`, `q[1]` — a *virtual*
 * register, which is right for a file someone pastes into a notebook and wrong
 * for a job. The whole value of layer two is that it chose qubits 53 and 54
 * rather than 81 and 82, because the calibration says the first pair works and
 * the second does not; a program that says `q[0], q[1]` has thrown that choice
 * away and left the backend to make it again.
 *
 * OpenQASM 3 has a spelling for this and it is `$0`, `$1`, …: a **hardware
 * qubit**, which denotes a physical qubit directly and needs no declaration.
 * It exists precisely for programs that have already been placed, which is
 * what this one is. So the default style writes `$53` and drops the register
 * declaration entirely.
 *
 * ── AND WHY THE OTHER STYLE IS ALSO PRODUCED ─────────────────────────────
 *
 * Because there are two conventions in the wild and this project has not spent
 * a job to find out which one a given ingestion path prefers. The alternative
 * is a register as wide as the device — `qubit[156] q;` — with the same
 * physical indices written as `q[53]`, which is what Qiskit's own exporter
 * produces from a transpiled circuit. Both say the same thing; both are here;
 * neither is guessed at by the caller. The contract's own register ceiling is
 * 28 qubits, so the wide form cannot be built as a `Circuit` at all and is
 * written from the placed one instead.
 *
 * ── THE REWRITE IS A LINE FILTER, AND THAT IS SAFE ───────────────────────
 *
 * `toOpenQasm3` puts comments on whole lines and never mid-line, and after
 * expansion there are no `gate` definitions left to carry local qubit names.
 * So a pass that skips comment lines, drops the register declaration and
 * rewrites `q[i]` everywhere else touches exactly the operands.
 * `emit.test.ts` asserts no `q[` survives.
 */

import { toOpenQasm3 } from '@qsim/qasm'
import type { Circuit } from '@qsim/schema'

/** How physical qubits are spelled. See the header for why there are two. */
export type QasmStyle = 'hardware' | 'register'

export interface EmitOptions {
  readonly style?: QasmStyle
  /** Sentences for the header comment, one per line before wrapping. */
  readonly header?: readonly string[]
  /** Register width for the `register` style; ignored by `hardware`. */
  readonly deviceQubits?: number
}

/**
 * The placed circuit as an OpenQASM 3 program over physical qubits.
 *
 * `circuit` is on *compact* indices — qubit `i` of the document is
 * `physicalQubits[i]` on the chip — which is what keeps it inside the
 * contract's 28-qubit ceiling and simulatable by `@qsim/core`.
 */
export function emitPhysicalQasm(
  circuit: Circuit,
  physicalQubits: readonly number[],
  options: EmitOptions = {}
): string {
  const style = options.style ?? 'hardware'
  const source = toOpenQasm3(circuit)
  const body: string[] = []

  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('OPENQASM') || trimmed.startsWith('include '))
      continue
    if (/^qubit\[\d+]\s+q;$/.test(trimmed)) {
      if (style === 'register') {
        /*
         * THE FALLBACK IS THE HIGHEST PHYSICAL INDEX, NOT THE CIRCUIT'S WIDTH.
         *
         * Every operand `rewrite` writes in this style is a *physical* index —
         * `cz q[53], q[54]` — so the declared register has to cover them.
         * Falling back to `circuit.qubits` declared the width of the *compact*
         * circuit, which is the number of qubits the program uses and never
         * the number it indexes: `qubit[2] q;` followed by `q[53]` is an
         * out-of-range register a backend rejects on arrival. On an allowance
         * of ten minutes per twenty-eight days, a job refused at submission is
         * the expensive kind of mistake.
         *
         * `deviceQubits` is still the right answer when the caller has it —
         * `transpile()` always passes it — because a program that declares the
         * whole device is what Qiskit's exporter produces. This is only what
         * happens when nobody said.
         */
        const spanned = physicalQubits.reduce(
          (widest, wire) => Math.max(widest, wire + 1),
          circuit.qubits
        )
        body.push(`qubit[${String(options.deviceQubits ?? spanned)}] q;`)
      }
      continue
    }
    body.push(rewrite(line, physicalQubits, style))
  }

  const lines = [
    'OPENQASM 3.0;',
    'include "stdgates.inc";',
    '',
    ...(options.header ?? []).flatMap(wrapComment),
    '',
    ...body,
  ]
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

const OPERAND = /\bq\[(\d+)]/g

function rewrite(
  line: string,
  physicalQubits: readonly number[],
  style: QasmStyle
): string {
  return line.replace(OPERAND, (_match, digits: string) => {
    const index = Number(digits)
    const physical = physicalQubits[index]
    if (physical === undefined) {
      // Unreachable for a circuit whose width matches the layout, and a
      // silent `q[undefined]` in a submitted program would be a syntax error
      // discovered by a backend rather than by a test.
      throw new RangeError(
        `The emitted program refers to q[${digits}], but the layout has ` +
          `only ${physicalQubits.length} qubits in it.`
      )
    }
    return style === 'hardware'
      ? `$${String(physical)}`
      : `q[${String(physical)}]`
  })
}

/** Comment width, matching the project's 80-column prose. */
const COMMENT_WIDTH = 76

/** One sentence as `//` comment lines, wrapped so nothing runs off. */
function wrapComment(sentence: string): string[] {
  const words = sentence.split(' ')
  const lines: string[] = []
  let current = '//'
  for (const word of words) {
    if (current.length + word.length + 1 > COMMENT_WIDTH && current !== '//') {
      lines.push(current)
      current = '//'
    }
    current += ` ${word}`
  }
  lines.push(current)
  return lines
}
