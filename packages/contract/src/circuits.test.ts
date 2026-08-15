import { emptyCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  CreateCircuitBody,
  ForkCircuitBody,
  MAX_PAGE,
  PaginationQuery,
  UpdateCircuitBody,
  serverCircuitResponses,
  wireCircuitResponses,
} from './circuits.js'
import { Visibility } from './visibility.js'

/**
 * The assertions this package exists for.
 *
 * The first group is the round trip: take what a handler returns, serialise
 * it exactly as Fastify does, and parse it exactly as the browser does. If
 * the two instantiations ever describe different documents — a field added to
 * one, a type changed in one — this fails, which is the guarantee that
 * replaces "remember to update the client".
 */

const CREATED = new Date('2024-05-01T10:00:00.000Z')
const UPDATED = new Date('2024-05-02T11:30:45.123Z')

const owner = { id: 'usr_1', username: 'ada', avatarUrl: null }

const card = {
  id: 'cir_1',
  slug: 'V1StGXR8Z5jdHi6BmyT8a',
  title: 'Bell pair',
  visibility: Visibility.PUBLIC,
  qubitCount: 2,
  gateCount: 2,
  depth: 2,
  starCount: 0,
  viewCount: 0,
  createdAt: CREATED,
  updatedAt: UPDATED,
  owner,
}

const detail = { ...card, description: null }

const version = {
  id: 'ver_1',
  versionNum: 1,
  message: null,
  createdAt: CREATED,
  circuit: emptyCircuit(2),
}

/** What Fastify's serialiser does: parse through the schema, then stringify. */
function throughTheWire<T extends z.ZodType>(
  schema: T,
  value: unknown
): unknown {
  return JSON.parse(JSON.stringify(schema.parse(value)))
}

describe('server and wire response schemas', () => {
  it('round-trips a circuit card without losing or changing a field', () => {
    const sent = throughTheWire(
      serverCircuitResponses.CircuitCardResponse,
      card
    )
    const received = wireCircuitResponses.CircuitCardResponse.parse(sent)

    expect(received).toEqual(card)
  })

  it('round-trips a circuit with its version', () => {
    const payload = { circuit: detail, version }
    const sent = throughTheWire(
      serverCircuitResponses.CircuitWithVersionResponse,
      payload
    )
    const received = wireCircuitResponses.CircuitWithVersionResponse.parse(sent)

    expect(received).toEqual(payload)
    // The circuit document survives as a document, not as a blob of JSON.
    expect(received.version.circuit.operations).toEqual([])
  })

  it('drops a forkedFromId the repository row still carries', () => {
    /*
     * The row has the column and the response must not have the field: it is
     * a handle to a different circuit with a different visibility, and a
     * PUBLIC fork used to hand every anonymous reader a working handle to the
     * UNLISTED circuit it came from. Serialising *through* the schema is what
     * makes that structural rather than remembered, so this asserts the
     * serialiser actually strips it rather than trusting that no projection
     * ever selects it.
     */
    const fromTheDatabase = { ...card, forkedFromId: 'cir_the_source' }
    const sent = throughTheWire(
      serverCircuitResponses.CircuitCardResponse,
      fromTheDatabase
    )

    expect(sent).not.toHaveProperty('forkedFromId')
    expect(JSON.stringify(sent)).not.toContain('cir_the_source')
  })

  it('round-trips a page of cards', () => {
    const page = {
      items: [card],
      page: 1,
      perPage: 20,
      total: 1,
      totalPages: 1,
    }
    const sent = throughTheWire(
      serverCircuitResponses.CircuitPageResponse,
      page
    )

    expect(wireCircuitResponses.CircuitPageResponse.parse(sent)).toEqual(page)
  })

  /*
   * The structural half of the same guarantee: the round trip above proves
   * the fields that exist agree, and this proves neither instance has a field
   * the other lacks. A field added to `buildCircuitResponses` reaches both by
   * construction — this is what catches somebody "fixing" that by editing one
   * instance after the fact.
   */
  it.each([
    'CircuitCardResponse',
    'CircuitDetailResponse',
    'VersionSummaryResponse',
    'VersionResponse',
  ] as const)('declares the same field set on both ends of %s', (name) => {
    const server = serverCircuitResponses[name] as z.ZodObject
    const wire = wireCircuitResponses[name] as z.ZodObject

    expect(Object.keys(wire.shape).sort()).toEqual(
      Object.keys(server.shape).sort()
    )
  })

  it('rejects a timestamp that is not ISO-8601', () => {
    const broken = { ...card, createdAt: 'tomorrow' }

    expect(
      wireCircuitResponses.CircuitCardResponse.safeParse(broken).success
    ).toBe(false)
  })

  /*
   * The leak defence. `circuitDetailSelect` fetches `ownerId` because
   * authorisation needs it; no response schema mentions it, so serialising
   * through the schema is what stops it reaching a browser.
   */
  it('drops a field the response schema does not declare', () => {
    const withOwnerId = { ...detail, ownerId: 'usr_1' }
    const sent = throughTheWire(
      serverCircuitResponses.CircuitDetailResponse,
      withOwnerId
    )

    expect(sent).not.toHaveProperty('ownerId')
  })
})

describe('request bodies', () => {
  it('defaults a new circuit to PRIVATE', () => {
    const parsed = CreateCircuitBody.parse({
      title: 'Bell pair',
      circuit: emptyCircuit(2),
    })

    expect(parsed.visibility).toBe(Visibility.PRIVATE)
  })

  it('trims a title and rejects one that is only whitespace', () => {
    expect(
      CreateCircuitBody.parse({
        title: '  Bell pair  ',
        circuit: emptyCircuit(2),
      }).title
    ).toBe('Bell pair')

    expect(
      CreateCircuitBody.safeParse({ title: '   ', circuit: emptyCircuit(2) })
        .success
    ).toBe(false)
  })

  it('refuses a metadata patch with nothing in it', () => {
    expect(UpdateCircuitBody.safeParse({}).success).toBe(false)
    expect(UpdateCircuitBody.safeParse({ title: 'Renamed' }).success).toBe(true)
  })

  it('accepts a fork with no body at all', () => {
    // Fastify hands the validator `null`, never `undefined`.
    expect(ForkCircuitBody.parse(null)).toBeNull()
  })

  it('coerces pagination out of a query string and applies defaults', () => {
    expect(PaginationQuery.parse({ page: '3' })).toEqual({
      page: 3,
      perPage: 20,
    })
    expect(PaginationQuery.safeParse({ page: '0' }).success).toBe(false)
    expect(PaginationQuery.safeParse({ perPage: '101' }).success).toBe(false)
  })

  it('reads a page number as decimal digits and nothing else', () => {
    /*
     * `z.coerce.number()` delegates to `Number()`, whose grammar is the whole
     * of JavaScript's numeric literal syntax plus surrounding whitespace. None
     * of these is a page number a person typed into a URL bar.
     */
    for (const page of ['0x10', ' 5 ', '1e15', '0b11', '0o17', '+3', '3.0']) {
      expect(PaginationQuery.safeParse({ page }).success, page).toBe(false)
    }
    expect(PaginationQuery.parse({ page: '16' }).page).toBe(16)
  })

  it('bounds the page number, the way the version number already was', () => {
    // Unbounded, `page` becomes an unbounded OFFSET: page=1e15 produced a
    // skip of 19,999,999,999,999,980.
    expect(PaginationQuery.parse({ page: String(MAX_PAGE) }).page).toBe(
      MAX_PAGE
    )
    expect(
      PaginationQuery.safeParse({ page: String(MAX_PAGE + 1) }).success
    ).toBe(false)
  })

  it('refuses a NUL in any string PostgreSQL will have to store', () => {
    /*
     * `Circuit.title` is `text` and `CircuitVersion.data` is `jsonb`; both
     * refuse U+0000, and the refusal arrives as a driver error that used to
     * become a 500. One character, typed by anyone.
     */
    const NUL = String.fromCharCode(0)
    const circuit = emptyCircuit(2)

    expect(
      CreateCircuitBody.safeParse({ title: `probe${NUL}nul`, circuit }).success
    ).toBe(false)
    expect(
      CreateCircuitBody.safeParse({
        title: 'ok',
        description: `d${NUL}d`,
        circuit,
      }).success
    ).toBe(false)
    expect(
      CreateCircuitBody.safeParse({ title: 'ok', message: `m${NUL}m`, circuit })
        .success
    ).toBe(false)

    // A description keeps its paragraphs: prose is the one field where a line
    // break means something.
    expect(
      CreateCircuitBody.safeParse({
        title: 'ok',
        description: 'first line\nsecond line',
        circuit,
      }).success
    ).toBe(true)
  })

  it('refuses a lone surrogate rather than storing U+FFFD instead', () => {
    // Accepted, this is silent corruption: Node encodes it lossily on the way
    // to the wire, so the title that comes back is not the one that went in.
    expect(
      CreateCircuitBody.safeParse({
        title: `broken${String.fromCharCode(0xd800)}`,
        circuit: emptyCircuit(2),
      }).success
    ).toBe(false)
  })
})
