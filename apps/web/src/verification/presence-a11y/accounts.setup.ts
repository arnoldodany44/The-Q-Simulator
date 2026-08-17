/**
 * Two accounts, signed in, before any scenario of this lens runs.
 *
 * A setup *project* rather than a `globalSetup` hook, for the reason
 * `e2e/live/accounts.setup.ts` gives: this needs a browser and a running Vite,
 * and a project dependency is the only arrangement Playwright guarantees runs
 * after `webServer` is up.
 *
 * Both accounts are written to the identities file *before* either browser signs
 * in, so a failed sign-in still leaves the teardown two accounts to delete. The
 * database is the owner's only one and a failing run is exactly when rows get
 * left behind.
 */

import { test as setup } from '@playwright/test'

import {
  liveEnv,
  mintAccount,
  signInAndSaveState,
  type LiveAccount,
} from '../../../e2e/live/support/live'
import { storageStateFile, writeIdentities } from './support'

setup('two accounts exist and are signed in', async ({ browser }) => {
  setup.setTimeout(180_000)

  const env = liveEnv()

  /*
   * The display names are the only part of these fixtures that is not
   * arbitrary: the relay composes `displayName ?? username` into every presence
   * frame, so these are the words the roster and the live region will read.
   * `Ana` and `Beto` are the names §3.4's scenarios use.
   */
  const owner = await mintAccount(env, {
    displayName: 'Ana',
    handle: 'pa11y-ana',
  })
  const watcher = await mintAccount(env, {
    displayName: 'Beto',
    handle: 'pa11y-beto',
  })

  const identities = {
    apiUrl: env.apiUrl,
    owner: {
      ...owner,
      storageState: storageStateFile('owner'),
    } satisfies LiveAccount,
    watcher: {
      ...watcher,
      storageState: storageStateFile('watcher'),
    } satisfies LiveAccount,
  }
  writeIdentities(identities)

  await signInAndSaveState(browser, owner, identities.owner.storageState)
  await signInAndSaveState(browser, watcher, identities.watcher.storageState)
})
