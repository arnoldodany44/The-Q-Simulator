/**
 * Reading which unique constraint a P2002 refers to.
 *
 * ── Why this needed its own module, and a test against real Postgres ──────
 *
 * Prisma reports a unique-constraint violation as `P2002`, and every guide
 * says the violated columns are in `error.meta.target`. Under Prisma 7 with a
 * driver adapter — which is this project's only configuration, since Prisma 7
 * dropped the Rust query engine — that field **does not exist**. What arrives
 * instead is:
 *
 *     {
 *       code: 'P2002',
 *       meta: {
 *         modelName: 'CircuitVersion',
 *         driverAdapterError: {
 *           name: 'DriverAdapterError',
 *           cause: {
 *             kind: 'UniqueConstraintViolation',
 *             originalCode: '23505',
 *             originalMessage: 'duplicate key value violates unique ' +
 *               'constraint "CircuitVersion_circuitId_versionNum_key"',
 *             constraint: { fields: ['"circuitId"', '"versionNum"'] },
 *           },
 *         },
 *       },
 *     }
 *
 * — with the column names carrying their SQL quotes.
 *
 * Code that only reads `meta.target` therefore classifies every conflict as
 * "unknown" and stops retrying: a save that lost a race becomes a 500, and a
 * username collision on someone's first sign-in becomes a 500 too. Both look
 * fine in any suite whose P2002 fixtures were written by hand from the
 * documentation, which is exactly how this survived until an integration test
 * asked the real database for a real duplicate.
 *
 * So: read every shape, prefer the structured ones, and fall back to the
 * driver's message text only when nothing structured is there. The message
 * fallback is deliberately last — it is the one that could match by accident
 * — and it is worth having because it is the field least likely to disappear
 * in the next release.
 */

/** True for Prisma's "unique constraint failed", whatever produced it. */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  )
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/** `"versionNum"` → `versionNum`. The adapter quotes its identifiers. */
function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, '$1')
}

function asStrings(value: unknown): string[] {
  if (typeof value === 'string') return [unquote(value)]
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(unquote)
}

/**
 * Every name the error offers for the constraint that fired: column names,
 * the index identifier, or — failing both — the driver's own message.
 *
 * Returns an empty array when the error says nothing usable, which callers
 * must treat as "do not know" rather than as "not this one". Guessing here
 * would mean retrying a conflict that is not retryable.
 */
export function uniqueConstraintTargets(error: unknown): string[] {
  if (!isUniqueConstraintError(error)) return []

  const meta = readProperty(error, 'meta')
  const names = new Set<string>()

  // Prisma 6, and Prisma 7 without a driver adapter.
  for (const name of asStrings(readProperty(meta, 'target'))) names.add(name)

  const cause = readProperty(readProperty(meta, 'driverAdapterError'), 'cause')
  const constraint = readProperty(cause, 'constraint')
  for (const name of asStrings(readProperty(constraint, 'fields'))) {
    names.add(name)
  }
  for (const name of asStrings(readProperty(constraint, 'index'))) {
    names.add(name)
  }

  if (names.size === 0) {
    // Last resort: the constraint identifier appears in the driver's message,
    // in quotes. Structured data is preferred above; this exists so that a
    // future change to `meta`'s shape degrades instead of breaking.
    const message = readProperty(cause, 'originalMessage')
    if (typeof message === 'string') names.add(message)
  }

  return [...names]
}

/**
 * Whether the constraint that fired is one of the given names.
 *
 * Substring rather than equality, because a name may arrive as the column
 * (`versionNum`) or as the index (`CircuitVersion_circuitId_versionNum_key`)
 * and both should answer the same question.
 */
export function violatedConstraintMentions(
  error: unknown,
  needles: readonly string[]
): boolean {
  const targets = uniqueConstraintTargets(error)
  return targets.some((target) =>
    needles.some((needle) => target.includes(needle))
  )
}
