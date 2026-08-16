import { emptyCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  AddCollectionItemBody,
  CreateCollectionBody,
  UpdateCollectionBody,
  serverCollectionResponses,
  wireCollectionResponses,
} from './collections.js'
import {
  DeleteAccountBody,
  UpdateProfileBody,
  serverUserResponses,
  wireUserResponses,
} from './users.js'
import { Visibility } from './visibility.js'

/**
 * The M1.9 shapes, held to the same two standards as the circuit ones.
 *
 * The round trip — serialise the way Fastify does, parse the way the browser
 * does — is what replaces "remember to update the client" when a field moves.
 * Beyond that, three assertions here are about *what may not travel*, and each
 * one is a hole this milestone could have shipped:
 *
 *   - a settings body may not carry an avatar URL, because a URL from a
 *     request body is fetched by every stranger who opens that profile;
 *   - `GET /me` may not carry an email, because there is one user projection
 *     in this system and it has none;
 *   - a collection view carries a *count* of what was withheld and never a
 *     handle to any of it.
 */

const CREATED = new Date('2024-05-01T10:00:00.000Z')
const UPDATED = new Date('2024-05-02T11:30:45.123Z')

const owner = { id: 'usr_1', username: 'ada', avatarUrl: null }

const user = {
  id: 'usr_1',
  username: 'ada',
  displayName: 'Ada',
  avatarUrl: null,
  createdAt: CREATED,
}

const collection = {
  id: 'col_1',
  title: 'Oracle algorithms',
  description: null,
  visibility: Visibility.PUBLIC,
  itemCount: 3,
  createdAt: CREATED,
  updatedAt: UPDATED,
  owner,
}

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
  tags: [],
  preview: null,
}

/** What Fastify's serialiser does: parse through the schema, then stringify. */
function throughTheWire<T extends z.ZodType>(
  schema: T,
  value: unknown
): unknown {
  return JSON.parse(JSON.stringify(schema.parse(value)))
}

describe('collection responses', () => {
  it('round-trips a collection card', () => {
    const sent = throughTheWire(
      serverCollectionResponses.CollectionCardResponse,
      collection
    )
    const received = wireCollectionResponses.CollectionCardResponse.parse(sent)

    expect(received).toEqual(collection)
  })

  it('round-trips a collection view, withheld count and all', () => {
    const payload = {
      collection,
      items: [card],
      withheldItemCount: 2,
      starred: ['cir_1'],
    }
    const sent = throughTheWire(
      serverCollectionResponses.CollectionViewResponse,
      payload
    )
    const received = wireCollectionResponses.CollectionViewResponse.parse(sent)

    expect(received).toEqual(payload)
  })

  it('reports what was withheld as a number and never as a handle', () => {
    /*
     * The whole trade this response shape makes. A viewer is told that
     * something is in the collection they may not see, and is told nothing at
     * all about what: the schema has no field a title, slug or id could ride
     * in, so a handler holding the withheld rows still cannot send them.
     */
    const sent = throughTheWire(
      serverCollectionResponses.CollectionViewResponse,
      {
        collection,
        items: [],
        withheldItemCount: 3,
        starred: [],
        // A handler that tried to be helpful. The serialiser drops it.
        withheldItems: [{ id: 'cir_secret', title: 'Confidential' }],
      }
    )

    expect(sent).not.toHaveProperty('withheldItems')
    expect(JSON.stringify(sent)).not.toContain('Confidential')
  })
})

describe('collection request bodies', () => {
  it('defaults a new collection to PRIVATE', () => {
    // The safe default is the one that publishes nothing when a client forgets
    // to say — the same rule `CreateCircuitBody` follows.
    const parsed = CreateCollectionBody.parse({ title: 'Oracle algorithms' })
    expect(parsed.visibility).toBe(Visibility.PRIVATE)
  })

  it('rejects a title that is only whitespace', () => {
    expect(CreateCollectionBody.safeParse({ title: '   ' }).success).toBe(false)
  })

  it('refuses a patch with nothing in it', () => {
    expect(UpdateCollectionBody.safeParse({}).success).toBe(false)
  })

  it('takes a circuit as a handle rather than an id', () => {
    // A slug reaches an UNLISTED circuit and an id does not, which is the
    // case where somebody collects something they hold a link to.
    const parsed = AddCollectionItemBody.parse({ circuit: 'V1StGXR8Z5jdHi' })
    expect(parsed.circuit).toBe('V1StGXR8Z5jdHi')
  })
})

describe('account responses', () => {
  it('round-trips the caller’s own row', () => {
    const sent = throughTheWire(serverUserResponses.AccountResponse, { user })
    const received = wireUserResponses.AccountResponse.parse(sent)

    expect(received).toEqual({ user })
  })

  it('never lets an email reach GET /me either', () => {
    /*
     * There is one user projection in this system and it has no `email`. That
     * is why `GET /me` uses it too: the caller already knows their own address
     * — it is a claim in the token they authenticated with — and a second
     * projection would be one a future handler could reach for by mistake.
     */
    const sent = throughTheWire(serverUserResponses.AccountResponse, {
      user: { ...user, email: 'ada@example.com' },
    })

    expect(JSON.stringify(sent)).not.toContain('ada@example.com')
  })

  it('round-trips a profile with its two counts', () => {
    const payload = { user, circuitCount: 4, collectionCount: 1 }
    const sent = throughTheWire(serverUserResponses.ProfileResponse, payload)

    expect(wireUserResponses.ProfileResponse.parse(sent)).toEqual(payload)
  })
})

describe('account request bodies', () => {
  it('has no field an avatar URL could ride in', () => {
    /*
     * The hole this shape exists to close. A URL accepted from a request body
     * is rendered by every stranger who opens that profile, which makes it a
     * way to log who looked — and one component away from being a stored XSS.
     * The caller picks a *source*; the server reads the value off the verified
     * token.
     */
    const parsed = UpdateProfileBody.parse({
      avatar: 'provider',
      avatarUrl: 'https://evil.example/track.png',
    })

    expect(parsed).toEqual({ avatar: 'provider' })
    expect(parsed).not.toHaveProperty('avatarUrl')
  })

  it('refuses a settings patch with nothing in it', () => {
    expect(UpdateProfileBody.safeParse({}).success).toBe(false)
  })

  it('accepts only a username that could appear in a URL', () => {
    expect(UpdateProfileBody.safeParse({ username: 'ada-7fk2' }).success).toBe(
      true
    )
    for (const handle of ['Ada', 'ad', 'ada lovelace', 'x'.repeat(33)]) {
      expect(
        UpdateProfileBody.safeParse({ username: handle }).success,
        handle
      ).toBe(false)
    }
  })

  it('clears a display name with null and leaves it alone when absent', () => {
    /*
     * Two different requests. `null` means "remove the name I had", which is a
     * thing a person asks for; an absent field means "do not touch it", and
     * over the wire that is what an absent field literally is — `JSON.stringify`
     * drops an `undefined` value, so a body can never arrive carrying the key
     * with nothing in it.
     */
    expect(UpdateProfileBody.parse({ displayName: null })).toEqual({
      displayName: null,
    })
    expect(
      UpdateProfileBody.parse(
        JSON.parse(JSON.stringify({ displayName: undefined, username: 'ada' }))
      )
    ).toEqual({ username: 'ada' })
  })

  it('requires a confirmation to delete an account', () => {
    expect(DeleteAccountBody.safeParse({}).success).toBe(false)
    expect(DeleteAccountBody.parse({ confirm: 'ada' }).confirm).toBe('ada')
  })
})

describe('the circuit document is untouched by any of this', () => {
  it('still parses inside a collection’s cards', () => {
    // A guard against the cards in a collection quietly becoming a different
    // shape from the cards in the gallery: they are the same schema instance.
    const sent = throughTheWire(
      serverCollectionResponses.CollectionViewResponse,
      { collection, items: [card], withheldItemCount: 0, starred: [] }
    )
    const received = wireCollectionResponses.CollectionViewResponse.parse(sent)

    expect(received.items[0]?.slug).toBe(card.slug)
    expect(emptyCircuit(2).qubits).toBe(2)
  })
})
