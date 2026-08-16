/**
 * The environment, parsed once, at boot, or the process refuses to start.
 *
 * The same discipline as `apps/api/src/env.ts`, and the same two rules: no
 * value is ever echoed, and only what this process reads is declared. What
 * differs is which variables are required, and the difference is the point of
 * this whole app.
 *
 * `REDIS_URL` is **required here and optional in the API**. That is not an
 * inconsistency; it is what each process is for. The API serves twelve routes
 * of which one needs a queue, so it degrades: a missing Redis is one 503 and
 * a gallery that still works. This process is *only* a queue consumer. Without
 * Redis it has nothing to do, and a worker that started successfully and then
 * sat idle would be the worst possible failure — green on every dashboard,
 * jobs accumulating, and nothing anywhere saying why.
 *
 * The same argument applies to `DATABASE_URL`: a worker that could run a
 * simulation and not store it would burn a minute of CPU per job to write the
 * result nowhere.
 *
 * §12.5 says the worker takes the API's variables "menos `PORT` y `WEB_URL`" —
 * and also minus everything about tokens, because this process never sees a
 * request and therefore never verifies one. Authorisation happened when the job
 * was enqueued; a worker that could check a JWT would be a worker that had a
 * reason to accept work from somewhere other than the queue.
 */

import process from 'node:process'
import {
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_SERVER_QUBITS,
  queuePrefix,
} from '@qsim/jobs'
import { z } from 'zod'

export type NodeEnv = 'development' | 'test' | 'production'
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

const HINTS: Record<string, string> = {
  NODE_ENV: 'one of development | test | production',
  LOG_LEVEL: `one of ${LOG_LEVELS.join(' | ')}`,
  REDIS_URL:
    'redis:// or rediss:// — the queue this process exists to consume; ' +
    'required, unlike in apps/api',
  DATABASE_URL:
    'Supabase TRANSACTION pooler, port 6543, with ' +
    '?pgbouncer=true&connection_limit=1',
  QUEUE_PREFIX:
    'namespace for every queue key; must match the API and must differ ' +
    'between environments sharing one Redis instance',
  WORKER_CONCURRENCY:
    'jobs in flight at once, which is also the number of child processes',
  SIMULATION_MAX_QUBITS: 'largest register a run may use; must match the API',
  SIMULATION_TIMEOUT_MS:
    'wall-clock bound on one run, enforced with SIGKILL; must match the API',
  SHUTDOWN_TIMEOUT_MS:
    'how long a graceful shutdown may take before the process is killed',
}

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),

  REDIS_URL: z
    .string()
    .min(1)
    .refine(isRedisUrl, { message: 'expected a redis:// or rediss:// URL' }),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(isPostgresUrl, { message: 'expected a postgresql:// URL' }),
  QUEUE_PREFIX: z.string().min(1).max(64).optional(),

  /*
   * Two, by default, and the ceiling is low on purpose. Each unit of
   * concurrency is a child process that may hold a 256 MB typed array, so the
   * memory this worker can reach is `concurrency × the register ceiling` — and
   * a Railway container that oversubscribes that does not degrade, it is
   * OOM-killed mid-job. Sixteen is an absurd upper bound rather than a
   * recommendation; it exists so a typo cannot ask for a thousand.
   */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

  SIMULATION_MAX_QUBITS: z.coerce.number().int().min(1).max(28).optional(),
  SIMULATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
})

function isRedisUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'redis:' || protocol === 'rediss:'
  } catch {
    return false
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'postgres:' || protocol === 'postgresql:'
  } catch {
    return false
  }
}

export interface WorkerEnv {
  readonly nodeEnv: NodeEnv
  readonly logLevel: LogLevel
  readonly redisUrl: string
  readonly databaseUrl: string
  readonly queuePrefix: string
  readonly concurrency: number
  readonly maxQubits: number
  readonly timeoutMs: number
  readonly shutdownTimeoutMs: number
}

export class EnvValidationError extends Error {
  constructor(
    override readonly message: string,
    readonly variables: readonly string[]
  ) {
    super(message)
    this.name = 'EnvValidationError'
  }
}

export type EnvSource = Record<string, string | undefined>

/** An unset variable and one set to the empty string mean the same thing. */
function withoutBlanks(source: EnvSource): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') result[key] = value
  }
  return result
}

function formatIssues(
  issues: readonly z.core.$ZodIssue[],
  present: Record<string, string>
): { message: string; variables: string[] } {
  const seen = new Set<string>()
  const lines: string[] = []

  for (const issue of issues) {
    const name = String(issue.path[0] ?? '(root)')
    if (seen.has(name)) continue
    seen.add(name)
    const state = name in present ? issue.message : 'missing'
    const hint = HINTS[name]
    lines.push(`  ${name} — ${state}${hint === undefined ? '' : ` (${hint})`}`)
  }

  const message = [
    'Invalid environment for apps/worker. The process will not start until ' +
      'these are fixed:',
    '',
    ...lines,
    '',
    'Values are never printed here. See .env.example for the shape and ' +
      'docs/especificacion.md §12.5 for where each one comes from.',
  ].join('\n')

  return { message, variables: [...seen] }
}

/**
 * @throws {EnvValidationError} naming every offending variable at once.
 * Reporting them one per restart is how a deploy takes five rounds.
 */
export function loadEnv(source: EnvSource): WorkerEnv {
  const present = withoutBlanks(source)
  const parsed = EnvSchema.safeParse(present)

  if (!parsed.success) {
    const { message, variables } = formatIssues(parsed.error.issues, present)
    throw new EnvValidationError(message, variables)
  }

  const env = parsed.data

  return {
    nodeEnv: env.NODE_ENV,
    logLevel:
      env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    redisUrl: env.REDIS_URL,
    databaseUrl: env.DATABASE_URL,
    queuePrefix: queuePrefix(env.QUEUE_PREFIX),
    concurrency: env.WORKER_CONCURRENCY,
    maxQubits: env.SIMULATION_MAX_QUBITS ?? DEFAULT_SERVER_QUBITS,
    timeoutMs: env.SIMULATION_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  }
}

/** Reads the real environment. Only `worker.ts` calls this. */
export function loadProcessEnv(): WorkerEnv {
  return loadEnv(process.env)
}
