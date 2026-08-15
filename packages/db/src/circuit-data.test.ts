import {
  CIRCUIT_SCHEMA_VERSION,
  emptyCircuit,
  type Circuit,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import {
  circuitJsonByteLength,
  CircuitTooLargeError,
  MAX_CIRCUIT_JSON_BYTES,
  parseCircuitVersion,
  parseStoredCircuit,
  toCircuitJson,
} from './circuit-data.js'
import type { CircuitVersion } from './generated/prisma/client.js'

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

function row(data: unknown): CircuitVersion {
  return {
    id: 'cv_1',
    circuitId: 'c_1',
    versionNum: 3,
    data: data as CircuitVersion['data'],
    message: 'add entanglement',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

describe('the JsonValue crossing', () => {
  it('round-trips a circuit through the column type', () => {
    const stored = JSON.parse(
      JSON.stringify(toCircuitJson(bell))
    ) as unknown as CircuitVersion['data']
    expect(parseStoredCircuit(stored)).toEqual(bell)
  })

  it('validates rather than casts', () => {
    // The whole reason this module exists. `row.data` is whatever Postgres
    // holds, including something written by an older build, and handing it
    // to the engine unchecked is how a malformed circuit becomes a crash
    // inside a simulation kernel rather than a 4xx at the boundary.
    expect(() => parseStoredCircuit({ qubits: 2 })).toThrow()
    expect(() => parseStoredCircuit(null)).toThrow()
    expect(() => parseStoredCircuit('a string')).toThrow()
  })

  it('rejects a circuit whose gate does not exist', () => {
    expect(() =>
      parseStoredCircuit({
        ...bell,
        operations: [
          { id: 'op-0', gate: 'flux-capacitor', targets: [0], column: 0 },
        ],
      })
    ).toThrow()
  })

  it('rejects a payload from a future schema version', () => {
    expect(() =>
      parseStoredCircuit({ ...bell, schemaVersion: CIRCUIT_SCHEMA_VERSION + 1 })
    ).toThrow()
  })

  it('narrows a whole row and leaves the other columns alone', () => {
    const parsed = parseCircuitVersion(row(toCircuitJson(bell)))

    expect(parsed.data).toEqual(bell)
    expect(parsed.versionNum).toBe(3)
    expect(parsed.message).toBe('add entanglement')
    expect(parsed.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'))
  })

  it('reports the row as invalid rather than returning a partial circuit', () => {
    expect(() => parseCircuitVersion(row({ nonsense: true }))).toThrow()
  })

  it('accepts an empty circuit, which is what a new document is', () => {
    expect(parseStoredCircuit(toCircuitJson(emptyCircuit(3)) as never)).toEqual(
      emptyCircuit(3)
    )
  })
})

describe('the storage size cap', () => {
  /** A circuit of `columns` columns with two gates in each, so it is valid. */
  function wide(columns: number): Circuit {
    const operations = []
    for (let column = 0; column < columns; column += 1) {
      operations.push({
        id: `op-a-${String(column)}`,
        gate: 'h',
        targets: [0],
        column,
      })
      operations.push({
        id: `op-b-${String(column)}`,
        gate: 'h',
        targets: [1],
        column,
      })
    }
    return { ...bell, operations }
  }

  it('lets an ordinary circuit through untouched', () => {
    expect(toCircuitJson(bell)).toBe(bell)
  })

  it('refuses a circuit that would not fit', () => {
    /*
     * The contract permits 4096 columns because that bounds *the engine*, and
     * nothing about a statevector's cost says how much text describes it. A
     * version is immutable, so a row written too large can never be shrunk —
     * only orphaned. The refusal has to happen before the write.
     */
    const huge = wide(3200)
    expect(circuitJsonByteLength(huge)).toBeGreaterThan(MAX_CIRCUIT_JSON_BYTES)
    expect(() => toCircuitJson(huge)).toThrow(CircuitTooLargeError)
  })

  it('reports the size and the limit, for the log and for nothing else', () => {
    try {
      toCircuitJson(wide(3200))
      expect.unreachable('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitTooLargeError)
      const failure = error as CircuitTooLargeError
      expect(failure.code).toBe('CIRCUIT_TOO_LARGE')
      expect(failure.limit).toBe(MAX_CIRCUIT_JSON_BYTES)
      expect(failure.byteLength).toBeGreaterThan(MAX_CIRCUIT_JSON_BYTES)
    }
  })

  it('measures bytes and not UTF-16 code units', () => {
    /*
     * A qubit label is a free string and `|ψ⟩` is a perfectly ordinary one.
     * Measured in `String.length`, a circuit of astral characters would pass
     * a byte budget it exceeds by three times.
     */
    const labelled: Circuit = { ...bell, qubitLabels: ['ψ', '𝜓'] }
    expect(circuitJsonByteLength(labelled)).toBeGreaterThan(
      JSON.stringify(labelled).length
    )
  })
})
