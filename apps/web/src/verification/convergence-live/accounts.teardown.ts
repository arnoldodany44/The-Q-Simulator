/**
 * Both accounts removed, and with them everything this suite created.
 *
 * Declared as the scenarios' `teardown`, so Playwright runs it whether they
 * passed or not — a failing run is exactly when rows get left behind, and this
 * database is the owner's only one.
 *
 * Every circuit, version, `CircuitSession` row and comment created here hangs
 * off one of these two users and cascades from `User` (`schema.prisma`), so
 * `DELETE /api/v1/me` is the whole cleanup. It runs *before* the Supabase user
 * is deleted, because it needs a token that half issues.
 */

import { expect, test as teardown } from '@playwright/test'

import { deleteAccount, liveEnv } from '../../../e2e/live/support/live'
import { forgetArtifacts, readIdentities } from './support'

teardown('both accounts and everything they own are gone', async () => {
  teardown.setTimeout(120_000)

  const env = liveEnv()
  const identities = readIdentities()

  /*
   * Both, and the second even if the first throws. A `Promise.all` would be
   * wrong here for the reason the ordering above is: one failure must not stop
   * the other account from being removed.
   */
  const results = await Promise.allSettled([
    deleteAccount(env, identities.owner),
    deleteAccount(env, identities.watcher),
  ])

  forgetArtifacts()

  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => String(result.reason))
  expect(
    failures,
    'an account this suite created could not be deleted, so rows are left in ' +
      'the shared database and must be removed by hand'
  ).toEqual([])
})
