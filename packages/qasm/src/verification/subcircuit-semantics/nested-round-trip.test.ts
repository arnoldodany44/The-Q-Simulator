/**
 * A nested, parametrised block survives OpenQASM 3 and comes back meaning the
 * same thing — §3.5, and the half of §3.1 that a serialiser can break.
 *
 * The interesting part is not that the text parses. It is that a `gate`
 * declaration whose body calls another `gate`, applied to wires in an order the
 * definition did not choose, still expands to the same primitives on the same
 * wires — and that the two numbers §3.6 ranks on come back unchanged. A
 * round trip that lost the nesting would still run correctly (the importer
 * could inline it) and would report a different gate count, which is the
 * failure this file exists to catch.
 *
 * The uses are deliberately on the SAME wires: the importer schedules each
 * statement into the earliest column its wires are free, so two uses on
 * disjoint wires would legitimately be repacked into one column and the depth
 * comparison would be measuring the scheduler rather than the block.
 */
import { analyticMode, run } from '@qsim/core'
import {
  depth,
  expandCircuit,
  gateCount,
  parseCircuit,
  type Circuit,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { importOpenQasm } from '../../import/index.js'
import { toOpenQasm3 } from '../../qasm3.js'

function stateOf(circuit: Circuit): number[] {
  const result = run(expandCircuit(circuit).circuit, analyticMode())
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  const out: number[] = []
  for (let index = 0; index < result.state.size; index++) {
    out.push(result.state.re[index] as number, result.state.im[index] as number)
  }
  return out
}

function worstGap(left: number[], right: number[]): number {
  let worst = 0
  for (let index = 0; index < left.length; index++) {
    worst = Math.max(
      worst,
      Math.abs((left[index] as number) - (right[index] as number))
    )
  }
  return worst
}

const NESTED = {
  schemaVersion: 1,
  qubits: 4,
  parameters: [{ name: 'alpha', value: 0.7 }],
  operations: [
    {
      id: 'op_1',
      gate: 'outer',
      targets: [0, 1],
      params: ['alpha'],
      column: 0,
    },
    { id: 'op_2', gate: 'outer', targets: [1, 0], params: [0.25], column: 1 },
  ],
  customGates: {
    inner: {
      qubits: 2,
      params: ['v'],
      operations: [
        { id: 'i1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'i2',
          gate: 'crz',
          targets: [1],
          controls: [0],
          params: ['v'],
          column: 1,
        },
      ],
    },
    outer: {
      qubits: 2,
      params: ['t'],
      // `[1, 0]`: the nested use reverses the wires, which is the mapping a
      // serialiser is most likely to lose.
      operations: [
        { id: 'o1', gate: 'inner', targets: [1, 0], params: ['t'], column: 0 },
        { id: 'o2', gate: 't', targets: [0], column: 1 },
      ],
    },
  },
}

describe('OpenQASM 3 round trip of a nested, parametrised block', () => {
  const circuit = parseCircuit(NESTED)
  const back = importOpenQasm(toOpenQasm3(circuit)).circuit

  it('keeps both definitions rather than flattening them', () => {
    expect(Object.keys(back.customGates ?? {}).sort()).toEqual([
      'inner',
      'outer',
    ])
  })

  it('runs to the same state', () => {
    expect(worstGap(stateOf(circuit), stateOf(back))).toBeLessThan(1e-10)
  })

  it('reports the same two numbers the gallery and the leaderboard read', () => {
    expect(gateCount(back)).toBe(gateCount(circuit))
    expect(depth(back)).toBe(depth(circuit))
  })
})
