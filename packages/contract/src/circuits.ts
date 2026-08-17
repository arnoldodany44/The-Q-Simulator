/**
 * The circuit routes' wire contract — §8, milestones M1.4 and M1.5.
 *
 * ── One declaration, two ends ─────────────────────────────────────────────
 *
 * `apps/api` validates requests with these schemas and *serialises responses
 * through* them; `apps/web` parses responses with them and derives its
 * TypeScript types from them. Neither end owns the file, so there is no
 * version of "what a circuit page returns" that can drift from the other —
 * which is the whole reason this package exists rather than a hand-copied
 * `types.ts` in the browser.
 *
 * The serialisation half is a leak defence and not documentation:
 * `circuitDetailSelect` in `@qsim/db` fetches `ownerId` because authorisation
 * needs it, no response schema below mentions it, and so it cannot reach a
 * client even though every handler has it in hand.
 *
 * ── Why the timestamp is a parameter ──────────────────────────────────────
 *
 * A `Date` and its ISO-8601 rendering are the same value on two sides of
 * `JSON.stringify`, and a single Zod schema cannot describe both: the server
 * hands the serialiser the `Date` Prisma returned, and the browser receives a
 * string. Declaring `z.string()` on the server would compile and then throw
 * at serialisation time — on the response path, which is the worst place to
 * find out — and declaring `z.date()` in the browser would reject every
 * response.
 *
 * The usual answers are both bad. Two files means the drift this package
 * exists to prevent, one field at a time. A `z.union([z.date(), z.string()])`
 * would type every client timestamp as `Date | string` and push the problem
 * into every component that formats one.
 *
 * So the field list is written once and instantiated twice, with the codec
 * for a timestamp as the only difference: `serverCircuitResponses` for
 * Fastify, `wireCircuitResponses` for the browser. Both produce `Date` on the
 * output side, so the TypeScript types are identical at both ends, and adding
 * a field is physically incapable of reaching only one of them.
 */

import {
  CircuitPreviewSchema,
  CircuitSchema,
  storableProse,
  storableText,
} from '@qsim/schema'
import { z } from 'zod'
import { VisibilitySchema, Visibility } from './visibility.js'

/** Longest title accepted. Long enough for a sentence, short enough to list. */
export const MAX_TITLE_LENGTH = 120
/** `description` is `@db.Text`, so this is a policy limit, not a column one. */
export const MAX_DESCRIPTION_LENGTH = 4000
/** A commit message for a version. Same spirit as a git subject line. */
export const MAX_MESSAGE_LENGTH = 200
/**
 * Longest tag a request may carry *before* normalisation.
 *
 * Deliberately larger than what survives: `@qsim/db` folds a tag to its
 * canonical spelling and caps the result at 32, and a name that is longer
 * than that afterwards is refused there with the position that was wrong.
 * This bound is the cheap one — it stops a kilobyte of "tag" from reaching
 * the normaliser at all — and it is not the rule.
 */
export const MAX_TAG_INPUT_LENGTH = 64
/**
 * Most tags one circuit may carry. Mirrors `MAX_TAGS_PER_CIRCUIT` in
 * `@qsim/db`, which is the authority; `apps/api` asserts the two agree, in
 * the same way and for the same reason it does for `Visibility`.
 */
export const MAX_TAGS = 8
/** Largest page a listing will serve, whatever `perPage` asks for. */
export const MAX_PER_PAGE = 100
/** What `perPage` means when a client does not say. */
export const DEFAULT_PER_PAGE = 20
/**
 * Largest page number accepted.
 *
 * `page` becomes `skip = (page - 1) * perPage` in a Prisma query, so an
 * unbounded page number is an unbounded `OFFSET`. Nothing crashes — Postgres
 * answers an offset past the end with an empty set — but a page number that
 * cannot correspond to a row is a malformed request, and the sibling
 * `VersionParams.n` already caps for exactly this reason. One million pages of
 * a hundred is a hundred million circuits, which is well past anything this
 * database will hold.
 */
export const MAX_PAGE = 1_000_000

/**
 * A title with the whitespace already gone.
 *
 * `.trim()` runs before `.min(1)`, so a title of three spaces is rejected
 * rather than stored — which matters because the gallery renders it and an
 * empty-looking card is indistinguishable from a broken one.
 *
 * `storableText` is the second half and is not cosmetic: `Circuit.title` is a
 * Postgres `text` column, a `text` column is UTF-8, and a single U+0000 in it
 * is SQLSTATE 22021 from the driver — a 500 produced by one character an
 * attacker can type. Refusing it here makes it a 400 like any other bad
 * field. See `text.ts` in @qsim/schema for the whole argument.
 */
const TitleSchema = storableText(z.string().trim().min(1).max(MAX_TITLE_LENGTH))

/** Prose, so `\n` and `\t` survive; every other control character does not. */
const DescriptionSchema = storableProse(
  z.string().trim().max(MAX_DESCRIPTION_LENGTH)
).nullable()

const MessageSchema = storableText(
  z.string().trim().max(MAX_MESSAGE_LENGTH)
).nullable()

/**
 * The tags on a request, as typed rather than as stored.
 *
 * This schema deliberately does *not* normalise. Canonicalising a tag is what
 * makes `Tag.name @unique` a browsable facet instead of a pile of near
 * duplicates, so it happens once, next to the write, in `@qsim/db` — the same
 * argument that keeps slug generation there. What is enforced here is only
 * what can be enforced without knowing that rule: the count, the length, and
 * that the strings are storable at all.
 */
export const TagsSchema = z
  .array(storableText(z.string().trim().min(1).max(MAX_TAG_INPUT_LENGTH)))
  .max(MAX_TAGS)

/* ── Requests ──────────────────────────────────────────────────────────── */

/**
 * A 1-based counter as it may appear in a URL a human edits: decimal digits
 * and nothing else.
 *
 * Deliberately *not* `z.coerce.number()`. Coercion delegates to `Number()`,
 * whose grammar is the whole of JavaScript's numeric literal syntax plus
 * surrounding whitespace — so `?page=0x10` is page 16, `?page=%20%205%20` is
 * page 5, and `?page=1e15` is a page number with fifteen zeroes in it. None of
 * those is a page number a person typed, and every one of them is an input
 * surface nobody meant to open. A digits-only string, or a number when the
 * caller is building the query in TypeScript, is the whole of what is wanted.
 */
export function pageNumber(max: number, fallback: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d+$/, { error: 'expected decimal digits' })
        .transform(Number),
    ])
    .pipe(z.int().min(1).max(max))
    .default(fallback)
}

/**
 * Page numbers are 1-based, which is what a URL a human edits should be.
 *
 * The client never parses with this schema — it builds the query string — so
 * it takes its type from the *output* side, where the numbers are numbers.
 */
export const PaginationQuery = z.object({
  /*
   * Described rather than left bare, and the reason is the generated
   * reference: the bounds live behind a `.pipe()`, so they are invisible on
   * the *input* side of the schema — which is the side a published document
   * has to describe, because it is what a caller sends. Without this the
   * reference would print a query parameter with no constraints at all, which
   * is precisely the sort of quietly-wrong sentence that generating
   * documentation is supposed to prevent.
   */
  page: pageNumber(MAX_PAGE, 1).describe(
    `The 1-based page number, at most ${String(MAX_PAGE)}.`
  ),
  perPage: pageNumber(MAX_PER_PAGE, DEFAULT_PER_PAGE).describe(
    `Rows per page, at most ${String(MAX_PER_PAGE)}.`
  ),
})

/** A resolved page selection: what the server ends up working with. */
export type Pagination = z.output<typeof PaginationQuery>
/** What a caller may ask for. Both fields have server-side defaults. */
export type PaginationParams = Partial<Pagination>

/**
 * A new circuit. `circuit` is the document itself and is re-validated by
 * `parseCircuit` in the handler — `CircuitSchema` here is what gives a 400 a
 * precise field path, not what makes the payload safe.
 *
 * There is no `gateCount`, `depth` or `qubitCount` field, and there never
 * will be: they are derived from the circuit on write (§7). A client that
 * could send them could rank itself first in the gallery and, in Phase 3, on
 * a challenge leaderboard.
 */
export const CreateCircuitBody = z.object({
  title: TitleSchema,
  description: DescriptionSchema.optional(),
  visibility: VisibilitySchema.default(Visibility.PRIVATE),
  circuit: CircuitSchema,
  message: MessageSchema.optional(),
  tags: TagsSchema.optional(),
})

/**
 * Metadata only. The circuit itself is never patched: a change to the
 * document is a new version, which is what makes the history immutable and
 * complete. Renaming a circuit does not create one.
 */
export const UpdateCircuitBody = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.optional(),
    visibility: VisibilitySchema.optional(),
    /**
     * Replaces the whole set. `[]` clears every tag, which is a thing a
     * person can ask for and is not the same request as omitting the field.
     */
    tags: TagsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'at least one field must be present',
  })

export const CreateVersionBody = z.object({
  circuit: CircuitSchema,
  message: MessageSchema.optional(),
})

/**
 * `.nullable()` and not `.optional()`: Fastify hands the validator `null`,
 * never `undefined`, for a request with no body (see the API's
 * `plugins/validation.ts`), so a genuinely optional body has to say `null`.
 */
export const ForkCircuitBody = z
  .object({ title: TitleSchema.optional() })
  .nullable()

/*
 * Request types come from the *input* side, so a caller may omit what the
 * server defaults — `visibility` on a create, `clbits` inside the circuit.
 */
export type CreateCircuitRequest = z.input<typeof CreateCircuitBody>
export type UpdateCircuitRequest = z.input<typeof UpdateCircuitBody>
export type CreateVersionRequest = z.input<typeof CreateVersionBody>
export type ForkCircuitRequest = z.input<typeof ForkCircuitBody>

/* ── Timestamps ────────────────────────────────────────────────────────── */

/** What Fastify serialises: the `Date` the handler is holding. */
export const serverTimestamp = z.date()

/**
 * What a browser receives: the ISO-8601 string `JSON.stringify` produced,
 * parsed straight back into a `Date`.
 *
 * The conversion happens here rather than in a component so that "the API
 * speaks ISO-8601" is a fact about the boundary and not about the fifteen
 * places that render a date. `z.iso.datetime()` rather than
 * `z.coerce.date()`: the latter accepts anything `new Date()` accepts,
 * including `"tomorrow"` and a bare number, so a garbled field would become a
 * plausible-looking date instead of a loud failure.
 */
export const wireTimestamp = z.iso
  .datetime()
  .transform((value) => new Date(value))

/* ── Responses ─────────────────────────────────────────────────────────── */

/**
 * Every response is an object with a named key rather than a bare resource.
 * It costs four characters and it means a field can be added beside the
 * resource — an ETag, a fork count — without the body changing shape.
 */
function buildCircuitResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  const OwnerRef = z.object({
    id: z.string(),
    username: z.string(),
    avatarUrl: z.string().nullable(),
  })

  /**
   * What a listing shows. No `description`: it is `@db.Text`.
   *
   * ── Why there is no `forkedFromId` ────────────────────────────────────
   *
   * There was one, and it was a hole. `Circuit.forkedFromId` is a handle to a
   * *different* circuit, whose visibility has nothing to do with this one's:
   * fork an UNLISTED circuit, make the fork PUBLIC, and every anonymous
   * reader of the fork was handed a working handle to the source. The owner
   * of the source could not see it, could not revoke it, and un-publishing
   * did not help — the fork kept pointing at it.
   *
   * A handle to a resource the viewer may not be allowed to read does not
   * belong in a response, whatever the field is called. Attribution is still
   * recorded on the row and is still what `POST /circuits/:id/fork` writes;
   * what it needs before it can travel is a resolved object — id, slug and
   * title of the source, or `null` — passed through the same §11 filter as
   * every other read. That is a Phase 2 shape and it is not this one.
   */
  const CircuitCardResponse = z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    visibility: VisibilitySchema,
    qubitCount: z.int(),
    gateCount: z.int(),
    depth: z.int(),
    starCount: z.int(),
    viewCount: z.int(),
    createdAt: timestamp,
    updatedAt: timestamp,
    owner: OwnerRef,
    /**
     * Canonical spellings, sorted. Present on the *card* and not only on the
     * detail because the gallery filters by tag: a facet a card cannot show
     * is one nobody can see they are standing inside.
     *
     * Unlike `forkedFromId`, a tag is a property of this circuit rather than
     * a handle to a different one, so there is no visibility question to get
     * wrong here.
     */
    tags: z.array(z.string()),
    /**
     * The thumbnail a card draws — @qsim/schema's bounded `CircuitPreview`,
     * derived from the head version on write and stored beside these counters
     * (M1.5b).
     *
     * It is on the *card* because that is the only place it is for, and it is
     * a distinct shape from the circuit itself because a listing of fifty
     * circuits must not carry fifty documents: `previewOf` keeps a handful of
     * wires and a handful of columns and throws away parameters, labels,
     * classical links and control polarity, none of which survives being drawn
     * at this size. `truncated` inside it says when the real circuit reaches
     * past the picture, because a drawing that silently omits its subject is a
     * drawing that lies.
     *
     * `null` for a circuit stored before this field existed, and for a stored
     * value that no longer parses. Both mean the same thing to a client: draw
     * the counters, not a picture.
     */
    preview: CircuitPreviewSchema.nullable(),
  })

  const CircuitDetailResponse = CircuitCardResponse.extend({
    description: z.string().nullable(),
  })

  /** A version as the history sidebar lists it. The payload is fetched singly. */
  const VersionSummaryResponse = z.object({
    id: z.string(),
    versionNum: z.int(),
    message: z.string().nullable(),
    createdAt: timestamp,
  })

  const VersionResponse = VersionSummaryResponse.extend({
    circuit: CircuitSchema,
  })

  function pageResponse<T extends z.ZodType>(item: T) {
    return z.object({
      items: z.array(item),
      page: z.int(),
      perPage: z.int(),
      total: z.int(),
      /** Precomputed so three clients do not each round it differently. */
      totalPages: z.int(),
    })
  }

  /**
   * A keyset page: the rows, and the opaque handle that resumes after them.
   *
   * There is no `total` and no `totalPages`, which is the honest shape for a
   * cursor listing — see `CursorPage` in `@qsim/db` for why counting the
   * gallery on every request is a cost paid for a number that is stale before
   * it renders. `nextCursor` is `null` exactly when this was the last page.
   *
   * The cursor is opaque *to the client on purpose*: it encodes a position in
   * a server-side ordering, and a client that parsed it would be building on
   * a shape that is free to change. It is not a credential either — every
   * page re-applies the visibility filter, so a forged cursor moves the
   * window and cannot widen it.
   */
  function cursorPageResponse<T extends z.ZodType>(item: T) {
    return z.object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
      /** Echoed because the server may have clamped what was asked for. */
      limit: z.int(),
      /**
       * The ids on *this page* that this viewer has starred. Empty for an
       * anonymous caller, who has no stars to have (M1.5b).
       *
       * ── Why it rides in the envelope and not on the card ───────────────
       *
       * For the reason `starred` rides in `CircuitViewResponse` rather than on
       * `CircuitDetailResponse`: it is not a property of a circuit, it is a
       * property of the pair (circuit, viewer). Putting a boolean on the card
       * would oblige every route that returns one — create, patch, fork, the
       * owner's own listing — to answer a question it has no reason to ask,
       * and would make a cached card wrong for the next person to sign in.
       *
       * ── Why a list and not a lookup per card ───────────────────────────
       *
       * Because a star button that does not know whether it is already
       * starred is a button that lies. The alternatives were a boolean per
       * card (above), or fifty `GET /circuits/:id` calls (the thing M1.5b's
       * preview exists to avoid). This is one indexed read of `Star` over the
       * ids the listing already returned, skipped entirely when nobody is
       * signed in — which is most of this route's traffic.
       *
       * It is scoped to the page rather than to the account on purpose: "which
       * of *these* have I starred" is answerable from the primary key, while
       * "everything I have ever starred" grows without bound and is not a
       * question any screen asks.
       */
      starred: z.array(z.string()),
    })
  }

  /** A user as a profile page shows them. No `email`, ever (§11). */
  const PublicUserResponse = z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    createdAt: timestamp,
  })

  /** A circuit and the version to open in the editor. */
  const CircuitWithVersionResponse = z.object({
    circuit: CircuitDetailResponse,
    version: VersionResponse,
  })

  return {
    OwnerRef,
    PublicUserResponse,
    CircuitCardResponse,
    CircuitDetailResponse,
    VersionSummaryResponse,
    VersionResponse,
    CircuitWithVersionResponse,
    /**
     * The same thing plus this viewer's own star, which only the *read* route
     * can answer.
     *
     * It rides in the envelope rather than on `CircuitDetailResponse` because
     * it is not a property of the circuit: it is a property of the pair
     * (circuit, viewer), and putting it on the resource would oblige every
     * route that returns a circuit — create, patch, fork — to answer a
     * question it has no reason to ask. `false` for an anonymous caller.
     */
    CircuitViewResponse: CircuitWithVersionResponse.extend({
      starred: z.boolean(),
    }),
    CircuitEnvelope: z.object({ circuit: CircuitDetailResponse }),
    VersionEnvelope: z.object({ version: VersionResponse }),
    CircuitPageResponse: pageResponse(CircuitCardResponse),
    VersionPageResponse: pageResponse(VersionSummaryResponse),
    GalleryPageResponse: cursorPageResponse(CircuitCardResponse),
    /** The profile page: whose circuits these are, and the page of them. */
    UserCircuitsResponse: cursorPageResponse(CircuitCardResponse).extend({
      user: PublicUserResponse,
    }),
  }
}

/** For Fastify's serialiser: takes the `Date` the handler returns. */
export const serverCircuitResponses = buildCircuitResponses(serverTimestamp)

/** For the browser: takes the ISO-8601 string and yields a `Date`. */
export const wireCircuitResponses = buildCircuitResponses(wireTimestamp)

/*
 * The types every consumer works with, taken from the wire instance because
 * its output side is what a parsed response actually is. They are identical
 * to the server instance's output types by construction — same field list,
 * same `Date` — which is the property the round-trip test in
 * `circuits.test.ts` asserts at runtime as well.
 */
export type CircuitOwner = z.infer<typeof wireCircuitResponses.OwnerRef>
export type CircuitCard = z.infer<
  typeof wireCircuitResponses.CircuitCardResponse
>
export type CircuitDetail = z.infer<
  typeof wireCircuitResponses.CircuitDetailResponse
>
export type CircuitVersionSummary = z.infer<
  typeof wireCircuitResponses.VersionSummaryResponse
>
export type CircuitVersion = z.infer<
  typeof wireCircuitResponses.VersionResponse
>
export type CircuitWithVersion = z.infer<
  typeof wireCircuitResponses.CircuitWithVersionResponse
>
export type CircuitView = z.infer<
  typeof wireCircuitResponses.CircuitViewResponse
>
export type CircuitEnvelope = z.infer<
  typeof wireCircuitResponses.CircuitEnvelope
>
export type VersionEnvelope = z.infer<
  typeof wireCircuitResponses.VersionEnvelope
>
export type CircuitPage = z.infer<
  typeof wireCircuitResponses.CircuitPageResponse
>
export type VersionPage = z.infer<
  typeof wireCircuitResponses.VersionPageResponse
>
export type PublicUser = z.infer<typeof wireCircuitResponses.PublicUserResponse>
export type GalleryPage = z.infer<
  typeof wireCircuitResponses.GalleryPageResponse
>
export type UserCircuitsPage = z.infer<
  typeof wireCircuitResponses.UserCircuitsResponse
>
