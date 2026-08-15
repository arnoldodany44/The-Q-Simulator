import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineConfig } from 'prisma/config'

/*
 * Prisma 7 no longer reads `.env` on its own — the CLI only sees the ambient
 * environment. This project keeps a single `.env` at the repo root (one file,
 * shared by web, api and worker), so load it here explicitly.
 *
 * `process.loadEnvFile` is built into Node ≥20.12, which keeps this file free
 * of a dotenv dependency, and it does not overwrite variables that are
 * already set — so a value exported by CI or by Railway still wins over the
 * local file, which is the behaviour we want on a deploy.
 */
const repoRootEnv = path.resolve(import.meta.dirname, '../../.env')
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv)
}

/*
 * The CLI gets DIRECT_URL and only DIRECT_URL. `prisma migrate` takes
 * advisory locks and runs DDL in long transactions, neither of which survives
 * a transaction-mode pooler, so pointing this at DATABASE_URL would produce
 * migrations that half apply. Note this is the Supabase *session* pooler on
 * 5432, not `db.<ref>.supabase.co` — that host is IPv6-only.
 *
 * Read conditionally rather than through Prisma's `env()` helper, which
 * throws at config-load time when the variable is absent. `prisma generate`
 * needs no database at all and runs in CI, where these secrets do not exist;
 * an eager read would turn a build into a credentials requirement. The
 * migrate commands still fail loudly, because Prisma itself demands a
 * datasource url before it will touch a database.
 */
const migrationUrl = process.env.DIRECT_URL

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
})
