/**
 * The live stack, as a test may use it: two accounts, a saved circuit, and a
 * browser that is really signed in.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS SUITE EXISTS AT ALL, GIVEN `e2e/collaboration.spec.ts`
 *
 * That spec mocks the relay frame for frame, deliberately: what it proves is
 * that the page *mounts* a session and paints one, and it can prove that with
 * `pnpm exec vite` and nothing else. What a mock can never prove is the
 * property the whole CRDT design exists for — that **two browsers that edited
 * concurrently end up showing the same circuit** — because a mock has no second
 * peer, no merge, and no projection deciding which of two claims on one cell
 * wins. Neither can jsdom: `src/verification/convergence` drives the real bridge
 * against itself in one process, which proves the algebra and skips the socket,
 * the relay, the authorisation, the persistence and the two event loops.
 *
 * So this suite runs the real thing: Fastify on 8080 against the real Postgres,
 * Vite on 5173, and two or three Chromium contexts each holding a genuine
 * Supabase session. It is minutes rather than seconds, which is why it has a
 * config of its own — see `playwright.live.config.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DATABASE IS THE OWNER'S ONLY ONE, SO EVERY ROW HERE IS ACCOUNTED FOR
 *
 * Two rules, and the second is the one that is easy to get wrong.
 *
 *   1. **Everything this suite creates hangs off two accounts.** A circuit, its
 *      versions, its `CircuitSession`, its comments — every one of them cascades
 *      from `User` (see `schema.prisma`), and `DELETE /api/v1/me` is the
 *      product's own path for removing all of it in one transaction. The
 *      teardown project calls it for both accounts and asserts what came back.
 *   2. **The API's account is deleted BEFORE the Supabase user.** They are two
 *      systems holding two halves of one identity, and the API's half can only
 *      be reached with a token the auth half issues. Deleting the auth user
 *      first strands the `public.User` row with no way left to authenticate as
 *      its owner — which happened once while this file was being written, and
 *      had to be cleaned out with a hand-written `DELETE`.
 *
 * Nothing here writes to Redis, and nothing here goes near the `auth` schema
 * except through Supabase's own admin API.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE BROWSER SIGNS IN THROUGH THE FORM
 *
 * The obvious shortcut is to mint a token in Node and write it into
 * `localStorage` under `qsim.auth`. That would couple this suite to the exact
 * JSON shape `supabase-js` persists — an internal detail of a dependency, which
 * changes without our involvement, and whose drift would show up as "the whole
 * collaboration suite is red" rather than as "the storage format moved".
 *
 * Driving `/sign-in` once per identity and saving the resulting `storageState`
 * costs about two seconds in the setup project and produces, by construction,
 * exactly what the app itself writes. It also means this suite would notice a
 * sign-in path that stopped working.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Browser, type Page } from '@playwright/test'

/** Where the setup project leaves what the specs need. Gitignored. */
const ARTIFACT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.playwright/live'
)

const IDENTITIES_FILE = resolve(ARTIFACT_DIR, 'identities.json')

/**
 * Which run owns the artifact directory, so a second one cannot overwrite it.
 *
 * ── WHY THIS FILE EXISTS, WHICH IS ABOUT THE DATABASE AND NOT ABOUT TIDINESS ──
 *
 * The suite is not isolated and cannot cheaply be made so: the identities live at
 * one fixed path, `playwright.live.config.ts` binds 5173 and 8080 with
 * `reuseExistingServer`, and Vite runs with `--strictPort`. Two runs in one tree
 * therefore share everything, and what happened when two were started is the
 * expensive part: the second run's setup overwrote `identities.json` between the
 * first run's setup and its teardown, so the first run's teardown deleted the
 * *second* run's accounts, asserted its counts against them, reported
 * `ok [cleanup] the accounts and every row they own are gone`, and left its own
 * two users, five circuits and four `CircuitSession` rows in the owner's only
 * database. A silent teardown is how a shared database fills up, and this one was
 * worse than silent: it was green.
 *
 * The honest fix for a suite that cannot be isolated is to refuse the second run
 * rather than to let it corrupt the first. The lock records the Playwright
 * *runner's* pid — `process.ppid` from inside a worker, which is stable for the
 * whole invocation, where a worker's own pid is not — and a run whose holder is
 * still alive is refused with the reason. A lock left by a crash is taken over,
 * because the process is gone and a suite nobody can re-run is its own problem.
 */
const LOCK_FILE = resolve(ARTIFACT_DIR, 'run.lock')

interface RunLock {
  /** The Playwright runner process, which outlives every worker. */
  readonly runner: number
  readonly startedAt: string
}

function readLock(): RunLock | null {
  if (!existsSync(LOCK_FILE)) return null
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as RunLock
  } catch {
    // A half-written lock is not a lock. Treated as absent so a corrupt file
    // cannot block the suite forever.
    return null
  }
}

function alive(pid: number): boolean {
  try {
    // Signal 0 asks "does this process exist" and sends nothing, on Windows too.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Takes ownership of the artifact directory for this run, or refuses.
 *
 * Called by the `accounts` setup before it writes anything, which is the only
 * moment at which a second run can still be stopped without cost.
 */
export function claimRun(): void {
  const held = readLock()
  const runner = process.ppid
  if (held !== null && held.runner !== runner && alive(held.runner)) {
    throw new Error(
      `another live run (pid ${String(held.runner)}, started ${held.startedAt}) ` +
        'already owns this tree. This suite shares one identities file, one ' +
        'artifact directory and the fixed ports 5173 and 8080, so a second run ' +
        'would overwrite the first — and the first run’s teardown would then ' +
        'delete this run’s accounts and leave its own behind, in the owner’s ' +
        'only database. Wait for it to finish, or remove ' +
        `${LOCK_FILE} if you are certain it is dead.`
    )
  }
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(
    LOCK_FILE,
    `${JSON.stringify({ runner, startedAt: new Date().toISOString() }, null, 2)}\n`
  )
}

/**
 * Mirrors `LANGUAGE_STORAGE_KEY` in `src/i18n/index.ts`, for the reason
 * `support/editor.ts` restates it: importing that module pulls in
 * `import.meta.glob`, which exists only inside Vite.
 */
const LANGUAGE_STORAGE_KEY = 'qsim.language'

/** The two people in these scenarios, by the names the brief gives them. */
export type Who = 'ana' | 'beto'

export interface LiveAccount {
  /** The Supabase user id, which is also `public.User.id`. */
  readonly id: string
  readonly email: string
  readonly password: string
  /** What the relay puts in a presence frame — `displayName ?? username`. */
  readonly displayName: string
  /** Minted by `ensureUser`; the confirmation `DELETE /me` demands. */
  readonly username: string
  /** Where this identity's signed-in `localStorage` was saved. */
  readonly storageState: string
}

export interface LiveIdentities {
  readonly apiUrl: string
  readonly ana: LiveAccount
  readonly beto: LiveAccount
}

/**
 * The circuit a scenario runs on. One per test, created through the API by its
 * owner, because a document shared between tests is a document one test's gates
 * leak into the next through — and the relay keeps it alive for minutes after
 * the last peer leaves.
 */
export interface LiveCircuit {
  readonly id: string
  readonly slug: string
  readonly title: string
  /** `/c/<slug>`, the address a person types. */
  readonly path: string
}

/* ------------------------------------------------------------------ *
 * The environment
 * ------------------------------------------------------------------ */

export interface LiveEnv {
  readonly apiUrl: string
  readonly supabaseUrl: string
  readonly secretKey: string
  readonly publishableKey: string
}

/**
 * Reads what the live stack needs, or fails naming the variable.
 *
 * A throw and never a skip. A skipped suite is a green run that proved nothing,
 * and this is the suite whose whole purpose is to catch a feature that looks
 * finished; if it cannot run, the run has to say so out loud. The values come
 * from the repository's own `.env`, which `playwright.live.config.ts` loads.
 */
export function liveEnv(): LiveEnv {
  const supabaseUrl = required('SUPABASE_URL')
  return {
    // The same origin the browser bundle was compiled against, so the token a
    // page holds is accepted by the API this file talks to.
    apiUrl: stripTrailingSlash(
      process.env.VITE_API_URL ?? 'http://localhost:8080'
    ),
    supabaseUrl: stripTrailingSlash(supabaseUrl),
    // Never reaches a browser: it is the admin key, and it is used here for the
    // two calls only an administrator can make — create a user, delete a user.
    secretKey: required('SUPABASE_SECRET_KEY'),
    publishableKey: required('VITE_SUPABASE_PUBLISHABLE_KEY'),
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. The live collaboration suite drives the real API, ` +
        'the real database and the real auth project; copy .env.example to ' +
        '.env and fill it in, or run `pnpm --filter web test:e2e` for the ' +
        'suite that needs none of that.'
    )
  }
  return value
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

/**
 * A run's own suffix, so two runs — or a run and a leftover from a crashed one
 * — cannot collide on an email address or be mistaken for each other by
 * whoever later reads the table.
 */
export function runSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Creates one account, signs it in, and makes the API mint its row.
 *
 * The third step is not a formality. `public.User` is created by `ensureUser`
 * on the first *authenticated request*, and until it exists the relay has no
 * name to put in a presence frame — a peer would show up as "Someone" and the
 * roster assertion would be testing the anonymous path by accident. `GET
 * /api/v1/me` is the cheapest request that provokes it, and its answer carries
 * the username `DELETE /me` will ask for as confirmation.
 */
export async function mintAccount(
  env: LiveEnv,
  input: { readonly displayName: string; readonly handle: string }
): Promise<Omit<LiveAccount, 'storageState'>> {
  const email = `qsim-e2e-${input.handle}-${runSuffix()}@example.com`
  /*
   * A password nobody chose and nobody reuses. It is written into the
   * identities file so the setup project can sign the browser in, and that file
   * is gitignored and lives for the length of one run — after which the account
   * it opens no longer exists.
   */
  const password = `Qsim-e2e-${runSuffix()}-${Math.random().toString(36).slice(2, 10)}`

  const created = await postJson(
    `${env.supabaseUrl}/auth/v1/admin/users`,
    {
      email,
      password,
      // Confirmed on creation: this project keeps email confirmation on, and
      // there is no inbox here to open a link from.
      email_confirm: true,
      // What `ensureUser` reads for `displayName`, and therefore what the
      // relay composes into every presence frame this peer produces.
      user_metadata: { full_name: input.displayName },
    },
    { apikey: env.secretKey, authorization: `Bearer ${env.secretKey}` }
  )
  const id = asString(created, 'id')

  const account = await fetchJson(`${env.apiUrl}/api/v1/me`, {
    headers: {
      authorization: `Bearer ${await passwordToken(env, email, password)}`,
    },
  })
  const user = (account as { user?: { username?: unknown } }).user
  const username = typeof user?.username === 'string' ? user.username : ''
  expect(
    username,
    'ensureUser minted no username for a fresh account'
  ).not.toBe('')

  return { id, email, password, displayName: input.displayName, username }
}

/** An access token for an account, by password. Used by Node, never by a page. */
export async function passwordToken(
  env: LiveEnv,
  email: string,
  password: string
): Promise<string> {
  const session = await postJson(
    `${env.supabaseUrl}/auth/v1/token?grant_type=password`,
    { email, password },
    { apikey: env.publishableKey }
  )
  return asString(session, 'access_token')
}

/**
 * Removes an account from both systems, API first — see the header.
 *
 * Returns what the API says it destroyed, which the teardown asserts on: a
 * report of zero circuits after a run that created several would mean the
 * cascade did not reach them, and that is exactly the failure this suite must
 * not leave behind quietly.
 */
export async function deleteAccount(
  env: LiveEnv,
  account: LiveAccount
): Promise<Record<string, number>> {
  const token = await passwordToken(env, account.email, account.password)
  const report = await fetchJson(`${env.apiUrl}/api/v1/me`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    // The route compares this against the caller's own username rather than
    // trusting the client to decide what counts as confirming.
    body: JSON.stringify({ confirm: account.username }),
  })

  const response = await fetch(
    `${env.supabaseUrl}/auth/v1/admin/users/${account.id}`,
    {
      method: 'DELETE',
      headers: {
        apikey: env.secretKey,
        authorization: `Bearer ${env.secretKey}`,
      },
    }
  )
  expect(
    response.ok,
    `the Supabase user ${account.id} was not deleted (${response.status})`
  ).toBe(true)

  const deleted = (report as { deleted?: Record<string, number> }).deleted
  return deleted ?? {}
}

/* ------------------------------------------------------------------ *
 * Circuits
 * ------------------------------------------------------------------ */

/**
 * A saved circuit owned by `account`, UNLISTED.
 *
 * UNLISTED and not PUBLIC on purpose: this is the live gallery, and a suite
 * that ran twice an hour would fill the front page with `two-browser proof`
 * cards. UNLISTED is readable by whoever holds the slug, which is exactly the
 * access the second peer needs — §11 makes visibility irrelevant to *writing*,
 * so it changes nothing about what the relay grants.
 */
export async function createCircuit(
  env: LiveEnv,
  account: LiveAccount,
  title: string,
  qubits = 3
): Promise<LiveCircuit> {
  const token = await passwordToken(env, account.email, account.password)
  const body = await postJson(
    `${env.apiUrl}/api/v1/circuits`,
    {
      title,
      visibility: 'UNLISTED',
      circuit: { schemaVersion: 1, qubits, clbits: 0, operations: [] },
    },
    { authorization: `Bearer ${token}` }
  )
  const circuit = (body as { circuit?: Record<string, unknown> }).circuit ?? {}
  const slug = asString(circuit, 'slug')
  return {
    id: asString(circuit, 'id'),
    slug,
    title,
    // `/c/:slug`, spelled out rather than imported from `circuit-storage/paths`
    // for the reason `support/editor.ts` restates the storage key: this half
    // runs in Node, and the app's modules expect Vite.
    path: `/c/${slug}`,
  }
}

/* ------------------------------------------------------------------ *
 * Browsers
 * ------------------------------------------------------------------ */

/**
 * Signs one identity in through the app's own form and saves the result.
 *
 * Called by the setup project, once per account. The saved state is what every
 * context in every scenario boots from, so no test pays for a sign-in.
 */
export async function signInAndSaveState(
  browser: Browser,
  account: Omit<LiveAccount, 'storageState'>,
  file: string
): Promise<string> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await pinLanguage(page)
    await page.goto('/sign-in')
    await page.getByLabel('Email address').fill(account.email)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    /*
     * The account menu naming this user is the app's own statement that the
     * session took — not a URL change, which happens a beat earlier and would
     * let a state be saved before `supabase-js` had written it. It shows the
     * email rather than the username: the menu is drawn from the Supabase
     * session, which has no idea what handle `ensureUser` minted.
     */
    await expect(
      page.locator('.account-menu__name'),
      'the sign-in did not produce a session'
    ).toHaveText(account.email, { timeout: 30_000 })
    mkdirSync(dirname(file), { recursive: true })
    await context.storageState({ path: file })
    return file
  } finally {
    await context.close()
  }
}

/**
 * Pins the interface language, exactly as `support/editor.ts` does.
 *
 * Every assertion in this suite reads an English sentence, and i18next detects
 * from `navigator.language` when storage is empty — so on a machine set to
 * Spanish the whole suite would fail on the words rather than on the behaviour.
 */
export async function pinLanguage(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]: [string, string]) => {
      window.localStorage.setItem(key, value)
    },
    [LANGUAGE_STORAGE_KEY, 'en'] as [string, string]
  )
}

/* ------------------------------------------------------------------ *
 * The identities file
 * ------------------------------------------------------------------ */

export function writeIdentities(identities: LiveIdentities): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(IDENTITIES_FILE, `${JSON.stringify(identities, null, 2)}\n`)
}

export function readIdentities(): LiveIdentities {
  if (!existsSync(IDENTITIES_FILE)) {
    throw new Error(
      `no identities at ${IDENTITIES_FILE}. The live suite's accounts are ` +
        'created by the `accounts` setup project; run it through ' +
        '`pnpm --filter web test:e2e:live` rather than by pointing Playwright ' +
        'at the spec directly.'
    )
  }
  return JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as LiveIdentities
}

export function storageStateFile(who: Who): string {
  return resolve(ARTIFACT_DIR, `${who}.json`)
}

/**
 * Removes the run's artifacts, which is part of the cleanup rather than tidiness.
 *
 * They hold a password and two live session tokens. The accounts are gone by the
 * time this runs, so the file is inert — but a file of credentials left on disk
 * is a habit worth not having, and a *stale* one is actively confusing: a later
 * `--project=live` run would find identities for accounts that no longer exist
 * and fail on an authentication error instead of on the missing setup.
 */
export function forgetArtifacts(): void {
  rmSync(ARTIFACT_DIR, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * Small HTTP helpers
 * ------------------------------------------------------------------ */

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<unknown> {
  return fetchJson(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * A JSON request that fails loudly.
 *
 * The status and the first of the body go into the message on purpose: every
 * call here is against a service that answers a *code* when it refuses — §11's
 * error envelope, or Supabase's — and a bare "request failed" would send
 * whoever reads it to the network tab of a browser that is not running any
 * more.
 */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${url} answered ${response.status}: ${text.slice(0, 400)}`
    )
  }
  return text === '' ? {} : (JSON.parse(text) as unknown)
}

function asString(source: unknown, field: string): string {
  const value = (source as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `expected a ${field} in ${JSON.stringify(source).slice(0, 200)}`
    )
  }
  return value
}
