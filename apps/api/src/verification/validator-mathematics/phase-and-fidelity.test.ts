/**
 * The validator's mathematics, derived independently — Phase 3 verification.
 *
 * Every expected number below comes out of `reference.ts`, which builds dense
 * 2ⁿ × 2ⁿ matrices from textbook definitions and multiplies them. `@qsim/core`
 * is never consulted for an expectation, only judged against one.
 *
 * The three questions this file exists to answer:
 *
 *   1. A submission differing from the target by an overall factor of modulus
 *      one is the SAME physical state (or the same operation) and must pass.
 *   2. A submission differing by a RELATIVE phase is a different state and must
 *      fail — with the fidelity the definition predicts, not merely "less".
 *   3. A correct circuit spelled differently — decomposed, repackaged, its
 *      columns renumbered — must be judged on what it computes.
 */

import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { CHALLENGES } from '../../challenges/catalog.js'
import { targetFor } from '../../challenges/seed.js'
import { parseChallengeTarget } from '../../challenges/target.js'
import type { ChallengeTarget } from '../../challenges/target.js'
import { judgeSubmission } from '../../challenges/validate.js'
import type { ChallengeConstraints } from '../../challenges/validate.js'
import {
  at,
  basis,
  c,
  circuitMatrix,
  finalState,
  identity,
  matrixWithGlobalPhase,
  matvec,
  stateFidelityRef,
  transitionRef,
  unitaryFidelityRef,
  withGlobalPhase,
} from './reference.js'
import type { Cx, Matrix, Step } from './reference.js'

function op(
  id: string,
  gate: string,
  targets: number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate, targets, column, ...extra }
}

/** A circuit whose gates run one per column, in the order written. */
function serial(qubits: number, steps: readonly Step[]): Circuit {
  return parseCircuit({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations: steps.map((step, index) =>
      op(
        `op${String(index)}`,
        step.gate,
        [...step.targets],
        index,
        step.controls === undefined
          ? {}
          : {
              controls: step.controls.map(([qubit, state]) => ({
                qubit,
                state: state as 0 | 1,
              })),
            }
      )
    ),
  })
}

function stateTarget(
  qubits: number,
  amplitudes: readonly Cx[]
): ChallengeTarget {
  return parseChallengeTarget({
    slug: 'probe',
    targetType: 'state',
    targetData: {
      type: 'state',
      qubits,
      amplitudes: amplitudes.map((amp) => [amp.re, amp.im]),
    },
  })
}

/** Column-major, which is what `@qsim/core`'s `Unitary` and the column say. */
function unitaryTarget(qubits: number, matrix: Matrix): ChallengeTarget {
  const dim = 2 ** qubits
  const entries: [number, number][] = []
  for (let col = 0; col < dim; col++) {
    for (let row = 0; row < dim; row++) {
      entries.push([at(matrix, row, col).re, at(matrix, row, col).im])
    }
  }
  return parseChallengeTarget({
    slug: 'probe',
    targetType: 'unitary',
    targetData: { type: 'unitary', qubits, entries },
  })
}

function tableTarget(
  qubits: number,
  rows: readonly { input: number; output: number }[]
): ChallengeTarget {
  return parseChallengeTarget({
    slug: 'probe',
    targetType: 'truth_table',
    targetData: { type: 'truth_table', qubits, rows: [...rows] },
  })
}

/** Constraints that get out of the physics' way: only the comparison is tested. */
function open(qubits: number, threshold = 0.99): ChallengeConstraints {
  return {
    qubitCount: qubits,
    allowedGates: [],
    maxGates: null,
    fidelityThreshold: threshold,
  }
}

function judge(
  constraints: ChallengeConstraints,
  target: ChallengeTarget,
  circuit: Circuit
) {
  return judgeSubmission({ slug: 'probe', constraints, target, circuit })
}

const codes = (verdict: { feedback: { code: string }[] }): string[] =>
  verdict.feedback.map((entry) => entry.code)

/* ───────────────────────── 1. global phase passes ──────────────────────── */

describe('a state that differs by a global phase is the same state', () => {
  /*
   * Five phases, including π (every amplitude's sign flipped, the case a
   * reader actually hits comparing against a textbook) and two irrational
   * ones, which is where an implementation that compared amplitudes rather
   * than the modulus of the overlap would come apart.
   */
  const phases = [
    Math.PI,
    Math.PI / 2,
    Math.PI / 4,
    1.234_567,
    2 * Math.PI - 1e-3,
  ]

  const cases: { name: string; qubits: number; steps: Step[] }[] = [
    { name: '|+>', qubits: 1, steps: [{ gate: 'h', targets: [0] }] },
    {
      name: 'a Bell pair',
      qubits: 2,
      steps: [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
      ],
    },
    {
      name: 'a three-qubit GHZ',
      qubits: 3,
      steps: [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
        { gate: 'cx', targets: [2], controls: [[0, 1]] },
      ],
    },
    {
      name: 'a state with a phase already in it',
      qubits: 1,
      steps: [
        { gate: 'h', targets: [0] },
        { gate: 't', targets: [0] },
      ],
    },
  ]

  for (const testCase of cases) {
    for (const phi of phases) {
      it(`${testCase.name} against e^{i·${phi.toFixed(3)}} times itself`, () => {
        const wanted = finalState(testCase.qubits, testCase.steps)
        const rotated = withGlobalPhase(wanted, phi)

        // The definition first: the overlap's modulus is untouched.
        expect(stateFidelityRef(rotated, wanted)).toBeCloseTo(1, 12)

        const verdict = judge(
          open(testCase.qubits),
          stateTarget(testCase.qubits, rotated),
          serial(testCase.qubits, testCase.steps)
        )
        expect(verdict.fidelity).toBeCloseTo(1, 12)
        expect(verdict.passed).toBe(true)
        expect(codes(verdict)).toContain('solved')
      })
    }
  }

  it('announces the phase it ignored rather than hiding it', () => {
    const wanted = finalState(1, [{ gate: 'h', targets: [0] }])
    const verdict = judge(
      open(1),
      stateTarget(1, withGlobalPhase(wanted, Math.PI)),
      serial(1, [{ gate: 'h', targets: [0] }])
    )
    expect(codes(verdict)).toContain('global-phase-ignored')
    const announced = verdict.feedback.find(
      (entry) => entry.code === 'global-phase-ignored'
    )
    // ⟨target|actual⟩ = e^{-iπ}, whose argument is ±π.
    expect(Math.abs(announced?.value ?? 0)).toBeCloseTo(Math.PI, 9)
  })

  it('a circuit that only adds a global phase still solves the puzzle', () => {
    /*
     * X·Z·X·Z = −I, so appending z, x, z, x multiplies the prepared state by
     * −1 and changes nothing physical. Derived, not asserted: the reference
     * matrix of the four-gate suffix is checked to be −I first.
     */
    const suffix: Step[] = [
      { gate: 'z', targets: [0] },
      { gate: 'x', targets: [0] },
      { gate: 'z', targets: [0] },
      { gate: 'x', targets: [0] },
    ]
    const asMatrix = circuitMatrix(1, suffix)
    expect(at(asMatrix, 0, 0).re).toBeCloseTo(-1, 12)
    expect(at(asMatrix, 1, 1).re).toBeCloseTo(-1, 12)

    const plain: Step[] = [{ gate: 'h', targets: [0] }]
    const wanted = finalState(1, plain)
    const verdict = judge(
      open(1),
      stateTarget(1, wanted),
      serial(1, [...plain, ...suffix])
    )
    expect(verdict.fidelity).toBeCloseTo(1, 12)
    expect(verdict.passed).toBe(true)
  })
})

describe('an operation that differs by a global phase is the same operation', () => {
  const phases = [Math.PI, Math.PI / 3, 0.777]

  const cases: { name: string; qubits: number; steps: Step[] }[] = [
    { name: 'Z', qubits: 1, steps: [{ gate: 'z', targets: [0] }] },
    {
      name: 'CNOT',
      qubits: 2,
      steps: [{ gate: 'cx', targets: [1], controls: [[0, 1]] }],
    },
    { name: 'SWAP', qubits: 2, steps: [{ gate: 'swap', targets: [0, 1] }] },
  ]

  for (const testCase of cases) {
    for (const phi of phases) {
      it(`${testCase.name} against e^{i·${phi.toFixed(3)}} times itself`, () => {
        const wanted = circuitMatrix(testCase.qubits, testCase.steps)
        const rotated = matrixWithGlobalPhase(wanted, phi)
        expect(unitaryFidelityRef(rotated, wanted)).toBeCloseTo(1, 12)

        const verdict = judge(
          open(testCase.qubits),
          unitaryTarget(testCase.qubits, rotated),
          serial(testCase.qubits, testCase.steps)
        )
        expect(verdict.fidelity).toBeCloseTo(1, 12)
        expect(verdict.passed).toBe(true)
      })
    }
  }

  it('X·Z·X = −Z, and a circuit that builds it solves a Z challenge', () => {
    // The five-gate answer to `hadamard-conjugation`, which really does differ
    // from the target by a factor of −1 rather than being equal to it.
    const steps: Step[] = [
      { gate: 'x', targets: [0] },
      { gate: 'h', targets: [0] },
      { gate: 'x', targets: [0] },
      { gate: 'h', targets: [0] },
      { gate: 'x', targets: [0] },
    ]
    const built = circuitMatrix(1, steps)
    expect(at(built, 0, 0).re).toBeCloseTo(-1, 12)
    expect(at(built, 1, 1).re).toBeCloseTo(1, 12)

    const target = unitaryTarget(
      1,
      circuitMatrix(1, [{ gate: 'z', targets: [0] }])
    )
    const verdict = judge(open(1), target, serial(1, steps))
    expect(verdict.fidelity).toBeCloseTo(1, 12)
    expect(verdict.passed).toBe(true)
  })
})

/* ─────────────────────── 2. relative phase must fail ───────────────────── */

describe('a relative phase is a different state and is scored as one', () => {
  const cases: {
    name: string
    qubits: number
    target: Step[]
    submitted: Step[]
  }[] = [
    {
      name: '|+> against |->',
      qubits: 1,
      target: [{ gate: 'h', targets: [0] }],
      submitted: [
        { gate: 'h', targets: [0] },
        { gate: 'z', targets: [0] },
      ],
    },
    {
      name: '|+> against (|0> + i|1>)/sqrt2',
      qubits: 1,
      target: [{ gate: 'h', targets: [0] }],
      submitted: [
        { gate: 'h', targets: [0] },
        { gate: 's', targets: [0] },
      ],
    },
    {
      name: '|+> against a T-phase',
      qubits: 1,
      target: [{ gate: 'h', targets: [0] }],
      submitted: [
        { gate: 'h', targets: [0] },
        { gate: 't', targets: [0] },
      ],
    },
    {
      name: 'a Bell pair against its minus sibling',
      qubits: 2,
      target: [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
      ],
      submitted: [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
        { gate: 'z', targets: [0] },
      ],
    },
    {
      name: 'a GHZ against one with a sign on |111>',
      qubits: 3,
      target: [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
        { gate: 'cx', targets: [2], controls: [[0, 1]] },
      ],
      submitted: [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
        { gate: 'cx', targets: [2], controls: [[0, 1]] },
        { gate: 'z', targets: [0] },
      ],
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const wanted = finalState(testCase.qubits, testCase.target)
      const mine = finalState(testCase.qubits, testCase.submitted)
      const expected = stateFidelityRef(mine, wanted)

      const verdict = judge(
        open(testCase.qubits),
        stateTarget(testCase.qubits, wanted),
        serial(testCase.qubits, testCase.submitted)
      )
      expect(verdict.fidelity).toBeCloseTo(expected, 12)
      expect(verdict.passed).toBe(false)
    })
  }

  it('the T-phase miss is exactly cos²(π/8)', () => {
    // A closed form nobody has to trust the reference for: the overlap of
    // (|0>+|1>)/√2 with (|0>+e^{iπ/4}|1>)/√2 is (1 + e^{iπ/4})/2.
    const wanted = finalState(1, [{ gate: 'h', targets: [0] }])
    const verdict = judge(
      open(1),
      stateTarget(1, wanted),
      serial(1, [
        { gate: 'h', targets: [0] },
        { gate: 't', targets: [0] },
      ])
    )
    expect(verdict.fidelity).toBeCloseTo(Math.cos(Math.PI / 8) ** 2, 12)
  })

  it('names the miss as a phase, since the probabilities are identical', () => {
    const wanted = finalState(1, [{ gate: 'h', targets: [0] }])
    const verdict = judge(
      open(1),
      stateTarget(1, wanted),
      serial(1, [
        { gate: 'h', targets: [0] },
        { gate: 'z', targets: [0] },
      ])
    )
    expect(codes(verdict)).toContain('relative-phase')
  })
})

describe('a relative phase in an operation is scored by the definition', () => {
  const cases: {
    name: string
    qubits: number
    target: Step[]
    submitted: Step[]
    expected: number
  }[] = [
    {
      name: 'Z against the identity',
      qubits: 1,
      target: [{ gate: 'z', targets: [0] }],
      submitted: [{ gate: 'i', targets: [0] }],
      // Tr(Z†I) = 1 − 1 = 0.
      expected: 0,
    },
    {
      name: 'Z against S',
      qubits: 1,
      target: [{ gate: 'z', targets: [0] }],
      submitted: [{ gate: 's', targets: [0] }],
      // Tr(Z†S) = 1 − i, |1 − i|² = 2, divided by d² = 4.
      expected: 0.5,
    },
    {
      name: 'CZ against the identity',
      qubits: 2,
      target: [{ gate: 'cz', targets: [1], controls: [[0, 1]] }],
      submitted: [{ gate: 'i', targets: [0] }],
      // Tr(CZ†I) = 1 + 1 + 1 − 1 = 2, squared is 4, over d² = 16.
      expected: 0.25,
    },
    {
      name: 'a CNOT against the same CNOT with its wires exchanged',
      qubits: 2,
      target: [{ gate: 'cx', targets: [1], controls: [[0, 1]] }],
      submitted: [{ gate: 'cx', targets: [0], controls: [[1, 1]] }],
      // The two permutations agree on |00> alone: Tr = 1, over 16.
      expected: 1 / 16,
    },
    {
      name: 'X against Y, which are as unlike as two operations get',
      qubits: 1,
      target: [{ gate: 'x', targets: [0] }],
      submitted: [{ gate: 'y', targets: [0] }],
      expected: 0,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const wanted = circuitMatrix(testCase.qubits, testCase.target)
      const mine = circuitMatrix(testCase.qubits, testCase.submitted)
      expect(unitaryFidelityRef(mine, wanted)).toBeCloseTo(
        testCase.expected,
        12
      )

      const verdict = judge(
        open(testCase.qubits),
        unitaryTarget(testCase.qubits, wanted),
        serial(testCase.qubits, testCase.submitted)
      )
      expect(verdict.fidelity).toBeCloseTo(testCase.expected, 12)
      expect(verdict.passed).toBe(false)
    })
  }
})

/* ─────────── 3. the fidelity is the one claimed, everywhere ───────────── */

describe('the reported fidelity is |<t|a>|^2 and nothing else', () => {
  it('agrees with the slow definition across a sweep of states', () => {
    const wanted = finalState(2, [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [[0, 1]] },
    ])
    for (let k = 0; k < 8; k++) {
      const submitted: Step[] = [
        { gate: 'h', targets: [0] },
        { gate: 'cx', targets: [1], controls: [[0, 1]] },
        ...Array.from({ length: k }, () => ({ gate: 't', targets: [0] })),
      ]
      const mine = finalState(2, submitted)
      const verdict = judge(
        open(2),
        stateTarget(2, wanted),
        serial(2, submitted)
      )
      expect(verdict.fidelity).toBeCloseTo(stateFidelityRef(mine, wanted), 12)
    }
  })

  it('is a probability: never below 0, never above 1', () => {
    const wanted = finalState(1, [{ gate: 'h', targets: [0] }])
    for (let k = 0; k < 16; k++) {
      const submitted: Step[] = [
        { gate: 'h', targets: [0] },
        ...Array.from({ length: k }, () => ({ gate: 't', targets: [0] })),
      ]
      const verdict = judge(
        open(1),
        stateTarget(1, wanted),
        serial(1, submitted)
      )
      expect(verdict.fidelity).toBeGreaterThanOrEqual(0)
      expect(verdict.fidelity).toBeLessThanOrEqual(1)
    }
  })

  it('the threshold is read against the same number the verdict reports', () => {
    /*
     * A submission engineered to sit just under and just over 0.99: the
     * overlap of |+> with (|0> + e^{iθ}|1>)/√2 is cos²(θ/2), so θ = 2·acos(√F)
     * puts the fidelity exactly where we want it.
     */
    const wanted = finalState(1, [{ gate: 'h', targets: [0] }])
    for (const [fidelity, shouldPass] of [
      [0.989, false],
      [0.991, true],
    ] as const) {
      const theta = 2 * Math.acos(Math.sqrt(fidelity))
      const circuit = parseCircuit({
        schemaVersion: CIRCUIT_SCHEMA_VERSION,
        qubits: 1,
        clbits: 0,
        operations: [
          op('a', 'h', [0], 0),
          op('b', 'p', [0], 1, { params: [theta] }),
        ],
      })
      const verdict = judge(open(1), stateTarget(1, wanted), circuit)
      expect(verdict.fidelity).toBeCloseTo(fidelity, 9)
      expect(verdict.passed).toBe(shouldPass)
    }
  })
})

/* ───────────── 4. a truth table checks basis states and says so ────────── */

describe('a truth table is scored on the rows it lists and on nothing else', () => {
  it('cannot tell CZ from the identity, and the seeded catalog knows it', () => {
    // Both leave every two-qubit basis state where it is. The table passes
    // both; the unitary comparison separates them immediately.
    const rows = [0, 1, 2, 3].map((index) => ({ input: index, output: index }))
    const table = tableTarget(2, rows)
    const cz = serial(2, [{ gate: 'cz', targets: [1], controls: [[0, 1]] }])

    expect(judge(open(2), table, cz).fidelity).toBeCloseTo(1, 12)
    expect(judge(open(2), table, cz).passed).toBe(true)

    const asOperation = unitaryTarget(2, identity(4))
    const verdict = judge(open(2), asOperation, cz)
    // Tr(I†CZ) = 2, so the process fidelity is 4/16.
    expect(verdict.fidelity).toBeCloseTo(0.25, 12)
    expect(verdict.passed).toBe(false)
  })

  it('says out loud how many basis inputs it looked at, pass or fail', () => {
    const rows = [0, 1].map((index) => ({ input: index, output: index }))
    const passing = judge(
      open(1),
      tableTarget(1, rows),
      serial(1, [{ gate: 'i', targets: [0] }])
    )
    expect(codes(passing)).toContain('basis-states-only')
    const failing = judge(
      open(1),
      tableTarget(1, rows),
      serial(1, [{ gate: 'x', targets: [0] }])
    )
    expect(codes(failing)).toContain('basis-states-only')
    expect(
      passing.feedback.find((entry) => entry.code === 'basis-states-only')
        ?.value
    ).toBe(2)
  })

  it('scores the worst row, not the average of them', () => {
    /*
     * Three rows correct, one wrong. An average would be 0.75 and would clear
     * a threshold of 0.7; the worst row is 0 and must not.
     */
    const rows = [
      { input: 0, output: 0 },
      { input: 1, output: 1 },
      { input: 2, output: 2 },
      { input: 3, output: 3 },
    ]
    // Flips qubit 1 only when qubit 0 is 1: sends |01>→|11> and |11>→|01>,
    // leaving |00> and |10> alone. Two rows right, two wrong.
    const cx = serial(2, [{ gate: 'cx', targets: [1], controls: [[0, 1]] }])
    const verdict = judge(open(2, 0.7), tableTarget(2, rows), cx)
    expect(verdict.fidelity).toBe(0)
    expect(verdict.passed).toBe(false)
  })

  it('each row is |<out|U|in>|^2, matching the slow reference', () => {
    const steps: Step[] = [
      { gate: 'h', targets: [0] },
      { gate: 'cx', targets: [1], controls: [[0, 1]] },
    ]
    const matrix = circuitMatrix(2, steps)
    const rows = [{ input: 0, output: 3 }]
    const verdict = judge(open(2, 0.4), tableTarget(2, rows), serial(2, steps))
    expect(verdict.fidelity).toBeCloseTo(transitionRef(matrix, 0, 3), 12)
    expect(verdict.fidelity).toBeCloseTo(0.5, 12)
  })

  it('a superposed input is not part of what a table asserts', () => {
    /*
     * Two circuits with the same table on the listed inputs and different
     * behaviour on |++>. The table passes both; that is the documented limit,
     * and this pins it so a future change cannot quietly widen or narrow it.
     */
    const rows = [0, 1, 2, 3].map((index) => ({ input: index, output: index }))
    const table = tableTarget(2, rows)
    const nothing = serial(2, [{ gate: 'i', targets: [0] }])
    const cz = serial(2, [{ gate: 'cz', targets: [1], controls: [[0, 1]] }])
    expect(judge(open(2), table, nothing).passed).toBe(true)
    expect(judge(open(2), table, cz).passed).toBe(true)

    // …and they really do differ, on the state a table cannot see.
    const plus = matvec(
      circuitMatrix(2, [
        { gate: 'h', targets: [0] },
        { gate: 'h', targets: [1] },
      ]),
      basis(2, 0)
    )
    const afterCz = matvec(
      circuitMatrix(2, [{ gate: 'cz', targets: [1], controls: [[0, 1]] }]),
      plus
    )
    expect(stateFidelityRef(afterCz, plus)).toBeCloseTo(0.25, 12)
  })
})

/* ────────── 5. the same computation, spelled differently, is equal ─────── */

describe('a submission is judged on what it computes, not how it is written', () => {
  const bell: Step[] = [
    { gate: 'h', targets: [0] },
    { gate: 'cx', targets: [1], controls: [[0, 1]] },
  ]

  it('column numbers may have gaps without changing the verdict', () => {
    const target = stateTarget(2, finalState(2, bell))
    const dense = serial(2, bell)
    const sparse = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [
        op('a', 'h', [0], 4),
        op('b', 'cx', [1], 41, { controls: [{ qubit: 0, state: 1 }] }),
      ],
    })
    const first = judge(open(2), target, dense)
    const second = judge(open(2), target, sparse)
    expect(second.fidelity).toBeCloseTo(first.fidelity, 12)
    expect(second.gateCount).toBe(first.gateCount)
    expect(second.depth).toBe(first.depth)
    expect(second.passed).toBe(true)
  })

  it('the array order of operations does not matter, only the columns', () => {
    const target = stateTarget(2, finalState(2, bell))
    const shuffled = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [
        op('b', 'cx', [1], 1, { controls: [{ qubit: 0, state: 1 }] }),
        op('a', 'h', [0], 0),
      ],
    })
    const verdict = judge(open(2), target, shuffled)
    expect(verdict.fidelity).toBeCloseTo(1, 12)
    expect(verdict.passed).toBe(true)
  })

  it('two gates on disjoint wires cost one instant however they are drawn', () => {
    const target = stateTarget(
      2,
      finalState(2, [
        { gate: 'h', targets: [0] },
        { gate: 'x', targets: [1] },
      ])
    )
    const together = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [op('a', 'h', [0], 0), op('b', 'x', [1], 0)],
    })
    const apart = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [op('a', 'h', [0], 0), op('b', 'x', [1], 7)],
    })
    const first = judge(open(2), target, together)
    const second = judge(open(2), target, apart)
    expect(first.fidelity).toBeCloseTo(1, 12)
    expect(second.fidelity).toBeCloseTo(1, 12)
    expect(first.depth).toBe(second.depth)
    expect(first.gateCount).toBe(second.gateCount)
  })

  it('a decomposition is worth exactly what the gate it replaces is worth', () => {
    // SWAP = CX(0→1)·CX(1→0)·CX(0→1), and the challenge that asks for it
    // forbids `swap` — so the two spellings must reach the same matrix.
    const swap = circuitMatrix(2, [{ gate: 'swap', targets: [0, 1] }])
    const threeCnots: Step[] = [
      { gate: 'cx', targets: [1], controls: [[0, 1]] },
      { gate: 'cx', targets: [0], controls: [[1, 1]] },
      { gate: 'cx', targets: [1], controls: [[0, 1]] },
    ]
    expect(unitaryFidelityRef(circuitMatrix(2, threeCnots), swap)).toBeCloseTo(
      1,
      12
    )
    const verdict = judge(
      open(2),
      unitaryTarget(2, swap),
      serial(2, threeCnots)
    )
    expect(verdict.fidelity).toBeCloseTo(1, 12)
    expect(verdict.passed).toBe(true)
  })

  it('wrapping the answer in a custom gate changes nothing but the drawing', () => {
    const target = stateTarget(2, finalState(2, bell))
    const wrapped = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [op('a', 'bell', [0, 1], 0)],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            op('i1', 'h', [0], 0),
            op('i2', 'cx', [1], 1, { controls: [{ qubit: 0, state: 1 }] }),
          ],
        },
      },
    })
    const flat = judge(open(2), target, serial(2, bell))
    const packaged = judge(open(2), target, wrapped)
    expect(packaged.fidelity).toBeCloseTo(1, 12)
    expect(packaged.passed).toBe(true)
    // The count and the depth are the primitives', not the package's.
    expect(packaged.gateCount).toBe(flat.gateCount)
    expect(packaged.depth).toBe(flat.depth)
  })
})

/* ─────────── 6. the nine seeded targets are what the maths says ────────── */

describe('every seeded target is the matrix or state the reference computes', () => {
  /** The catalog's reference circuit, in the vocabulary of `reference.ts`. */
  function stepsOf(circuit: Circuit): Step[] {
    return [...circuit.operations]
      .sort((a, b) => a.column - b.column)
      .map((operation) => ({
        gate: operation.gate,
        targets: operation.targets,
        controls: (operation.controls ?? []).map((control) =>
          typeof control === 'number'
            ? ([control, 1] as const)
            : ([control.qubit, control.state] as const)
        ),
      }))
  }

  for (const definition of CHALLENGES) {
    it(definition.slug, () => {
      const seeded = targetFor(definition)
      const steps = stepsOf(definition.reference)
      const qubits = definition.reference.qubits

      if (seeded.targetType === 'state') {
        const wanted = finalState(qubits, steps)
        const stored = (
          seeded.targetData as { amplitudes: [number, number][] }
        ).amplitudes.map(([re, im]) => c(re, im))
        expect(stateFidelityRef(stored, wanted)).toBeCloseTo(1, 10)
      } else if (seeded.targetType === 'unitary') {
        const wanted = circuitMatrix(qubits, steps)
        const dim = 2 ** qubits
        const stored: Matrix = Array.from({ length: dim }, () => [])
        const entries = (seeded.targetData as { entries: [number, number][] })
          .entries
        for (let col = 0; col < dim; col++) {
          for (let row = 0; row < dim; row++) {
            const entry = entries[col * dim + row] as [number, number]
            ;(stored[row] as Cx[])[col] = c(entry[0], entry[1])
          }
        }
        expect(unitaryFidelityRef(stored, wanted)).toBeCloseTo(1, 10)
      } else {
        const matrix = circuitMatrix(qubits, steps)
        const rows = (
          seeded.targetData as { rows: { input: number; output: number }[] }
        ).rows
        for (const row of rows) {
          expect(transitionRef(matrix, row.input, row.output)).toBeCloseTo(
            1,
            10
          )
        }
      }
    })
  }
})
