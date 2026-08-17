/**
 * Two questions the header of `catalog.ts` asserts and this file checks from
 * outside — Phase 3 verification.
 *
 *   1. **Every seeded challenge is solvable under its own rules.** The catalog
 *      says the reference circuit "is a solution", which is only true for six of
 *      the nine — the other three compute their target from a gate the puzzle
 *      forbids, which is the puzzle. So the solutions are written out here, in
 *      the allowed gate set, and the validator has to accept each one.
 *   2. **The validator's fidelity is the mathematics' fidelity, on circuits
 *      nobody chose.** A deterministic pseudo-random sweep builds circuits from
 *      the palette, computes the answer with the dense reference, and demands
 *      agreement to 1e-10 — D6's tolerance.
 */

import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { CHALLENGES } from '../../challenges/catalog.js'
import { targetFor } from '../../challenges/seed.js'
import { parseChallengeTarget } from '../../challenges/target.js'
import type { ChallengeTarget } from '../../challenges/target.js'
import { judgeSubmission } from '../../challenges/validate.js'
import {
  at,
  c,
  circuitMatrix,
  finalState,
  stateFidelityRef,
  transitionRef,
  unitaryFidelityRef,
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

/** The stored target of a seeded challenge, parsed the way the route does. */
function seededTarget(slug: string): {
  target: ChallengeTarget
  constraints: {
    qubitCount: number
    allowedGates: readonly string[]
    maxGates: number | null
    fidelityThreshold: number
  }
} {
  const definition = CHALLENGES.find((entry) => entry.slug === slug)
  if (definition === undefined) throw new Error(`No challenge "${slug}".`)
  const seeded = targetFor(definition)
  return {
    target: parseChallengeTarget({
      slug,
      targetType: seeded.targetType,
      targetData: seeded.targetData,
    }),
    constraints: {
      qubitCount: seeded.qubitCount,
      allowedGates: definition.allowedGates,
      maxGates: definition.maxGates,
      fidelityThreshold: definition.fidelityThreshold,
    },
  }
}

const ctrl = (q: number): readonly (readonly [number, number])[] => [[q, 1]]

/**
 * A solution to each of the nine, written in its own allowed gate set and
 * within its own budget. Nothing here is copied from the catalog's reference:
 * three of them cannot be.
 */
const SOLUTIONS: Record<string, Step[]> = {
  superposition: [{ gate: 'h', targets: [0] }],
  'minus-state': [
    { gate: 'x', targets: [0] },
    { gate: 'h', targets: [0] },
  ],
  'bell-pair': [
    { gate: 'h', targets: [0] },
    { gate: 'cx', targets: [1], controls: ctrl(0) },
  ],
  'ghz-three': [
    { gate: 'h', targets: [0] },
    { gate: 'cx', targets: [1], controls: ctrl(0) },
    { gate: 'cx', targets: [2], controls: ctrl(0) },
  ],
  'y-eigenstate': [
    { gate: 'h', targets: [0] },
    { gate: 's', targets: [0] },
  ],
  // H·X·H = Z, and `z` is not in the allowed set.
  'hadamard-conjugation': [
    { gate: 'h', targets: [0] },
    { gate: 'x', targets: [0] },
    { gate: 'h', targets: [0] },
  ],
  // H(q0)·CZ·H(q0) = CX(1→0), and `cx` is not in the allowed set.
  'cnot-reversed': [
    { gate: 'h', targets: [0] },
    { gate: 'cz', targets: [1], controls: ctrl(0) },
    { gate: 'h', targets: [0] },
  ],
  'swap-from-cnots': [
    { gate: 'cx', targets: [1], controls: ctrl(0) },
    { gate: 'cx', targets: [0], controls: ctrl(1) },
    { gate: 'cx', targets: [1], controls: ctrl(0) },
  ],
  // The textbook Toffoli decomposition: controls 0 and 1, target 2.
  'toffoli-truth-table': [
    { gate: 'h', targets: [2] },
    { gate: 'cx', targets: [2], controls: ctrl(1) },
    { gate: 'tdg', targets: [2] },
    { gate: 'cx', targets: [2], controls: ctrl(0) },
    { gate: 't', targets: [2] },
    { gate: 'cx', targets: [2], controls: ctrl(1) },
    { gate: 'tdg', targets: [2] },
    { gate: 'cx', targets: [2], controls: ctrl(0) },
    { gate: 't', targets: [1] },
    { gate: 't', targets: [2] },
    { gate: 'h', targets: [2] },
    { gate: 'cx', targets: [1], controls: ctrl(0) },
    { gate: 't', targets: [0] },
    { gate: 'tdg', targets: [1] },
    { gate: 'cx', targets: [1], controls: ctrl(0) },
  ],
}

describe('every seeded challenge is solvable inside its own rules', () => {
  for (const definition of CHALLENGES) {
    it(definition.slug, () => {
      const steps = SOLUTIONS[definition.slug] ?? []
      expect(
        steps.length,
        `no solution written for ${definition.slug}`
      ).toBeGreaterThan(0)

      // The rules, checked here rather than trusted to the validator.
      const allowed = new Set(definition.allowedGates)
      for (const step of steps) {
        expect(allowed.has(step.gate), `${step.gate} is not allowed`).toBe(true)
      }
      if (definition.maxGates !== null) {
        expect(steps.length).toBeLessThanOrEqual(definition.maxGates)
      }

      const { target, constraints } = seededTarget(definition.slug)
      const verdict = judgeSubmission({
        slug: definition.slug,
        constraints,
        target,
        circuit: serial(constraints.qubitCount, steps),
      })
      const codes = verdict.feedback.map((entry) => entry.code)
      expect(codes).toContain('solved')
      expect(verdict.fidelity).toBeGreaterThanOrEqual(
        definition.fidelityThreshold
      )
      expect(verdict.passed).toBe(true)

      /*
       * The invariant `validate.ts` states in its header and a plain `slice`
       * could drop: a truth-table verdict always says what its scope was, on
       * a pass as much as on a failure. Asserted on the one passing
       * truth-table submission this file builds, which is the case a reader
       * is most likely to over-read.
       */
      if (definition.targetType === 'truth_table') {
        expect(codes).toContain('basis-states-only')
      }
    })
  }

  it('the Toffoli decomposition really is CCX, by the dense reference', () => {
    const built = circuitMatrix(3, SOLUTIONS['toffoli-truth-table'] ?? [])
    const wanted = circuitMatrix(3, [
      {
        gate: 'ccx',
        targets: [2],
        controls: [
          [0, 1],
          [1, 1],
        ],
      },
    ])
    // Exact as an operation, not merely as a table — which is more than the
    // challenge asks and is why the table cannot be the thing that fails.
    expect(unitaryFidelityRef(built, wanted)).toBeCloseTo(1, 10)
  })

  it('the conjugated CZ really is the reversed CNOT', () => {
    const built = circuitMatrix(2, SOLUTIONS['cnot-reversed'] ?? [])
    const wanted = circuitMatrix(2, [
      { gate: 'cx', targets: [0], controls: [[1, 1]] },
    ])
    expect(unitaryFidelityRef(built, wanted)).toBeCloseTo(1, 10)
  })

  it('conjugating the other wire gives the CNOT that points the other way', () => {
    // The half of the lesson the challenge does not ask for, checked so that
    // the prompt's claim — the Hadamards decide the direction — is a fact.
    const built = circuitMatrix(2, [
      { gate: 'h', targets: [1] },
      { gate: 'cz', targets: [1], controls: ctrl(0) },
      { gate: 'h', targets: [1] },
    ])
    const wanted = circuitMatrix(2, [
      { gate: 'cx', targets: [1], controls: [[0, 1]] },
    ])
    expect(unitaryFidelityRef(built, wanted)).toBeCloseTo(1, 10)
  })
})

/**
 * The invariant `catalog.ts` states and nothing checked: a challenge whose
 * reference circuit is NOT the intended solution excludes the reference gate
 * from `allowedGates`, so the rule the prompt states is one the server can see.
 *
 * `cnot-reversed` failed this. It computed its target from `cx` and allowed
 * `cx`, so submitting the reference verbatim answered 201 passed:true with one
 * gate and depth one — a rank nobody who does the exercise can beat, and an
 * identity never forced. This asserts the property for all nine rather than
 * for the one that was wrong.
 */
describe('a reference circuit is either a legal solution or a refused one', () => {
  for (const definition of CHALLENGES) {
    it(definition.slug, () => {
      const { target, constraints } = seededTarget(definition.slug)
      const verdict = judgeSubmission({
        slug: definition.slug,
        constraints,
        target,
        circuit: definition.reference,
      })
      const codes = verdict.feedback.map((entry) => entry.code)
      const allowed = new Set(definition.allowedGates)
      const referenceGates = new Set(
        definition.reference.operations.map((operation) => operation.gate)
      )
      const legal = [...referenceGates].every((gate) => allowed.has(gate))

      if (legal) {
        // The reference is the intended answer: it must pass its own puzzle.
        expect(verdict.passed, `${definition.slug} reference`).toBe(true)
        return
      }

      /*
       * The reference is the *statement* of the puzzle, so writing it out must
       * be refused — and refused without a score, because a fidelity answered
       * here is a fidelity answered for any probe (see `validate.ts`).
       */
      expect(verdict.passed, `${definition.slug} reference`).toBe(false)
      expect(codes).toContain('not-scored')
      expect(verdict.fidelity).toBe(0)
      expect(
        verdict.feedback
          .filter((entry) => entry.code === 'gate-not-allowed')
          .map((entry) => entry.gate)
      ).toEqual([...referenceGates].filter((gate) => !allowed.has(gate)).sort())
    })
  }
})

/* ───────────────── the differential sweep over random circuits ─────────── */

/** A small deterministic PRNG, so a failure is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const ONE_QUBIT = ['x', 'y', 'z', 'h', 's', 'sdg', 't', 'tdg', 'i']
const TWO_QUBIT = ['cx', 'cz', 'swap']

function randomSteps(
  random: () => number,
  qubits: number,
  length: number
): Step[] {
  const steps: Step[] = []
  for (let k = 0; k < length; k++) {
    const twoQubit = qubits >= 2 && random() < 0.35
    if (!twoQubit) {
      const gate = ONE_QUBIT[Math.floor(random() * ONE_QUBIT.length)] as string
      steps.push({ gate, targets: [Math.floor(random() * qubits)] })
      continue
    }
    const a = Math.floor(random() * qubits)
    let b = Math.floor(random() * qubits)
    while (b === a) b = Math.floor(random() * qubits)
    const gate = TWO_QUBIT[Math.floor(random() * TWO_QUBIT.length)] as string
    if (gate === 'swap') {
      steps.push({ gate, targets: [a, b] })
    } else {
      steps.push({ gate, targets: [b], controls: [[a, 1]] })
    }
  }
  return steps
}

function stateTargetOf(qubits: number, amplitudes: readonly Cx[]) {
  return parseChallengeTarget({
    slug: 'sweep',
    targetType: 'state',
    targetData: {
      type: 'state',
      qubits,
      amplitudes: amplitudes.map((amp) => [amp.re, amp.im]),
    },
  })
}

function unitaryTargetOf(qubits: number, matrix: Matrix) {
  const dim = 2 ** qubits
  const entries: [number, number][] = []
  for (let col = 0; col < dim; col++) {
    for (let row = 0; row < dim; row++) {
      entries.push([at(matrix, row, col).re, at(matrix, row, col).im])
    }
  }
  return parseChallengeTarget({
    slug: 'sweep',
    targetType: 'unitary',
    targetData: { type: 'unitary', qubits, entries },
  })
}

describe('the validator agrees with the dense reference on circuits nobody chose', () => {
  it('state targets: 240 random pairs, to 1e-10', () => {
    const random = mulberry32(20_260_816)
    for (let trial = 0; trial < 240; trial++) {
      const qubits = 1 + (trial % 3)
      const wantedSteps = randomSteps(
        random,
        qubits,
        1 + Math.floor(random() * 5)
      )
      const mineSteps = randomSteps(
        random,
        qubits,
        1 + Math.floor(random() * 5)
      )
      const wanted = finalState(qubits, wantedSteps)
      const mine = finalState(qubits, mineSteps)
      const expected = stateFidelityRef(mine, wanted)

      const verdict = judgeSubmission({
        slug: 'sweep',
        constraints: {
          qubitCount: qubits,
          allowedGates: [],
          maxGates: null,
          fidelityThreshold: 0.99,
        },
        target: stateTargetOf(qubits, wanted),
        circuit: serial(qubits, mineSteps),
      })
      expect(
        Math.abs(verdict.fidelity - Math.min(1, Math.max(0, expected))),
        `trial ${String(trial)}`
      ).toBeLessThan(1e-10)
      expect(verdict.passed).toBe(expected >= 0.99)
    }
  })

  it('unitary targets: 120 random pairs, to 1e-10', () => {
    const random = mulberry32(9_781_233)
    for (let trial = 0; trial < 120; trial++) {
      const qubits = 1 + (trial % 3)
      const wantedSteps = randomSteps(
        random,
        qubits,
        1 + Math.floor(random() * 4)
      )
      const mineSteps = randomSteps(
        random,
        qubits,
        1 + Math.floor(random() * 4)
      )
      const wanted = circuitMatrix(qubits, wantedSteps)
      const mine = circuitMatrix(qubits, mineSteps)
      const expected = unitaryFidelityRef(mine, wanted)

      const verdict = judgeSubmission({
        slug: 'sweep',
        constraints: {
          qubitCount: qubits,
          allowedGates: [],
          maxGates: null,
          fidelityThreshold: 0.99,
        },
        target: unitaryTargetOf(qubits, wanted),
        circuit: serial(qubits, mineSteps),
      })
      expect(
        Math.abs(verdict.fidelity - Math.min(1, Math.max(0, expected))),
        `trial ${String(trial)}`
      ).toBeLessThan(1e-10)
    }
  })

  it('a global phase never changes the answer, on 120 random circuits', () => {
    const random = mulberry32(4_242_424)
    for (let trial = 0; trial < 120; trial++) {
      const qubits = 1 + (trial % 3)
      const steps = randomSteps(random, qubits, 1 + Math.floor(random() * 5))
      const phi = random() * 2 * Math.PI
      const factor = c(Math.cos(phi), Math.sin(phi))

      const wanted = finalState(qubits, steps).map((amp) =>
        c(
          amp.re * factor.re - amp.im * factor.im,
          amp.re * factor.im + amp.im * factor.re
        )
      )
      const verdict = judgeSubmission({
        slug: 'sweep',
        constraints: {
          qubitCount: qubits,
          allowedGates: [],
          maxGates: null,
          fidelityThreshold: 0.99,
        },
        target: stateTargetOf(qubits, wanted),
        circuit: serial(qubits, steps),
      })
      expect(
        Math.abs(verdict.fidelity - 1),
        `trial ${String(trial)}`
      ).toBeLessThan(1e-10)
      expect(verdict.passed).toBe(true)
    }
  })

  it('truth-table rows agree with |<out|U|in>|^2 on 120 random circuits', () => {
    const random = mulberry32(7_070_707)
    for (let trial = 0; trial < 120; trial++) {
      const qubits = 1 + (trial % 3)
      const steps = randomSteps(random, qubits, 1 + Math.floor(random() * 4))
      const matrix = circuitMatrix(qubits, steps)
      const dim = 2 ** qubits
      const rows = Array.from({ length: dim }, (_value, index) => ({
        input: index,
        output: Math.floor(random() * dim),
      }))
      const expected = Math.min(
        ...rows.map((row) => transitionRef(matrix, row.input, row.output))
      )

      const verdict = judgeSubmission({
        slug: 'sweep',
        constraints: {
          qubitCount: qubits,
          allowedGates: [],
          maxGates: null,
          fidelityThreshold: 0.99,
        },
        target: parseChallengeTarget({
          slug: 'sweep',
          targetType: 'truth_table',
          targetData: { type: 'truth_table', qubits, rows },
        }),
        circuit: serial(qubits, steps),
      })
      expect(
        Math.abs(verdict.fidelity - Math.min(1, Math.max(0, expected))),
        `trial ${String(trial)}`
      ).toBeLessThan(1e-10)
    }
  })
})
