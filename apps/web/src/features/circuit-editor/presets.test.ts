import {
  amplitude,
  createRng,
  marginalProbability,
  probabilities,
  run,
  runTrajectory,
  type Statevector,
} from '@qsim/core'
import { safeParseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { decode, encode } from '../../lib/circuit-url'
import { needsTrajectories } from '../simulation/mode'
import {
  PRESETS,
  PRESET_IDS,
  TELEPORTATION_MESSAGE_ANGLE,
  findPreset,
  type PresetId,
} from './presets'

/**
 * Every preset is run through `@qsim/core` and checked against the state its
 * name claims. This is the whole point of the file: a preset is a promise made
 * to a reader who cannot yet check it themselves, so the promise is checked
 * here instead.
 *
 * Tolerance is D6's 1e-10 throughout. It is not slack: `p(π)` is
 * `e^{iπ} = -1 + 1.22e-16 i`, so several of these states carry a genuine
 * float residue in the imaginary part, and the assertions have to be about
 * physics rather than about the last bits of a mantissa.
 */

const TOLERANCE = 1e-10
const HALF = 1 / 2
const INVERSE_ROOT_TWO = Math.SQRT1_2

function analyticState(circuit: Circuit): Statevector {
  const result = run(circuit)
  // Narrowed rather than asserted: `run` returns a union, and a preset that
  // silently became a measuring circuit should fail here loudly.
  if (result.mode !== 'analytic') {
    throw new Error('expected an analytic run')
  }
  return result.state
}

function circuitOf(id: PresetId): Circuit {
  const preset = findPreset(id)
  if (preset === undefined) throw new Error(`no preset named ${id}`)
  return preset.circuit
}

/** Probability of every basis state, as a plain array for readable diffs. */
function distribution(state: Statevector): number[] {
  return [...probabilities(state)]
}

describe('every preset', () => {
  it('has exactly the ids it declares, in one order', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([...PRESET_IDS])
  })

  it.each(PRESETS)('is a valid circuit: $id', (preset) => {
    const parsed = safeParseCircuit(preset.circuit)
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
  })

  it.each(PRESETS)('survives a round trip through a link: $id', (preset) => {
    // A preset that cannot be shared is a preset the landing page cannot link
    // to, which is most of what they are for.
    const result = decode(encode(preset.circuit))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.circuit).toEqual(preset.circuit)
  })

  it.each(PRESETS)('produces a normalised state: $id', (preset) => {
    const total = needsTrajectories(preset.circuit)
      ? [...probabilities(runTrajectory(preset.circuit, createRng(7)).state)]
      : distribution(analyticState(preset.circuit))
    expect(total.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10)
  })
})

describe('superposition', () => {
  it('puts all four basis states at equal probability', () => {
    const state = analyticState(circuitOf('superposition'))
    expect(distribution(state)).toHaveLength(4)
    for (const probability of distribution(state)) {
      expect(probability).toBeCloseTo(0.25, 10)
    }
  })

  it('leaves each qubit at an even chance of reading one', () => {
    const state = analyticState(circuitOf('superposition'))
    expect(marginalProbability(state, 0)).toBeCloseTo(HALF, 10)
    expect(marginalProbability(state, 1)).toBeCloseTo(HALF, 10)
  })
})

describe('Bell', () => {
  it('is (|00⟩ + |11⟩)/√2 and nothing else', () => {
    const state = analyticState(circuitOf('bell'))
    // Little-endian (D1): index = q0 + 2·q1, so |00⟩ is 0 and |11⟩ is 3.
    expect(amplitude(state, 0).re).toBeCloseTo(INVERSE_ROOT_TWO, 10)
    expect(amplitude(state, 3).re).toBeCloseTo(INVERSE_ROOT_TWO, 10)
    for (const index of [0, 3]) {
      expect(Math.abs(amplitude(state, index).im)).toBeLessThan(TOLERANCE)
    }
    for (const index of [1, 2]) {
      expect(distribution(state)[index]).toBeLessThan(TOLERANCE)
    }
  })

  it('is entangled: each qubit alone is even, and the two always agree', () => {
    const state = analyticState(circuitOf('bell'))
    // The signature of entanglement in a histogram: both marginals say "half
    // the time", and yet only two of the four joint outcomes ever occur.
    expect(marginalProbability(state, 0)).toBeCloseTo(HALF, 10)
    expect(marginalProbability(state, 1)).toBeCloseTo(HALF, 10)
    const joint = distribution(state)
    expect(joint[0]! + joint[3]!).toBeCloseTo(1, 10)
  })
})

describe('GHZ', () => {
  it('is (|000⟩ + |111⟩)/√2', () => {
    const state = analyticState(circuitOf('ghz'))
    const joint = distribution(state)
    expect(joint).toHaveLength(8)
    expect(joint[0]).toBeCloseTo(HALF, 10)
    expect(joint[7]).toBeCloseTo(HALF, 10)
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(joint[index]).toBeLessThan(TOLERANCE)
    }
  })

  it('correlates all three qubits, not just the two the CNOTs touch', () => {
    const state = analyticState(circuitOf('ghz'))
    for (const qubit of [0, 1, 2]) {
      expect(marginalProbability(state, qubit)).toBeCloseTo(HALF, 10)
    }
  })
})

describe('interference', () => {
  it('cancels on |0⟩ and adds on |1⟩ at φ = π', () => {
    const state = analyticState(circuitOf('interference'))
    const joint = distribution(state)
    expect(joint[0]).toBeLessThan(TOLERANCE)
    expect(joint[1]).toBeCloseTo(1, 10)
  })

  it('is the identity at φ = 0 — the same circuit, the other outcome', () => {
    // Not a second preset: the claim being checked is that the *phase* is what
    // decides, and the only way to check that is to change nothing else.
    const circuit = circuitOf('interference')
    const flat: Circuit = {
      ...circuit,
      operations: circuit.operations.map((operation) =>
        operation.gate === 'p' ? { ...operation, params: [0] } : operation
      ),
    }
    const joint = distribution(analyticState(flat))
    expect(joint[0]).toBeCloseTo(1, 10)
    expect(joint[1]).toBeLessThan(TOLERANCE)
  })

  it('passes through an even split halfway, at φ = π/2', () => {
    const circuit = circuitOf('interference')
    const half: Circuit = {
      ...circuit,
      operations: circuit.operations.map((operation) =>
        operation.gate === 'p'
          ? { ...operation, params: [Math.PI / 2] }
          : operation
      ),
    }
    const joint = distribution(analyticState(half))
    expect(joint[0]).toBeCloseTo(HALF, 10)
    expect(joint[1]).toBeCloseTo(HALF, 10)
  })
})

describe('Deutsch–Jozsa', () => {
  it('reads |11⟩ on the input register, which is the balanced answer', () => {
    const state = analyticState(circuitOf('deutschJozsa'))
    // The oracle f(x) = x₀ ⊕ x₁ is balanced, so both input qubits read 1 with
    // certainty. A constant oracle would give 0 with the same certainty; the
    // whole algorithm is that this is decided in one run.
    expect(marginalProbability(state, 0)).toBeCloseTo(1, 10)
    expect(marginalProbability(state, 1)).toBeCloseTo(1, 10)
  })

  it('leaves the ancilla in |−⟩, untouched by the query', () => {
    const state = analyticState(circuitOf('deutschJozsa'))
    expect(marginalProbability(state, 2)).toBeCloseTo(HALF, 10)
    // |11⟩ on the input times (|0⟩ − |1⟩)/√2 on the ancilla: indices 3 and 7,
    // and nothing anywhere else.
    const joint = distribution(state)
    expect(joint[3]! + joint[7]!).toBeCloseTo(1, 10)
  })

  it('answers |00⟩ for a constant oracle', () => {
    // The control case, and the reason the balanced answer above means
    // anything: with the oracle removed, f is constant and the input register
    // comes back to where it started.
    const circuit = circuitOf('deutschJozsa')
    const constant: Circuit = {
      ...circuit,
      operations: circuit.operations.filter(
        (operation) => operation.gate !== 'cx'
      ),
    }
    const state = analyticState(constant)
    expect(marginalProbability(state, 0)).toBeLessThan(TOLERANCE)
    expect(marginalProbability(state, 1)).toBeLessThan(TOLERANCE)
  })
})

describe('teleportation', () => {
  const expectedOne = Math.sin(TELEPORTATION_MESSAGE_ANGLE / 2) ** 2

  /**
   * The protocol without its closing readout of q2.
   *
   * That measurement is what puts the arriving state on the reader's screen —
   * a circuit answering with a tally of the classical register has no other
   * way to show it (`presets.ts`) — and it is a collapse, so the claims below
   * about the state Bob is *holding* are asked of the protocol proper. What
   * the readout produces is asserted separately, and the two together are the
   * whole circuit.
   */
  function protocol(): Circuit {
    const circuit = circuitOf('teleportation')
    return {
      ...circuit,
      operations: circuit.operations.filter(
        (operation) => operation.id !== 'op_10'
      ),
    }
  }

  /**
   * |⟨ψ|χ⟩|² for Bob's qubit after one trajectory.
   *
   * THIS, AND NOT `marginalProbability`, IS WHAT PINS THE PROTOCOL. The message
   * is prepared by an `ry`, so |ψ⟩ is real and dropping Bob's Z correction
   * gives cos|0⟩ − sin|1⟩ — whose marginal is sin²(θ/2), identical to the
   * correct state's. A file asserting only the marginal therefore passed on a
   * teleporter with a quarter of its corrections deleted, which is not a test
   * of teleportation. Fidelity sees the sign; `it('would fail…')` proves it by
   * breaking the circuit and watching this number fall to a quarter.
   *
   * q0 and q1 have been measured, so the state is a product |m₀⟩|m₁⟩|χ⟩ and χ
   * is the pair of amplitudes at m₀ + 2·m₁ and that index plus four.
   */
  function bobsFidelity(circuit: Circuit, seed: number): number {
    const { state, register } = runTrajectory(circuit, createRng(seed))
    const base = register[0]! + 2 * register[1]!
    const psi = [
      Math.cos(TELEPORTATION_MESSAGE_ANGLE / 2),
      Math.sin(TELEPORTATION_MESSAGE_ANGLE / 2),
    ] as const
    // ⟨ψ| is real, so the overlap is ψ₀·χ₀ + ψ₁·χ₁ component by component.
    const re =
      psi[0] * amplitude(state, base).re +
      psi[1] * amplitude(state, base + 4).re
    const im =
      psi[0] * amplitude(state, base).im +
      psi[1] * amplitude(state, base + 4).im
    return re * re + im * im
  }

  it('needs trajectories mode, and says so from the document alone', () => {
    expect(needsTrajectories(circuitOf('teleportation'))).toBe(true)
  })

  it('lands the message itself on q2, phase and all, in every trajectory', () => {
    // Every seed, not an average: teleportation is exact per run, not exact on
    // average. If any single trajectory left q2 holding the wrong state, the
    // protocol would be wrong and a tally over many runs could still hide it —
    // the four measurement outcomes are equally likely and their errors would
    // partly cancel in the aggregate.
    const circuit = protocol()
    for (let seed = 1; seed <= 60; seed += 1) {
      expect(bobsFidelity(circuit, seed), `seed ${seed}`).toBeCloseTo(1, 10)
    }
  })

  it('would fail if either correction were dropped', () => {
    // The point of this one is the test, not the preset: a check that cannot
    // fail proves nothing about the check above it. Dropping Bob's Z leaves
    // the *marginal* of q2 exactly right and the state wrong.
    for (const dropped of ['op_8', 'op_9']) {
      const base = protocol()
      const broken: Circuit = {
        ...base,
        operations: base.operations.filter(
          (operation) => operation.id !== dropped
        ),
      }
      let worst = 1
      for (let seed = 1; seed <= 60; seed += 1) {
        worst = Math.min(worst, bobsFidelity(broken, seed))
      }
      expect(worst, `removing ${dropped} must be visible`).toBeLessThan(0.99)
    }
  })

  it('writes three classical bits, and reads the message into the third', () => {
    // The reader's whole view of this preset is the register tally, so this is
    // the assertion about what is actually on screen: Alice's two bits carry
    // nothing about the message, and c2 carries its 75/25 split.
    const circuit = circuitOf('teleportation')
    let ones = 0
    const shots = 800
    for (let seed = 1; seed <= shots; seed += 1) {
      const { register } = runTrajectory(circuit, createRng(seed))
      expect(register).toHaveLength(3)
      for (const bit of register) expect([0, 1]).toContain(bit)
      ones += register[2]!
    }
    /*
     * A sampled frequency, so the bound is a sampling bound and is stated
     * rather than guessed at: √(p(1−p)/n) is 1,53 % at p = ¼ over 800 shots,
     * and 5 % is a shade over three of those. Loose enough never to flake, and
     * nowhere near loose enough to pass on a teleporter that lost the message
     * — that one reads a half, five bounds away.
     */
    expect(Math.abs(ones / shots - expectedOne)).toBeLessThan(0.05)
  })

  it('collapses the two sending qubits, as a Bell measurement must', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { state, register } = runTrajectory(protocol(), createRng(seed))
      // q0 and q1 have been measured, so each is certainly 0 or certainly 1 —
      // and certainly whatever its classical bit recorded.
      expect(marginalProbability(state, 0)).toBeCloseTo(register[0]!, 10)
      expect(marginalProbability(state, 1)).toBeCloseTo(register[1]!, 10)
    }
  })

  it('exercises all four correction branches across seeds', () => {
    // The corrections are the part of the protocol a broken circuit would get
    // wrong in only one of four cases, so a test that never saw all four could
    // pass on three quarters of a working teleporter.
    const seen = new Set<string>()
    for (let seed = 1; seed <= 200; seed += 1) {
      const { register } = runTrajectory(
        circuitOf('teleportation'),
        createRng(seed)
      )
      seen.add(`${register[0]}${register[1]}`)
    }
    expect([...seen].sort()).toEqual(['00', '01', '10', '11'])
  })
})

describe('modes', () => {
  it('runs every preset but teleportation analytically', () => {
    for (const preset of PRESETS) {
      expect(needsTrajectories(preset.circuit)).toBe(
        preset.id === 'teleportation'
      )
    }
  })
})
