// @vitest-environment node
import { probabilities, run } from '@qsim/core'
import {
  equivalentCircuits,
  importOpenQasm,
  toOpenQasm3,
  toQiskit,
} from '@qsim/qasm'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { PRESETS } from '../circuit-editor/presets'

/**
 * EVERY SHIPPED EXAMPLE SURVIVES THE ROUND TRIP.
 *
 * ── WHY THIS SUITE IS HERE AND NOT IN `@qsim/qasm` ───────────────────────
 *
 * Because the presets are here. §12.3 says a package never imports from an app,
 * so the round trip over the six examples has to run on this side of the
 * boundary — and it should: these are the circuits a reader actually opens, and
 * an export they cannot re-import is a broken promise on the most-used screen
 * in the product rather than a gap in a library.
 *
 * The package's own `roundtrip.test.ts` covers the general claim with random
 * circuits over the whole catalog. What this adds is the specific one: Bell,
 * GHZ, superposition, interference, Deutsch–Jozsa and teleportation, by name.
 * Teleportation is the interesting member — it is the only preset with a
 * classical register, a mid-circuit measurement and two conditioned gates, which
 * is exactly the combination the column scheduling has to reconstruct correctly
 * from a file that has no columns in it.
 */

function reimport(circuit: Circuit): Circuit {
  return importOpenQasm(toOpenQasm3(circuit)).circuit
}

describe.each(PRESETS.map((preset) => [preset.id, preset.circuit] as const))(
  'the %s preset',
  (_id, circuit) => {
    it('comes back equivalent through OpenQASM 3', () => {
      const verdict = equivalentCircuits(circuit, reimport(circuit))
      expect(verdict.ok ? 'equivalent' : verdict.reason).toBe('equivalent')
    })

    it('reaches a text fixed point after one normalising pass', () => {
      /*
       * The first pass is allowed to move things, and on teleportation it does:
       * the preset's two measurements sit in the same hand-chosen column, and
       * the importer's as-soon-as-possible schedule puts each one as early as
       * its wire allows. That is a different layout of the same circuit — the
       * equivalence above is what says so — and the property that matters is
       * that it settles. Every pass from the second on must be byte-identical,
       * which is what an importer that drifted a little each trip would fail.
       */
      const normalised = toOpenQasm3(reimport(circuit))
      const again = toOpenQasm3(importOpenQasm(normalised).circuit)
      const third = toOpenQasm3(importOpenQasm(again).circuit)
      expect(again).toBe(normalised)
      expect(third).toBe(normalised)
    })

    it('still exports as Python afterwards', () => {
      // The Qiskit emitter reads the same document through the same shared
      // `program.ts`, so an imported circuit it refuses would mean the importer
      // produced a shape only one of the two exporters accepts.
      expect(toQiskit(reimport(circuit))).toContain('from qiskit import')
    })
  }
)

describe('the presets that can be simulated analytically', () => {
  /*
   * All but teleportation, which measures mid-circuit and conditions on the
   * result — analytic mode refuses both by design (§5.3), and the structural
   * equivalence above is what covers it.
   */
  const UNITARY = PRESETS.filter((preset) =>
    preset.circuit.operations.every(
      (operation) =>
        operation.gate !== 'measure' && operation.condition === undefined
    )
  )

  it.each(UNITARY.map((preset) => [preset.id, preset.circuit] as const))(
    'produces the same distribution after a round trip: %s',
    (_id, circuit) => {
      const before = distribution(circuit)
      const after = distribution(reimport(circuit))
      expect(after).toHaveLength(before.length)
      for (let index = 0; index < before.length; index++) {
        expect(after[index] ?? 0).toBeCloseTo(before[index] ?? 0, 10)
      }
    }
  )
})

function distribution(circuit: Circuit): number[] {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return [...probabilities(result.state)]
}
