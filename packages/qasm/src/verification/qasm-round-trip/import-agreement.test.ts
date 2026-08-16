/**
 * What a file MEANS, checked against matrices written out here rather than
 * against anything the importer computes.
 *
 * ── WHY THE EXPECTATIONS ARE DENSE MATRICES AND NOT OPERATION LISTS ──────
 *
 * Because an expectation spelled as "a `p` on the control and a controlled `U`"
 * is the importer's own decomposition, and a test that asserts it would pass
 * for any decomposition the importer happened to choose, right or wrong. So
 * every case below states the 2ⁿ × 2ⁿ unitary it expects from the published
 * definition of the gate — `u3(θ,φ,λ) = e^{−i(φ+λ)/2}·U(θ,φ,λ)`, `ctrl @ G` is
 * G on the branch where the control reads 1 — and compares the whole matrix,
 * global phase included. A dropped or doubled phase is invisible to a
 * probability comparison and visible here.
 *
 * ── AND WHY THE CIRCUITS ARE ASYMMETRIC ──────────────────────────────────
 *
 * The endianness cases use circuits whose mirror image is a different circuit:
 * an X on one specific wire, a CNOT with distinguishable control and target,
 * two registers of different sizes. A Bell pair agrees with itself under either
 * convention and proves nothing.
 */

import { run } from '@qsim/core'
import { describe, expect, it } from 'vitest'

import { importOpenQasm } from '../../import/index.js'
import {
  apply1,
  apply2,
  basis,
  fixedMatrix,
  matrixDistance,
  paramMatrix,
  unitaryOf,
  type Ctrl,
  type M2,
  type Vec,
} from './reference.js'

const TOLERANCE = 1e-12

/** `scalar · matrix`, with the scalar given as e^{i·phase}. */
function phased(matrix: M2, phase: number): M2 {
  const cos = Math.cos(phase)
  const sin = Math.sin(phase)
  return matrix.map(([re, im]) => [
    cos * re - sin * im,
    cos * im + sin * re,
  ]) as unknown as M2
}

/** Builds the full unitary of an expectation written as a function of a state. */
function expectation(qubits: number, build: (state: Vec) => void): Vec[] {
  const columns: Vec[] = []
  for (let index = 0; index < 1 << qubits; index++) {
    const state = basis(qubits, index)
    build(state)
    columns.push(state)
  }
  return columns
}

function check(source: string, qubits: number, build: (state: Vec) => void) {
  const imported = importOpenQasm(source)
  expect(imported.circuit.qubits).toBe(qubits)
  const distance = matrixDistance(
    unitaryOf(imported.circuit),
    expectation(qubits, build)
  )
  expect(`distance ${String(distance < TOLERANCE)}`).toBe('distance true')
  return imported
}

const HEAD3 = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'
const HEAD2 = 'OPENQASM 2.0;\ninclude "qelib1.inc";\n'

/* ───────────────────────────── endianness ──────────────────────────────── */

describe('q[k] is qubit k, on the way in', () => {
  it('puts an X on the wire the file names, not its mirror', () => {
    const source = `${HEAD3}qubit[3] q;\nx q[0];\n`
    const { circuit } = check(source, 3, (state) => {
      apply1(state, fixedMatrix('x') as M2, 0, [])
    })
    const result = run(circuit)
    if (result.mode !== 'analytic') throw new Error('expected analytic')
    // |001> in Qiskit's printing order, i.e. amplitude index 1.
    expect(result.state.re[1]).toBeCloseTo(1, 12)
  })

  it('reads a CNOT control-first', () => {
    // Asymmetric on purpose: with the operands the other way round the state
    // after `x q[0]; cx q[0], q[1];` would be |001> rather than |011>.
    const source = `${HEAD3}qubit[2] q;\nx q[0];\ncx q[0], q[1];\n`
    const { circuit } = check(source, 2, (state) => {
      apply1(state, fixedMatrix('x') as M2, 0, [])
      apply1(state, fixedMatrix('x') as M2, 1, [{ qubit: 0, state: 1 }])
    })
    const result = run(circuit)
    if (result.mode !== 'analytic') throw new Error('expected analytic')
    expect(result.state.re[3]).toBeCloseTo(1, 12)
  })

  it('concatenates named registers in declaration order', () => {
    const source = `OPENQASM 2.0;\nqreg alice[2];\nqreg bob[2];\nx bob[0];\n`
    check(source, 4, (state) => {
      apply1(state, fixedMatrix('x') as M2, 2, [])
    })
  })

  it('does not mirror a three-qubit register', () => {
    const source = `${HEAD3}qubit[3] q;\nccx q[0], q[1], q[2];\nx q[2];\n`
    check(source, 3, (state) => {
      apply1(state, fixedMatrix('x') as M2, 2, [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 1 },
      ])
      apply1(state, fixedMatrix('x') as M2, 2, [])
    })
  })

  it('reads crz with the control and the target the right way round', () => {
    const source = `${HEAD3}qubit[2] q;\ncrz(0.7) q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(state, paramMatrix('rz', [0.7]), 1, [{ qubit: 0, state: 1 }])
    })
  })
})

/* ──────────────────── the phase that only a control reveals ─────────────── */

describe('global phases are carried until the controls are known', () => {
  const theta = 0.83
  const phi = 1.27
  const lambda = -0.41

  it('reads OpenQASM 3 U as the unphased matrix', () => {
    const source = `${HEAD3}qubit[1] q;\nU(${String(theta)}, ${String(phi)}, ${String(lambda)}) q[0];\n`
    check(source, 1, (state) => {
      apply1(state, paramMatrix('u', [theta, phi, lambda]), 0, [])
    })
  })

  it('drops OpenQASM 2 U’s phase only when nothing can observe it', () => {
    /*
     * Version 2's built-in `U` is the phased matrix, and the contract has no
     * gate for a global phase — so an *uncontrolled* one comes back as the
     * unphased `u`, which is the same physics and a deliberate loss. The claim
     * worth checking is that the loss is exactly the phase and nothing else:
     * the imported matrix is the unphased U to the last bit, and the phase
     * reappears the moment a control makes it observable (the `cu3` case
     * below).
     */
    const source = `${HEAD2}qreg q[1];\nU(${String(theta)}, ${String(phi)}, ${String(lambda)}) q[0];\n`
    check(source, 1, (state) => {
      apply1(state, paramMatrix('u', [theta, phi, lambda]), 0, [])
    })
  })

  it('keeps u3’s phase when u3 is controlled', () => {
    const source = `${HEAD3}qubit[2] q;\nctrl @ u3(${String(theta)}, ${String(phi)}, ${String(lambda)}) q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(
        state,
        phased(paramMatrix('u', [theta, phi, lambda]), -(phi + lambda) / 2),
        1,
        [{ qubit: 0, state: 1 }]
      )
    })
  })

  it('does not invent one when the bare U is controlled', () => {
    const source = `${HEAD3}qubit[2] q;\nctrl @ U(${String(theta)}, ${String(phi)}, ${String(lambda)}) q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(state, paramMatrix('u', [theta, phi, lambda]), 1, [
        { qubit: 0, state: 1 },
      ])
    })
  })

  it('reads qelib1 cu3 as the controlled phased U', () => {
    const source = `${HEAD2}qreg q[2];\ncu3(${String(theta)}, ${String(phi)}, ${String(lambda)}) q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(
        state,
        phased(paramMatrix('u', [theta, phi, lambda]), -(phi + lambda) / 2),
        1,
        [{ qubit: 0, state: 1 }]
      )
    })
  })

  it('reads stdgates cu as p(γ) on the control and a controlled U', () => {
    const gamma = 0.29
    const source = `${HEAD3}qubit[2] q;\ncu(${String(theta)}, ${String(phi)}, ${String(lambda)}, ${String(gamma)}) q[0], q[1];\n`
    check(source, 2, (state) => {
      // The published definition, applied as written: a phase on the control
      // and then the unphased U on the branch where it fires.
      apply1(state, paramMatrix('p', [gamma]), 0, [])
      apply1(state, paramMatrix('u', [theta, phi, lambda]), 1, [
        { qubit: 0, state: 1 },
      ])
    })
  })

  it('reads u2 as u3(pi/2, φ, λ), phase included', () => {
    const source = `${HEAD3}qubit[2] q;\nctrl @ u2(${String(phi)}, ${String(lambda)}) q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(
        state,
        phased(
          paramMatrix('u', [Math.PI / 2, phi, lambda]),
          -(phi + lambda) / 2
        ),
        1,
        [{ qubit: 0, state: 1 }]
      )
    })
  })

  it('reads a bare gphase as unobservable and a controlled one as a phase', () => {
    const source = `${HEAD3}qubit[2] q;\nctrl @ gphase(0.6) q[0];\n`
    check(source, 2, (state) => {
      apply1(state, paramMatrix('p', [0.6]), 0, [])
    })
  })
})

/* ───────────────────────────── the modifiers ───────────────────────────── */

describe('modifiers mean what the language says they mean', () => {
  it('negctrl fires on |0>', () => {
    const source = `${HEAD3}qubit[2] q;\nnegctrl @ x q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(state, fixedMatrix('x') as M2, 1, [{ qubit: 0, state: 0 }])
    })
  })

  it('binds stacked control qubits left to right', () => {
    const source = `${HEAD3}qubit[3] q;\nctrl @ negctrl @ x q[0], q[1], q[2];\n`
    check(source, 3, (state) => {
      apply1(state, fixedMatrix('x') as M2, 2, [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 0 },
      ])
    })
  })

  it('reads ctrl(2) as two controls', () => {
    const source = `${HEAD3}qubit[3] q;\nctrl(2) @ z q[0], q[1], q[2];\n`
    check(source, 3, (state) => {
      apply1(state, fixedMatrix('z') as M2, 2, [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 1 },
      ])
    })
  })

  it('inverts a rotation by negating its angle', () => {
    const source = `${HEAD3}qubit[1] q;\ninv @ rz(0.4) q[0];\n`
    check(source, 1, (state) => {
      apply1(state, paramMatrix('rz', [-0.4]), 0, [])
    })
  })

  it('inverts U as U(-θ, -λ, -φ)', () => {
    const source = `${HEAD3}qubit[1] q;\ninv @ U(0.4, 0.9, -1.2) q[0];\n`
    check(source, 1, (state) => {
      // Written as the conjugate transpose of the matrix itself, not as the
      // angle rule the importer uses — those are the same claim only if the
      // rule is right.
      const u = paramMatrix('u', [0.4, 0.9, -1.2])
      const dagger: M2 = [
        [u[0][0], -u[0][1]],
        [u[2][0], -u[2][1]],
        [u[1][0], -u[1][1]],
        [u[3][0], -u[3][1]],
      ]
      apply1(state, dagger, 0, [])
    })
  })

  it('repeats a gate with pow', () => {
    const source = `${HEAD3}qubit[1] q;\npow(3) @ s q[0];\n`
    check(source, 1, (state) => {
      for (let step = 0; step < 3; step++) {
        apply1(state, fixedMatrix('s') as M2, 0, [])
      }
    })
  })

  it('reads a negative pow as the repeated inverse', () => {
    const source = `${HEAD3}qubit[1] q;\npow(-2) @ t q[0];\n`
    check(source, 1, (state) => {
      for (let step = 0; step < 2; step++) {
        apply1(state, fixedMatrix('tdg') as M2, 0, [])
      }
    })
  })

  it('applies the modifier nearest the gate first', () => {
    const source = `${HEAD3}qubit[2] q;\nctrl @ inv @ s q[0], q[1];\n`
    check(source, 2, (state) => {
      apply1(state, fixedMatrix('sdg') as M2, 1, [{ qubit: 0, state: 1 }])
    })
  })

  it('distributes a control over a user gate body', () => {
    const source = `${HEAD3}gate block a, b { h a; cx a, b; }\nqubit[3] q;\nctrl @ block q[0], q[1], q[2];\n`
    check(source, 3, (state) => {
      apply1(state, fixedMatrix('h') as M2, 1, [{ qubit: 0, state: 1 }])
      apply1(state, fixedMatrix('x') as M2, 2, [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 1 },
      ])
    })
  })
})

/* ──────────────────────── broadcast and iswap ──────────────────────────── */

describe('the language’s own broadcast', () => {
  it('applies one gate to a whole register', () => {
    const source = `${HEAD3}qubit[3] q;\nh q;\n`
    check(source, 3, (state) => {
      for (const qubit of [0, 1, 2]) {
        apply1(state, fixedMatrix('h') as M2, qubit, [])
      }
    })
  })

  it('pairs two registers index by index', () => {
    const source = `OPENQASM 2.0;\nqreg a[2];\nqreg b[2];\nx a[0];\ncx a, b;\n`
    check(source, 4, (state) => {
      apply1(state, fixedMatrix('x') as M2, 0, [])
      apply1(state, fixedMatrix('x') as M2, 2, [{ qubit: 0, state: 1 }])
      apply1(state, fixedMatrix('x') as M2, 3, [{ qubit: 1, state: 1 }])
    })
  })

  it('reads iswap as the published matrix', () => {
    const source = `${HEAD3}qubit[2] q;\niswap q[0], q[1];\n`
    check(source, 2, (state) => {
      apply2(state, 'iswap', 0, 1, [] as Ctrl[])
    })
  })

  it('reads cswap with the control first', () => {
    const source = `${HEAD3}qubit[3] q;\ncswap q[0], q[1], q[2];\n`
    check(source, 3, (state) => {
      apply2(state, 'swap', 1, 2, [{ qubit: 0, state: 1 }])
    })
  })
})
