// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  blochVector,
  formatKet,
  probabilities,
  qubitEntropy,
  run,
  stateFidelity,
  type Statevector,
} from '@qsim/core'
import {
  expandCircuit,
  validateCircuit,
  type Circuit,
  type Operation,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { LESSONS, lessonAfter, lessonBySlug } from './catalog'
import { bb84 } from './catalog/bb84'
import { deutschJozsa } from './catalog/deutschJozsa'
import { entanglement } from './catalog/entanglement'
import { grover } from './catalog/grover'
import { interference } from './catalog/interference'
import { qpe } from './catalog/qpe'
import { superdenseCoding } from './catalog/superdenseCoding'
import { superposition } from './catalog/superposition'
import { teleportation } from './catalog/teleportation'
import {
  circuitAtStep,
  requiredKeys,
  stepCircuits,
  type Lesson,
} from './format'
import { circuitForNavigation, startingCircuit } from './navigation'
import { MAX_LESSON_QUBITS, checkObjective, lessonState } from './objectives'
import { applyPatch, lessonBaseCircuit } from './patch'

/**
 * The lessons themselves, held to the same bar `presets.test.ts` holds the six
 * examples to: **a lesson called superposition that does not produce one
 * teaches the wrong thing to exactly the reader who cannot tell.**
 *
 * So this file does not check that the data parses. It runs every step of
 * every lesson through `@qsim/core` and asserts the physics the prose claims —
 * and it checks the three catalogs against the *structure*, which locale
 * parity cannot do, because three catalogs can agree perfectly on a lesson
 * that no longer exists.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TWO LAYERS, AND THE GENERIC ONE IS THE ONE THAT SCALES.
 *
 * `describe('every lesson')` asserts what is true of all nine — every step
 * builds, every build step's own answer satisfies its own check, and the step
 * before it does not. That last pair is worth more than it looks: a
 * `probabilities` check names a distribution *in the catalog file*, so running
 * it against the lesson's own circuit is what ties the number an author wrote
 * down to the number the engine produces. An author who mistypes a ket, or who
 * writes a build step whose exercise is already done when the reader arrives,
 * fails here without anybody writing a test for that lesson.
 *
 * The per-lesson blocks below it assert the things only that lesson claims:
 * that Deutsch–Jozsa separates constant from balanced in one query, that
 * Grover lands on the marked item and that a second round undoes it, that
 * teleportation reproduces the input state on the third qubit, that all four
 * superdense messages come back, that BB84 agrees when the bases match and
 * disagrees when Eve guesses wrong, that phase estimation reads 3 out of 8.
 * Each one is a sentence in the prose, checked.
 */

const LOCALES = ['en', 'es', 'fr'] as const
const LOCALES_DIR = join(import.meta.dirname, '..', '..', 'i18n', 'locales')

function catalog(language: string): Record<string, unknown> {
  const path = join(LOCALES_DIR, language, 'lessons.json')
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Reads a dotted key out of a catalog, or `undefined`. */
function at(source: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      source
    )
}

/** Every string in a lesson's catalog entry, bodies flattened. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringsOf)
  }
  return []
}

/* ── The engine, over a lesson ──────────────────────────────────────────── */

/** The lesson's own circuit at a step, or a failure naming the step. */
function circuitOf(lesson: Lesson, index: number): Circuit {
  const circuit = circuitAtStep(lesson, index)
  expect(
    circuit,
    `${lesson.slug} step ${index} (${lesson.steps[index]?.id}) does not build`
  ).not.toBeNull()
  return circuit as Circuit
}

function analyticState(circuit: Circuit): Statevector {
  const result = run(expandCircuit(circuit).circuit)
  expect(result.mode).toBe('analytic')
  if (result.mode !== 'analytic') throw new Error('no analytic state')
  return result.state
}

/** Basis state to probability, keyed the way §3.2 prints kets (D1). */
function distributionOf(circuit: Circuit): Record<string, number> {
  const state = analyticState(circuit)
  const values = probabilities(state)
  const out: Record<string, number> = {}
  for (let index = 0; index < values.length; index += 1) {
    out[formatKet(index, state.qubits)] = values[index] ?? 0
  }
  return out
}

/**
 * The distribution at a lesson step, rounded to D6's tolerance and with the
 * empty bars dropped — so a test can say `{ '10': 1 }` and mean it.
 *
 * Rounding rather than a per-key `toBeCloseTo` because what these tests assert
 * is usually the *shape* of a histogram — which bars exist at all — and that is
 * a claim about the whole object. Grover's answer at four items really is
 * probability one, and folding eleven gates of Float64 lands it at
 * 1.0000000000000004; D6 fixes the tolerance at 1e-10 precisely so that a
 * difference of four ulps is not a test failure and a difference of 0.01 is.
 */
const TOLERANCE_DIGITS = 10

function bars(lesson: Lesson, index: number): Record<string, number> {
  const all = distributionOf(circuitOf(lesson, index))
  const out: Record<string, number> = {}
  for (const [ket, probability] of Object.entries(all)) {
    const rounded = Number(probability.toFixed(TOLERANCE_DIGITS))
    if (rounded > 0) out[ket] = rounded
  }
  return out
}

function entropyAt(lesson: Lesson, index: number, qubit: number): number {
  return qubitEntropy(analyticState(circuitOf(lesson, index)), qubit)
}

function blochAt(
  lesson: Lesson,
  index: number,
  qubit: number
): readonly [number, number, number] {
  const vector = blochVector(analyticState(circuitOf(lesson, index)), qubit)
  return [vector.x, vector.y, vector.z]
}

/** The chance a given qubit reads 1, summed over everything else. */
function marginalOne(circuit: Circuit, qubit: number): number {
  const state = analyticState(circuit)
  const values = probabilities(state)
  let total = 0
  for (let index = 0; index < values.length; index += 1) {
    if (((index >> qubit) & 1) === 1) total += values[index] ?? 0
  }
  return total
}

describe('the lesson catalog', () => {
  it('has all nine of §3.6, in the order it lists them', () => {
    expect(LESSONS.map((lesson) => lesson.slug)).toEqual([
      'superposition',
      'entanglement',
      'interference',
      'deutsch-jozsa',
      'grover',
      'teleportation',
      'superdense-coding',
      'bb84',
      'qpe',
    ])
    expect(lessonBySlug('superposition')).toBe(superposition)
    expect(lessonBySlug('no-such-lesson')).toBeNull()
    expect(lessonBySlug(undefined)).toBeNull()
  })

  it('has unique slugs and unique step ids', () => {
    const slugs = LESSONS.map((lesson) => lesson.slug)
    expect(new Set(slugs).size).toBe(slugs.length)

    for (const lesson of LESSONS) {
      const ids = lesson.steps.map((step) => step.id)
      expect(new Set(ids).size, `${lesson.slug} repeats a step id`).toBe(
        ids.length
      )
    }
  })

  it('knows what comes next, and that the last one is last', () => {
    const last = LESSONS[LESSONS.length - 1] as Lesson
    expect(lessonAfter(last)).toBeNull()
    expect(lessonAfter(superposition)).toBe(entanglement)
  })

  it.each(LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    '%s produces a contract-valid circuit at every step',
    (_slug, lesson) => {
      for (const [index, circuit] of stepCircuits(lesson).entries()) {
        expect(
          circuit,
          `${lesson.slug} step ${index} (${lesson.steps[index]?.id}) does not build`
        ).not.toBeNull()
        expect(validateCircuit(circuit!)).toEqual([])
      }
    }
  )

  it.each(LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    '%s stays inside the register this checker will run',
    (_slug, lesson) => {
      // `objectives.ts` runs on the main thread on every edit, and the bound it
      // documents is only true if the catalog respects it.
      for (const circuit of stepCircuits(lesson)) {
        expect(circuit?.qubits).toBeLessThanOrEqual(MAX_LESSON_QUBITS)
      }
    }
  )

  it.each(LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    '%s has every key its shape requires, in all three languages',
    (_slug, lesson) => {
      for (const language of LOCALES) {
        const source = catalog(language)
        for (const key of requiredKeys(lesson)) {
          const value = at(source, key)
          expect(
            value,
            `${language}/lessons.json is missing ${key}`
          ).toBeDefined()
        }
      }
    }
  )

  it.each(LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    '%s has the same number of paragraphs in every language',
    (_slug, lesson) => {
      for (const step of lesson.steps) {
        const counts = LOCALES.map((language) => {
          const body = at(
            catalog(language),
            `${lesson.slug}.steps.${step.id}.body`
          )
          return Array.isArray(body) ? body.length : -1
        })
        expect(
          new Set(counts).size,
          `${lesson.slug}/${step.id} has ${counts.join('/')} paragraphs in en/es/fr`
        ).toBe(1)
        expect(counts[0]).toBeGreaterThan(0)
      }
    }
  )

  /*
   * Notation is invariant (D2), so the *set* of backticked spans must be the
   * same in all three languages. This is the assertion that catches a
   * translator who rendered `|0⟩` as `|zéro⟩`, or who dropped a gate name out
   * of a sentence they rephrased — neither of which parity or a key count can
   * see, and both of which make a lesson point at something that is not on
   * screen.
   */
  it.each(LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    '%s uses the same notation in every language',
    (_slug, lesson) => {
      const spansFor = (language: string): string[] => {
        const text = stringsOf(at(catalog(language), lesson.slug)).join(' ')
        return [...text.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1] as string)
          .sort()
      }
      const reference = spansFor('en')
      for (const language of LOCALES) {
        expect(spansFor(language), `${language} notation differs`).toEqual(
          reference
        )
      }
    }
  )

  /*
   * The prose is rendered by `splitNotation`, which understands backticks and
   * nothing else. A `*` or an underscore meant as emphasis would reach the
   * reader as a literal character in three languages at once, and no other
   * guard in the project looks at the inside of a paragraph.
   */
  it.each(LESSONS.map((lesson) => [lesson.slug, lesson] as const))(
    '%s uses no markup the renderer does not understand',
    (_slug, lesson) => {
      for (const language of LOCALES) {
        for (const text of stringsOf(at(catalog(language), lesson.slug))) {
          expect(text, `${language}: ${text}`).not.toMatch(/[*_]/)
          // An odd number of backticks leaves one unpaired, which `prose.ts`
          // treats as literal — forgiving at runtime, a typo at build time.
          expect((text.match(/`/g) ?? []).length % 2, text).toBe(0)
        }
      }
    }
  )
})

describe('every lesson', () => {
  const buildSteps = LESSONS.flatMap((lesson) =>
    lesson.steps.flatMap((step, index) =>
      step.objective.kind === 'build'
        ? [[`${lesson.slug}/${step.id}`, lesson, index] as const]
        : []
    )
  )

  it('has at least one build step per lesson', () => {
    for (const lesson of LESSONS) {
      expect(
        lesson.steps.some((step) => step.objective.kind === 'build'),
        `${lesson.slug} never hands the canvas over`
      ).toBe(true)
    }
  })

  /*
   * The assertion that ties the catalog to the engine. A `probabilities` check
   * names a distribution by hand; this runs the lesson's own answer and demands
   * that the engine agree with it.
   */
  it.each(buildSteps)(
    '%s is satisfied by its own answer',
    (_name, lesson, index) => {
      const step = lesson.steps[index]!
      if (step.objective.kind !== 'build') return
      const answer = circuitOf(lesson, index)
      expect(checkObjective(step.objective.check, answer, answer).status).toBe(
        'met'
      )
    }
  )

  /*
   * …and is not satisfied before the reader does anything. A build step whose
   * exercise is already done on arrival reports "well done" for a circuit the
   * lesson handed over, which is worse than having no exercise: it teaches the
   * reader that the verdict line means nothing.
   */
  it.each(buildSteps)(
    '%s is not already done when the reader arrives',
    (_name, lesson, index) => {
      const step = lesson.steps[index]!
      if (step.objective.kind !== 'build') return
      const start = startingCircuit(lesson, index)
      const answer = circuitOf(lesson, index)
      expect(checkObjective(step.objective.check, start, answer).status).toBe(
        'unmet'
      )
    }
  )
})

describe('the superposition lesson', () => {
  it('starts at |0⟩ with all of the probability on one outcome', () => {
    expect(bars(superposition, 0)['0']).toBeCloseTo(1, 10)
  })

  it('splits into an even pair after the Hadamard', () => {
    const after = bars(superposition, 1)
    expect(after['0']).toBeCloseTo(0.5, 10)
    expect(after['1']).toBeCloseTo(0.5, 10)
  })

  it('leaves the odds untouched when Z turns the phase', () => {
    // The step whose entire argument is that the histogram does not move.
    expect(bars(superposition, 4)).toEqual(bars(superposition, 3))
  })

  it('interferes back to a certainty, and it is |1⟩ rather than |0⟩', () => {
    // H·Z·H = X. If this ever came back |0⟩ the lesson's closing paragraph
    // would be describing a circuit that does not exist.
    const after = bars(superposition, 5)
    expect(after['1']).toBeCloseTo(1, 10)
    expect(after['0'] ?? 0).toBeCloseTo(0, 10)
  })

  it('ends on an even pair again once the reader adds a gate', () => {
    const after = bars(superposition, 6)
    expect(after['0']).toBeCloseTo(0.5, 10)
    expect(after['1']).toBeCloseTo(0.5, 10)
  })

  it('checks its build step by the outcome, not by the gate', () => {
    const step = superposition.steps[6]!
    expect(step.objective.kind).toBe('build')
    if (step.objective.kind !== 'build') return

    const start = startingCircuit(superposition, 6)
    const target = circuitOf(superposition, 6)

    // A different construction with the same statistics: √X. It produces a
    // state whose phase is nothing like the lesson's, and it must still pass —
    // this is the assertion that keeps the objective from being a spelling
    // test.
    const alternative = applyPatch(start, {
      add: [{ id: 'reader', gate: 'sx', targets: [0], column: 3 }],
    })
    expect(alternative.ok).toBe(true)
    if (!alternative.ok) return
    expect(
      checkObjective(step.objective.check, alternative.circuit, target).status
    ).toBe('met')

    // …and the state really is different, so the test above is not trivially
    // comparing a circuit with itself.
    const mine = lessonState(alternative.circuit)!
    const theirs = lessonState(target)!
    expect(stateFidelity(mine, theirs)).toBeLessThan(0.99)
  })
})

describe('the entanglement lesson', () => {
  it('is a product state before the CNOT and a Bell pair after it', () => {
    const separate = bars(entanglement, 1)
    expect(separate['00']).toBeCloseTo(0.5, 10)
    expect(separate['01']).toBeCloseTo(0.5, 10)
    expect(entropyAt(entanglement, 1, 0)).toBeCloseTo(0, 10)

    const linked = bars(entanglement, 2)
    expect(Object.keys(linked).sort()).toEqual(['00', '11'])
    expect(linked['00']).toBeCloseTo(0.5, 10)
    expect(entropyAt(entanglement, 2, 0)).toBeCloseTo(1, 10)
    expect(entropyAt(entanglement, 2, 1)).toBeCloseTo(1, 10)
  })

  it('leaves neither qubit an arrow of its own', () => {
    // The step whose whole argument is the length of the Bloch vector.
    for (const qubit of [0, 1]) {
      const [x, y, z] = blochAt(entanglement, 3, qubit)
      expect(Math.hypot(x, y, z)).toBeCloseTo(0, 10)
    }
  })

  it('keeps the agreement when both qubits are turned', () => {
    // The lesson's central claim: H⊗H|Φ+⟩ = |Φ+⟩, so the histogram is
    // unchanged and the pair still never disagrees.
    expect(bars(entanglement, 5)).toEqual(bars(entanglement, 2))
    expect(entropyAt(entanglement, 5, 0)).toBeCloseTo(1, 10)
  })

  it('is a claim a shared coin cannot match', () => {
    /*
     * The other half of that claim, and the one the prose leans on: a
     * *mixture* of |00⟩ and |11⟩ — a machine that flipped a coin and printed
     * the answer twice — washes out under the same H⊗H into all four outcomes
     * at a quarter each.
     *
     * Probabilities are linear in the state, so averaging the two branches'
     * distributions is exactly what the mixture gives; no density matrix is
     * needed to say it, and saying it this way keeps the test as short as the
     * argument it is checking.
     */
    const turn: Operation[] = [
      { id: 'a', gate: 'h', targets: [0], column: 2 },
      { id: 'b', gate: 'h', targets: [1], column: 2 },
    ]
    const branch = (bits: 0 | 1): Record<string, number> => {
      const flips: Operation[] =
        bits === 1
          ? [
              { id: 'x0', gate: 'x', targets: [0], column: 0 },
              { id: 'x1', gate: 'x', targets: [1], column: 0 },
            ]
          : []
      const built = applyPatch(lessonBaseCircuit(2), {
        add: [...flips, ...turn],
      })
      expect(built.ok).toBe(true)
      if (!built.ok) throw new Error('branch does not build')
      return distributionOf(built.circuit)
    }

    const zero = branch(0)
    const one = branch(1)
    for (const ket of ['00', '01', '10', '11']) {
      const mixed = ((zero[ket] ?? 0) + (one[ket] ?? 0)) / 2
      expect(mixed, `a shared coin puts ${mixed} on ${ket}`).toBeCloseTo(
        0.25,
        10
      )
    }
    // Where the Bell pair puts nothing at all on two of them.
    expect(bars(entanglement, 5)['01'] ?? 0).toBeCloseTo(0, 10)
  })

  it('ends anti-correlated, by any gate that flips one wire', () => {
    const after = bars(entanglement, 6)
    expect(Object.keys(after).sort()).toEqual(['01', '10'])

    const step = entanglement.steps[6]!
    if (step.objective.kind !== 'build') throw new Error('not a build step')
    const start = startingCircuit(entanglement, 6)
    const target = circuitOf(entanglement, 6)

    // The lesson flips the first wire; flipping the second is just as right,
    // and so is a Y, whose extra phase this check deliberately cannot see.
    for (const [gate, qubit] of [
      ['x', 1],
      ['y', 0],
      ['y', 1],
    ] as const) {
      const mine = applyPatch(start, {
        add: [{ id: 'reader', gate, targets: [qubit], column: 3 }],
      })
      expect(mine.ok).toBe(true)
      if (!mine.ok) continue
      expect(
        checkObjective(step.objective.check, mine.circuit, target).status,
        `${gate} on q${qubit}`
      ).toBe('met')
    }
  })
})

describe('the interference lesson', () => {
  it('turns the phase knob and the odds follow', () => {
    // Certainty, then an eighth, a quarter and a half of a turn.
    expect(bars(interference, 1)['00']).toBeCloseTo(1, 10)
    // (2 − √2)/4, the number the prose rounds to "about 15 per cent".
    expect(bars(interference, 2)['01']).toBeCloseTo((2 - Math.SQRT2) / 4, 10)
    expect(bars(interference, 2)['01']).toBeGreaterThan(0.14)
    expect(bars(interference, 2)['01']).toBeLessThan(0.16)
    expect(bars(interference, 3)['01']).toBeCloseTo(0.5, 10)
    expect(bars(interference, 4)['01']).toBeCloseTo(1, 10)
  })

  it('loses the interference the moment the path is recorded', () => {
    const marked = bars(interference, 5)
    for (const ket of ['00', '01', '10', '11']) {
      expect(marked[ket]).toBeCloseTo(0.25, 10)
    }
    expect(entropyAt(interference, 5, 0)).toBeCloseTo(1, 10)
  })

  it('brings back two bars without making the first qubit predictable', () => {
    // The eraser. `|00⟩` and `|11⟩` at half each…
    const erased = bars(interference, 7)
    expect(Object.keys(erased).sort()).toEqual(['00', '11'])
    expect(erased['00']).toBeCloseTo(0.5, 10)

    // …and the first qubit's own odds are untouched by a gate on the second,
    // which is the sentence in the prose that keeps this step honest. If this
    // ever failed, the lesson would be describing signalling.
    expect(marginalOne(circuitOf(interference, 5), 0)).toBeCloseTo(0.5, 10)
    expect(marginalOne(circuitOf(interference, 7), 0)).toBeCloseTo(0.5, 10)
  })
})

describe('the Deutsch–Jozsa lesson', () => {
  it('leaves the histogram alone when the oracle kicks a phase back', () => {
    // Step 2 is the oracle; the claim is that only the signs moved.
    expect(bars(deutschJozsa, 2)).toEqual(bars(deutschJozsa, 1))
  })

  it('separates balanced from constant in a single query', () => {
    // Balanced (f = the first input bit): the input wires are not both zero.
    expect(bars(deutschJozsa, 3)).toEqual({ '001': 1 })
    // Constant: they are.
    expect(bars(deutschJozsa, 4)).toEqual({ '000': 1 })
    // Balanced the other way (f = the second input bit).
    expect(bars(deutschJozsa, 5)).toEqual({ '010': 1 })
  })

  it('accepts a phase oracle as readily as a CNOT one', () => {
    // The alternative the hint offers: a bare Z on the second input wire
    // applies the same phase without touching the answer sheet at all. It is
    // a different circuit and the same answer, which is exactly what a check
    // over the state rather than over the gates is for.
    const step = deutschJozsa.steps[5]!
    if (step.objective.kind !== 'build') throw new Error('not a build step')
    const start = startingCircuit(deutschJozsa, 5)
    const mine = applyPatch(start, {
      add: [{ id: 'reader', gate: 'z', targets: [1], column: 2 }],
    })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(distributionOf(mine.circuit)['010']).toBeCloseTo(1, 10)
    expect(
      checkObjective(
        step.objective.check,
        mine.circuit,
        circuitOf(deutschJozsa, 5)
      ).status
    ).toBe('met')
  })
})

describe('the Grover lesson', () => {
  it('marks the item without moving a single bar', () => {
    expect(bars(grover, 1)).toEqual(bars(grover, 0))
    for (const probability of Object.values(bars(grover, 0))) {
      expect(probability).toBeCloseTo(0.25, 10)
    }
  })

  it('finds the marked element with certainty after one round', () => {
    expect(bars(grover, 3)).toEqual({ '10': 1 })
  })

  it('finds a different element when the oracle is retargeted', () => {
    expect(bars(grover, 5)).toEqual({ '01': 1 })
  })

  it('gets worse with a second round, exactly as the prose says', () => {
    /*
     * sin(5θ) = 1/2 when sin θ = 1/2, so at four items a second round takes
     * the marked amplitude from 1 back to ½ and the distribution back to a
     * flat quarter. "More rounds is better" is the most common false belief
     * about this algorithm, and the lesson contradicts it in writing, so the
     * circuit had better contradict it too.
     */
    const once = circuitOf(grover, 3)
    const twice = applyPatch(once, {
      add: [
        { id: 'r2_x0a', gate: 'x', targets: [0], column: 9 },
        { id: 'r2_cz', gate: 'cz', targets: [1], controls: [0], column: 10 },
        { id: 'r2_x0b', gate: 'x', targets: [0], column: 11 },
        { id: 'r2_h0', gate: 'h', targets: [0], column: 12 },
        { id: 'r2_h1', gate: 'h', targets: [1], column: 12 },
        { id: 'r2_x0', gate: 'x', targets: [0], column: 13 },
        { id: 'r2_x1', gate: 'x', targets: [1], column: 13 },
        { id: 'r2_dcz', gate: 'cz', targets: [1], controls: [0], column: 14 },
        { id: 'r2_y0', gate: 'x', targets: [0], column: 15 },
        { id: 'r2_y1', gate: 'x', targets: [1], column: 15 },
        { id: 'r2_g0', gate: 'h', targets: [0], column: 16 },
        { id: 'r2_g1', gate: 'h', targets: [1], column: 16 },
      ],
    })
    expect(twice.ok).toBe(true)
    if (!twice.ok) return
    for (const probability of Object.values(distributionOf(twice.circuit))) {
      expect(probability).toBeCloseTo(0.25, 10)
    }
  })
})

describe('the teleportation lesson', () => {
  it('leaves the third qubit with nothing until the corrections land', () => {
    const [x, y, z] = blochAt(teleportation, 2, 2)
    expect(Math.hypot(x, y, z)).toBeCloseTo(0, 10)
  })

  it('recovers the height before the phase', () => {
    // After the CNOT correction the vertical component is already right and
    // everything around the equator is still missing — which is the sentence
    // the step's prose uses.
    const input = blochAt(teleportation, 0, 0)
    const half = blochAt(teleportation, 4, 2)
    expect(half[0]).toBeCloseTo(0, 10)
    expect(half[1]).toBeCloseTo(0, 10)
    expect(half[2]).toBeCloseTo(input[2], 10)
  })

  it('reproduces the input state on the third qubit', () => {
    const input = blochAt(teleportation, 0, 0)
    const arrived = blochAt(teleportation, 5, 2)
    for (const axis of [0, 1, 2] as const) {
      expect(arrived[axis]).toBeCloseTo(input[axis], 10)
    }
    // A real state, not a shrunken one: the arrow is on the surface.
    expect(Math.hypot(...arrived)).toBeCloseTo(1, 10)
    // …and the third qubit is not entangled with anything, so it is a state
    // Bob can now use.
    expect(entropyAt(teleportation, 5, 2)).toBeCloseTo(0, 10)
  })

  it('leaves nothing of the state on the wire it came from', () => {
    // No-cloning, on screen: whatever was on q0, it now reads |+⟩.
    const source = blochAt(teleportation, 5, 0)
    expect(source[0]).toBeCloseTo(1, 10)
    expect(source[1]).toBeCloseTo(0, 10)
    expect(source[2]).toBeCloseTo(0, 10)
  })

  it('accepts the correction pointed the other way round', () => {
    // CZ is symmetric, so a reader who drew it from Bob's qubit to Alice's has
    // built the same gate. The hint says so; this is why it can.
    const step = teleportation.steps[5]!
    if (step.objective.kind !== 'build') throw new Error('not a build step')
    const start = startingCircuit(teleportation, 5)
    const mine = applyPatch(start, {
      add: [
        { id: 'reader', gate: 'cz', targets: [0], controls: [2], column: 7 },
      ],
    })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(
      checkObjective(
        step.objective.check,
        mine.circuit,
        circuitOf(teleportation, 5)
      ).status
    ).toBe('met')
  })
})

describe('the superdense coding lesson', () => {
  it('recovers all four messages', () => {
    expect(bars(superdenseCoding, 1)).toEqual({ '00': 1 })
    expect(bars(superdenseCoding, 2)).toEqual({ '10': 1 })
    expect(bars(superdenseCoding, 3)).toEqual({ '01': 1 })
    expect(bars(superdenseCoding, 4)).toEqual({ '11': 1 })
  })

  it('accepts a single Y for the fourth message', () => {
    // `Y` is `XZ` up to a global phase, so it sends `11` on its own. The hint
    // offers it, which is only honest if the checker agrees.
    const step = superdenseCoding.steps[4]!
    if (step.objective.kind !== 'build') throw new Error('not a build step')
    const start = startingCircuit(superdenseCoding, 4)
    const mine = applyPatch(start, {
      remove: ['sd_e1'],
      add: [{ id: 'sd_e1', gate: 'y', targets: [0], column: 2 }],
    })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return
    expect(distributionOf(mine.circuit)['11']).toBeCloseTo(1, 10)
    expect(
      checkObjective(
        step.objective.check,
        mine.circuit,
        circuitOf(superdenseCoding, 4)
      ).status
    ).toBe('met')
  })

  it('says nothing to Bob until Alice’s qubit arrives', () => {
    // Before the decoder, Bob's own qubit is a fair coin whatever Alice did —
    // which is the half of the accounting the closing step insists on.
    for (const index of [2, 3, 4]) {
      const encoded = circuitOf(superdenseCoding, index)
      const withoutDecoder = applyPatch(encoded, {
        remove: ['sd_dcx', 'sd_dh'],
      })
      expect(withoutDecoder.ok).toBe(true)
      if (!withoutDecoder.ok) continue
      expect(marginalOne(withoutDecoder.circuit, 1)).toBeCloseTo(0.5, 10)
    }
  })
})

describe('the BB84 lesson', () => {
  it('agrees when the bases match and says nothing when they do not', () => {
    expect(bars(bb84, 0)).toEqual({ '1': 1 })
    const mismatched = bars(bb84, 1)
    expect(mismatched['0']).toBeCloseTo(0.5, 10)
    expect(mismatched['1']).toBeCloseTo(0.5, 10)
    expect(bars(bb84, 2)).toEqual({ '1': 1 })
  })

  it('wrecks a matched round when Eve guesses the wrong basis', () => {
    const tapped = bars(bb84, 4)
    for (const ket of ['00', '01', '10', '11']) {
      expect(tapped[ket]).toBeCloseTo(0.25, 10)
    }
    // Bob is wrong half the time on a round that was certain a step ago.
    expect(marginalOne(circuitOf(bb84, 4), 0)).toBeCloseTo(0.5, 10)
    // And the mark she leaves is a whole bit of entropy on the travelling
    // qubit, which is what the entanglement panel is pointed at.
    expect(entropyAt(bb84, 4, 0)).toBeCloseTo(1, 10)
  })

  it('is invisible when she guesses right, which the lesson says out loud', () => {
    expect(bars(bb84, 6)).toEqual({ '11': 1 })
    // Bob certain, Eve holding a copy, and no entropy anywhere to notice.
    expect(entropyAt(bb84, 6, 0)).toBeCloseTo(0, 10)
    expect(entropyAt(bb84, 6, 1)).toBeCloseTo(0, 10)
  })
})

describe('the phase estimation lesson', () => {
  it('shows an eigenstate going through the gate unchanged', () => {
    // The opening claim: the gate is applied and nothing measurable happens.
    expect(bars(qpe, 0)).toEqual({ '1000': 1 })
  })

  it('changes only phases while the controlled applications run', () => {
    const ruler = bars(qpe, 1)
    expect(Object.keys(ruler)).toHaveLength(8)
    for (const probability of Object.values(ruler)) {
      expect(probability).toBeCloseTo(0.125, 10)
    }
    expect(bars(qpe, 2)).toEqual(ruler)
    expect(bars(qpe, 3)).toEqual(ruler)
  })

  it('reads three eighths of a turn as 3 out of 8', () => {
    const answer = bars(qpe, 4)
    expect(Object.keys(answer)).toEqual(['1011'])
    expect(answer['1011']).toBeCloseTo(1, 10)
  })

  it('spreads, and peaks on the nearest value, when the phase does not fit', () => {
    /*
     * 0.3 of a turn is 2.4 eighths. The prose quotes about 58 per cent on 2 and
     * about 26 per cent on 3, and then makes a stronger claim than either: that
     * the two nearest values hold at least 8/π² between them, which is the
     * algorithm's guarantee rather than a property of this angle. All three are
     * asserted, so an edit to the angle cannot quietly make the paragraph
     * wrong.
     */
    const spread = bars(qpe, 5)
    const tallest = Object.entries(spread).sort((a, b) => b[1] - a[1])[0]!
    expect(tallest[0]).toBe('1010')
    expect(spread['1010']).toBeCloseTo(0.5775, 3)
    expect(spread['1011']).toBeCloseTo(0.2593, 3)
    expect(spread['1010']! + spread['1011']!).toBeGreaterThan(8 / Math.PI ** 2)
  })

  it('reads five eighths once the reader sets the three angles', () => {
    expect(bars(qpe, 6)).toEqual({ '1101': 1 })
  })
})

describe('moving through a lesson', () => {
  const lesson = superposition

  it('opens a build step on the circuit the reader has to change', () => {
    // Step 6 is the build step; its starting circuit is step 5's, not its own.
    expect(startingCircuit(lesson, 6)).toEqual(stepCircuits(lesson)[5])
  })

  it('applies a step forward as a diff to whatever is on the canvas', () => {
    const start = stepCircuits(lesson)[0]!
    const next = circuitForNavigation(lesson, start, 0, 1)
    // Exactly one operation more than the step before it: the patch landed on
    // the reader's document rather than replacing it.
    expect(next.operations).toHaveLength(start.operations.length + 1)
    expect(next).toEqual(stepCircuits(lesson)[1])
  })

  it("keeps the reader's own construction when they move on", () => {
    const start = startingCircuit(lesson, 6)
    const mine = applyPatch(start, {
      add: [{ id: 'reader', gate: 'sx', targets: [0], column: 3 }],
    })
    expect(mine.ok).toBe(true)
    if (!mine.ok) return

    // There is no step 7, so this asserts the shape of the rule rather than a
    // real move: a forward step applies the patch to what is there. The last
    // step has nothing after it, so the canvas is left alone.
    expect(circuitForNavigation(lesson, mine.circuit, 6, 7)).toBe(mine.circuit)
  })

  it("restores the lesson's own circuit when the reader goes back", () => {
    const wandered = applyPatch(lessonBaseCircuit(1), {
      add: [{ id: 'stray', gate: 'x', targets: [0], column: 0 }],
    })
    expect(wandered.ok).toBe(true)
    if (!wandered.ok) return

    // Backwards from step 5 to step 2, holding something the lesson never
    // produced: the fold repairs it.
    expect(circuitForNavigation(lesson, wandered.circuit, 5, 2)).toEqual(
      stepCircuits(lesson)[2]
    )
  })

  it('falls back to the fold when a forward patch cannot land', () => {
    // The reader has parked a gate exactly where step 1's H was going.
    const blocked = applyPatch(lessonBaseCircuit(1), {
      add: [{ id: 'ls_h1', gate: 'x', targets: [0], column: 0 }],
    })
    expect(blocked.ok).toBe(true)
    if (!blocked.ok) return

    // A duplicate id and an occupied cell — `applyPatch` refuses, and
    // navigation answers with the lesson's own circuit rather than throwing.
    expect(circuitForNavigation(lesson, blocked.circuit, 0, 1)).toEqual(
      stepCircuits(lesson)[1]
    )
  })

  it('grows the register when a lesson asks for another wire', () => {
    // BB84 is the only lesson that adds a qubit mid-way, and the moment it
    // does is the moment Eve appears. A patch that silently failed to resize
    // would leave her CNOT pointing at a wire that does not exist, which
    // `applyPatch` refuses — so this is the assertion that the growth works
    // rather than that it is merely written down.
    expect(circuitOf(bb84, 3).qubits).toBe(1)
    expect(circuitOf(bb84, 4).qubits).toBe(2)
  })
})
