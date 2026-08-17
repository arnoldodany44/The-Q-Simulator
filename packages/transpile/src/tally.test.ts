import { tallyQasm3 } from '@qsim/qasm'
import { gateCount } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { deviceGraph } from './device.js'
import { transpile } from './transpile.js'
import { HERON } from './testing/heron.js'
import { bellPair, chain, sequence } from './testing/circuits.js'

/**
 * The submitted program, counted back out of itself.
 *
 * §3.7's comparison view prints "you drew N gates, the device ran M". `N` comes
 * from `@qsim/schema`'s `gateCount` over the document; `M` comes from
 * `tallyQasm3` over the stored OpenQASM 3, because the program that ran was
 * placed against a calibration that no longer exists and cannot be rebuilt.
 * Nothing in either package knows about the other, so this file is where the
 * two readings are made to agree — against a transpiler run that produced both.
 *
 * It is worth the file because the failure mode is invisible. A tally that
 * missed a statement shape would not throw and would not look wrong: it would
 * quietly report a smaller `M`, and the comparison would understate exactly the
 * thing it exists to show.
 */

const heron = deviceGraph(HERON)

/** Every count the tally makes, against the ones the transpiler already made. */
function checkAgreement(circuit: Parameters<typeof transpile>[0]) {
  const plan = transpile(circuit, heron)
  const tally = tallyQasm3(plan.qasm)
  const named = (name: string) =>
    tally.gates.find((gate) => gate.name === name)?.count ?? 0

  /*
   * `stats.operations` is the length of the decomposed circuit, structural
   * statements and all, so the identity has to put the structural counts back
   * in. Writing it this way rather than comparing `gateCalls` alone is what
   * makes a miscounted `barrier` fail here instead of moving silently between
   * two buckets.
   */
  expect(
    tally.gateCalls + tally.measurements + tally.resets + tally.barriers
  ).toBe(plan.stats.operations)

  expect(named('sx') + named('x')).toBe(plan.stats.pulses)
  expect(named('rz')).toBe(plan.stats.frameChanges)
  expect(named('cz')).toBe(plan.stats.twoQubitGates)

  // The program is flat: every custom gate is expanded before decomposition,
  // so a definition here would mean the tally was reading a body as calls.
  expect(tally.definitions).toBe(0)

  return { plan, tally }
}

describe('the tally of a submitted program', () => {
  it('agrees with the transpiler about a Bell pair', () => {
    checkAgreement(bellPair())
  })

  it('agrees about a circuit with a chain of interactions', () => {
    checkAgreement(chain())
  })

  /**
   * The one shape where the tally has to read *inside* a block. A conditioned
   * gate is emitted as `if (c[0] == true) { … }`, and its body runs — so a
   * reader that skipped block contents the way it must skip a definition's
   * would undercount every feed-forward circuit, which is to say every
   * teleportation.
   */
  it('agrees about a circuit with classical feed-forward', () => {
    const { tally } = checkAgreement(
      sequence(2, 2, [
        { gate: 'h', targets: [0] },
        { gate: 'measure', targets: [0], clbitTargets: [0] },
        { gate: 'x', targets: [1], condition: { clbit: 0, equals: 1 } },
        { gate: 'measure', targets: [1], clbitTargets: [1] },
      ])
    )

    expect(tally.conditionals).toBeGreaterThan(0)
  })

  it('agrees about a long one-qubit sequence and a barrier', () => {
    // Varied on purpose: the point is to reach statement shapes a two-gate
    // circuit never produces — several rotations, a `reset`, a `barrier`, and
    // enough `rz` that a dropped line moves a number rather than zeroing one.
    checkAgreement(
      sequence(2, 2, [
        { gate: 'h', targets: [0] },
        { gate: 's', targets: [0] },
        { gate: 't', targets: [0] },
        { gate: 'y', targets: [1] },
        { gate: 'sdg', targets: [1] },
        { gate: 'rx', targets: [0], params: [0.37] },
        { gate: 'ry', targets: [1], params: [1.1] },
        { gate: 'reset', targets: [1] },
        { gate: 'barrier', targets: [0, 1] },
        { gate: 'cx', targets: [1], controls: [0] },
        { gate: 'measure', targets: [0], clbitTargets: [0] },
        { gate: 'measure', targets: [1], clbitTargets: [1] },
      ])
    )
  })

  /**
   * The headline the view actually prints. It is asserted as an inequality
   * rather than a number because the exact expansion is the transpiler's
   * business and changes when a decomposition improves — what must never change
   * is that both sides are counting the same kind of thing, so that the
   * difference is the transpiler's doing and not an accounting change.
   */
  it('counts more gates than were drawn, on the same accounting', () => {
    const drawn = bellPair()
    const { tally } = checkAgreement(drawn)

    expect(tally.gateCalls).toBeGreaterThan(gateCount(drawn))
    // Both exclude measurement. A Bell pair measures two qubits and the device
    // measures the same two, so this difference is entirely decomposition.
    expect(tally.measurements).toBe(2)
  })
})
