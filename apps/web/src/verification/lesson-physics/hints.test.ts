/**
 * Every alternative answer a hint offers, run through the checker the reader's
 * browser runs.
 *
 * `format.ts` decision 3 is explicit that an objective must accept every
 * construction of the state and not only the one the lesson draws, and each
 * build step's hint names the alternatives it believes are equivalent. This
 * file takes those sentences literally: build the reader's circuit, ask
 * `checkObjective`, and require `met`.
 */

import { describe, expect, it } from 'vitest'

import { LESSONS, lessonBySlug } from '../../features/lessons/catalog'
import { circuitAtStep } from '../../features/lessons/format'
import { checkObjective } from '../../features/lessons/objectives'
import { applyPatch } from '../../features/lessons/patch'
import { startingCircuit } from '../../features/lessons/navigation'
import type { Operation } from '@qsim/schema'

/** Index of the one build step each lesson closes with. */
function buildStepOf(slug: string): { index: number } {
  const lesson = lessonBySlug(slug)
  if (lesson === null) throw new Error(`no lesson ${slug}`)
  const index = lesson.steps.findIndex(
    (step) => step.objective.kind === 'build'
  )
  if (index === -1) throw new Error(`no build step in ${slug}`)
  return { index }
}

/** Status of `answer` placed on the canvas the reader arrives holding. */
function verdict(slug: string, answer: readonly Operation[]): string {
  const lesson = lessonBySlug(slug)!
  const { index } = buildStepOf(slug)
  const start = startingCircuit(lesson, index)
  const applied = applyPatch(start, { add: answer })
  expect(applied.ok).toBe(true)
  if (!applied.ok) throw new Error('patch refused')
  const step = lesson.steps[index]!
  if (step.objective.kind !== 'build') throw new Error('not a build step')
  return checkObjective(
    step.objective.check,
    applied.circuit,
    circuitAtStep(lesson, index)
  ).status
}

describe('every lesson has exactly one build step, and its own patch passes', () => {
  it.each(LESSONS.map((lesson) => lesson.slug))('%s', (slug) => {
    const lesson = lessonBySlug(slug)!
    const { index } = buildStepOf(slug)
    const step = lesson.steps[index]!
    if (step.objective.kind !== 'build') throw new Error('not a build step')
    const status = checkObjective(
      step.objective.check,
      circuitAtStep(lesson, index)!,
      circuitAtStep(lesson, index)
    ).status
    expect(status).toBe('met')
  })
})

describe('superposition: "H … Ry at a quarter turn … and so does √X"', () => {
  it.each([
    { name: 'H', op: { id: 'a', gate: 'h', targets: [0], column: 3 } },
    {
      name: 'Ry(π/2)',
      op: {
        id: 'a',
        gate: 'ry',
        targets: [0],
        params: [Math.PI / 2],
        column: 3,
      },
    },
    { name: '√X', op: { id: 'a', gate: 'sx', targets: [0], column: 3 } },
  ])('$name is accepted', ({ op }) => {
    expect(verdict('superposition', [op as Operation])).toBe('met')
  })
})

describe('entanglement: "an X on either wire … Y works too"', () => {
  it.each([
    { name: 'X on q0', op: { id: 'a', gate: 'x', targets: [0], column: 3 } },
    { name: 'X on q1', op: { id: 'a', gate: 'x', targets: [1], column: 3 } },
    { name: 'Y on q0', op: { id: 'a', gate: 'y', targets: [0], column: 3 } },
    { name: 'Y on q1', op: { id: 'a', gate: 'y', targets: [1], column: 3 } },
  ])('$name is accepted', ({ op }) => {
    expect(verdict('entanglement', [op as Operation])).toBe('met')
  })
})

describe('interference: "H on the second wire … Ry at a quarter turn does the same job"', () => {
  it('H on the marker wire is accepted', () => {
    expect(
      verdict('interference', [{ id: 'a', gate: 'h', targets: [1], column: 3 }])
    ).toBe('met')
  })

  /*
   * ── THE DISCREPANCY THIS FILE USED TO RECORD, NOW REPAIRED ──────────────
   *
   * The hint says, in all three catalogs, that "`Ry` at a quarter turn does
   * the same job" as the `H`. It does — both read the marker wire in the X
   * basis, and they differ only in which of `|+⟩`/`|−⟩` they call zero:
   *
   *   H on q1          → 00 = 0.5, 11 = 0.5
   *   Ry(−π/2) on q1   → 00 = 0.5, 11 = 0.5
   *   Ry(+π/2) on q1   → 01 = 0.5, 10 = 0.5   two bars, the other sorting
   *   √X on q1         → all four at 0.25     not an erasure at all
   *
   * The step's check used to name `|00⟩` and `|11⟩`, so the third of those —
   * a physically correct quantum eraser, built by following the printed hint
   * with the natural reading of "a quarter turn" — was told "Not there yet".
   * That is exactly the failure `format.ts` decision 3 says the feature exists
   * to avoid, arriving through the `expected` map instead of through the
   * gates. The check now asks the task's own question, "two bars instead of
   * four", and says nothing about which two.
   *
   * `√X` is still rejected, and correctly: it is diagonal in the X basis
   * rather than a reading of it. The catalog comment used to offer it.
   */
  it.each([
    { name: 'Ry(+π/2)', angle: Math.PI / 2 },
    { name: 'Ry(−π/2)', angle: -Math.PI / 2 },
  ])('$name on the marker wire is accepted', ({ angle }) => {
    expect(
      verdict('interference', [
        { id: 'a', gate: 'ry', targets: [1], params: [angle], column: 3 },
      ])
    ).toBe('met')
  })

  it('√X is refused: it is diagonal in that basis, not a reading of it', () => {
    expect(
      verdict('interference', [
        { id: 'a', gate: 'sx', targets: [1], column: 3 },
      ])
    ).toBe('unmet')
  })

  /*
   * And the check has not simply become "anything passes". Four equal bars is
   * where the reader starts, and a `Z` on the marker wire changes nothing a
   * histogram can see — both must still be refused, or the step would report
   * success before the reader had done anything.
   */
  it.each([
    { name: 'no gate at all', ops: [] },
    {
      name: 'a Z on the marker wire',
      ops: [{ id: 'a', gate: 'z', targets: [1], column: 3 }],
    },
    {
      name: 'an X on the marker wire',
      ops: [{ id: 'a', gate: 'x', targets: [1], column: 3 }],
    },
  ])('$name is still refused', ({ ops }) => {
    expect(verdict('interference', ops as Operation[])).toBe('unmet')
  })
})

describe('deutsch-jozsa: "a bare Z on that wire works too"', () => {
  it.each([
    {
      name: 'CNOT from q1',
      op: { id: 'a', gate: 'cx', targets: [2], controls: [1], column: 2 },
    },
    { name: 'Z on q1', op: { id: 'a', gate: 'z', targets: [1], column: 2 } },
  ])('$name is accepted', ({ op }) => {
    expect(verdict('deutsch-jozsa', [op as Operation])).toBe('met')
  })
})

describe('grover: "take the two X gates off the first wire and put them on the second"', () => {
  it('the X pair on q1 is accepted', () => {
    const lesson = lessonBySlug('grover')!
    const { index } = buildStepOf('grover')
    const start = startingCircuit(lesson, index)
    const applied = applyPatch(start, {
      remove: ['gr_x0a', 'gr_x0b'],
      add: [
        { id: 'a', gate: 'x', targets: [1], column: 1 },
        { id: 'b', gate: 'x', targets: [1], column: 3 },
      ],
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const step = lesson.steps[index]!
    if (step.objective.kind !== 'build') return
    expect(
      checkObjective(
        step.objective.check,
        applied.circuit,
        circuitAtStep(lesson, index)
      ).status
    ).toBe('met')
  })
})

describe('superdense: "a single Y in place of the Z"', () => {
  it('Z then X is accepted', () => {
    expect(
      verdict('superdense-coding', [
        { id: 'a', gate: 'x', targets: [0], column: 3 },
      ])
    ).toBe('met')
  })

  it('a single Y replacing the Z is accepted', () => {
    const lesson = lessonBySlug('superdense-coding')!
    const { index } = buildStepOf('superdense-coding')
    const start = startingCircuit(lesson, index)
    const applied = applyPatch(start, {
      remove: ['sd_e1'],
      add: [{ id: 'a', gate: 'y', targets: [0], column: 2 }],
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const step = lesson.steps[index]!
    if (step.objective.kind !== 'build') return
    expect(
      checkObjective(
        step.objective.check,
        applied.circuit,
        circuitAtStep(lesson, index)
      ).status
    ).toBe('met')
  })
})

describe('bb84: "an H in the column before her CNOT and another after it"', () => {
  it('the H pair around Eve is accepted', () => {
    expect(
      verdict('bb84', [
        { id: 'a', gate: 'h', targets: [0], column: 2 },
        { id: 'b', gate: 'h', targets: [0], column: 4 },
      ])
    ).toBe('met')
  })
})

describe('teleportation: "either way round is the same gate"', () => {
  it.each([
    {
      name: 'CZ controlled by q0',
      op: { id: 'a', gate: 'cz', targets: [2], controls: [0], column: 7 },
    },
    {
      name: 'CZ controlled by q2',
      op: { id: 'a', gate: 'cz', targets: [0], controls: [2], column: 7 },
    },
  ])('$name is accepted', ({ op }) => {
    expect(verdict('teleportation', [op as Operation])).toBe('met')
  })
})

describe('qpe: the three angles the hint names', () => {
  it('5π/4, π/2 and π are accepted', () => {
    const lesson = lessonBySlug('qpe')!
    const { index } = buildStepOf('qpe')
    const start = startingCircuit(lesson, index)
    const applied = applyPatch(start, {
      remove: ['qp_cp0', 'qp_cp1', 'qp_cp2'],
      add: [
        {
          id: 'a',
          gate: 'cp',
          targets: [3],
          controls: [0],
          params: [(5 * Math.PI) / 4],
          column: 2,
        },
        {
          id: 'b',
          gate: 'cp',
          targets: [3],
          controls: [1],
          params: [Math.PI / 2],
          column: 3,
        },
        {
          id: 'c',
          gate: 'cp',
          targets: [3],
          controls: [2],
          params: [Math.PI],
          column: 4,
        },
      ],
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const step = lesson.steps[index]!
    if (step.objective.kind !== 'build') return
    expect(
      checkObjective(
        step.objective.check,
        applied.circuit,
        circuitAtStep(lesson, index)
      ).status
    ).toBe('met')
  })
})
