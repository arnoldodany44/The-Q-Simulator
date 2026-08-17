/**
 * The circuits and identities every file in this lens needs.
 *
 * Separate from the tests so that importing them does not re-register another
 * file's suite, and so that the three visibilities exist in one place: most of
 * the questions here are "which of these three does this frame reach".
 */

import { emptyCircuit, type Circuit } from '@qsim/schema'
import type { Relay } from './harness.js'

export const OWNER = '11111111-1111-4111-8111-111111111111'
export const STRANGER = '22222222-2222-4222-8222-222222222222'

export const base = emptyCircuit(2)

/** One legal gate, appended. `column` is what makes a collision constructible. */
export function withGate(id: string, column = 0) {
  return (circuit: Circuit): Circuit => ({
    ...circuit,
    operations: [
      ...circuit.operations,
      { id, gate: 'h', targets: [0], column },
    ],
  })
}

export interface SeededCircuits {
  readonly private: { readonly id: string; readonly slug: string }
  readonly unlisted: { readonly id: string; readonly slug: string }
  readonly public: { readonly id: string; readonly slug: string }
}

export async function seed(relay: Relay): Promise<SeededCircuits> {
  relay.repository.addUser({
    id: OWNER,
    username: 'ada',
    displayName: 'Ada Lovelace',
  })
  relay.repository.addUser({ id: STRANGER, username: 'grace' })
  const make = async (visibility: 'PRIVATE' | 'UNLISTED' | 'PUBLIC') => {
    const created = await relay.repository.create({
      ownerId: OWNER,
      title: visibility,
      description: null,
      visibility,
      data: base,
      message: null,
      forkedFromId: null,
    })
    return { id: created.circuit.id, slug: created.circuit.slug }
  }
  return {
    private: await make('PRIVATE'),
    unlisted: await make('UNLISTED'),
    public: await make('PUBLIC'),
  }
}

/**
 * A circuit's row, for the changes a route cannot make.
 *
 * `allCircuits` hands back the live row objects, which is how a transfer of
 * ownership — the one revocation with no endpoint behind it — is simulated
 * without touching the owner's database.
 */
export function row(relay: Relay, circuitId: string) {
  const found = relay.repository
    .allCircuits()
    .find((candidate) => candidate.id === circuitId)
  if (found === undefined) throw new Error('no such circuit')
  return found
}
