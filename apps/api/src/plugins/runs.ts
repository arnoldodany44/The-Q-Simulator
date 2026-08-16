/**
 * The simulation-run repository, decorated onto the instance.
 *
 * Lazy behind a getter for the reason `circuits.ts` and `database.ts` are:
 * constructing the Prisma-backed implementation touches `app.db`, and touching
 * `app.db` opens a connection against a pooler whose budget is one.
 *
 * A separate decorator from `app.circuits` rather than another method on it,
 * because a run is not a circuit. It has its own visibility rule
 * (`simulationRunFilter` — the id is the credential for an anonymous run, and
 * the circuit it names has to be readable too), it is the one table two
 * processes write, and `apps/worker` uses the same repository interface from
 * the other side. Bolting it onto the circuit repository would have made that
 * shared surface include forking, starring and the gallery.
 */

import { prismaSimulationRunRepository } from '@qsim/db'
import type { SimulationRunRepository } from '@qsim/db'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    /** Built on first access. See the note above about the connection budget. */
    readonly runs: SimulationRunRepository
  }
}

export interface RunsPluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly repository?: SimulationRunRepository
}

function runsPlugin(
  app: FastifyInstance,
  options: RunsPluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.repository
  let owned: SimulationRunRepository | null = null

  app.decorate('runs', {
    getter: (): SimulationRunRepository => {
      if (injected !== undefined) return injected
      owned ??= prismaSimulationRunRepository(app.db)
      return owned
    },
  })

  done()
}

export default fp(runsPlugin, {
  name: 'qsim-runs',
  dependencies: ['qsim-database'],
})
