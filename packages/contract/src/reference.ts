/**
 * The human-readable reference, rendered from the same schemas the server
 * validates with — §3.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A FIELD TABLE AND NOT THE JSON SCHEMA
 *
 * `openapi.ts` already publishes the complete, exact machine description. If
 * this file printed that too, it would be a forty-kilobyte document of
 * `{"type":"object","properties":…}` that nobody reads and that the
 * machine-readable one already says better.
 *
 * What a person needs from a reference is different and smaller: the fields
 * of a request, whether each is required, and what the bounds are. So every
 * table below is derived from the JSON Schema — the same object — one level
 * deep, and the nested detail is one link away. Derived rather than written,
 * because the whole argument for generating documentation is that a field
 * somebody renames must not be able to stay renamed in only one place.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE HAS NO `fs` AND CANNOT
 *
 * `@qsim/contract` is bundled into the browser and a boundary rule forbids
 * Node builtins here. So this renders a string, and the *writing* of
 * `docs/api.md` is a file snapshot in `openapi.test.ts` — which also means the
 * committed file cannot drift: a change to any schema fails that test until
 * the reference is regenerated.
 */

import { API_KEY_SCOPES, API_KEY_PATTERN, API_KEY_PREFIX } from './api-keys.js'
import { API_ERROR_CODES } from './errors.js'
import {
  PUBLIC_ROUTES,
  UNIVERSAL_ERRORS,
  WORKED_EXAMPLE,
  jsonSchemaOf,
  openApiPath,
  pathParamNames,
} from './openapi.js'
import type { JsonSchema, PublicRoute } from './openapi.js'

/* ────────────────────────── JSON Schema → prose ─────────────────────── */

/**
 * Makes a string safe inside a markdown table cell.
 *
 * A pipe ends a cell, and this document is full of union types written with
 * one — `string | null`, and every enum. Escaping is not cosmetic: an
 * unescaped pipe silently splits a row, so the *type* of a field lands in the
 * "required" column and the reader is told the wrong thing rather than told
 * nothing. Backticks do not protect it; markdown resolves the table first.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function asRecord(value: unknown): JsonSchema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null
}

/**
 * A short type label for one property.
 *
 * Deliberately lossy and deliberately readable. `anyOf` of a string and a null
 * is written `string | null`, an enum is written as its members, and anything
 * this does not recognise becomes `object` with the full description left to
 * the OpenAPI document. A label that tried to be complete would be the JSON
 * Schema again, in worse notation.
 */
function typeLabel(node: unknown): string {
  const schema = asRecord(node)
  if (schema === null) return 'unknown'

  const enumeration = schema['enum']
  if (Array.isArray(enumeration)) {
    return enumeration
      .map((value) => `\`${JSON.stringify(value)}\``)
      .join(' | ')
  }

  const constant = schema['const']
  if (constant !== undefined) return `\`${JSON.stringify(constant)}\``

  const anyOf = schema['anyOf'] ?? schema['oneOf']
  if (Array.isArray(anyOf)) {
    const labels = anyOf.map(typeLabel)
    return [...new Set(labels)].join(' | ')
  }

  const type = schema['type']
  if (Array.isArray(type)) return type.join(' | ')
  if (type === 'array') return `${typeLabel(schema['items'])}[]`
  if (typeof type === 'string') {
    const format = schema['format']
    return typeof format === 'string' ? `${type} (${format})` : type
  }

  if (schema['$ref'] !== undefined) return 'object'
  if (schema['properties'] !== undefined) return 'object'
  return 'any'
}

/** The bounds worth printing, joined into one cell. */
function constraintsOf(node: unknown): string {
  const schema = asRecord(node)
  if (schema === null) return ''

  const parts: string[] = []
  const push = (key: string, label: string): void => {
    const value = schema[key]
    if (typeof value === 'number') parts.push(`${label} ${String(value)}`)
  }
  push('minLength', 'min length')
  push('maxLength', 'max length')
  push('minimum', '≥')
  push('maximum', '≤')
  push('minItems', 'min items')
  push('maxItems', 'max items')
  const pattern = schema['pattern']
  if (typeof pattern === 'string') parts.push(`pattern \`${pattern}\``)
  const fallback = schema['default']
  if (fallback !== undefined) {
    parts.push(`default \`${JSON.stringify(fallback)}\``)
  }
  return parts.join(', ')
}

/** One markdown table of a schema's top-level fields, or `null` if it has none. */
function fieldTable(schema: JsonSchema): string | null {
  const properties = asRecord(schema['properties'])
  if (properties === null) return null
  const entries = Object.entries(properties)
  if (entries.length === 0) return null

  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : []
  )

  const rows = entries.map(([name, node]) => {
    const description = asRecord(node)?.['description']
    const notes = [
      constraintsOf(node),
      typeof description === 'string' ? description : '',
    ]
      .filter((part) => part.length > 0)
      .join(' — ')
    return `| \`${name}\` | ${cell(typeLabel(node))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(notes)} |`
  })

  return [
    '| Field | Type | Required | Notes |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/* ──────────────────────────────── rendering ─────────────────────────── */

function anchorOf(route: PublicRoute): string {
  return route.operationId.toLowerCase()
}

function fence(language: string, body: string): string {
  return ['```' + language, body, '```'].join('\n')
}

function json(value: unknown): string {
  return fence('json', JSON.stringify(value, null, 2))
}

function renderRoute(route: PublicRoute, serverUrl: string): string {
  const url = openApiPath(route.path)
  const lines: string[] = []

  lines.push(`### ${route.method} ${url}`)
  lines.push('')
  lines.push(`<a id="${anchorOf(route)}"></a>`)
  lines.push('')
  lines.push(`**${route.summary}.** ${route.description}`)
  lines.push('')

  const scope =
    route.scope === null
      ? 'Session only — no API key may use this endpoint, however it is scoped.'
      : `Scope \`${route.scope}\`.`
  const anonymous = route.anonymous
    ? 'Works without credentials; what you see depends on who you are.'
    : 'Requires credentials.'
  lines.push(`- **Authorisation:** ${scope} ${anonymous}`)

  const params = pathParamNames(route.path)
  if (params.length > 0) {
    lines.push('- **Path parameters:**')
    for (const name of params) {
      lines.push(`  - \`${name}\` — ${route.params?.[name] ?? ''}`)
    }
  }

  if (route.query !== undefined) {
    const table = fieldTable(jsonSchemaOf(route.query))
    if (table !== null) {
      lines.push('')
      lines.push('**Query string**')
      lines.push('')
      lines.push(table)
    }
  }

  if (route.body !== undefined) {
    const table = fieldTable(jsonSchemaOf(route.body))
    lines.push('')
    lines.push('**Request body** (`application/json`)')
    lines.push('')
    lines.push(
      table ??
        'No fields of its own; see the machine-readable schema for the shape.'
    )
  }

  lines.push('')
  lines.push('**Responses**')
  lines.push('')
  lines.push('| Status | Body |')
  lines.push('| --- | --- |')
  for (const response of route.responses) {
    const body =
      response.schema === undefined
        ? '_(empty)_'
        : Object.keys(
            asRecord(jsonSchemaOf(response.schema)['properties']) ?? {}
          )
            .map((name) => `\`${name}\``)
            .join(', ')
    lines.push(
      `| ${String(response.status)} | ${cell(`${response.description} ${body}`)} |`
    )
  }

  if (route.errors !== undefined && route.errors.length > 0) {
    lines.push('')
    lines.push(
      `**Errors beyond the universal ones:** ${route.errors
        .map((code) => `\`${code}\``)
        .join(', ')}.`
    )
  }

  lines.push('')
  lines.push(
    `<details><summary>curl</summary>\n\n${fence(
      'bash',
      curlFor(route, serverUrl)
    )}\n\n</details>`
  )
  lines.push('')
  return lines.join('\n')
}

/** A copy-pasteable call, with the placeholders left visibly as placeholders. */
function curlFor(route: PublicRoute, serverUrl: string): string {
  const url =
    serverUrl +
    openApiPath(route.path).replace(
      /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => `<${name}>`
    )
  const parts = [`curl -X ${route.method} '${url}'`]
  parts.push(`  -H 'Authorization: Bearer $QSIM_API_KEY'`)
  if (route.body !== undefined) {
    parts.push(`  -H 'Content-Type: application/json'`)
    parts.push(`  -d '{ … }'`)
  }
  return parts.join(' \\\n')
}

function renderWorkedExample(serverUrl: string): string {
  const lines: string[] = []
  lines.push('## A worked example')
  lines.push('')
  lines.push(
    'Three calls, end to end: make a circuit, run it, read the counts. Set ' +
      '`QSIM_API_KEY` to a key with the `write`, `simulate` and `read` scopes.'
  )
  lines.push('')

  for (const [index, step] of WORKED_EXAMPLE.entries()) {
    const route = PUBLIC_ROUTES.find(
      (candidate) => candidate.operationId === step.operationId
    )
    /* istanbul ignore next — the test asserts every step names a real route. */
    if (route === undefined) continue

    lines.push(`### ${String(index + 1)}. ${step.title}`)
    lines.push('')
    lines.push(step.note)
    lines.push('')
    lines.push(
      `[\`${route.method} ${openApiPath(route.path)}\`](#${anchorOf(route)})`
    )
    lines.push('')
    if (step.request !== undefined) {
      lines.push(
        fence(
          'bash',
          [
            `curl -X ${route.method} '${serverUrl}${openApiPath(route.path)}' \\`,
            `  -H 'Authorization: Bearer '"$QSIM_API_KEY" \\`,
            `  -H 'Content-Type: application/json' \\`,
            `  -d '${JSON.stringify(step.request)}'`,
          ].join('\n')
        )
      )
      lines.push('')
    }
    if (step.response !== undefined) {
      lines.push('Abbreviated response:')
      lines.push('')
      lines.push(json(step.response))
      lines.push('')
    }
  }
  return lines.join('\n')
}

export interface ReferenceOptions {
  readonly serverUrl: string
  readonly version: string
}

/**
 * The whole of `docs/api.md`.
 *
 * Written as one string rather than assembled from template files, because a
 * template file is a second place a heading can live and this document has
 * exactly one source.
 */
export function renderApiReference(options: ReferenceOptions): string {
  const { serverUrl } = options
  const lines: string[] = []

  lines.push('# The Q Simulator — public API')
  lines.push('')
  lines.push(
    '<!-- Generated from the Zod schemas in @qsim/contract. Do not edit: ' +
      'run `pnpm --filter @qsim/contract test -u` to regenerate. -->'
  )
  lines.push('')
  lines.push(
    'Create circuits, run simulations and read results from outside the ' +
      'application (§3.5). Everything below is generated from the schemas the ' +
      'server validates with, so a field described here is a field the server ' +
      'accepts.'
  )
  lines.push('')
  lines.push(`- **Base URL:** \`${serverUrl}\``)
  lines.push(`- **Version:** \`${options.version}\``)
  lines.push(
    `- **Machine-readable:** [\`${serverUrl}/api/v1/openapi.json\`](${serverUrl}/api/v1/openapi.json) — OpenAPI 3.1, the complete schemas.`
  )
  lines.push('- **Content type:** `application/json`, and nothing else.')
  lines.push('')

  /* ── authentication ── */
  lines.push('## Authentication')
  lines.push('')
  lines.push(
    'Send your key as a bearer token. It is the same header a browser ' +
      'session uses, so any HTTP client works unchanged:'
  )
  lines.push('')
  lines.push(fence('http', 'Authorization: Bearer qsk_…'))
  lines.push('')
  lines.push(
    `A key is \`${API_KEY_PREFIX}\` followed by 43 characters of base64url — ` +
      `43 + ${String(API_KEY_PREFIX.length)} characters in all, matching ` +
      `\`${API_KEY_PATTERN.source}\`. The prefix and the fixed length are ` +
      'deliberate: they make a leaked key findable by one grep, in a log or in ' +
      'a public repository, by somebody who has never seen this API before. ' +
      'Treat it as a password.'
  )
  lines.push('')
  lines.push('Four things that are worth knowing before you build on this:')
  lines.push('')
  lines.push(
    '1. **A key is shown once**, in the response that creates it. It is not ' +
      'recoverable afterwards by anyone, including you: the server stores a ' +
      'SHA-256 of it and there is no endpoint that returns a key. If you lose ' +
      'it, revoke it and mint another.'
  )
  lines.push(
    '2. **A key acts as the account that minted it, and can do no less and ' +
      'no more.** It sees exactly the circuits that account sees; somebody ' +
      'else’s PRIVATE circuit answers 404 to your key exactly as it does to ' +
      'your browser.'
  )
  lines.push(
    '3. **Revocation is immediate and cannot be undone.** The next request ' +
      'carrying a revoked key fails. There is no cache to wait out.'
  )
  lines.push(
    '4. **Rate limits are per key**, not per address and not per account. A ' +
      'runaway script cannot exhaust the budget of your browser session or of ' +
      'your other keys, and a `429` names a key you can revoke.'
  )
  lines.push('')
  lines.push('### Scopes')
  lines.push('')
  lines.push(
    'A key carries one or more of the following. Each endpoint below states ' +
      'the one it requires; a key without it is refused with ' +
      '`API_KEY_SCOPE_REQUIRED` and the `details` name the scope that was ' +
      'missing.'
  )
  lines.push('')
  lines.push('| Scope | What it allows |')
  lines.push('| --- | --- |')
  const scopeMeaning: Record<(typeof API_KEY_SCOPES)[number], string> = {
    read:
      'Every read: your circuits and their versions, the gallery, ' +
      'collections, profiles, and the result of a run.',
    write:
      'Everything that creates, changes or destroys a document: circuits, ' +
      'versions, forks, stars and collections.',
    simulate:
      'Running simulations. Separate from `write` so a key can run your ' +
      'circuits without being able to change them.',
  }
  for (const scope of API_KEY_SCOPES) {
    lines.push(`| \`${scope}\` | ${scopeMeaning[scope]} |`)
  }
  lines.push('')
  lines.push('### What no key can do')
  lines.push('')
  lines.push(
    'Two parts of the API are unreachable with a key however it is scoped, ' +
      'and both refuse with `API_KEY_NOT_ACCEPTED`:'
  )
  lines.push('')
  lines.push(
    '- **Managing keys.** A key that could mint keys would survive its own ' +
      'revocation, which would make revoking a leaked key pointless. Mint and ' +
      'revoke from the settings screen, signed in.'
  )
  lines.push(
    '- **Real quantum hardware.** Submitting a job spends an allowance that ' +
      'does not refill on request, so it is a decision made by a person at a ' +
      'screen rather than by a script holding a credential.'
  )
  lines.push('')

  /* ── errors ── */
  lines.push('## Errors')
  lines.push('')
  lines.push(
    'Every failure has the same body. Switch on `error.code`; never display ' +
      '`error.message`, which is fixed English for whoever is holding a ' +
      'terminal.'
  )
  lines.push('')
  lines.push(
    json({
      error: {
        code: 'API_KEY_SCOPE_REQUIRED',
        message:
          'This API key does not carry the scope this endpoint requires.',
        requestId: '3f0a1c6e-2b7d-4f13-9a55-0c4e6a1d2b88',
        details: [{ path: 'scope', code: 'write' }],
      },
    })
  )
  lines.push('')
  lines.push(
    '`requestId` is also returned as the `x-request-id` header, on every ' +
      'response. Quote it in a bug report: it is what joins what you saw to ' +
      'the server’s own log line for the same request.'
  )
  lines.push('')
  lines.push(
    `Any endpoint may answer with ${UNIVERSAL_ERRORS.map(
      (code) => `\`${code}\``
    ).join(', ')}. The complete vocabulary is ${String(
      API_ERROR_CODES.length
    )} codes, enumerated in the OpenAPI document.`
  )
  lines.push('')
  lines.push(
    'Rate-limited responses carry `retry-after` and `x-ratelimit-remaining`. ' +
      'The remaining budget is on *every* response, not only on the refusal, ' +
      'so a well-behaved client can slow down before it is cut off.'
  )
  lines.push('')

  /* ── conventions ── */
  lines.push('## Conventions')
  lines.push('')
  lines.push(
    '- **Bit order.** Qubit 0 is the least significant bit. A count key ' +
      '`"01"` means qubit 0 measured 1 and qubit 1 measured 0. This is the ' +
      'single most likely thing to get wrong when comparing results with ' +
      'another toolchain.'
  )
  lines.push(
    '- **Timestamps** are ISO-8601 in UTC. **Numbers** are IEEE-754 double ' +
      'precision; amplitudes and probabilities agree with the engine to 1e-10.'
  )
  lines.push(
    '- **A resource you may not see answers `404`**, never `403`. `403` ' +
      'would confirm that it exists.'
  )
  lines.push(
    '- **Listings that can grow are cursor-paged.** Send back the ' +
      '`nextCursor` you were given; a `null` one means you have reached the ' +
      'end. Offsets are not offered, because the default ordering changes ' +
      'while you read it and an offset over a moving order repeats or skips ' +
      'rows without saying so.'
  )
  lines.push('')

  lines.push(renderWorkedExample(serverUrl))

  /* ── endpoints ── */
  lines.push('## Endpoints')
  lines.push('')
  lines.push('| Method | Path | Scope | Summary |')
  lines.push('| --- | --- | --- | --- |')
  for (const route of PUBLIC_ROUTES) {
    const scope = route.scope === null ? '_session only_' : `\`${route.scope}\``
    lines.push(
      `| ${route.method} | [\`${openApiPath(route.path)}\`](#${anchorOf(route)}) | ${scope} | ${route.summary} |`
    )
  }
  lines.push('')

  for (const route of PUBLIC_ROUTES) {
    lines.push(renderRoute(route, serverUrl))
  }

  return `${lines.join('\n').trimEnd()}\n`
}
