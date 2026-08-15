/**
 * The circuit repository, decorated onto the instance.
 *
 * Built lazily, and behind a getter, for the same reason `database.ts` is:
 * constructing the Prisma-backed implementation touches `app.db`, and
 * touching `app.db` opens a connection against a pooler whose budget is one.
 * A repository built at boot would connect before the process has finished
 * starting; built on first use, it connects when a request needs it.
 *
 * The `repository` option is how the route tests get an in-memory
 * implementation. That is not a mock of the thing under test: the routes,
 * the hooks, the auth policy, the Zod compilers and the error handler are all
 * real, and what is substituted is Postgres — which this project has exactly
 * one of, shared between development and production, and which therefore
 * cannot be what CI writes to on every push. The Prisma implementation has
 * its own suite in `@qsim/db`, run deliberately against the real database.
 */

import fp from 'fastify-plugin'
import { prismaCircuitRepository } from '@qsim/db'
import type { CircuitRepository } from '@qsim/db'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    /** Built on first access. See the note above about the connection budget. */
    readonly circuits: CircuitRepository
  }
}

export interface CircuitsPluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly repository?: CircuitRepository
}

function circuitsPlugin(
  app: FastifyInstance,
  options: CircuitsPluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.repository
  let owned: CircuitRepository | null = null

  app.decorate('circuits', {
    getter: (): CircuitRepository => {
      if (injected !== undefined) return injected
      owned ??= prismaCircuitRepository(app.db)
      return owned
    },
  })

  done()
}

export default fp(circuitsPlugin, {
  name: 'qsim-circuits',
  dependencies: ['qsim-database'],
})
