/**
 * Zod as Fastify's validator, so there is exactly one schema language.
 *
 * The alternative — JSON Schema for the route, Zod for the circuit inside it
 * — means two descriptions of the same request that drift apart, and the
 * drift shows up as a payload the router accepts and the domain rejects, or
 * worse, the reverse. §11 asks for "strict Zod validation of every incoming
 * circuit before the engine is touched"; making Zod the *only* validator is
 * how that stays true of every other input as well.
 *
 * It also means `@qsim/schema` plugs straight into a route:
 *
 *     app.post('/circuits', {
 *       config: { auth: 'required' },
 *       schema: { body: z.object({ data: CircuitSchema }) },
 *     }, handler)
 *
 * with `request.body` typed from the schema and no second validator anywhere
 * — which is the rule the milestone brief states outright.
 *
 * Two details worth knowing:
 *
 *   - Fastify hands the validator `null`, not `undefined`, when a part of
 *     the request is absent (`lib/validation.js`). A route that declares a
 *     body schema therefore rejects a request with no body, which is what
 *     you want, but it means an *optional* body must be spelled
 *     `.nullable()` rather than `.optional()`.
 *   - Query strings and path parameters arrive as strings. A numeric field
 *     needs `z.coerce.number()`; `z.number()` will reject `?page=2`.
 */

import type {
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from 'fastify'
import type { z, ZodType, input as ZodInput, output as ZodOutput } from 'zod'
import { ApiError } from '../errors.js'
import type { ErrorDetail } from '../errors.js'

/**
 * Teaches Fastify to read the request types out of the Zod schemas, so
 * `request.body` is typed without a second generic parameter on the route.
 */
export interface ZodTypeProvider extends FastifyTypeProvider {
  readonly validator: this['schema'] extends ZodType
    ? ZodOutput<this['schema']>
    : unknown
  readonly serializer: this['schema'] extends ZodType
    ? ZodInput<this['schema']>
    : unknown
}

/**
 * Most issues a single 400 will enumerate.
 *
 * ── Why there is a cap at all ─────────────────────────────────────────────
 *
 * Without one, a 400 costs the server far more than the request cost the
 * client. Measured: a body of 1,040,057 bytes — comfortably under the 1 MiB
 * limit — of 130,000 malformed operations produced 650,000 Zod issues, a
 * 44,684,609-byte response and about 2.8 seconds of blocking CPU. That is a
 * 43x amplifier on egress, and on a single-threaded runtime it is 2.8 seconds
 * during which this process serves nobody. The ordinary rate limit allows 300
 * of them a minute per authenticated caller.
 *
 * Twenty is chosen for the reader, not for the attacker. `details` exists so
 * a person can see what is wrong with their request; nobody has ever fixed
 * the twenty-first problem before fixing the first twenty, and the client
 * holds the same schemas and can re-derive the whole list locally if it wants
 * it. One extra entry marks that the list was cut, so a client says "and
 * more" rather than quietly implying there were exactly twenty.
 */
export const MAX_ERROR_DETAILS = 20

/** The `code` of the entry that stands for everything that did not fit. */
export const TRUNCATED_DETAIL_CODE = 'too_many_issues'

/**
 * Flattens Zod issues into the response `details`, capped.
 *
 * The issue *code* travels and the issue *message* does not — the client is
 * trilingual and owns the wording (D2). It can do better than a translated
 * sentence anyway: `@qsim/schema` is shared, so the browser holds the same
 * schema and can say precisely which gate on which column is wrong.
 *
 * A `custom` issue from `@qsim/schema`'s text guards carries the useful name
 * under `params.qsim` — `control_character`, `lone_surrogate` — because Zod
 * spells every refinement `custom` and "custom" tells a client nothing.
 */
export function toErrorDetails(
  httpPart: string | undefined,
  issues: readonly z.core.$ZodIssue[]
): ErrorDetail[] {
  const details = issues.slice(0, MAX_ERROR_DETAILS).map((issue) => {
    const path = issue.path.map((segment) => String(segment))
    return {
      path: [httpPart ?? 'request', ...path].join('.'),
      code: qsimIssueCode(issue) ?? issue.code,
    }
  })

  return withTruncationMarker(details, issues.length, httpPart ?? 'request')
}

function qsimIssueCode(issue: z.core.$ZodIssue): string | undefined {
  const params = (issue as { params?: Record<string, unknown> }).params
  const code = params?.qsim
  return typeof code === 'string' ? code : undefined
}

/**
 * Appends the "and this many more" entry when the list was cut short.
 *
 * Shared with `acceptCircuit` in the circuit routes, which caps the semantic
 * issues from `@qsim/schema` for the same reason and has to say so the same
 * way — two spellings of "truncated" would be two things for a client to
 * learn.
 */
export function withTruncationMarker(
  details: ErrorDetail[],
  total: number,
  path: string
): ErrorDetail[] {
  if (total <= details.length) return details
  return [...details, { path, code: TRUNCATED_DETAIL_CODE }]
}

/**
 * Returns the error rather than throwing it. Fastify's `validateParam`
 * catches a synchronous throw and re-labels it a *500* — a client mistake
 * reported as a server fault. Returning `{ error }` takes the documented
 * path, where `wrapValidationError` keeps the `code` and `statusCode` this
 * `ApiError` already carries.
 */
export const zodValidatorCompiler: FastifySchemaCompiler<ZodType> =
  ({ schema, httpPart }) =>
  (data) => {
    const result = schema.safeParse(data)
    if (result.success) return { value: result.data }
    return {
      error: new ApiError('VALIDATION_FAILED', {
        details: toErrorDetails(httpPart, result.error.issues),
        cause: result.error,
      }),
    }
  }

/**
 * Serialising *through* the response schema, rather than stringifying the
 * handler's return value, is a leak defence and not a formality: a `select`
 * that grows a column, or a projection that forgets one, cannot reach a
 * client through a route whose response schema does not mention it.
 *
 * A mismatch throws, which becomes a 500. That is the correct outcome —
 * sending a shape the route did not promise is a server bug — and it is far
 * better than discovering an extra `email` field in production.
 */
export const zodSerializerCompiler: FastifySerializerCompiler<ZodType> =
  ({ schema }) =>
  (data) =>
    JSON.stringify(schema.parse(data))
