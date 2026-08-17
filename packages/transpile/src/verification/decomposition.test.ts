/**
 * The safety net for layer one: every gate in the catalog, decomposed, and the
 * decomposition multiplied out against the original.
 *
 * ── WHY THE COMPARISON IS A UNITARY AND NOT A DISTRIBUTION ───────────────
 *
 * Because a distribution only ever tests the gate's action on |0…0⟩, and far
 * too many wrong decompositions agree there. `x` on q0 and `cx q0→q1 · x q0`
 * send |00⟩ to the same place and are different operations; a controlled gate
 * whose phase landed on the wrong branch of the control is identical on every
 * computational basis input and different on every superposition. So the test
 * builds the whole matrix, from the same runner and the same kernel the
 * browser uses, and compares it entry for entry — modulo one overall factor.
 *
 * ── AND WHY "UP TO GLOBAL PHASE" IS THE RIGHT MODULO ─────────────────────
 *
 * `unitaryFidelity` is |Tr(A†B)|²/d², which is 1 exactly when B = e^{iφ}A. An
 * overall phase is unobservable, and a decomposition that reproduced it would
 * be spending gates on nothing. What the fidelity does *not* forgive is a
 * phase on part of the register — which is precisely the failure mode a
 * controlled gate has, and why every gate below is also tested under one and
 * two controls.
 *
 * ── EXHAUSTIVE, NOT A SAMPLE ─────────────────────────────────────────────
 *
 * The gate list is read out of `GATES` rather than written here, so a gate
 * added to the contract without a decomposition fails this file instead of
 * failing in somebody's circuit.
 */

import { describe, expect, it } from 'vitest'
import { GATES, type Control, type GateId } from '@qsim/schema'
import { circuitUnitary, unitaryFidelity } from '@qsim/core'

import { isBasisGate, isPassthrough } from '../basis.js'
import { decomposeCircuit } from '../decompose.js'
import { gateCircuit } from '../testing/circuits.js'

/** D6's tolerance. Every comparison in this project is against 1e-10. */
const TOLERANCE = 1e-10

/**
 * Angles chosen to hit each branch of `zsxOf` and several that hit none:
 * 0 and π and π/2 take the three short paths, and the rest take the general
 * five-gate one. The tiny and the large are there because the general path
 * adds π to θ and a decomposition that normalised the sum would drift.
 */
const ANGLES = [
  0,
  Math.PI / 2,
  Math.PI,
  -Math.PI / 2,
  Math.PI / 4,
  (3 * Math.PI) / 2,
  0.1,
  -0.1,
  2.345,
  -1.234,
  1e-9,
  12.5,
] as const

function paramsFor(gate: GateId, seed: number): readonly number[] {
  const count = GATES[gate].paramCount
  return Array.from(
    { length: count },
    (_unused, index) => ANGLES[(seed + index * 5) % ANGLES.length] as number
  )
}

/** The decomposition agrees with the source, up to one overall factor. */
function expectEquivalent(source: ReturnType<typeof gateCircuit>): void {
  const decomposed = decomposeCircuit(source)
  for (const operation of decomposed.circuit.operations) {
    expect(
      isBasisGate(operation.gate) || isPassthrough(operation.gate),
      `emitted "${operation.gate}", which is not in the native basis`
    ).toBe(true)
  }
  const fidelity = unitaryFidelity(
    circuitUnitary(source),
    circuitUnitary(decomposed.circuit)
  )
  expect(1 - fidelity).toBeLessThan(TOLERANCE)
}

const CATALOG = (Object.keys(GATES) as GateId[]).filter(
  (id) => GATES[id].category !== 'structural'
)

describe('every catalog gate, bare', () => {
  for (const gate of CATALOG) {
    const meta = GATES[gate]
    const arity = meta.arity as number
    const wires = arity + meta.controlCount

    it(`${gate} on its own wires`, () => {
      for (let seed = 0; seed < ANGLES.length; seed++) {
        const targets = Array.from({ length: arity }, (_u, i) => i)
        const controls = Array.from(
          { length: meta.controlCount },
          (_u, i) => arity + i
        )
        expectEquivalent(
          gateCircuit(wires, gate, targets, {
            ...(controls.length === 0 ? {} : { controls }),
            params: paramsFor(gate, seed),
          })
        )
        if (meta.paramCount === 0) break
      }
    })

    it(`${gate} with its wires reversed`, () => {
      /*
       * The same gate with the target above the controls rather than below.
       * A decomposition that hard-coded "control is the lower index" passes
       * the case above and fails this one — and on hardware that mistake is
       * invisible, because the device gives nothing to compare against.
       */
      const total = wires
      const targets = Array.from({ length: arity }, (_u, i) => total - 1 - i)
      const controls = Array.from({ length: meta.controlCount }, (_u, i) => i)
      expectEquivalent(
        gateCircuit(total, gate, targets, {
          ...(controls.length === 0 ? {} : { controls }),
          params: paramsFor(gate, 3),
        })
      )
    })
  }
})

const ONE_QUBIT = CATALOG.filter(
  (id) =>
    GATES[id].category === 'single' || GATES[id].category === 'parametrised'
)

describe('every one-qubit gate under one control', () => {
  for (const gate of ONE_QUBIT) {
    it(`controlled ${gate}`, () => {
      for (let seed = 0; seed < ANGLES.length; seed++) {
        // Target above the control, so an index mix-up is not symmetric.
        expectEquivalent(
          gateCircuit(2, gate, [1], {
            controls: [0],
            params: paramsFor(gate, seed),
          })
        )
        if (GATES[gate].paramCount === 0) break
      }
    })

    it(`negatively controlled ${gate}`, () => {
      const controls: Control[] = [{ qubit: 0, state: 0 }]
      expectEquivalent(
        gateCircuit(2, gate, [1], { controls, params: paramsFor(gate, 7) })
      )
    })
  }
})

describe('every one-qubit gate under two controls', () => {
  for (const gate of ONE_QUBIT) {
    it(`doubly controlled ${gate}`, () => {
      expectEquivalent(
        gateCircuit(3, gate, [2], {
          controls: [0, 1],
          params: paramsFor(gate, 2),
        })
      )
    })

    it(`doubly controlled ${gate} with one negative control`, () => {
      const controls: Control[] = [0, { qubit: 1, state: 0 }]
      expectEquivalent(
        gateCircuit(3, gate, [2], { controls, params: paramsFor(gate, 9) })
      )
    })
  }
})

describe('the catalog gates that carry their own controls', () => {
  /*
   * `cx`, `cz`, `crz`, `cp`, `ccx` and `cswap` have `acceptsControls: false`,
   * so a user cannot add controls to them — but the ones they already have are
   * stored in the same `controls` array and may perfectly well be negative.
   * The wrapping `x` that turns a negative control into a positive one is
   * written once, generically, and this is where that genericity is checked
   * rather than assumed.
   */
  const withBuiltInControls = CATALOG.filter((id) => GATES[id].controlCount > 0)

  for (const gate of withBuiltInControls) {
    it(`${gate} with every control negative`, () => {
      const meta = GATES[gate]
      const arity = meta.arity as number
      const wires = arity + meta.controlCount
      const controls: Control[] = Array.from(
        { length: meta.controlCount },
        (_u, index) => ({ qubit: arity + index, state: 0 as const })
      )
      expectEquivalent(
        gateCircuit(
          wires,
          gate,
          Array.from({ length: arity }, (_u, i) => i),
          { controls, params: paramsFor(gate, 4) }
        )
      )
    })

    it(`${gate} with a mix of positive and negative controls`, () => {
      const meta = GATES[gate]
      const arity = meta.arity as number
      const wires = arity + meta.controlCount
      const controls: Control[] = Array.from(
        { length: meta.controlCount },
        (_u, index) =>
          index === 0
            ? { qubit: arity + index, state: 0 as const }
            : arity + index
      )
      expectEquivalent(
        gateCircuit(
          wires,
          gate,
          Array.from({ length: arity }, (_u, i) => i),
          { controls, params: paramsFor(gate, 6) }
        )
      )
    })
  }
})

describe('the controlled-phase trap', () => {
  /*
   * `crz(θ)` and `cp(θ)` differ only by the global phase of `rz` against `p`,
   * which is unobservable until the gate is controlled. A construction that
   * read the Euler angles and dropped the phase emits the same circuit for
   * both — so this asserts they come out *different*, which no amount of
   * comparing each against itself would catch.
   */
  it('crz and cp decompose to different circuits', () => {
    const theta = 0.7
    const crz = decomposeCircuit(
      gateCircuit(2, 'crz', [1], { controls: [0], params: [theta] })
    )
    const cp = decomposeCircuit(
      gateCircuit(2, 'cp', [1], { controls: [0], params: [theta] })
    )
    const fidelity = unitaryFidelity(
      circuitUnitary(crz.circuit),
      circuitUnitary(cp.circuit)
    )
    expect(fidelity).toBeLessThan(0.999)
  })

  it('a controlled sx is not a controlled rx(pi/2)', () => {
    // √X = e^{iπ/4}·rx(π/2): the same gate on a wire, different under control.
    const csx = decomposeCircuit(gateCircuit(2, 'sx', [1], { controls: [0] }))
    const crx = decomposeCircuit(
      gateCircuit(2, 'rx', [1], { controls: [0], params: [Math.PI / 2] })
    )
    const fidelity = unitaryFidelity(
      circuitUnitary(csx.circuit),
      circuitUnitary(crx.circuit)
    )
    expect(fidelity).toBeLessThan(0.999)
  })
})

describe('the shapes a decomposition is cheapest on', () => {
  it('h is one pulse: rz(pi/2), sx, rz(pi/2)', () => {
    const { circuit } = decomposeCircuit(gateCircuit(1, 'h', [0]))
    expect(circuit.operations.map((op) => op.gate)).toEqual(['rz', 'sx', 'rz'])
    expect(circuit.operations.map((op) => op.params?.[0])).toEqual([
      Math.PI / 2,
      undefined,
      Math.PI / 2,
    ])
  })

  it('cx is one cz between two Hadamards', () => {
    const { circuit, twoQubitGates } = decomposeCircuit(
      gateCircuit(2, 'cx', [1], { controls: [0] })
    )
    expect(twoQubitGates).toBe(1)
    expect(circuit.operations.map((op) => op.gate)).toEqual([
      'rz',
      'sx',
      'rz',
      'cz',
      'rz',
      'sx',
      'rz',
    ])
  })

  it('cz is itself, with nothing added', () => {
    const { circuit } = decomposeCircuit(
      gateCircuit(2, 'cz', [1], { controls: [0] })
    )
    expect(circuit.operations).toHaveLength(1)
    expect(circuit.operations[0]?.gate).toBe('cz')
  })

  it('the exact angles survive as exact angles', () => {
    // `formatAngle` recognises pi/2 by `===` and by nothing else, so a
    // decomposition that computed 1.5707963267948968 would export a decimal.
    const gates = ['h', 's', 'sdg', 't', 'tdg', 'z'] as const
    const expected = [
      Math.PI / 2,
      Math.PI / 2,
      -Math.PI / 2,
      Math.PI / 4,
      -Math.PI / 4,
      Math.PI,
    ]
    for (const [index, gate] of gates.entries()) {
      const { circuit } = decomposeCircuit(gateCircuit(1, gate, [0]))
      const angles = circuit.operations
        .filter((op) => op.gate === 'rz')
        .map((op) => op.params?.[0])
      expect(angles.every((angle) => angle === expected[index])).toBe(true)
    }
  })

  it('the identity survives as id rather than as nothing', () => {
    const { circuit } = decomposeCircuit(gateCircuit(1, 'i', [0]))
    expect(circuit.operations.map((op) => op.gate)).toEqual(['i'])
  })

  it('a rotation by exactly zero disappears', () => {
    const { circuit } = decomposeCircuit(
      gateCircuit(1, 'rz', [0], { params: [0] })
    )
    expect(circuit.operations).toHaveLength(0)
  })

  it('three or more controls are refused, not approximated', () => {
    expect(() =>
      decomposeCircuit(gateCircuit(4, 'h', [3], { controls: [0, 1, 2] }))
    ).toThrowError(/three|3 controls/i)
  })
})
