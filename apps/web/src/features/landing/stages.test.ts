import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { PRESETS } from '../circuit-editor/presets'
import {
  DEMO_QUBITS,
  DEMO_STAGES,
  DEMO_STAGE_IDS,
  readStage,
  stageAt,
  stageState,
} from './stages'

/**
 * The landing page makes four claims in prose, and each of them is a claim
 * about a distribution. If the physics under a stage stops matching the
 * sentence beside it, the page teaches the wrong thing to exactly the reader
 * who cannot tell — which is the reader §2 wrote the requirement for.
 *
 * So this file asserts the numbers the copy names: one outcome, then two, then
 * four, then two again; and, between the last two, marginals that do not move
 * while the agreement does.
 *
 * D6 fixes the tolerance at 1e-10. Everything here is a half or a quarter, so
 * the comparisons are exact to well inside it.
 */

const TOLERANCE = 1e-10

function reading(id: (typeof DEMO_STAGE_IDS)[number]) {
  const stage = DEMO_STAGES.find((candidate) => candidate.id === id)
  if (stage === undefined) throw new Error(`no stage ${id}`)
  return readStage(stageState(stage.circuit))
}

describe('the demo stages', () => {
  it('lists every id exactly once, in order', () => {
    expect(DEMO_STAGES.map((stage) => stage.id)).toEqual([...DEMO_STAGE_IDS])
  })

  /*
   * The version is written out in `stages.ts` so the landing chunk never
   * imports a value from `@qsim/schema` and therefore never carries Zod. That
   * duplication is deliberate and this is the thing that keeps it honest.
   */
  it('pins the schema version the contract actually declares', () => {
    for (const stage of DEMO_STAGES) {
      expect(stage.circuit.schemaVersion).toBe(CIRCUIT_SCHEMA_VERSION)
    }
  })

  it('ships four circuits the contract accepts', () => {
    for (const stage of DEMO_STAGES) {
      expect(() => parseCircuit(stage.circuit)).not.toThrow()
      expect(stage.circuit.qubits).toBe(DEMO_QUBITS)
    }
  })

  /*
   * Stages 3 and 4 *are* the `superposition` and `bell` examples, and the
   * landing page's second call to action opens the editor on the second of
   * them. A reader who watches the demonstration and then presses that button
   * must arrive at the circuit they were just looking at.
   */
  it.each([
    ['independent', 'superposition'],
    ['entangled', 'bell'],
  ] as const)('draws the same circuit as the %s example', (stageId, preset) => {
    const stage = DEMO_STAGES.find((candidate) => candidate.id === stageId)
    const example = PRESETS.find((candidate) => candidate.id === preset)
    expect(stage?.circuit).toEqual(example?.circuit)
  })

  it('clamps `stageAt` into the sequence at both ends', () => {
    expect(stageAt(-3).id).toBe('zero')
    expect(stageAt(99).id).toBe('entangled')
  })
})

describe('what each stage actually computes', () => {
  it('starts from one certain outcome', () => {
    const { outcomes, marginals, agreement } = reading('zero')
    expect(outcomes).toBe(1)
    expect(marginals[0]).toBeCloseTo(0, 10)
    expect(marginals[1]).toBeCloseTo(0, 10)
    expect(agreement).toBeCloseTo(1, 10)
  })

  it('turns one bar into two with a single H — superposition', () => {
    const { outcomes, marginals } = reading('superposed')
    expect(outcomes).toBe(2)
    // The gate went on q0, and only q0 moved.
    expect(marginals[0]).toBeCloseTo(0.5, 10)
    expect(marginals[1]).toBeCloseTo(0, 10)
  })

  it('draws four outcomes for two independent qubits', () => {
    const { outcomes, marginals, agreement } = reading('independent')
    expect(outcomes).toBe(4)
    expect(marginals[0]).toBeCloseTo(0.5, 10)
    expect(marginals[1]).toBeCloseTo(0.5, 10)
    // Two fair coins agree half the time, which is what makes the next case a
    // comparison rather than a coincidence.
    expect(agreement).toBeCloseTo(0.5, 10)
  })

  /*
   * The claim the whole page turns on: each qubit alone is unchanged, and the
   * pair is not. Asserted as a difference between the two stages rather than
   * as two independent numbers, because the sentence on screen is a comparison.
   */
  it('keeps both marginals and halves the outcomes when the CNOT arrives', () => {
    const coins = reading('independent')
    const pair = reading('entangled')

    expect(pair.marginals[0]).toBeCloseTo(coins.marginals[0] ?? NaN, 10)
    expect(pair.marginals[1]).toBeCloseTo(coins.marginals[1] ?? NaN, 10)

    expect(pair.outcomes).toBe(2)
    expect(coins.outcomes).toBe(4)

    expect(pair.agreement).toBeCloseTo(1, 10)
    expect(Math.abs(pair.agreement - coins.agreement)).toBeGreaterThan(0.49)
  })

  it('never reports a probability outside [0, 1]', () => {
    for (const id of DEMO_STAGE_IDS) {
      const { marginals, agreement } = reading(id)
      for (const value of [...marginals, agreement]) {
        expect(value).toBeGreaterThanOrEqual(-TOLERANCE)
        expect(value).toBeLessThanOrEqual(1 + TOLERANCE)
      }
    }
  })
})
