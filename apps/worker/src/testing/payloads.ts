/**
 * Job payloads for the worker's tests.
 *
 * One builder rather than a literal per test, so that adding a field to
 * `SimulationJobPayload` is a compile error here and nowhere else — which is
 * the whole reason the payload has no optional fields.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import type { SimulationJobPayload } from '@qsim/jobs'

/** |00⟩ + |11⟩, over √2. Two gates, no measurement, no classical bits. */
export const BELL: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'h0', gate: 'h', targets: [0], column: 0 },
    { id: 'cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** The same pair, measured into two classical bits — what trajectories needs. */
export const MEASURED_BELL: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'h0', gate: 'h', targets: [0], column: 0 },
    { id: 'cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
    { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
  ],
}

export function jobPayload(
  overrides: Partial<SimulationJobPayload> = {}
): SimulationJobPayload {
  return {
    runId: 'run_test_000000000000001',
    circuit: BELL,
    mode: 'STATEVECTOR',
    shots: null,
    seed: 7,
    noiseProfileId: null,
    readout: true,
    submittedBy: null,
    circuitId: null,
    ...overrides,
  }
}

/** A wide but shallow circuit, for the memory and cost-model tests. */
export function wideCircuit(qubits: number, columns = 1): Circuit {
  const operations = []
  for (let column = 0; column < columns; column++) {
    for (let qubit = 0; qubit < qubits; qubit++) {
      operations.push({
        id: `h-${String(column)}-${String(qubit)}`,
        gate: 'h' as const,
        targets: [qubit],
        column,
      })
    }
  }
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  }
}
