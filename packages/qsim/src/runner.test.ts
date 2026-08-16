/**
 * The runner is where a circuit stops being JSON and starts being physics, so
 * these tests come in two halves.
 *
 * The first half pins the translation itself: column order, the gates that are
 * stored as "one-qubit gate plus controls", symbolic parameters, the
 * structural operations, and the shapes that must be refused rather than
 * quietly mis-simulated.
 *
 * The second half runs three protocols end to end. They are worth far more
 * than the sum of the unit tests: teleportation is the only test that exercises
 * mid-circuit measurement, the classical register and conditioned gates at
 * once, superdense coding checks that all four classical messages survive the
 * round trip, and Grover is a number that a single wrong sign anywhere in the
 * chain would move.
 */

import { describe, expect, it } from 'vitest'

import { apply1q, applyControlled, applyISwap, applySwap } from './apply.js'
import { GATE_MATRICES, rzMatrix } from './gates.js'
import {
  MidCircuitMeasurementError,
  marginalProbability,
  orderedCounts,
  probabilities,
  trajectoriesMode,
  type ShotCounts,
} from './measure.js'
import { NOISE_PROFILES, NoiseProfileError } from './noise.js'
import { createRng, type Rng } from './rng.js'
import {
  CircuitRunError,
  formatRegister,
  run,
  runNoisy,
  runNoisyDensity,
  runTrajectory,
  type CircuitLike,
  type OperationLike,
} from './runner.js'
import { alloc, amplitude, norm, type Statevector } from './statevector.js'

/** Decision D6: tolerance 1e-10, expressed as digits for `toBeCloseTo`. */
const DIGITS = 10
const SQRT1_2 = Math.SQRT1_2

const { h, s, t, x, z } = GATE_MATRICES

type OperationExtras = Pick<
  OperationLike,
  'controls' | 'params' | 'clbitTargets' | 'condition'
>

let nextId = 0

/** An operation with a unique id, since ids only matter for error messages. */
function op(
  gate: string,
  targets: number[],
  column: number,
  extras: Partial<OperationExtras> = {}
): OperationLike {
  nextId++
  return { id: `op${nextId}`, gate, targets, column, ...extras }
}

/** The final state of an analytic run — the common case in this file. */
function finalState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') expect.unreachable('expected analytic mode')
  return result.state
}

function counts(circuit: CircuitLike, shots: number, seed: number): ShotCounts {
  const result = run(circuit, trajectoriesMode(shots, createRng(seed)))
  if (result.mode !== 'trajectories') {
    expect.unreachable('expected trajectories mode')
  }
  return result.counts
}

function expectSameState(actual: Statevector, expected: Statevector): void {
  expect(actual.size).toBe(expected.size)
  for (let i = 0; i < expected.size; i++) {
    expect(actual.re[i], `re[${i}]`).toBeCloseTo(expected.re[i], DIGITS)
    expect(actual.im[i], `im[${i}]`).toBeCloseTo(expected.im[i], DIGITS)
  }
}

/** H on q0 then CNOT q0→q1, written in the circuit contract. */
const BELL: CircuitLike = {
  qubits: 2,
  operations: [op('h', [0], 0), op('cx', [1], 1, { controls: [0] })],
}

describe('walking a circuit', () => {
  it('builds the Bell pair from circuit JSON', () => {
    const state = finalState(BELL)
    expect(state.re[0]).toBeCloseTo(SQRT1_2, DIGITS)
    expect(state.re[3]).toBeCloseTo(SQRT1_2, DIGITS)
    expect(state.re[1]).toBeCloseTo(0, DIGITS)
    expect(state.re[2]).toBeCloseTo(0, DIGITS)
    expect(norm(state)).toBeCloseTo(1, DIGITS)
  })

  it('runs columns in order, whatever order the operations are listed in', () => {
    // The editor appends operations as they are drawn, not in time order, so
    // this is the property that keeps a circuit meaning one thing.
    const forwards: CircuitLike = {
      qubits: 3,
      operations: [
        op('h', [0], 0),
        op('cx', [1], 1, { controls: [0] }),
        op('t', [1], 2),
        op('cx', [2], 3, { controls: [1] }),
      ],
    }
    const shuffled: CircuitLike = {
      qubits: 3,
      operations: [...forwards.operations].reverse(),
    }
    expectSameState(finalState(shuffled), finalState(forwards))
  })

  it('treats empty columns as the no-ops they are', () => {
    const dense: CircuitLike = {
      qubits: 2,
      operations: [op('h', [0], 0), op('cx', [1], 1, { controls: [0] })],
    }
    const sparse: CircuitLike = {
      qubits: 2,
      operations: [op('h', [0], 3), op('cx', [1], 40, { controls: [0] })],
    }
    expectSameState(finalState(sparse), finalState(dense))
  })

  it('lets a barrier hold a column without touching the state', () => {
    const withBarrier: CircuitLike = {
      qubits: 2,
      operations: [
        op('h', [0], 0),
        op('barrier', [0, 1], 1),
        op('cx', [1], 2, { controls: [0] }),
      ],
    }
    expectSameState(finalState(withBarrier), finalState(BELL))
  })

  it('skips the identity instead of running it', () => {
    const withIdentity: CircuitLike = {
      qubits: 2,
      operations: [
        op('h', [0], 0),
        op('i', [1], 0),
        op('cx', [1], 1, { controls: [0] }),
        op('i', [0], 2, { controls: [1] }),
      ],
    }
    expectSameState(finalState(withIdentity), finalState(BELL))
  })

  it('dispatches the multi-qubit gates exactly as the kernel does', () => {
    const circuit: CircuitLike = {
      qubits: 4,
      operations: [
        op('h', [0], 0),
        op('t', [1], 0),
        op('s', [2], 0),
        op('h', [3], 0),
        op('swap', [0, 2], 1),
        op('iswap', [1, 3], 2),
        op('ccx', [3], 3, { controls: [0, 1] }),
        op('cswap', [0, 1], 4, { controls: [2] }),
        op('cz', [1], 5, { controls: [3] }),
        op('crz', [2], 6, { controls: [0], params: [0.9] }),
      ],
    }

    const expected = alloc(4)
    apply1q(expected, h, 0)
    apply1q(expected, t, 1)
    apply1q(expected, s, 2)
    apply1q(expected, h, 3)
    applySwap(expected, 0, 2)
    applyISwap(expected, 1, 3)
    applyControlled(expected, x, 3, [
      { qubit: 0, state: 1 },
      { qubit: 1, state: 1 },
    ])
    applySwap(expected, 0, 1, [{ qubit: 2, state: 1 }])
    applyControlled(expected, z, 1, [{ qubit: 3, state: 1 }])
    applyControlled(expected, rzMatrix(0.9), 2, [{ qubit: 0, state: 1 }])

    expectSameState(finalState(circuit), expected)
  })

  it('honours a negative control', () => {
    // q0 stays |0⟩, so the gate conditioned on it reading |0⟩ must fire.
    const circuit: CircuitLike = {
      qubits: 2,
      operations: [op('x', [1], 0, { controls: [{ qubit: 0, state: 0 }] })],
    }
    const state = finalState(circuit)
    expect(state.re[2]).toBeCloseTo(1, DIGITS)
  })

  it('resolves symbolic parameters against the circuit', () => {
    const symbolic: CircuitLike = {
      qubits: 1,
      parameters: [{ name: 'theta', value: 0.73 }],
      operations: [op('h', [0], 0), op('rz', [0], 1, { params: ['theta'] })],
    }
    const literal: CircuitLike = {
      qubits: 1,
      operations: [op('h', [0], 0), op('rz', [0], 1, { params: [0.73] })],
    }
    expectSameState(finalState(symbolic), finalState(literal))
  })

  it('keeps the norm across hundreds of gates (D6)', () => {
    const operations: OperationLike[] = []
    for (let column = 0; column < 200; column++) {
      operations.push(
        op('u', [column % 5], column, { params: [0.31 * column, 0.11, -0.07] })
      )
    }
    expect(norm(finalState({ qubits: 5, operations }))).toBeCloseTo(1, DIGITS)
  })
})

describe('circuits the engine refuses', () => {
  it('names the operation that uses an unknown gate', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [{ id: 'op_bad', gate: 'bellPair', targets: [0], column: 0 }],
    }
    try {
      run(circuit)
      expect.unreachable('an unknown gate must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitRunError)
      expect((error as CircuitRunError).operationId).toBe('op_bad')
      expect((error as CircuitRunError).message).toContain('bellPair')
    }
  })

  it('refuses a controlled gate that arrives without its control', () => {
    // The dangerous one: the kernel would apply a bare X to every index and
    // return a perfectly normalised state that is not the circuit.
    const circuit: CircuitLike = {
      qubits: 2,
      operations: [op('cx', [1], 0)],
    }
    expect(() => run(circuit)).toThrow(CircuitRunError)
  })

  it('refuses a gate applied to the wrong number of qubits', () => {
    const circuit: CircuitLike = {
      qubits: 2,
      operations: [op('swap', [0], 0)],
    }
    expect(() => run(circuit)).toThrow(CircuitRunError)
  })

  it('refuses a parameter the circuit never declared', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [op('rz', [0], 0, { params: ['theta'] })],
    }
    expect(() => run(circuit)).toThrow(/theta/)
  })

  it('refuses a measurement writing outside the classical register', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      clbits: 1,
      operations: [op('measure', [0], 0, { clbitTargets: [3] })],
    }
    expect(() => run(circuit, trajectoriesMode(1, createRng(1)))).toThrow(
      CircuitRunError
    )
  })
})

describe('execution modes', () => {
  it('rejects a measurement in analytic mode, before doing any work', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      clbits: 1,
      operations: [
        op('h', [0], 0),
        op('measure', [0], 1, { clbitTargets: [0] }),
      ],
    }
    expect(() => run(circuit)).toThrow(MidCircuitMeasurementError)
    expect(() => run(circuit)).toThrow(/trajectories/)
  })

  it('rejects a conditioned operation in analytic mode', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      clbits: 1,
      operations: [op('x', [0], 0, { condition: { clbit: 0, equals: 1 } })],
    }
    expect(() => run(circuit)).toThrow(MidCircuitMeasurementError)
  })

  it('refuses a trajectories run with nowhere to write the counts', () => {
    expect(() => run(BELL, trajectoriesMode(8, createRng(1)))).toThrow(
      CircuitRunError
    )
  })

  it('tallies the classical register over shots', () => {
    const circuit: CircuitLike = {
      qubits: 2,
      clbits: 2,
      operations: [
        op('h', [0], 0),
        op('cx', [1], 1, { controls: [0] }),
        op('measure', [0], 2, { clbitTargets: [0] }),
        op('measure', [1], 2, { clbitTargets: [1] }),
      ],
    }
    const tally = counts(circuit, 400, 20250814)
    // A Bell pair is perfectly correlated: '01' and '10' are impossible, and
    // the two survivors split evenly. The split itself is pinned by the χ²
    // test in measure.test.ts; here the point is that nothing else appears.
    expect(Object.keys(tally).sort()).toEqual(['00', '11'])
    expect(tally['00'] + tally['11']).toBe(400)
    expect(tally['00']).toBeGreaterThan(150)
  })

  it('offers the register counts in ascending order, unsorted by the caller', () => {
    // The histogram of M0.7 reads `orderedCounts` and never `Object.keys`: a
    // plain object hoists its array-index keys, so "10" enumerates ahead of
    // "00" whatever order the runner inserted them in. Asserted without a
    // `.sort()` on purpose — sorting first is what hid this for both count
    // paths.
    const circuit: CircuitLike = {
      qubits: 2,
      clbits: 2,
      operations: [
        op('h', [0], 0),
        op('h', [1], 0),
        op('measure', [0], 1, { clbitTargets: [0] }),
        op('measure', [1], 1, { clbitTargets: [1] }),
      ],
    }
    const tally = counts(circuit, 400, 17)
    expect(orderedCounts(tally).map(([label]) => label)).toEqual([
      '00',
      '01',
      '10',
      '11',
    ])
    expect(orderedCounts(tally).reduce((sum, [, n]) => sum + n, 0)).toBe(400)
  })

  it('reproduces its counts for the same seed', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      clbits: 1,
      operations: [
        op('h', [0], 0),
        op('measure', [0], 1, { clbitTargets: [0] }),
      ],
    }
    expect(counts(circuit, 200, 7)).toEqual(counts(circuit, 200, 7))
    expect(counts(circuit, 200, 7)).not.toEqual(counts(circuit, 200, 8))
  })
})

describe('reset', () => {
  it('returns a certain |1⟩ to |0⟩ without needing a trajectory', () => {
    const circuit: CircuitLike = {
      qubits: 2,
      operations: [op('x', [0], 0), op('reset', [0], 1), op('h', [1], 2)],
    }
    const state = finalState(circuit)
    expect(marginalProbability(state, 0)).toBeCloseTo(0, DIGITS)
    expect(marginalProbability(state, 1)).toBeCloseTo(0.5, DIGITS)
  })

  it('needs trajectories mode when the qubit is in superposition', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [op('h', [0], 0), op('reset', [0], 1)],
    }
    expect(() => run(circuit)).toThrow(MidCircuitMeasurementError)
  })

  it('collapses a superposition to |0⟩ in a trajectory', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [op('h', [0], 0), op('reset', [0], 1)],
    }
    for (let seed = 0; seed < 8; seed++) {
      const { state } = runTrajectory(circuit, createRng(seed))
      expect(marginalProbability(state, 0), `seed ${seed}`).toBeCloseTo(
        0,
        DIGITS
      )
      expect(norm(state)).toBeCloseTo(1, DIGITS)
    }
  })
})

describe('the classical register', () => {
  it('is read as it entered the column, not mid-column', () => {
    // c0 is written in column 1 and read in columns 1 and 2. Operations in one
    // column are simultaneous, so only the column 2 read sees the write —
    // otherwise the answer would depend on the order the editor happened to
    // append the two operations.
    const build = (reversed: boolean): CircuitLike => {
      const sameColumn = [
        op('measure', [0], 1, { clbitTargets: [0] }),
        op('x', [1], 1, { condition: { clbit: 0, equals: 1 } }),
      ]
      return {
        qubits: 3,
        clbits: 1,
        operations: [
          op('x', [0], 0),
          ...(reversed ? [...sameColumn].reverse() : sameColumn),
          op('x', [2], 2, { condition: { clbit: 0, equals: 1 } }),
        ],
      }
    }

    for (const reversed of [false, true]) {
      const { state, register } = runTrajectory(build(reversed), createRng(5))
      expect(register[0]).toBe(1)
      // q0 = 1 (measured), q1 = 0 (the same-column condition did not fire),
      // q2 = 1 (the next-column condition did): index 1 + 4.
      expect(amplitude(state, 5).re, `reversed=${reversed}`).toBeCloseTo(
        1,
        DIGITS
      )
    }
  })

  it('prints highest clbit first, the way formatKet prints qubits', () => {
    const register = new Uint8Array([1, 0, 1])
    expect(formatRegister(register)).toBe('101')
    expect(formatRegister(new Uint8Array([1, 0, 0]))).toBe('001')
  })
})

describe('teleportation (specification §13)', () => {
  /**
   * Alice's message on q0, her half of the pair on q1, Bob's half on q2. The
   * two corrections are ordinary gates carrying a `condition`, which is the
   * whole point: this is the protocol as the editor would draw it, not as a
   * sequence of kernel calls.
   */
  function teleportCircuit(
    theta: number,
    phi: number,
    correct = true
  ): CircuitLike {
    const corrections = correct
      ? [
          op('x', [2], 6, { condition: { clbit: 1, equals: 1 } }),
          op('z', [2], 7, { condition: { clbit: 0, equals: 1 } }),
        ]
      : []
    return {
      qubits: 3,
      clbits: 2,
      operations: [
        op('u', [0], 0, { params: [theta, phi, 0] }),
        op('h', [1], 0),
        op('cx', [2], 1, { controls: [1] }),
        op('cx', [1], 2, { controls: [0] }),
        op('h', [0], 3),
        op('barrier', [0, 1, 2], 4),
        op('measure', [0], 5, { clbitTargets: [0] }),
        op('measure', [1], 5, { clbitTargets: [1] }),
        ...corrections,
      ],
    }
  }

  interface Teleported {
    /** `|⟨ψ|bob⟩|²` — 1 when Bob holds exactly what Alice sent. */
    readonly fidelity: number
    /** The two classical bits, as `messageBit`/`pairBit`. */
    readonly branch: string
  }

  function teleport(
    theta: number,
    phi: number,
    rng: Rng,
    correct = true
  ): Teleported {
    const { state, register } = runTrajectory(
      teleportCircuit(theta, phi, correct),
      rng
    )
    const messageBit = register[0]
    const pairBit = register[1]

    // Only the measured branch survives, so Bob's amplitudes sit at the two
    // indices with q0 = messageBit and q1 = pairBit.
    const base = messageBit + 2 * pairBit
    const bob0 = amplitude(state, base)
    const bob1 = amplitude(state, base + 4)

    const inputRe = [Math.cos(theta / 2), Math.cos(phi) * Math.sin(theta / 2)]
    const inputIm = [0, Math.sin(phi) * Math.sin(theta / 2)]
    const overlapRe =
      inputRe[0] * bob0.re +
      inputIm[0] * bob0.im +
      (inputRe[1] * bob1.re + inputIm[1] * bob1.im)
    const overlapIm =
      inputRe[0] * bob0.im -
      inputIm[0] * bob0.re +
      (inputRe[1] * bob1.im - inputIm[1] * bob1.re)
    return {
      fidelity: overlapRe * overlapRe + overlapIm * overlapIm,
      branch: `${messageBit}${pairBit}`,
    }
  }

  it('delivers 20 random input states with fidelity 1', () => {
    const rng = createRng(20250814)
    const branches = new Set<string>()
    for (let trial = 0; trial < 20; trial++) {
      const theta = rng.next() * Math.PI
      const phi = rng.next() * 2 * Math.PI
      const { fidelity, branch } = teleport(theta, phi, rng)
      expect(fidelity, `θ=${theta} φ=${phi}`).toBeCloseTo(1, DIGITS)
      branches.add(branch)
    }
    // All four branches occur, so the conditioned corrections are doing work
    // rather than being trivially skipped on every run.
    expect(branches).toEqual(new Set(['00', '01', '10', '11']))
  })

  it('fails on three branches out of four without the corrections', () => {
    // Without this, the test above could pass for the wrong reason: if the
    // measurement happened to leave Bob correct, nothing would be proved about
    // conditioned gates.
    const broken = new Map<string, number>()
    for (let seed = 0; seed < 40; seed++) {
      const { fidelity, branch } = teleport(1.1, 0.7, createRng(seed), false)
      broken.set(branch, fidelity)
    }
    expect(broken.get('00')).toBeCloseTo(1, DIGITS)
    for (const branch of ['01', '10', '11']) {
      expect(broken.get(branch), branch).toBeLessThan(0.99)
    }
  })
})

describe('superdense coding', () => {
  /**
   * Two classical bits carried by one qubit. Alice acts on q0 only: `Z^a X^b`
   * turns the shared pair into one of the four Bell states, and Bob's CNOT and
   * H turn those back into the four computational basis states.
   */
  function superdenseCircuit(a: 0 | 1, b: 0 | 1): CircuitLike {
    return {
      qubits: 2,
      clbits: 2,
      operations: [
        op('h', [0], 0),
        op('cx', [1], 1, { controls: [0] }),
        ...(b === 1 ? [op('x', [0], 2)] : []),
        ...(a === 1 ? [op('z', [0], 3)] : []),
        op('cx', [1], 4, { controls: [0] }),
        op('h', [0], 5),
        op('measure', [0], 6, { clbitTargets: [0] }),
        op('measure', [1], 6, { clbitTargets: [1] }),
      ],
    }
  }

  it('decodes all four two-bit messages', () => {
    const messages: readonly (readonly [0 | 1, 0 | 1])[] = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]
    for (const [a, b] of messages) {
      const tally = counts(superdenseCircuit(a, b), 64, 4242)
      // c0 carries the Z bit and c1 the X bit; labels print c1 first.
      const expected = `${b}${a}`
      expect(tally, `message ${a}${b}`).toEqual({ [expected]: 64 })
    }
  })
})

describe('Grover on 3 qubits (specification §13)', () => {
  /**
   * The marked element is |101⟩ — q0 = 1, q1 = 0, q2 = 1, index 5.
   *
   * The oracle is a single CCZ with a negative control on q1, which is the
   * whole X-sandwich the textbook draws collapsed into the control states the
   * contract already supports. The diffuser keeps its sandwich because the
   * reflection is about |000⟩ and the phase a Z applies lives on |1⟩.
   */
  function groverCircuit(iterations: number): CircuitLike {
    const operations: OperationLike[] = []
    let column = 0
    const wall = (gate: string): void => {
      for (const qubit of [0, 1, 2]) operations.push(op(gate, [qubit], column))
      column++
    }

    wall('h')
    for (let round = 0; round < iterations; round++) {
      operations.push(
        op('z', [2], column++, {
          controls: [
            { qubit: 0, state: 1 },
            { qubit: 1, state: 0 },
          ],
        })
      )
      wall('h')
      wall('x')
      operations.push(op('z', [2], column++, { controls: [0, 1] }))
      wall('x')
      wall('h')
    }
    return { qubits: 3, operations }
  }

  it('drives the marked element above 0.94 in two iterations', () => {
    const distribution = probabilities(finalState(groverCircuit(2)))
    expect(distribution[5]).toBeGreaterThan(0.94)
    // sin(5·asin(1/√8))² — the closed form, which a wrong number of
    // reflections or a misplaced phase would miss by a wide margin.
    expect(distribution[5]).toBeCloseTo(
      Math.sin(5 * Math.asin(SQRT1_2 / 2)) ** 2,
      DIGITS
    )
  })

  it('starts flat and gets there by amplifying, not by construction', () => {
    const flat = probabilities(finalState(groverCircuit(0)))
    for (let i = 0; i < flat.length; i++) {
      expect(flat[i], `|${i}⟩`).toBeCloseTo(0.125, DIGITS)
    }
    const once = probabilities(finalState(groverCircuit(1)))
    expect(once[5]).toBeGreaterThan(0.75)
    expect(once[5]).toBeLessThan(0.79)
  })
})

describe('a circuit that uses every kind of operation at once', () => {
  it('runs U, controls, swaps, a barrier, a reset and a measurement', () => {
    const circuit: CircuitLike = {
      qubits: 3,
      clbits: 2,
      parameters: [{ name: 'theta', value: Math.PI / 3 }],
      operations: [
        op('u', [0], 0, { params: ['theta', 0, 0] }),
        op('h', [1], 0),
        op('cx', [2], 1, { controls: [1] }),
        op('swap', [0, 1], 2),
        op('barrier', [0, 1, 2], 3),
        op('measure', [1], 4, { clbitTargets: [0] }),
        op('x', [0], 5, { condition: { clbit: 0, equals: 1 } }),
        op('reset', [2], 6),
        op('measure', [2], 7, { clbitTargets: [1] }),
      ],
    }

    for (let seed = 0; seed < 5; seed++) {
      const { state, register } = runTrajectory(circuit, createRng(seed))
      expect(norm(state), `seed ${seed}`).toBeCloseTo(1, DIGITS)
      // The reset happens after the last gate on q2, so its measurement can
      // only ever read 0.
      expect(register[1]).toBe(0)
    }

    // Only c0 varies: c1 is the reset qubit, which cannot read 1.
    const tally = counts(circuit, 200, 99)
    expect(Object.keys(tally).sort()).toEqual(['00', '01'])
  })
})

describe('the noise mode (specification §3.3)', () => {
  const teaching = { profile: NOISE_PROFILES.teaching }
  const ideal = { profile: NOISE_PROFILES.ideal }

  it('tallies the whole quantum register, with or without clbits', () => {
    // Unlike `run(…, trajectoriesMode(…))`, which reports what the circuit's
    // own measurements wrote and refuses a circuit with no clbits, a noisy run
    // reads every qubit at the end of every shot: §3.3's deliverable is the
    // noisy distribution over basis states beside the ideal one.
    const result = runNoisy(BELL, {
      ...teaching,
      shots: 500,
      rng: createRng(1),
    })
    expect(result.mode).toBe('noisyTrajectories')
    expect(result.shots).toBe(500)
    let total = 0
    for (const [label, count] of Object.entries(result.counts)) {
      expect(label).toHaveLength(2)
      total += count
    }
    expect(total).toBe(500)
    // A noisy Bell pair still lands mostly on the two correlated outcomes.
    expect(
      (result.counts['00'] ?? 0) + (result.counts['11'] ?? 0)
    ).toBeGreaterThan(400)
  })

  it('refuses a shot count that is not one', () => {
    for (const shots of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        runNoisy(BELL, { ...teaching, shots, rng: createRng(1) })
      ).toThrow(RangeError)
    }
  })

  it('refuses a profile that is not physical, before running anything', () => {
    const impossible = { ...NOISE_PROFILES.teaching, t2Ns: 1e9 }
    expect(() =>
      runNoisy(BELL, { profile: impossible, shots: 1, rng: createRng(1) })
    ).toThrow(NoiseProfileError)
    expect(() => runNoisyDensity(BELL, { profile: impossible })).toThrow(
      NoiseProfileError
    )
  })

  it('measures mid-circuit and applies noise in the same trajectory', () => {
    // The two kinds of randomness share a run and a generator. With no noise
    // the correlation this circuit builds is exact: q1 is flipped exactly when
    // the measurement of q0 read 1, so the register can only be 00 or 11.
    const circuit: CircuitLike = {
      qubits: 2,
      clbits: 1,
      operations: [
        op('h', [0], 0),
        op('measure', [0], 1, { clbitTargets: [0] }),
        op('x', [1], 2, { condition: { clbit: 0, equals: 1 } }),
      ],
    }
    const clean = runNoisy(circuit, { ...ideal, shots: 400, rng: createRng(7) })
    expect(Object.keys(clean.counts).sort()).toEqual(['00', '11'])
    expect(clean.counts['00']).toBeGreaterThan(150)
    expect(clean.counts['11']).toBeGreaterThan(150)

    // Under noise the same circuit still runs, and the correlation degrades
    // rather than disappearing — which is the whole point of the mode.
    const noisy = runNoisy(circuit, {
      ...teaching,
      shots: 400,
      rng: createRng(7),
    })
    const correlated = (noisy.counts['00'] ?? 0) + (noisy.counts['11'] ?? 0)
    expect(correlated).toBeGreaterThan(280)
    expect(correlated).toBeLessThan(400)
  })

  it('refuses a mid-circuit measurement on a density matrix', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      clbits: 1,
      operations: [
        op('h', [0], 0),
        op('measure', [0], 1, { clbitTargets: [0] }),
      ],
    }
    expect(() => runNoisyDensity(circuit, teaching)).toThrow(
      MidCircuitMeasurementError
    )
  })

  it('resets a qubit the same way in both representations', () => {
    // ρ takes the reset as amplitude damping at γ = 1; a trajectory takes it as
    // a measurement and a conditional flip. Both must end in |0⟩ with
    // certainty, and at the ideal profile they must do it exactly.
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [op('h', [0], 0), op('reset', [0], 1)],
    }
    const exact = runNoisyDensity(circuit, ideal)
    expect(exact.distribution[0]).toBeCloseTo(1, DIGITS)
    expect(exact.distribution[1]).toBeCloseTo(0, DIGITS)

    const sampled = runNoisy(circuit, {
      ...ideal,
      shots: 200,
      rng: createRng(3),
    })
    expect(sampled.counts).toEqual({ '0': 200 })
  })

  it('charges no noise to the identity placeholder', () => {
    // `i` is a hole in the circuit the editor draws a box around, not a
    // scheduled delay: a register of identities under the worst profile must
    // come back in exactly |000⟩, not slightly excited.
    const circuit: CircuitLike = {
      qubits: 3,
      operations: [op('i', [0], 0), op('i', [1], 0), op('i', [2], 1)],
    }
    const exact = runNoisyDensity(circuit, { ...teaching, readout: false })
    expect(exact.distribution[0]).toBe(1)
    const sampled = runNoisy(circuit, {
      ...teaching,
      readout: false,
      shots: 50,
      rng: createRng(2),
    })
    expect(sampled.counts).toEqual({ '000': 50 })

    // The reading is still not certain, and that is not a contradiction: the
    // state is exactly |000⟩ and the amplifier misreads each wire with
    // probability p0to1 = 0.03, so the register comes back clean 0.97³ of the
    // time. Readout error is the one term that is not decoherence.
    const read = runNoisyDensity(circuit, teaching)
    expect(read.distribution[0]).toBeCloseTo(0.97 ** 3, DIGITS)
  })

  it('applies readout error to the outcome and not to the state', () => {
    // The profile misreads a 1 as a 0 more often than the reverse (relaxation
    // during integration), so reading a certain |1⟩ has to be biased towards 0
    // — and the bias must be exactly p1to0, since the state itself is
    // untouched by the misreading.
    const circuit: CircuitLike = { qubits: 1, operations: [op('x', [0], 0)] }
    const profile = {
      ...NOISE_PROFILES.ideal,
      readoutP0to1: 0.01,
      readoutP1to0: 0.2,
    }
    const exact = runNoisyDensity(circuit, { profile })
    expect(exact.distribution[0]).toBeCloseTo(0.2, DIGITS)
    // ρ itself is |1⟩⟨1|: the misread happened after the state was gone.
    expect(exact.rho.re[3]).toBeCloseTo(1, DIGITS)

    const shots = 20_000
    const sampled = runNoisy(circuit, { profile, shots, rng: createRng(11) })
    const misread = (sampled.counts['0'] ?? 0) / shots
    expect(Math.abs(misread - 0.2)).toBeLessThan(0.01)

    // …and switching it off leaves the answer certain again.
    const clean = runNoisy(circuit, {
      profile,
      readout: false,
      shots: 100,
      rng: createRng(11),
    })
    expect(clean.counts).toEqual({ '1': 100 })
  })

  it('runs one noisy trajectory at a time, state and register both', () => {
    const { state, register } = runTrajectory(BELL, createRng(5), teaching)
    expect(norm(state)).toBeCloseTo(1, DIGITS)
    expect(register).toHaveLength(0)
  })
})
