/**
 * A random circuit generator, for the property tests.
 *
 * Deliberately *not* the one in `packages/qsim/src/testing/` or
 * `packages/qasm/src/testing/`: those are excluded from their packages' builds
 * and are not exported, and copying a generator is cheaper than widening two
 * public surfaces to share one. This one also has a different job — it must
 * reach every corner of the *decomposer*, which means extra controls, negative
 * controls and angles chosen to sit on and just off the constants `zsxOf`
 * branches at.
 *
 * Seeded from `@qsim/core`'s own generator, so a failure is reproducible from
 * the seed printed with it.
 */

import { createRng, type Rng } from '@qsim/core'
import {
  CIRCUIT_SCHEMA_VERSION,
  GATES,
  type Circuit,
  type Control,
  type GateId,
  type Operation,
} from '@qsim/schema'

/** Every catalog gate that applies a matrix. Structural ones are separate. */
const UNITARY_GATES = (Object.keys(GATES) as GateId[]).filter(
  (id) => GATES[id].category !== 'structural'
)

/**
 * Angles chosen so that the branch cuts in `zsxOf` are hit and also missed:
 * the exact constants take the short paths, and the values one ulp away must
 * take the long one rather than being rounded onto them.
 */
const ANGLES: readonly number[] = [
  0,
  Math.PI,
  Math.PI / 2,
  -Math.PI / 2,
  Math.PI / 4,
  Math.PI / 2 + Number.EPSILON,
  Math.PI - Number.EPSILON,
  0.3,
  -1.7,
  2.9,
  4.6,
  -0.0001,
]

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[
    Math.min(values.length - 1, Math.floor(rng.next() * values.length))
  ] as T
}

/** A shuffled prefix of `0…qubits-1`, of length `count`. */
function distinctQubits(rng: Rng, qubits: number, count: number): number[] {
  const pool = Array.from({ length: qubits }, (_unused, index) => index)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j] as number, pool[i] as number]
  }
  return pool.slice(0, count)
}

/**
 * A random unitary circuit on `qubits` wires with `length` operations.
 *
 * No measurements and no conditions: these circuits are compared as *matrices*
 * (see `verification/random-circuits.test.ts`), and a circuit that measures is
 * not a matrix.
 */
export function randomCircuit(
  seed: number,
  qubits: number,
  length: number
): Circuit {
  const rng = createRng(seed)
  const operations: Operation[] = []

  for (let index = 0; index < length; index++) {
    const gate = pick(rng, UNITARY_GATES)
    const meta = GATES[gate]
    const arity = meta.arity as number
    // Extra controls only where the contract allows them, and at most two in
    // total, which is what the decomposer builds.
    const extra = meta.acceptsControls
      ? Math.min(2 - meta.controlCount, Math.floor(rng.next() * 3))
      : 0
    const needed = arity + meta.controlCount + extra
    if (needed > qubits) {
      index--
      continue
    }

    const wires = distinctQubits(rng, qubits, needed)
    const targets = wires.slice(0, arity)
    const controls: Control[] = wires
      .slice(arity)
      .map((qubit) =>
        rng.next() < 0.25 ? { qubit, state: 0 as const } : qubit
      )

    operations.push({
      id: `r${String(index)}`,
      gate,
      targets,
      column: index,
      ...(controls.length === 0 ? {} : { controls }),
      ...(meta.paramCount === 0
        ? {}
        : {
            params: Array.from({ length: meta.paramCount }, () =>
              pick(rng, ANGLES)
            ),
          }),
    })
  }

  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  }
}
