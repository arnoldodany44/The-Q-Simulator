/**
 * Two accounts, signed in, before any scenario runs.
 *
 * A setup *project* rather than a `globalSetup` hook, for one reason that
 * matters: this file needs a browser and a running Vite, and a project
 * dependency is the only arrangement Playwright guarantees runs after
 * `webServer` is up and with the full fixture set available. `playwright.live
 * .config.ts` names it as the dependency of the scenarios and pairs it with the
 * teardown that removes what it creates.
 *
 * ── The order below is the recovery plan ──────────────────────────────────
 *
 * Both accounts are minted and written to the identities file *before* either
 * browser signs in. If a sign-in then fails — a broken form, an auth outage —
 * the teardown project still finds two accounts to delete, and the run leaves
 * nothing behind in the owner's only database. Writing the file after the
 * sign-ins would make a failure there a leak.
 */

import { test as setup } from '@playwright/test'

import {
  claimRun,
  liveEnv,
  mintAccount,
  signInAndSaveState,
  storageStateFile,
  writeIdentities,
  type LiveAccount,
} from './support/live'

setup('two accounts exist and are signed in', async ({ browser }) => {
  // Two Supabase users, two `public.User` rows, two browsers: minutes of
  // network in the worst case, and nothing else in the run may start until it
  // is done.
  setup.setTimeout(180_000)

  /*
   * Before anything is created, because this is the last moment at which a second
   * concurrent run can be stopped for free. The suite shares one identities file
   * and the fixed ports 5173 and 8080, so two runs in one tree end with one
   * teardown deleting the other run's accounts and reporting success — see
   * `claimRun`.
   */
  claimRun()

  const env = liveEnv()

  /*
   * `Ana` and `Beto` are the names the acceptance brief gives the two peers, and
   * they are the names the relay will compose into presence frames —
   * `readViewerName` resolves `displayName ?? username`, and `displayName` is
   * what `user_metadata.full_name` becomes. The roster assertions read them, so
   * they are the one piece of these fixtures that is not arbitrary.
   */
  const ana = await mintAccount(env, { displayName: 'Ana', handle: 'ana' })
  const beto = await mintAccount(env, { displayName: 'Beto', handle: 'beto' })

  const identities = {
    apiUrl: env.apiUrl,
    ana: {
      ...ana,
      storageState: storageStateFile('ana'),
    } satisfies LiveAccount,
    beto: {
      ...beto,
      storageState: storageStateFile('beto'),
    } satisfies LiveAccount,
  }
  // Before the sign-ins — see the header.
  writeIdentities(identities)

  await signInAndSaveState(browser, ana, identities.ana.storageState)
  await signInAndSaveState(browser, beto, identities.beto.storageState)
})
