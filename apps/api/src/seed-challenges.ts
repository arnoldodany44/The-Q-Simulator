/**
 * The seed as a process. Railway runs `node dist/seed-challenges.js` between
 * `prisma migrate deploy` and the server — see `release.sh`.
 *
 * A second entry point rather than a step inside the server's boot, and the
 * reason is that a boot is the wrong place for a write: the platform runs more
 * than one instance during a rolling deploy, a healthcheck is waiting, and a
 * seed that failed would take down a service whose actual job is unaffected.
 * As its own process it runs once, before anything is serving, and its exit
 * code is the whole of its report.
 *
 * Everything it does is argued in `challenges/seed.ts`: idempotent, keyed on
 * the unique slug, never deletes, targets computed by the engine rather than
 * typed. This file is the plumbing — a client, a repository, a log line, a
 * disconnect.
 */

import process from 'node:process'
import {
  disconnectPrismaClient,
  getPrismaClient,
  prismaChallengeRepository,
} from '@qsim/db'

import { seedChallenges } from './challenges/seed.js'

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  try {
    const report = await seedChallenges(prismaChallengeRepository(prisma))
    /*
     * Plain lines to stdout rather than pino JSON. The audience is whoever is
     * reading a deploy console, exactly as it is for `release.sh` and for the
     * environment error in `server.ts`. Written through `process.stdout`
     * because this project's lint rule allows `console.warn` and
     * `console.error` only — and a seed that succeeded is neither.
     */
    process.stdout.write(
      `seed: ${String(report.created.length)} challenge(s) created, ` +
        `${String(report.converged.length)} already present\n`
    )
    if (report.created.length > 0) {
      process.stdout.write(`seed: created ${report.created.join(', ')}\n`)
    }
  } finally {
    /*
     * Released whatever happened. `DATABASE_URL` carries `connection_limit=1`,
     * so a seed process that exits still holding its connection makes the
     * server's first requests queue behind a connection nobody is using — the
     * same argument `server.ts` makes about shutdown.
     */
    await disconnectPrismaClient()
  }
}

try {
  await main()
} catch (error) {
  console.error('\nseed: failed to write the challenge ladder\n')
  console.error(error)
  /*
   * A non-zero exit stops the release, and that is the right severity: a
   * deployment whose challenges did not seed would serve an empty ladder and
   * 404 every challenge page, which is worse than a deployment that visibly
   * did not happen.
   */
  process.exit(1)
}
