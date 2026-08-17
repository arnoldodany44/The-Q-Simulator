/**
 * The two smaller findings of the transpile-equivalence pass, as runnable
 * reproductions. Both were `it.fails` while they were open; both are now plain
 * assertions, kept because they are the cases the fixes were written for and a
 * regression in either is silent.
 */

import { describe, expect, it } from 'vitest'
import type { Circuit } from '@qsim/schema'
import { deviceGraph, type DeviceTarget } from '../../device.js'
import { emitPhysicalQasm } from '../../emit.js'
import { safeTranspile } from '../../transpile.js'

/* ─────────── a readout calibration that failed is not a wiring fault ────── */

/**
 * `infidelity()` in `placement.ts` answers `Infinity` for an error of 1, and
 * `place` prunes any branch whose cost is not strictly below the best so far —
 * which, before the first complete placement, is `Infinity`. So when every
 * *measured* qubit reported `readout_error: 1`, every placement was pruned, the
 * search ended with `best === null`, and the refusal produced was
 * `no-placement` with a message about the coupling map.
 *
 * The circuit below is a Bell pair on a five-qubit path: it embeds, trivially,
 * on any adjacent pair. Nothing about its connectivity is wrong. A readout
 * error is a *quality* number — the qubits compute, the reading is just not
 * worth much — so the penalty now saturates instead of diverging and the
 * placement is found.
 */
describe('a device whose readout calibration failed', () => {
  const target: DeviceTarget = {
    name: 'dead-readout',
    qubits: 5,
    basisGates: ['cz', 'id', 'rx', 'rz', 'rzz', 'sx', 'x'],
    coupling: [
      { a: 0, b: 1, error: 1e-3 },
      { a: 1, b: 2, error: 1e-3 },
      { a: 2, b: 3, error: 1e-3 },
      { a: 3, b: 4, error: 1e-3 },
    ],
    qubitProperties: Array.from({ length: 5 }, () => ({
      gateError: 3e-4,
      readoutError: 1,
    })),
  }

  const bell: Circuit = {
    schemaVersion: 1,
    qubits: 2,
    clbits: 2,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
      { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
    ],
  }

  it('places the circuit rather than blaming the coupling map', () => {
    const outcome = safeTranspile(bell, deviceGraph(target))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Two adjacent physical qubits, which is all this circuit ever needed.
    const [a, b] = [...outcome.value.layout].sort((x, y) => x - y)
    expect(Math.abs((b as number) - (a as number))).toBe(1)
  })

  it('still prefers the readable pair when there is one', () => {
    /*
     * The other half: saturating the penalty must not make readout stop
     * mattering. Qubits 1 and 2 are the only readable pair, and they are the
     * ones chosen.
     */
    const readable: DeviceTarget = {
      ...target,
      qubitProperties: [
        { gateError: 3e-4, readoutError: 1 },
        { gateError: 3e-4, readoutError: 0.02 },
        { gateError: 3e-4, readoutError: 0.02 },
        { gateError: 3e-4, readoutError: 1 },
        { gateError: 3e-4, readoutError: 1 },
      ],
    }
    const outcome = safeTranspile(bell, deviceGraph(readable))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect([...outcome.value.layout].sort()).toEqual([1, 2])
  })

  it('and still refuses when the *gates* are what failed', () => {
    /*
     * The distinction the fix turns on. A `gate_error` of 1 is hardware that
     * does not work: `device.ts` removes those qubits from the graph, and a
     * circuit with nowhere to go is genuinely unplaceable. That refusal is
     * unchanged.
     */
    const broken: DeviceTarget = {
      ...target,
      qubitProperties: Array.from({ length: 5 }, () => ({
        gateError: 1,
        readoutError: 0.02,
      })),
    }
    const outcome = safeTranspile(bell, deviceGraph(broken))
    expect(outcome.ok).toBe(false)
  })
})

/* ──────────── the register style declares a register too narrow ────────── */

/**
 * `emitPhysicalQasm`'s `register` style writes `qubit[n] q;` and then indexes
 * it by *physical* qubit. `n` comes from `options.deviceQubits`, and when that
 * was omitted it fell back to `circuit.qubits` — the width of the **compact**
 * circuit, which is the number of qubits the program uses, never the largest
 * index it names. The result declared `qubit[2] q;` and then wrote `q[53]`: an
 * out-of-range register a backend rejects on arrival.
 *
 * `transpile()` always supplies `deviceQubits`, so this was never on the
 * production path; it is reachable through the package's own public export,
 * which is exactly the path a caller handing a program to a different ingestion
 * route would take.
 */
describe('emitPhysicalQasm in register style without a device width', () => {
  const placed: Circuit = {
    schemaVersion: 1,
    qubits: 2,
    clbits: 2,
    operations: [
      { id: 'a', gate: 'cz', targets: [1], controls: [0], column: 0 },
      { id: 'm', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    ],
  }

  it('declares a register wide enough for the operands it writes', () => {
    const qasm = emitPhysicalQasm(placed, [53, 54], { style: 'register' })
    const declared = Number(/^qubit\[(\d+)]\s+q;$/m.exec(qasm)?.[1] ?? '0')
    const largest = Math.max(
      ...[...qasm.matchAll(/\bq\[(\d+)]/g)]
        .map((match) => Number(match[1]))
        .filter((index) => index !== declared)
    )
    expect(declared).toBeGreaterThan(largest)
    // Concretely: the operands are $53 and $54, so 55 is the narrowest legal
    // declaration.
    expect(declared).toBe(55)
  })

  it('and is correct as soon as the width is passed', () => {
    const qasm = emitPhysicalQasm(placed, [53, 54], {
      style: 'register',
      deviceQubits: 156,
    })
    expect(qasm).toContain('qubit[156] q;')
    expect(qasm).toContain('cz q[53], q[54];')
  })
})
