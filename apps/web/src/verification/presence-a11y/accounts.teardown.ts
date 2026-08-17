/**
 * Removes everything this lens created, whether the scenarios passed or not.
 *
 * Declared as the setup project's `teardown` so Playwright runs it after a
 * failing run too — the database is the owner's only one, and a red run is
 * exactly when rows get left behind.
 *
 * `DELETE /api/v1/me` first and the Supabase user second: the API's half of an
 * identity can only be reached with a token the auth half issues, so deleting
 * the auth user first would strand a `public.User` row with no way left to
 * authenticate as its owner.
 */

import { expect, test as teardown } from '@playwright/test'

import { deleteAccount, liveEnv } from '../../../e2e/live/support/live'
import { forgetArtifacts, readIdentities } from './support'

teardown('both accounts and everything they own are gone', async () => {
  teardown.setTimeout(120_000)

  const env = liveEnv()
  const identities = readIdentities()

  const owner = await deleteAccount(env, identities.owner)
  const watcher = await deleteAccount(env, identities.watcher)

  /*
   * That the API answered with a report at all is what says the cascade ran; the
   * counts are logged rather than asserted, because a run that failed in its
   * setup created no circuit and a teardown that went red on *that* would be a
   * teardown reporting a leak it had just prevented.
   */
  // eslint-disable-next-line no-console -- what was destroyed, for the record
  console.log('deleted:', JSON.stringify({ owner, watcher }))
  expect(owner, 'the owner was not deleted').toBeTruthy()
  expect(watcher, 'the watcher was not deleted').toBeTruthy()

  forgetArtifacts()
})
