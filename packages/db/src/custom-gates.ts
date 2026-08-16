/**
 * The custom gate library — §3.1, milestone M2.3.
 *
 * ── A library, not a dependency graph ─────────────────────────────────────
 *
 * Nothing in `CircuitVersion.data` ever points at a row in this table. A
 * circuit carries its own copy of every definition it uses, and installing a
 * published block copies the definition into the document. So deleting a
 * library entry, editing it, or making it private again cannot change, break
 * or silently alter a circuit anybody has saved — which is the property §3.4
 * already requires of a version ("cada guardado crea una versión inmutable")
 * and which a reference would take away. It is also the only answer that works
 * outside the database: a circuit travels in a URL (D4) and in an exported
 * JSON file, and neither has anything to resolve a reference against.
 *
 * The cost is attribution, and `forkedFromId` is where it is paid back — the
 * same column `Circuit` carries, nullable for the same reason: losing the
 * credit must not take the copy with it.
 *
 * ── A library entry is self-contained ─────────────────────────────────────
 *
 * A stored definition may not name another custom gate. That is a real limit —
 * you cannot publish a block built out of your other blocks without flattening
 * it first — and it is the deliberate one: the alternative is a row whose
 * meaning depends on other rows, which is the dependency graph this whole
 * design exists to not have. The editor inlines nested blocks before saving,
 * and `definitionIssues` below is what refuses the rest.
 */

import {
  CustomGateSchema,
  gateCount as countGates,
  emptyCircuit,
  isGateId,
  safeParseCircuit,
  type CustomGate,
  type ValidationIssue,
} from '@qsim/schema'
import { Visibility } from './generated/prisma/client.js'
import type { Prisma } from './generated/prisma/client.js'
import type { CustomGate as CustomGateRow } from './generated/prisma/client.js'
import type { ViewerId } from './visibility.js'

/**
 * Ceiling on a stored definition, in bytes of JSON.
 *
 * A quarter of `MAX_CIRCUIT_JSON_BYTES`, because a block is a fragment and a
 * circuit is a document: a definition that needs more than 64 KiB of JSON —
 * some eight hundred operations — is not a reusable gate, it is a circuit
 * wearing one. The bound also caps what installing one costs the document it
 * is copied into.
 */
export const MAX_DEFINITION_JSON_BYTES = 64 * 1024

/** Most definitions one account may keep. A library, not a dumping ground. */
export const MAX_CUSTOM_GATES_PER_USER = 200

/** Raised for a definition too large to store. */
export class CustomGateTooLargeError extends Error {
  readonly code = 'CIRCUIT_TOO_LARGE'

  constructor(
    readonly byteLength: number,
    readonly limit: number = MAX_DEFINITION_JSON_BYTES
  ) {
    super(
      `Custom gate JSON is ${String(byteLength)} bytes, over the ` +
        `${String(limit)} byte storage limit`
    )
    this.name = 'CustomGateTooLargeError'
  }
}

/**
 * Everything wrong with a definition, judged by the circuit contract itself.
 *
 * It is validated the only way the contract can validate a definition: by
 * declaring it inside a throwaway circuit with the same register and asking
 * `safeParseCircuit`. That runs the body against its own qubits and its own
 * formal parameters, refuses a measurement or a reset inside it, and applies
 * the expansion ceilings — one implementation, the same one the editor and the
 * engine use, rather than a second opinion that could disagree with them.
 */
export function definitionIssues(
  name: string,
  definition: unknown
): readonly ValidationIssue[] {
  const shape = CustomGateSchema.safeParse(definition)
  if (!shape.success) {
    return shape.error.issues.map((issue) => ({
      code: 'shape' as const,
      message: `definition.${issue.path.join('.')}: ${issue.message}`,
    }))
  }

  // Before the contract probe, so the reader gets the specific sentence. The
  // probe would refuse this too — as `unknown-gate`, since the probe circuit
  // declares nothing but this one definition — and that message sends someone
  // looking for a typo instead of telling them the rule.
  //
  // `isGateId` and not a second gate table: the catalog is declared once in
  // @qsim/schema, and a copy here is how a gate ends up meaning two things.
  const nested = shape.data.operations.find(
    (operation) => !isGateId(operation.gate)
  )
  if (nested !== undefined) {
    return [
      {
        code: 'unknown-gate',
        customGate: name,
        operationId: nested.id,
        message:
          `Operation "${nested.id}" uses "${nested.gate}", which is not a ` +
          `catalog gate. A saved block has to stand on its own — expand any ` +
          `block inside it before saving.`,
      },
    ]
  }

  const probe = {
    ...emptyCircuit(shape.data.qubits),
    customGates: { [name]: shape.data },
  }
  const parsed = safeParseCircuit(probe)
  return parsed.ok ? [] : parsed.issues
}

/** The denormalised counters a listing sorts and filters on. */
export function countersFor(definition: CustomGate): {
  qubitCount: number
  paramCount: number
  gateCount: number
} {
  return {
    qubitCount: definition.qubits,
    paramCount: definition.params?.length ?? 0,
    // Through the contract's own counter, so a block's advertised size is the
    // number of primitives it really runs (M2.3 reversed this — see
    // `gateCount` in @qsim/schema).
    gateCount: countGates({
      ...emptyCircuit(definition.qubits),
      operations: definition.operations,
    }),
  }
}

/** The write crossing, with the size cap on it. */
export function toDefinitionJson(
  definition: CustomGate
): Prisma.InputJsonValue {
  const bytes = new TextEncoder().encode(JSON.stringify(definition)).length
  if (bytes > MAX_DEFINITION_JSON_BYTES) {
    throw new CustomGateTooLargeError(bytes)
  }
  return definition
}

/** The read crossing. Throws for a row the contract no longer accepts. */
export function parseStoredDefinition(data: Prisma.JsonValue): CustomGate {
  return CustomGateSchema.parse(data)
}

/* ─────────────────────────────── visibility ─────────────────────────── */

/**
 * Blocks that may appear in a listing: PUBLIC for everyone, plus the viewer's
 * own whatever their visibility.
 *
 * UNLISTED is absent for the same reason it is absent from
 * `listableCircuitFilter` — a listing is discovery, and unlisted means
 * reachable by whoever holds the link.
 */
export function listableCustomGateFilter(
  viewerId: ViewerId
): Prisma.CustomGateWhereInput {
  if (viewerId === null) return { visibility: Visibility.PUBLIC }
  return { OR: [{ visibility: Visibility.PUBLIC }, { ownerId: viewerId }] }
}

/**
 * The complete `where` for "the block this id names, if this viewer may read
 * it". UNLISTED is reachable by id here for the reason
 * `collectionHandleFilter` gives: a block has no slug, so its `cuid(2)` id is
 * the only handle it has, and no response carries the id of a block the reader
 * may not list.
 */
export function customGateHandleFilter(
  id: string,
  viewerId: ViewerId
): Prisma.CustomGateWhereInput {
  const shared: Prisma.CustomGateWhereInput[] = [
    { visibility: Visibility.PUBLIC },
    { visibility: Visibility.UNLISTED },
  ]
  return {
    AND: [
      { id },
      viewerId === null
        ? { OR: shared }
        : { OR: [...shared, { ownerId: viewerId }] },
    ],
  }
}

/** Write access. Visibility has nothing to do with it, as ever. */
export function canEditCustomGate(
  gate: { ownerId: string },
  viewerId: ViewerId
): boolean {
  return viewerId !== null && gate.ownerId === viewerId
}

/* ─────────────────────────────── repository ─────────────────────────── */

/** A row with its definition already through the contract. */
export interface StoredCustomGate extends Omit<CustomGateRow, 'definition'> {
  definition: CustomGate
}

export interface NewCustomGate {
  readonly ownerId: string
  readonly name: string
  readonly title: string
  readonly description: string | null
  readonly visibility: Visibility
  readonly definition: CustomGate
  readonly forkedFromId: string | null
}

export interface CustomGatePatch {
  readonly title?: string
  readonly description?: string | null
  readonly visibility?: Visibility
  readonly definition?: CustomGate
}

/**
 * What `apps/api` depends on. An interface rather than the Prisma client
 * directly, for the reason the circuit repository states: the route tests run
 * against an in-memory implementation, and a route that reached for `prisma`
 * would need a database to test a 404.
 */
export interface CustomGateStore {
  listOwn(ownerId: string, take: number): Promise<StoredCustomGate[]>
  listPublished(viewerId: ViewerId, take: number): Promise<StoredCustomGate[]>
  findReadable(id: string, viewerId: ViewerId): Promise<StoredCustomGate | null>
  countOwn(ownerId: string): Promise<number>
  create(input: NewCustomGate): Promise<StoredCustomGate>
  update(id: string, patch: CustomGatePatch): Promise<StoredCustomGate>
  remove(id: string): Promise<void>
  recordInstall(id: string): Promise<void>
}

type Client = {
  customGate: {
    findMany: (args: unknown) => Promise<CustomGateRow[]>
    findFirst: (args: unknown) => Promise<CustomGateRow | null>
    count: (args: unknown) => Promise<number>
    create: (args: unknown) => Promise<CustomGateRow>
    update: (args: unknown) => Promise<CustomGateRow>
    delete: (args: unknown) => Promise<CustomGateRow>
  }
}

export function createCustomGateStore(prisma: Client): CustomGateStore {
  const parse = (row: CustomGateRow): StoredCustomGate => ({
    ...row,
    definition: parseStoredDefinition(row.definition),
  })

  return {
    async listOwn(ownerId, take) {
      const rows = await prisma.customGate.findMany({
        where: { ownerId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take,
      })
      return rows.map(parse)
    },

    async listPublished(viewerId, take) {
      const rows = await prisma.customGate.findMany({
        where: listableCustomGateFilter(viewerId),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take,
      })
      return rows.map(parse)
    },

    async findReadable(id, viewerId) {
      const row = await prisma.customGate.findFirst({
        where: customGateHandleFilter(id, viewerId),
      })
      return row === null ? null : parse(row)
    },

    countOwn(ownerId) {
      return prisma.customGate.count({ where: { ownerId } })
    },

    async create(input) {
      const row = await prisma.customGate.create({
        data: {
          ownerId: input.ownerId,
          name: input.name,
          title: input.title,
          description: input.description,
          visibility: input.visibility,
          definition: toDefinitionJson(input.definition),
          forkedFromId: input.forkedFromId,
          ...countersFor(input.definition),
        },
      })
      return parse(row)
    },

    async update(id, patch) {
      const row = await prisma.customGate.update({
        where: { id },
        data: {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined
            ? {}
            : { description: patch.description }),
          ...(patch.visibility === undefined
            ? {}
            : { visibility: patch.visibility }),
          ...(patch.definition === undefined
            ? {}
            : {
                definition: toDefinitionJson(patch.definition),
                ...countersFor(patch.definition),
              }),
        },
      })
      return parse(row)
    },

    async remove(id) {
      await prisma.customGate.delete({ where: { id } })
    },

    async recordInstall(id) {
      // Best effort and deliberately unguarded: an install counter is a
      // popularity signal, not a fact anything depends on, and a failure here
      // must never cost the caller the definition they asked for.
      await prisma.customGate.update({
        where: { id },
        data: { installCount: { increment: 1 } },
      })
    },
  }
}
