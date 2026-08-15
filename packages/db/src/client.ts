import process from 'node:process'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.js'

/**
 * The one PrismaClient this process is allowed to have.
 *
 * Why a singleton is not optional here: `DATABASE_URL` points at Supabase's
 * shared transaction pooler with `connection_limit=1`. Every PrismaClient
 * owns its own `pg` pool, so a second client is a second connection against
 * a budget of one — and the failure mode is not an error, it is a query that
 * waits for a connection that is never coming back. That is the shape of bug
 * people spend an afternoon on.
 *
 * A module-level `const` would not be enough. Under a watcher (tsx --watch,
 * vitest, a Vite SSR graph) a module is re-evaluated on every reload, and
 * each evaluation would build another pool while the previous one still
 * holds its connection. So the instance is parked on `globalThis` under a
 * registered symbol, which survives module re-evaluation because the module
 * registry is what gets discarded, not the global object.
 *
 * The cache is unconditional rather than dev-only, which is the opposite of
 * the pattern usually copied from Next.js examples. That pattern exists to
 * avoid leaking clients across serverless invocations; this API is a
 * long-lived Node process on Railway, where the real risk runs the other
 * way — a dual ESM/CJS resolution, or two bundles of this package in one
 * process, would otherwise open two pools in production and nothing would
 * report it.
 */
const CLIENT_KEY = Symbol.for('@qsim/db.prisma-client')

interface ClientRegistry {
  [CLIENT_KEY]?: PrismaClient
}

/**
 * Pool size, read from the connection string rather than hardcoded.
 *
 * `connection_limit` is a Prisma query-string parameter, not a PostgreSQL
 * one. Prisma 6 parsed it inside the Rust engine; Prisma 7 hands the URL to
 * a driver adapter that has never heard of it, so `pg` would silently use
 * its own default of 10 and quietly exceed the pooler budget the URL was
 * written to declare. Reading it here keeps the URL the single source of
 * truth, which is where an operator will look.
 *
 * Returns `undefined` when the parameter is absent or unusable, leaving the
 * driver's default in place — a missing hint must not become a hard failure
 * on a connection string that is otherwise fine.
 */
export function poolSizeFromConnectionString(
  connectionString: string
): number | undefined {
  let raw: string | null
  try {
    raw = new URL(connectionString).searchParams.get('connection_limit')
  } catch {
    // Not a URL we can parse. Never re-throw and never log: this string is
    // a credential.
    return undefined
  }
  if (raw === null) return undefined

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return undefined
  return parsed
}

/**
 * Builds a client without consulting or populating the singleton. Exported
 * for the rare caller that genuinely needs a second connection — a migration
 * script, a one-off maintenance task — and which is then responsible for
 * disconnecting it. Application code wants `getPrismaClient`.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const max = poolSizeFromConnectionString(connectionString)
  const adapter = new PrismaPg({
    connectionString,
    ...(max === undefined ? {} : { max }),
  })
  return new PrismaClient({ adapter })
}

/**
 * The process-wide client. Constructed on first call, so importing this
 * module costs nothing and needs no environment — which is what lets the
 * tests around it run with no database in reach.
 *
 * @throws if `DATABASE_URL` is unset. Deliberately at first use rather than
 * at import: a missing database URL should fail the request that needed a
 * database, not the module graph of a process that might not.
 */
export function getPrismaClient(): PrismaClient {
  const registry = globalThis as unknown as ClientRegistry
  const existing = registry[CLIENT_KEY]
  if (existing !== undefined) return existing

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. It is the Supabase transaction pooler URL ' +
        '(port 6543, with ?pgbouncer=true&connection_limit=1); DIRECT_URL is ' +
        'for migrations only and must not be substituted here.'
    )
  }

  const created = createPrismaClient(connectionString)
  registry[CLIENT_KEY] = created
  return created
}

/**
 * Closes the pooled connections and forgets the singleton, so a later
 * `getPrismaClient()` builds a fresh one. Call from the API's shutdown hook:
 * with `connection_limit=1`, a process that exits without releasing its
 * connection makes the next deploy's first requests wait on the pooler.
 */
export async function disconnectPrismaClient(): Promise<void> {
  const registry = globalThis as unknown as ClientRegistry
  const existing = registry[CLIENT_KEY]
  if (existing === undefined) return

  delete registry[CLIENT_KEY]
  await existing.$disconnect()
}
