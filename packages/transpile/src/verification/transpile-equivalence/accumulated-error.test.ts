/**
 * How far a *whole* transpiled circuit drifts, not just one gate.
 *
 * The gate-by-gate sweep in `decomposition-equivalence.test.ts` cannot see
 * accumulation: a Toffoli is six CNOTs and fifteen rotations, and a twenty-gate
 * circuit becomes eighty-odd native operations whose float errors compound. So
 * this measures the drift over random circuits that use every construction at
 * once — three-qubit gates, negative controls, exchanges, and runs long enough
 * for the fusion pass to fold them.
 *
 * Measured on 2026-08-17: the worst entrywise deviation over 500 such circuits
 * was 1.07e-13, three orders inside decision D6's 1e-10. The bound asserted
 * below is 1e-11, which leaves room for a different machine's rounding without
 * leaving room for an arithmetic mistake.
 */

import { describe, expect, it } from 'vitest'
import type { Operation } from '@qsim/schema'
import { decomposeCircuit } from '../../decompose.js'
import { denseUnitary, line, op, sameUpToGlobalPhase } from './harness.test.js'

const ONE_QUBIT = [
  'i',
  'x',
  'y',
  'z',
  'h',
  's',
  'sdg',
  't',
  'tdg',
  'sx',
  'rx',
  'ry',
  'rz',
  'p',
  'u',
] as const

describe('a whole circuit, not one gate at a time', () => {
  it('200 random circuits of 20 mixed gates stay inside 1e-11', () => {
    let seed = 0x7c1d55
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)] as T

    let worst = 0
    let worstLabel = ''
    for (let trial = 0; trial < 200; trial++) {
      const qubits = 3 + Math.floor(random() * 2)
      const gates: Operation[] = []
      for (let g = 0; g < 20; g++) {
        const kind = random()
        if (kind < 0.55) {
          const gate = pick(ONE_QUBIT)
          const params =
            gate === 'u'
              ? [random() * 12 - 6, random() * 12 - 6, random() * 12 - 6]
              : (['rx', 'ry', 'rz', 'p'] as readonly string[]).includes(gate)
                ? [random() * 12 - 6]
                : undefined
          gates.push(
            op(gate, [Math.floor(random() * qubits)], {
              ...(params === undefined ? {} : { params }),
            })
          )
          continue
        }
        const a = Math.floor(random() * qubits)
        let b = Math.floor(random() * qubits)
        if (b === a) b = (a + 1) % qubits
        if (kind < 0.85) {
          const gate = pick(['cx', 'cz', 'crz', 'cp'] as const)
          gates.push(
            op(gate, [b], {
              controls: [{ qubit: a, state: random() < 0.2 ? 0 : 1 }],
              ...(gate === 'crz' || gate === 'cp'
                ? { params: [random() * 12 - 6] }
                : {}),
            })
          )
          continue
        }
        if (kind < 0.95) {
          gates.push(op(pick(['swap', 'iswap'] as const), [a, b]))
          continue
        }
        let c = Math.floor(random() * qubits)
        while (c === a || c === b) c = (c + 1) % qubits
        gates.push(
          random() < 0.5
            ? op('ccx', [c], { controls: [a, b] })
            : op('cswap', [b, c], { controls: [a] })
        )
      }

      const source = line(qubits, gates)
      const decomposed = decomposeCircuit(source)
      const comparison = sameUpToGlobalPhase(
        denseUnitary(source),
        denseUnitary(decomposed.circuit),
        0
      )
      if (comparison.worst > worst) {
        worst = comparison.worst
        worstLabel =
          `trial ${String(trial)}, ${String(qubits)} qubits, ` +
          `${String(decomposed.circuit.operations.length)} native operations`
      }
    }

    if (worst > 1e-11) {
      throw new Error(
        `worst entrywise deviation ${worst.toExponential(3)} at ${worstLabel}`
      )
    }
    expect(worst).toBeLessThan(1e-11)
  })
})
