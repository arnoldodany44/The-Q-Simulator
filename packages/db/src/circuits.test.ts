import { CIRCUIT_SCHEMA_VERSION, emptyCircuit, previewOf } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it, vi } from 'vitest'
import {
  forkCircuit,
  isSlugConflict,
  isVersionNumberConflict,
  metricsOf,
  MissingVersionError,
  SlugUnavailableError,
  VersionConflictError,
} from './circuits.js'
import type {
  CircuitRepository,
  CircuitWithVersion,
  CreateCircuitInput,
  StoredVersion,
} from './circuits.js'
import { Visibility } from './generated/prisma/client.js'
import type { CircuitDetail } from './projections.js'

/*
 * The Prisma implementation is exercised against the real database, on
 * purpose and opt-in, in `circuits.db.test.ts`. What is here is everything
 * that can be decided without one — the derivations, the error
 * classification, and the fork policy — because those are the parts a route
 * depends on being right and none of them need a connection to check.
 */

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

describe('the denormalised counters', () => {
  it('reads the qubit count off the circuit', () => {
    expect(metricsOf(bell).qubitCount).toBe(2)
    expect(metricsOf(emptyCircuit(7)).qubitCount).toBe(7)
  })

  it('counts gates the way a leaderboard means it', () => {
    /*
     * Structure is not gates. This is @qsim/schema's definition, reused
     * rather than restated — the number in the `Circuit` row has to be the
     * number the editor showed, or the gallery orders by one thing and
     * displays another.
     */
    const withStructure: Circuit = {
      ...bell,
      clbits: 1,
      operations: [
        ...bell.operations,
        { id: 'op-2', gate: 'barrier', targets: [0, 1], column: 2 },
        {
          id: 'op-3',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 3,
        },
      ],
    }
    expect(metricsOf(withStructure).gateCount).toBe(2)
  })

  it('counts depth as occupied columns, ignoring barriers', () => {
    const gapped: Circuit = {
      ...bell,
      operations: [
        { id: 'op-0', gate: 'h', targets: [0], column: 0 },
        { id: 'op-1', gate: 'x', targets: [0], column: 9 },
      ],
    }
    // Two occupied columns, not ten: a gap left by an edit must not inflate
    // the number a gallery sorts on.
    expect(metricsOf(gapped).depth).toBe(2)
  })

  it('gives an empty circuit zero of everything but qubits', () => {
    expect(metricsOf(emptyCircuit(3))).toEqual({
      qubitCount: 3,
      gateCount: 0,
      depth: 0,
    })
  })
})

describe('classifying a unique-constraint violation', () => {
  /*
   * Prisma does not report `meta.target` in one fixed shape: depending on
   * connector and version it is a list of field names, one field name, or the
   * Postgres index identifier. Getting this wrong turns a retryable conflict
   * into a 500 — so all three shapes are matched, and all three are asserted.
   */
  const shapes = [
    { label: 'a list of fields', target: ['circuitId', 'versionNum'] },
    { label: 'one field', target: 'versionNum' },
    {
      label: 'the index identifier',
      target: 'CircuitVersion_circuitId_versionNum_key',
    },
  ]

  for (const { label, target } of shapes) {
    it(`recognises a versionNum conflict reported as ${label}`, () => {
      const error = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target },
      })
      expect(isVersionNumberConflict(error)).toBe(true)
      expect(isSlugConflict(error)).toBe(false)
    })
  }

  it('recognises the shape Prisma 7’s driver adapter actually produces', () => {
    /*
     * Not a hypothetical fourth shape — this is what PostgreSQL 17.6 and
     * Prisma 7.9.1 returned in `circuits.db.test.ts`. There is no
     * `meta.target` here at all, and the column names carry their SQL quotes.
     * A predicate written from the documentation returns false, the retry
     * never runs, and a lost race becomes a 500.
     */
    const error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: {
        modelName: 'CircuitVersion',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            kind: 'UniqueConstraintViolation',
            originalCode: '23505',
            originalMessage:
              'duplicate key value violates unique constraint ' +
              '"CircuitVersion_circuitId_versionNum_key"',
            constraint: { fields: ['"circuitId"', '"versionNum"'] },
          },
        },
      },
    })
    expect(isVersionNumberConflict(error)).toBe(true)
    expect(isSlugConflict(error)).toBe(false)
  })

  it('recognises a slug conflict', () => {
    const error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: 'Circuit_slug_key' },
    })
    expect(isSlugConflict(error)).toBe(true)
    expect(isVersionNumberConflict(error)).toBe(false)
  })

  it('claims nothing about an error that is not a unique violation', () => {
    // Retrying a connection failure as though it were a lost race would turn
    // one outage into five attempts at one.
    expect(isVersionNumberConflict(new Error('boom'))).toBe(false)
    expect(
      isVersionNumberConflict(Object.assign(new Error(), { code: 'P1001' }))
    ).toBe(false)
    expect(isVersionNumberConflict(null)).toBe(false)
    expect(isSlugConflict(undefined)).toBe(false)
  })

  it('claims nothing when the error does not say what was violated', () => {
    const error = Object.assign(new Error(), { code: 'P2002' })
    expect(isVersionNumberConflict(error)).toBe(false)
  })
})

describe('the domain errors carry a code the API can translate', () => {
  it('so that no English sentence has to reach a user', () => {
    // §11 and D2: the response says `VERSION_CONFLICT`, and apps/web says it
    // in Spanish, English or French. The message on these is for a terminal.
    expect(new VersionConflictError('cir_1', 5).code).toBe('VERSION_CONFLICT')
    expect(new SlugUnavailableError(5).code).toBe('SLUG_UNAVAILABLE')
    expect(new MissingVersionError('cir_1').code).toBe('MISSING_VERSION')
  })
})

describe('forking', () => {
  const source: CircuitDetail = {
    id: 'cir_source',
    ownerId: 'owner-uuid',
    slug: 'a-slug-of-twenty-one0',
    title: 'Bell pair',
    description: 'Two qubits, maximally entangled',
    visibility: Visibility.PUBLIC,
    qubitCount: 2,
    gateCount: 2,
    depth: 2,
    starCount: 12,
    viewCount: 300,
    forkedFromId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    owner: { id: 'owner-uuid', username: 'ada', avatarUrl: null },
    tags: ['bell', 'entanglement'],
    preview: previewOf(bell),
  }

  const latest: StoredVersion = {
    id: 'ver_4',
    versionNum: 4,
    message: 'final',
    createdAt: new Date('2026-02-01T00:00:00Z'),
    data: bell,
  }

  function stubRepository(version: StoredVersion | null) {
    const create = vi.fn(
      (_input: CreateCircuitInput): Promise<CircuitWithVersion> =>
        Promise.resolve({ circuit: source, version: latest })
    )
    const repository = {
      latestVersion: vi.fn(() => Promise.resolve(version)),
      create,
    } as unknown as CircuitRepository
    return { repository, create }
  }

  it('copies the current version into a circuit owned by the caller', async () => {
    const { repository, create } = stubRepository(latest)

    await forkCircuit(repository, { source, ownerId: 'forker-uuid' })

    expect(create).toHaveBeenCalledWith({
      ownerId: 'forker-uuid',
      title: 'Bell pair',
      description: 'Two qubits, maximally entangled',
      // A fork of a public circuit is not itself published: pressing "fork"
      // must not put an unfinished experiment in the gallery.
      visibility: Visibility.PRIVATE,
      data: bell,
      message: null,
      // The attribution the whole feature exists for.
      forkedFromId: 'cir_source',
      // Tags describe what the circuit *is*, and a fork is the same circuit
      // until its new owner changes it. Dropping them would file every fork
      // under nothing.
      tags: ['bell', 'entanglement'],
    })
  })

  it('takes a title from the caller when one is offered', async () => {
    const { repository, create } = stubRepository(latest)

    await forkCircuit(repository, {
      source,
      ownerId: 'forker-uuid',
      title: 'My take',
    })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My take' })
    )
  })

  it('does not carry the source’s stars or views across', async () => {
    // They belong to the original. A fork starts at zero, and the create
    // input has no field that could say otherwise.
    const { repository, create } = stubRepository(latest)

    await forkCircuit(repository, { source, ownerId: 'forker-uuid' })

    const input = create.mock.calls[0]?.[0]
    expect(input).not.toHaveProperty('starCount')
    expect(input).not.toHaveProperty('viewCount')
  })

  it('refuses a circuit with no version rather than inventing one', async () => {
    const { repository, create } = stubRepository(null)

    await expect(
      forkCircuit(repository, { source, ownerId: 'forker-uuid' })
    ).rejects.toBeInstanceOf(MissingVersionError)
    expect(create).not.toHaveBeenCalled()
  })
})
