/**
 * Building the real app for tests.
 *
 * The environment goes through `loadEnv` rather than being hand-written as
 * an `ApiEnv` literal, so every test also exercises the parser and a change
 * to the schema cannot pass here while failing at boot.
 *
 * Nothing reaches the network or the database: the JWKS endpoint is a
 * function over an in-memory key set, and the database probe is injected.
 * `DATABASE_URL` still has to be present and well-formed, because refusing
 * to start without it is the behaviour under test.
 */

import { buildApp } from '../app.js'
import type { BuildAppOptions } from '../app.js'
import { loadEnv } from '../env.js'
import type { ApiEnv, EnvSource } from '../env.js'
import { TEST_AUDIENCE, TEST_ISSUER, TEST_JWKS_URL } from './tokens.js'

export const TEST_WEB_ORIGIN = 'https://the-q-simulator.vercel.app'

/**
 * A syntactically valid AES-256 key for the environment parser.
 *
 * Thirty-two zero bytes, base64. Deliberately not random and deliberately not
 * a secret: nothing in the API suite seals anything with it — the hardware port
 * is injected, and `testing/hardware.ts` builds its own cipher over
 * `randomBytes`. What this exists for is `loadEnv`, which refuses a key that is
 * not canonical base64 of exactly 32 bytes, and which every test drives.
 */
export const TEST_ENCRYPTION_KEY =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

/** A complete, valid environment. Override one key to test one failure. */
export function testEnvSource(overrides: EnvSource = {}): EnvSource {
  return {
    NODE_ENV: 'test',
    PORT: '8080',
    WEB_URL: TEST_WEB_ORIGIN,
    // Never connected to: the database plugin is lazy and every test injects
    // a probe. It is here because a missing DATABASE_URL must fail the boot.
    DATABASE_URL: 'postgresql://postgres@localhost:5432/qsim_test',
    SUPABASE_URL: 'https://project-ref.supabase.co',
    SUPABASE_JWKS_URL: TEST_JWKS_URL,
    SUPABASE_JWT_AUDIENCE: TEST_AUDIENCE,
    ...overrides,
  }
}

export function testEnv(overrides: EnvSource = {}): ApiEnv {
  const env = loadEnv(testEnvSource(overrides))
  // The issuer is derived from SUPABASE_URL; this asserts the derivation
  // matches what the token fixtures sign, so a change to either is caught
  // here rather than as a puzzling 401 in an unrelated test.
  if (env.jwtIssuer !== TEST_ISSUER) {
    throw new Error(
      `Test issuer drift: env derived ${env.jwtIssuer}, fixtures sign ${TEST_ISSUER}`
    )
  }
  return env
}

export type TestAppOptions = Partial<BuildAppOptions> & {
  readonly envOverrides?: EnvSource
}

export async function createTestApp(options: TestAppOptions = {}) {
  return buildApp({
    env: options.env ?? testEnv(options.envOverrides),
    // Silent by default: a suite that prints a stack for every deliberate
    // 401 buries the one failure that matters.
    logger: options.logger ?? false,
    database: options.database ?? { probe: () => Promise.resolve() },
    ...(options.jwks === undefined ? {} : { jwks: options.jwks }),
    ...(options.circuits === undefined ? {} : { circuits: options.circuits }),
    /*
     * Absent by default, which leaves `app.apiKeys` reaching for `app.db` — a
     * client no test has, so a route or a hook that started resolving keys
     * without being asked fails loudly instead of silently answering 401. Only
     * the suites that are about keys inject one.
     */
    ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    /*
     * Deliberately not defaulted to a working queue. A test that does not say
     * what the queue is gets `app.simulations === null`, which is the
     * REDIS_URL-absent state — so the "server simulation is unavailable" path
     * is the one every unrelated suite exercises by accident, and a route that
     * started reaching for Redis without being asked would fail immediately.
     */
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    /*
     * Defaulted to absent for the same reason the queue is: a test that does
     * not say what the event bus is gets `app.runEvents === null`, which is the
     * REDIS_URL-absent state — so a socket that started reaching for Redis
     * without being asked would answer SIMULATION_UNAVAILABLE in every
     * unrelated suite rather than opening a connection.
     */
    ...(options.events === undefined ? {} : { events: options.events }),
    /*
     * Absent by default, for the third time and the same reason: a test that
     * does not say what the hardware port is gets `app.hardware === null`,
     * which is the ENCRYPTION_KEY-absent state. §11 has no weaker mode, so the
     * default in a test harness must be the one where nothing can be sealed.
     */
    ...(options.hardware === undefined ? {} : { hardware: options.hardware }),
    ...(options.hardwareQueue === undefined
      ? {}
      : { hardwareQueue: options.hardwareQueue }),
    /*
     * The collaboration relay (M5.2) is **on** by default, which is the one
     * default here that is not "absent", and the reason is that it needs no
     * external dependency: it holds a Y.Doc in memory and reads the circuit
     * repository. `app.collab` therefore behaves in a test exactly as it does on
     * Railway with no REDIS_URL — single-instance, no bus — and a suite that
     * wants it off says so, rather than every suite accidentally exercising the
     * switched-off path the way they do for Redis.
     */
    ...(options.collab === undefined ? {} : { collab: options.collab }),
  })
}
