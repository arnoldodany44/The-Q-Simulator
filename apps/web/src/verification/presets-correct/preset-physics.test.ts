/**
 * Independent verification of the six presets (M0.9) — lens `presets-correct`.
 *
 * The claim under test is the one `presets.ts` makes in its own header: each
 * example really produces the state its name says. That claim is checked here
 * three ways, none of which is the engine checking itself:
 *
 *  1. against a from-scratch dense simulator (`reference.ts`), which shares no
 *     code with `@qsim/core`;
 *  2. against the closed-form state written out from the mathematics — the
 *     literal amplitudes a reader would derive with a pencil;
 *  3. for the algorithms, against the property that gives them their name:
 *     Deutsch–Jozsa is swept over *every* constant and every balanced oracle on
 *     two bits, and teleportation is checked for fidelity 1 against random
 *     input states rather than for the one lopsided angle it ships with.
 *
 * WHY THE FIDELITY CHECK IS NOT A MARGINAL CHECK. `presets.test.ts` asserts
 * `marginalProbability(state, 2)` after teleportation, and that quantity is
 * blind to the sign of the |1⟩ amplitude: with the message prepared by an
 * `ry`, |ψ⟩ is real, and dropping Bob's Z correction produces cos|0⟩ − sin|1⟩,
 * whose marginal is `sin²(θ/2)` — identical. A test that can pass on a
 * teleporter missing a quarter of its corrections is not a test of
 * teleportation. Fidelity ⟨ψ|ρ|ψ⟩ is, and `it('has teeth')` below proves it by
 * breaking the circuit deliberately and watching the assertion fail.
 */

import {
  amplitude,
  createRng,
  probabilities,
  run,
  runTrajectory,
  type Statevector,
} from '@qsim/core'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  PRESETS,
  TELEPORTATION_MESSAGE_ANGLE,
  findPreset,
  type PresetId,
} from '../../features/circuit-editor/presets'
import {
  ONE,
  ZERO,
  absSquared,
  add,
  conj,
  cx,
  mul,
  orderedOperations,
  project,
  referenceRun,
  type Cx,
} from './reference'

/** D6's tolerance. Everything here is exact physics up to Float64 drift. */
const TOLERANCE = 1e-10
const ROOT_HALF = Math.SQRT1_2

function circuitOf(id: PresetId): Circuit {
  const preset = findPreset(id)
  if (preset === undefined) throw new Error(`no preset named ${id}`)
  return preset.circuit
}

/** The engine's answer, as plain complex numbers. */
function engineRun(circuit: Circuit): Cx[] {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return readState(result.state)
}

function readState(state: Statevector): Cx[] {
  const out: Cx[] = []
  for (let index = 0; index < state.size; index++) {
    const value = amplitude(state, index)
    out.push(cx(value.re, value.im))
  }
  return out
}

function expectSameVector(
  actual: readonly Cx[],
  expected: readonly Cx[]
): void {
  expect(actual).toHaveLength(expected.length)
  for (let index = 0; index < expected.length; index++) {
    const a = actual[index]!
    const b = expected[index]!
    expect(
      Math.hypot(a.re - b.re, a.im - b.im),
      `amplitude ${index}: got ${a.re}${a.im < 0 ? '' : '+'}${a.im}i, ` +
        `expected ${b.re}${b.im < 0 ? '' : '+'}${b.im}i`
    ).toBeLessThan(TOLERANCE)
  }
}

/* ───────────────────── 1. engine against the reference ──────────────────── */

const UNITARY_PRESETS = PRESETS.filter(
  (preset) => preset.id !== 'teleportation'
)

describe('the engine and an independent dense simulator agree', () => {
  it.each(UNITARY_PRESETS)('on preset $id', (preset) => {
    expectSameVector(engineRun(preset.circuit), referenceRun(preset.circuit))
  })
})

/* ─────────────────── 2. against the closed-form states ──────────────────── */

/**
 * The state each name promises, written out by hand from the mathematics and
 * D1's index = q₀ + 2·q₁ + 4·q₂.
 */
const CLOSED_FORM: Readonly<Record<string, readonly Cx[]>> = {
  // H⊗H|00⟩: every basis state at amplitude ½.
  superposition: [cx(0.5), cx(0.5), cx(0.5), cx(0.5)],
  // (|00⟩ + |11⟩)/√2.
  bell: [cx(ROOT_HALF), ZERO, ZERO, cx(ROOT_HALF)],
  // (|000⟩ + |111⟩)/√2.
  ghz: [cx(ROOT_HALF), ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, cx(ROOT_HALF)],
  // H·P(π)·H|0⟩ = Z in the X basis = |1⟩ exactly.
  interference: [ZERO, ONE],
  // |11⟩ on the input register ⊗ |−⟩ on the ancilla: index 3 and index 7.
  deutschJozsa: [
    ZERO,
    ZERO,
    ZERO,
    cx(ROOT_HALF),
    ZERO,
    ZERO,
    ZERO,
    cx(-ROOT_HALF),
  ],
}

describe('every unitary preset is the state its name claims', () => {
  it.each(UNITARY_PRESETS)('$id, from the engine', (preset) => {
    expectSameVector(engineRun(preset.circuit), CLOSED_FORM[preset.id]!)
  })

  it.each(UNITARY_PRESETS)('$id, from the reference simulator', (preset) => {
    expectSameVector(referenceRun(preset.circuit), CLOSED_FORM[preset.id]!)
  })
})

describe('Bell is entanglement and superposition is not', () => {
  it('draws four bars for superposition and two for Bell', () => {
    // The pair §2 hangs the landing page on: same register, same marginals,
    // different joint distribution. If these two ever stopped differing this
    // way, the page would be teaching nothing.
    const flat = probabilities(stateOf('superposition'))
    const bell = probabilities(stateOf('bell'))
    expect([...flat].filter((p) => p > 1e-12)).toHaveLength(4)
    expect([...bell].filter((p) => p > 1e-12)).toHaveLength(2)
    for (const qubit of [0, 1]) {
      expect(marginal(flat, qubit)).toBeCloseTo(0.5, 10)
      expect(marginal(bell, qubit)).toBeCloseTo(0.5, 10)
    }
    // Correlation: in Bell the two bits always agree, in superposition they
    // agree exactly half the time.
    expect(bell[0]! + bell[3]!).toBeCloseTo(1, 10)
    expect(flat[0]! + flat[3]!).toBeCloseTo(0.5, 10)
  })

  it('gives GHZ the same shape on three wires, and on n wires', () => {
    // The name is a family, not one circuit: the claim is that the chained
    // CNOTs produce the n-qubit GHZ state, so the same construction is checked
    // at 2, 3, 4 and 5 wires against the closed form.
    for (const qubits of [2, 3, 4, 5]) {
      const vector = referenceRun(chainedGhz(qubits))
      const size = 1 << qubits
      for (let index = 0; index < size; index++) {
        const expected = index === 0 || index === size - 1 ? ROOT_HALF : 0
        expect(Math.abs(vector[index]!.re - expected)).toBeLessThan(TOLERANCE)
        expect(Math.abs(vector[index]!.im)).toBeLessThan(TOLERANCE)
      }
    }
    // And the shipped preset is exactly the three-wire member of that family.
    expectSameVector(
      referenceRun(circuitOf('ghz')),
      referenceRun(chainedGhz(3))
    )
  })
})

function stateOf(id: PresetId): Statevector {
  const result = run(circuitOf(id))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function marginal(joint: Float64Array, qubit: number): number {
  let sum = 0
  for (let index = 0; index < joint.length; index++) {
    if (((index >> qubit) & 1) === 1) sum += joint[index]!
  }
  return sum
}

function chainedGhz(qubits: number): Circuit {
  const operations: Operation[] = [
    { id: 'g_h', gate: 'h', targets: [0], column: 0 },
  ]
  for (let target = 1; target < qubits; target++) {
    operations.push({
      id: `g_${target}`,
      gate: 'cx',
      targets: [target],
      controls: [target - 1],
      column: target,
    })
  }
  return {
    schemaVersion: circuitOf('ghz').schemaVersion,
    qubits,
    clbits: 0,
    operations,
  }
}

/* ─────────────── 3a. Deutsch–Jozsa over every oracle on 2 bits ──────────── */

/** An oracle as a list of operations acting on q0, q1 (inputs) and q2. */
type Oracle = readonly {
  readonly gate: string
  readonly target: number
  readonly controls?: readonly number[]
}[]

interface OracleCase {
  readonly name: string
  readonly oracle: Oracle
  /** f as a plain function of the two input bits, for the classification. */
  readonly f: (x0: number, x1: number) => number
}

const CX_0: Oracle[number] = { gate: 'cx', target: 2, controls: [0] }
const CX_1: Oracle[number] = { gate: 'cx', target: 2, controls: [1] }
const NOT: Oracle[number] = { gate: 'x', target: 2 }

const ORACLES: readonly OracleCase[] = [
  { name: 'f = 0', oracle: [], f: () => 0 },
  { name: 'f = 1', oracle: [NOT], f: () => 1 },
  { name: 'f = x0', oracle: [CX_0], f: (x0) => x0 },
  { name: 'f = x1', oracle: [CX_1], f: (_x0, x1) => x1 },
  { name: 'f = x0 xor x1', oracle: [CX_0, CX_1], f: (x0, x1) => x0 ^ x1 },
  { name: 'f = not x0', oracle: [CX_0, NOT], f: (x0) => 1 - x0 },
  { name: 'f = not x1', oracle: [CX_1, NOT], f: (_x0, x1) => 1 - x1 },
  {
    name: 'f = not (x0 xor x1)',
    oracle: [CX_0, CX_1, NOT],
    f: (x0, x1) => 1 - (x0 ^ x1),
  },
]

/**
 * The preset's own frame with a different oracle dropped into it: X on the
 * ancilla, H on all three, the oracle, H on the two input wires.
 */
function deutschJozsaWith(oracle: Oracle): Circuit {
  const operations: Operation[] = [
    { id: 'dj_x', gate: 'x', targets: [2], column: 0 },
    { id: 'dj_h0', gate: 'h', targets: [0], column: 1 },
    { id: 'dj_h1', gate: 'h', targets: [1], column: 1 },
    { id: 'dj_h2', gate: 'h', targets: [2], column: 1 },
  ]
  oracle.forEach((step, index) => {
    operations.push({
      id: `dj_o${index}`,
      gate: step.gate,
      targets: [step.target],
      column: 2 + index,
      ...(step.controls === undefined ? {} : { controls: [...step.controls] }),
    })
  })
  const closing = 2 + oracle.length
  operations.push(
    { id: 'dj_f0', gate: 'h', targets: [0], column: closing },
    { id: 'dj_f1', gate: 'h', targets: [1], column: closing }
  )
  return {
    schemaVersion: circuitOf('deutschJozsa').schemaVersion,
    qubits: 3,
    clbits: 0,
    operations,
  }
}

/** P(the input register reads 00) — indices with q0 = q1 = 0, i.e. 0 and 4. */
function allZeroInput(vector: readonly Cx[]): number {
  return absSquared(vector[0]!) + absSquared(vector[4]!)
}

function classify(
  f: (x0: number, x1: number) => number
): 'constant' | 'balanced' {
  const values = [f(0, 0), f(1, 0), f(0, 1), f(1, 1)]
  const ones = values.filter((value) => value === 1).length
  if (ones === 0 || ones === 4) return 'constant'
  if (ones === 2) return 'balanced'
  throw new Error(`f is neither constant nor balanced: ${values.join('')}`)
}

describe('Deutsch–Jozsa decides constant against balanced in one run', () => {
  it.each(ORACLES)('$name', ({ oracle, f }) => {
    const circuit = deutschJozsaWith(oracle)
    const kind = classify(f)
    // Both simulators, because the whole claim of the algorithm is a
    // certainty, and a certainty is worth checking twice.
    for (const vector of [engineRun(circuit), referenceRun(circuit)]) {
      const zero = allZeroInput(vector)
      if (kind === 'constant') {
        expect(
          zero,
          'a constant oracle must read 00 with certainty'
        ).toBeCloseTo(1, 10)
      } else {
        expect(zero, 'a balanced oracle must never read 00').toBeLessThan(
          TOLERANCE
        )
      }
    }
  })

  it('is the balanced XOR oracle that the preset ships', () => {
    // The preset claims f(x) = x₀ ⊕ x₁ in its comment; this is that claim
    // checked rather than read.
    expectSameVector(
      referenceRun(circuitOf('deutschJozsa')),
      referenceRun(deutschJozsaWith([CX_0, CX_1]))
    )
    expect(classify((x0, x1) => x0 ^ x1)).toBe('balanced')
  })

  it('leaves the ancilla in |−⟩, so the query really was a phase kickback', () => {
    const vector = referenceRun(circuitOf('deutschJozsa'))
    // |−⟩ on q2 means the two halves of the register are equal and opposite.
    for (let index = 0; index < 4; index++) {
      const low = vector[index]!
      const high = vector[index + 4]!
      expect(Math.abs(low.re + high.re)).toBeLessThan(TOLERANCE)
      expect(Math.abs(low.im + high.im)).toBeLessThan(TOLERANCE)
    }
  })
})

/* ──────────────────── 3b. teleportation, by fidelity ────────────────────── */

/** |ψ⟩ = U(θ, φ, λ)|0⟩ — λ is a global phase on |0⟩ and drops out. */
function messageState(theta: number, phi: number): readonly [Cx, Cx] {
  return [
    cx(Math.cos(theta / 2)),
    mul(cx(Math.cos(phi), Math.sin(phi)), cx(Math.sin(theta / 2))),
  ]
}

/**
 * The id of the preset's closing measurement of q2 into c2.
 *
 * That step is the only way a circuit whose whole answer is a tally of the
 * classical register can show a reader that anything arrived (`presets.ts`
 * argues it at length). It is also a collapse, and fidelity is a question
 * about the state Bob is *holding* — so every check in this section asks its
 * question of the protocol proper and strips the readout first. What the
 * readout itself does is checked below, as a distribution, which is the only
 * thing a measurement outcome can be checked as.
 */
const READOUT = 'op_10'

/** The protocol without its closing readout. See `READOUT`. */
function beforeReadout(operations: readonly Operation[]): readonly Operation[] {
  return operations.filter((operation) => operation.id !== READOUT)
}

/** The teleportation preset with its message prepared by an arbitrary U. */
function teleportationOf(
  theta: number,
  phi: number,
  lambda: number,
  mutate: (operations: readonly Operation[]) => readonly Operation[] = (ops) =>
    ops
): Circuit {
  const base = circuitOf('teleportation')
  const operations = base.operations.map((operation) =>
    operation.id === 'op_1'
      ? { ...operation, gate: 'u', params: [theta, phi, lambda] }
      : operation
  )
  return { ...base, operations: [...mutate(beforeReadout(operations))] }
}

/** |⟨ψ|χ⟩|², with χ read off two amplitudes. Both are unit vectors. */
function fidelity(psi: readonly [Cx, Cx], chi: readonly [Cx, Cx]): number {
  const overlap = add(mul(conj(psi[0]), chi[0]), mul(conj(psi[1]), chi[1]))
  return absSquared(overlap)
}

/**
 * A deterministic spread of message states. Not `Math.random`: a failing case
 * has to be reproducible from the file alone.
 */
const MESSAGES: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [Math.PI, 0, 0],
  [Math.PI / 2, 0, 0],
  [Math.PI / 3, Math.PI / 2, 0],
  [Math.PI / 3, Math.PI / 4, Math.PI / 5],
  [0.7, 2.1, 1.3],
  [2.4, -1.1, 0.2],
  [1.05, 3.0, -2.2],
  [0.31, 0.97, 1.61],
  [2.9, -2.75, 0.05],
]

/**
 * Bob's qubit after one trajectory, plus the branch it belongs to.
 *
 * q0 and q1 have been measured, so the state is a product |m₀⟩|m₁⟩|χ⟩ and χ is
 * two amplitudes: the ones at index m₀ + 2·m₁ and that index + 4.
 */
function bobsQubit(
  state: Statevector,
  register: Uint8Array
): readonly [Cx, Cx] {
  const base = register[0]! + 2 * register[1]!
  const vector = readState(state)
  // Nothing may survive outside the measured branch, or "Bob's qubit" is not
  // a well-defined thing to read.
  for (let index = 0; index < vector.length; index++) {
    if (index === base || index === base + 4) continue
    expect(absSquared(vector[index]!)).toBeLessThan(TOLERANCE)
  }
  return [vector[base]!, vector[base + 4]!]
}

describe('teleportation teleports', () => {
  it('carries the message the shipped preset actually prepares', () => {
    // The circuit as it ships, with its own `ry`, checked against the state
    // its comment claims: cos(π/6)|0⟩ + sin(π/6)|1⟩, a 75/25 split.
    const base = circuitOf('teleportation')
    const circuit: Circuit = {
      ...base,
      operations: [...beforeReadout(base.operations)],
    }
    const psi: readonly [Cx, Cx] = [
      cx(Math.cos(TELEPORTATION_MESSAGE_ANGLE / 2)),
      cx(Math.sin(TELEPORTATION_MESSAGE_ANGLE / 2)),
    ]
    expect(absSquared(psi[0])).toBeCloseTo(0.75, 10)
    expect(absSquared(psi[1])).toBeCloseTo(0.25, 10)
    for (let seed = 1; seed <= 60; seed++) {
      const { state, register } = runTrajectory(circuit, createRng(seed))
      expect(
        fidelity(psi, bobsQubit(state, register)),
        `seed ${seed}, corrections ${register[0]}${register[1]}`
      ).toBeCloseTo(1, 10)
    }
  })

  it.each(MESSAGES)(
    'carries U(%f, %f, %f)|0⟩ onto q2 with fidelity 1, every trajectory',
    (theta, phi, lambda) => {
      const circuit = teleportationOf(theta, phi, lambda)
      const psi = messageState(theta, phi)
      for (let seed = 1; seed <= 40; seed++) {
        const { state, register } = runTrajectory(circuit, createRng(seed))
        const chi = bobsQubit(state, register)
        expect(
          fidelity(psi, chi),
          `seed ${seed}, corrections ${register[0]}${register[1]}`
        ).toBeCloseTo(1, 10)
      }
    }
  )

  it('exercises all four correction branches on a message that can tell', () => {
    // A complex message is what makes the Z correction observable at all: with
    // a real |ψ⟩, dropping Z changes only a sign the marginal cannot see.
    const [theta, phi, lambda] = [1.05, 3.0, -2.2]
    const circuit = teleportationOf(theta, phi, lambda)
    const seen = new Set<string>()
    for (let seed = 1; seed <= 200; seed++) {
      const { register } = runTrajectory(circuit, createRng(seed))
      seen.add(`${register[0]}${register[1]}`)
    }
    expect([...seen].sort()).toEqual(['00', '01', '10', '11'])
  })

  /**
   * The same protocol worked out entirely outside the engine: run the circuit
   * up to the measurements with the dense reference simulator, project both
   * sending qubits onto each of the four outcomes by hand, apply the
   * corrections the preset's conditions name, and read what is left on q2.
   *
   * This is the check that the *circuit* is right rather than that the engine
   * is consistent with itself.
   */
  it.each(MESSAGES)(
    'has all four branches equally likely and exact, by hand (%f, %f, %f)',
    (theta, phi, lambda) => {
      const circuit = teleportationOf(theta, phi, lambda)
      const psi = messageState(theta, phi)
      const beforeMeasurement = referenceRun({
        ...circuit,
        // Columns 0 to 3 are the protocol up to Alice's measurements.
        operations: orderedOperations(circuit).filter(
          (operation) => operation.column < 4
        ),
      })
      for (const m0 of [0, 1] as const) {
        for (const m1 of [0, 1] as const) {
          const first = project(beforeMeasurement, 0, m0)
          const second = project(first.vector, 1, m1)
          const probability = first.probability * second.probability
          expect(probability, `branch ${m0}${m1}`).toBeCloseTo(0.25, 10)

          // The corrections the preset writes: X on q2 if c1 = 1 (that is m1),
          // then Z on q2 if c0 = 1 (that is m0).
          let corrected = second.vector
          if (m1 === 1) {
            corrected = applyOnQubitTwo(corrected, [ZERO, ONE, ONE, ZERO])
          }
          if (m0 === 1) {
            corrected = applyOnQubitTwo(corrected, [ONE, ZERO, ZERO, cx(-1)])
          }
          const base = m0 + 2 * m1
          const chi: readonly [Cx, Cx] = [
            corrected[base]!,
            corrected[base + 4]!,
          ]
          expect(fidelity(psi, chi), `branch ${m0}${m1}`).toBeCloseTo(1, 10)
        }
      }
    }
  )

  it('has teeth: dropping either correction breaks the fidelity', () => {
    // The point of this one is the test, not the preset. A fidelity check that
    // could not fail would prove nothing about the four checks above.
    const [theta, phi, lambda] = [1.05, 3.0, -2.2]
    const psi = messageState(theta, phi)
    for (const dropped of ['op_8', 'op_9']) {
      const broken = teleportationOf(theta, phi, lambda, (operations) =>
        operations.filter((operation) => operation.id !== dropped)
      )
      const worst = worstFidelity(broken, psi)
      expect(
        worst,
        `removing ${dropped} must be visible as a loss of fidelity`
      ).toBeLessThan(0.99)
    }
    // Swapping which bit drives which correction is the likelier mistake than
    // dropping one, and it is invisible to a marginal check too.
    const swapped = teleportationOf(theta, phi, lambda, (operations) =>
      operations.map((operation) =>
        operation.condition === undefined
          ? operation
          : {
              ...operation,
              condition: {
                ...operation.condition,
                clbit: operation.condition.clbit === 0 ? 1 : 0,
              },
            }
      )
    )
    expect(
      worstFidelity(swapped, psi),
      'swapping c0 and c1 must be visible as a loss of fidelity'
    ).toBeLessThan(0.99)

    // And the intact circuit is perfect on the same sweep.
    expect(
      worstFidelity(teleportationOf(theta, phi, lambda), psi)
    ).toBeGreaterThan(1 - TOLERANCE)
  })

  /**
   * The closing readout, checked as the only thing a measurement can be
   * checked as: a distribution.
   *
   * This is what the preset actually puts on a reader's screen. Alice's two
   * bits are a fair four-way split whatever the message is — they carry no
   * information about it, which is the point of the protocol — and c2 carries
   * sin²(θ/2), the message's own asymmetry, arriving on a qubit that was
   * never touched by it.
   */
  it('reads the arriving state into the classical register', () => {
    const circuit = circuitOf('teleportation')
    const expectedOne = Math.sin(TELEPORTATION_MESSAGE_ANGLE / 2) ** 2
    expect(expectedOne).toBeCloseTo(0.25, 10)

    const SHOTS = 4000
    let ones = 0
    const alice = new Map<string, number>()
    for (let seed = 1; seed <= SHOTS; seed++) {
      const { register } = runTrajectory(circuit, createRng(seed))
      expect(register).toHaveLength(3)
      ones += register[2]!
      const key = `${register[0]}${register[1]}`
      alice.set(key, (alice.get(key) ?? 0) + 1)
    }

    // √(p(1−p)/n) is 0,68 % at p = ¼ over 4 000 draws, so 2,5 % is between
    // three and four of those: loose enough never to flake, and ten times
    // tighter than the half a teleporter that lost the message would read.
    expect(Math.abs(ones / SHOTS - expectedOne)).toBeLessThan(0.025)

    expect([...alice.keys()].sort()).toEqual(['00', '01', '10', '11'])
    for (const count of alice.values()) {
      expect(Math.abs(count / SHOTS - 0.25)).toBeLessThan(0.025)
    }
  })

  it('has teeth on the readout too', () => {
    // The same mutation as above, seen through the register rather than
    // through the state: with Bob's Z dropped the arriving qubit is
    // cos|0⟩ − sin|1⟩ and c2 still reads 1 a quarter of the time, so the
    // *marginal* cannot tell. With his X dropped it can, and does.
    const broken: Circuit = {
      ...circuitOf('teleportation'),
      operations: circuitOf('teleportation').operations.filter(
        (operation) => operation.id !== 'op_8'
      ),
    }
    let ones = 0
    for (let seed = 1; seed <= 400; seed++) {
      ones += runTrajectory(broken, createRng(seed)).register[2]!
    }

    expect(Math.abs(ones / 400 - 0.25)).toBeGreaterThan(0.1)
  })
})

function worstFidelity(circuit: Circuit, psi: readonly [Cx, Cx]): number {
  let worst = 1
  for (let seed = 1; seed <= 60; seed++) {
    const { state, register } = runTrajectory(circuit, createRng(seed))
    const base = register[0]! + 2 * register[1]!
    const vector = readState(state)
    const chi: readonly [Cx, Cx] = [vector[base]!, vector[base + 4]!]
    worst = Math.min(worst, fidelity(psi, chi))
  }
  return worst
}

/** The dense reference's `applyOperation`, specialised to an uncontrolled q2. */
function applyOnQubitTwo(
  vector: readonly Cx[],
  matrix: readonly [Cx, Cx, Cx, Cx]
): Cx[] {
  return vector.map((_, index) => {
    const bit = (index >> 2) & 1
    const partner = index ^ 4
    const from =
      bit === 0
        ? [vector[index]!, vector[partner]!]
        : [vector[partner]!, vector[index]!]
    return add(
      mul(matrix[bit * 2]!, from[0]!),
      mul(matrix[bit * 2 + 1]!, from[1]!)
    )
  })
}
