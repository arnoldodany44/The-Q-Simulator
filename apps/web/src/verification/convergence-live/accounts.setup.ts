/**
 * Two accounts of this suite's own, signed in, before any scenario runs.
 *
 * A setup *project* rather than a hook, for the reason `e2e/live` gives: it
 * needs a browser and a running Vite, and a project dependency is the only
 * arrangement Playwright guarantees runs after `webServer` is up.
 *
 * Both accounts are written to the identities file *before* either browser signs
 * in, so that a failing sign-in still leaves the teardown two accounts to
 * delete. Writing the file afterwards would turn that failure into two stranded
 * rows in the owner's only database.
 */

import { test as setup } from '@playwright/test'

import {
  liveEnv,
  mintAccount,
  signInAndSaveState,
} from '../../../e2e/live/support/live'
import { storageStateFile, writeIdentities } from './support'

setup(
  'two accounts of this suite exist and are signed in',
  async ({ browser }) => {
    // Two Supabase users, two `public.User` rows and two sign-ins: minutes in the
    // worst case, and nothing in the run may start until it is done.
    setup.setTimeout(180_000)

    const env = liveEnv()

    /*
     * Names of this suite's own, and not the brief's Ana and Beto: a concurrent
     * run of `e2e/live` is minting those, and a roster assertion that read
     * "Ana" could then be satisfied by somebody else's peer if the two suites
     * ever met in one circuit. `displayName` is what `ensureUser` stores and what
     * the relay composes into every presence frame this peer sends.
     */
    const owner = await mintAccount(env, {
      displayName: 'Cyra',
      handle: 'cyra',
    })
    const watcher = await mintAccount(env, {
      displayName: 'Dov',
      handle: 'dov',
    })

    const identities = {
      apiUrl: env.apiUrl,
      owner: { ...owner, storageState: storageStateFile('owner') },
      watcher: { ...watcher, storageState: storageStateFile('watcher') },
    }
    // Before the sign-ins — see the header.
    writeIdentities(identities)

    await signInAndSaveState(browser, owner, identities.owner.storageState)
    await signInAndSaveState(browser, watcher, identities.watcher.storageState)
  }
)
