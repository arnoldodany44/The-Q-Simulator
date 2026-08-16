import { CIRCUIT_SCHEMA_VERSION, MAX_EXPANDED_OPERATIONS } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import {
  JOB_ID_DIGEST_CHARS,
  MAX_IDENTIFIER_LENGTH,
  canonicalJson,
  canonicalWork,
  jobIdFrom,
  parseJobPayload,
  shapeOf,
  utf8ByteLength,
} from './payload.js'
import type { SimulationJobPayload } from './payload.js'

const BELL: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

function payload(
  overrides: Partial<SimulationJobPayload> = {}
): SimulationJobPayload {
  return {
    runId: 'run_0000000000000000000001',
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

describe('parseJobPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(parseJobPayload(payload())).toMatchObject({ mode: 'STATEVECTOR' })
  })

  it('refuses an identifier long enough to be an attack on a key space', () => {
    expect(() =>
      parseJobPayload(payload({ runId: 'x'.repeat(MAX_IDENTIFIER_LENGTH + 1) }))
    ).toThrow()
  })

  it('refuses a seed that would not survive being expanded into the generator', () => {
    expect(() => parseJobPayload(payload({ seed: 2 ** 40 }))).toThrow()
    expect(() => parseJobPayload(payload({ seed: 1.5 }))).toThrow()
  })

  it('refuses a custom noise profile, which is eight numbers from a stranger', () => {
    // `custom` exists in NOISE_PROFILE_IDS for the editor. On the wire it would
    // mean accepting arbitrary Kraus parameters, so only the presets are here.
    expect(() =>
      parseJobPayload(payload({ noiseProfileId: 'custom' as never }))
    ).toThrow()
    expect(
      parseJobPayload(payload({ noiseProfileId: 'teaching' }))
    ).toMatchObject({ noiseProfileId: 'teaching' })
  })

  it('refuses a circuit whose shape is wrong', () => {
    expect(() =>
      parseJobPayload(payload({ circuit: { ...BELL, qubits: 0 } }))
    ).toThrow()
  })

  it('refuses shots outside the accepted range', () => {
    expect(() => parseJobPayload(payload({ shots: 0 }))).toThrow()
    expect(() => parseJobPayload(payload({ shots: 1_000_000 }))).toThrow()
  })
})

describe('canonicalJson', () => {
  it('is blind to the order the producer happened to serialise keys in', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('is not blind to array order, because an array is ordered', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('drops undefined the way JSON.stringify does, so the two agree', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('sorts nested objects too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(
      '{"outer":{"a":2,"z":1}}'
    )
  })
})

describe('canonicalWork', () => {
  it('is the same string for the same work submitted twice', () => {
    expect(canonicalWork(payload())).toBe(canonicalWork(payload()))
  })

  it('ignores the run id, which is the identity of the request and not the work', () => {
    expect(canonicalWork(payload({ runId: 'run_A' }))).toBe(
      canonicalWork(payload({ runId: 'run_B' }))
    )
  })

  it.each([
    ['mode', { mode: 'TRAJECTORIES' as const, shots: 100 }],
    ['seed', { seed: 8 }],
    ['shots', { mode: 'TRAJECTORIES' as const, shots: 200 }],
    ['noise profile', { noiseProfileId: 'teaching' as const }],
    ['readout', { readout: false }],
  ])('separates work that differs by its %s', (_label, overrides) => {
    expect(canonicalWork(payload(overrides))).not.toBe(canonicalWork(payload()))
  })

  it('separates two callers, so a shared answer is never a shared row', () => {
    // A SimulationRun belongs to somebody and is read through the same
    // visibility rules as everything else. Collapsing two users onto one row
    // because their circuits matched would hand the second one the first's run.
    expect(canonicalWork(payload({ submittedBy: 'user-a' }))).not.toBe(
      canonicalWork(payload({ submittedBy: 'user-b' }))
    )
    expect(canonicalWork(payload({ submittedBy: 'user-a' }))).not.toBe(
      canonicalWork(payload())
    )
  })

  it('separates two attributions, because the read filter joins through them', () => {
    expect(canonicalWork(payload({ circuitId: 'circuit-public' }))).not.toBe(
      canonicalWork(payload({ circuitId: 'circuit-private' }))
    )
  })

  it('separates two different circuits', () => {
    const other: Circuit = {
      ...BELL,
      operations: [{ id: 'a', gate: 'x', targets: [0], column: 0 }],
    }
    expect(canonicalWork(payload({ circuit: other }))).not.toBe(
      canonicalWork(payload())
    )
  })
})

describe('jobIdFrom', () => {
  it('keeps 128 bits of the digest', () => {
    const id = jobIdFrom('a'.repeat(64))
    expect(id).toBe(`sim-${'a'.repeat(JOB_ID_DIGEST_CHARS)}`)
  })

  it('never contains a colon, which is how BullMQ builds its keys', () => {
    expect(jobIdFrom('deadbeef'.repeat(8))).not.toContain(':')
  })
})

describe('utf8ByteLength', () => {
  it('counts bytes and not UTF-16 code units', () => {
    // A ket label is exactly this problem: `⟩` is one code unit and three
    // bytes, so a budget measured in `.length` is a budget half again too big.
    expect(utf8ByteLength('|01⟩')).toBe(1 + 2 + 3)
    expect('|01⟩'.length).toBe(4)
  })

  it('counts an astral character once, as four bytes', () => {
    expect(utf8ByteLength('\u{1F600}')).toBe(4)
  })

  it('counts a lone surrogate as the replacement character an encoder writes', () => {
    expect(utf8ByteLength('\ud800')).toBe(3)
  })

  it('agrees with what JSON of a circuit actually weighs', () => {
    const text = JSON.stringify(BELL)
    expect(utf8ByteLength(text)).toBe(text.length)
  })
})

describe('shapeOf', () => {
  it('reduces a payload to what the limit checks and the cost model need', () => {
    expect(shapeOf(payload({ mode: 'TRAJECTORIES', shots: 500 }))).toEqual({
      mode: 'TRAJECTORIES',
      qubits: 2,
      operations: 2,
      shots: 500,
    })
  })

  /*
   * The §11 half. `operations` decides admission, and a custom gate is a
   * multiplier the flat count cannot see: this document has two operations on
   * the canvas and eight for the engine to run.
   */
  it('counts a custom gate as the operations it expands to', () => {
    const packaged: Circuit = {
      ...BELL,
      operations: [
        { id: 'a', gate: 'bell', targets: [0, 1], column: 0 },
        { id: 'b', gate: 'bell', targets: [0, 1], column: 1 },
      ],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'x', gate: 'bell2', targets: [0, 1], column: 0 },
            { id: 'y', gate: 'bell2', targets: [0, 1], column: 1 },
          ],
        },
        bell2: { qubits: 2, operations: BELL.operations },
      },
    }
    expect(shapeOf(payload({ circuit: packaged })).operations).toBe(8)
  })

  it('reports a circuit past the expansion ceiling as past the ceiling', () => {
    const customGates: Record<
      string,
      { qubits: number; operations: unknown[] }
    > = {
      g0: {
        qubits: 1,
        operations: [{ id: 'a', gate: 'x', targets: [0], column: 0 }],
      },
    }
    for (let level = 1; level <= 24; level++) {
      customGates[`g${level}`] = {
        qubits: 1,
        operations: [
          { id: 'a', gate: `g${level - 1}`, targets: [0], column: 0 },
          { id: 'b', gate: `g${level - 1}`, targets: [0], column: 1 },
        ],
      }
    }
    const bomb = {
      ...BELL,
      operations: [{ id: 'a', gate: 'g24', targets: [0], column: 0 }],
      customGates,
    } as unknown as Circuit

    expect(shapeOf(payload({ circuit: bomb })).operations).toBeGreaterThan(
      MAX_EXPANDED_OPERATIONS
    )
  })
})
