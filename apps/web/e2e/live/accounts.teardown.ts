/**
 * Everything this suite created, removed — including on a failing run.
 *
 * A `teardown` project runs after the project that depends on the setup,
 * whatever the scenarios did: passed, failed, or timed out. That is why the
 * cleanup lives here rather than in an `afterAll`, which a crashed worker skips.
 *
 * ── What it deletes, and what it proves ──────────────────────────────────
 *
 * `DELETE /api/v1/me` is the product's own account deletion: one transaction
 * that removes the `User` row and everything that cascades from it — every
 * circuit, every version, every `CircuitSession` the relay persisted, every
 * comment (§7's schema, and `packages/db/src/accounts.ts` for the rows no
 * foreign key would have reached). It answers with counts, and those counts are
 * asserted rather than logged: a run that created five circuits and reports
 * `circuits: 0` deleted nothing, and a silent teardown is how a shared database
 * fills up.
 *
 * The Supabase user is deleted second and never first. The API's half of an
 * identity can only be reached with a token the auth half issues, so deleting
 * the auth user first would strand a `public.User` row that nothing in the
 * product can then remove.
 */

import { expect, test as teardown } from '@playwright/test'

import {
  deleteAccount,
  forgetArtifacts,
  liveEnv,
  readIdentities,
} from './support/live'

teardown('the accounts and every row they own are gone', async () => {
  teardown.setTimeout(180_000)

  const env = liveEnv()
  const identities = readIdentities()

  const ana = await deleteAccount(env, identities.ana)
  const beto = await deleteAccount(env, identities.beto)
  // The passwords and the saved sessions go with the accounts they opened.
  forgetArtifacts()

  /*
   * Ana owns every circuit in this suite, so her report is the one that has to
   * be non-trivial. Beto's is expected to be all zeros — he watches, and §11
   * gives him nothing to own — which is itself worth asserting: a non-zero
   * count there would mean a scenario had written something under the wrong
   * identity.
   */
  expect(
    ana.circuits,
    'Ana owned no circuits at teardown, so this run created none and proved nothing'
  ).toBeGreaterThan(0)
  expect(beto.circuits, 'the watcher came to own a circuit').toBe(0)
})
