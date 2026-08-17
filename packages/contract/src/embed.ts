/**
 * The embed route's wire contract — §3.4 ("enlaces compartibles y embeds"),
 * §11 ("embeds servidos con CSP restrictiva y en modo solo lectura").
 *
 * ── This response is a projection, and the projection IS the security ─────
 *
 * An embed is served *into somebody else's page*. Everything in this shape
 * ends up inside a document this project does not control, read by people who
 * never visited this app, so the field list is the whole of what a third party
 * learns about a circuit and about the person who wrote it. It is therefore
 * built from what a reader needs rather than from what a row has, and every
 * field a circuit *does* have and this one does not is a deliberate omission:
 *
 *   - `id`. A handle to a resource. `idAddressableCircuitFilter` in `@qsim/db`
 *     exists because ids escaping into responses had already opened an
 *     UNLISTED circuit once (through `forkedFromId`), and the lesson recorded
 *     there is that a handle in a response is a handle in the wild. An embed
 *     needs no handle: it was addressed by one.
 *   - `visibility`. An embed exists only for the two visibilities that are
 *     embeddable, so the field would carry no information a reader could act
 *     on — while printing "unlisted" in a stranger's blog post publishes the
 *     owner's decision about who should find their work.
 *   - `description`. User prose, shipped into a third party's document. It is
 *     escaped by React like any other string, so this is not an injection
 *     defence; it is that an embed is a picture of a circuit and the sentence
 *     around it belongs to whoever wrote the page. Every user-authored string
 *     that travels is one more thing a teacher cannot moderate.
 *   - `avatarUrl`. It points at an OAuth provider's CDN, so carrying it would
 *     mean the embed issues a cross-origin image request from inside a
 *     stranger's page — a third-party request, and therefore an IP address,
 *     per reader — and would force `img-src` in the embed's Content-Security-
 *     Policy open to `https:`. §10 already refuses that trade for fonts.
 *   - `starCount`, `viewCount`, `createdAt`, `updatedAt`, `tags`, `preview`.
 *     Social and catalogue metadata. None of it is part of the circuit, all of
 *     it changes under a reader who is looking at a slide.
 *
 * What is left is a picture of a circuit, the three numbers that describe it,
 * and a name to credit.
 *
 * ── The three numbers are the server's, not the client's ─────────────────
 *
 * `qubitCount`, `gateCount` and `depth` are the denormalised columns `@qsim/db`
 * computes with @qsim/schema's helpers on every write, over the *expanded*
 * circuit (§3.1, decision 3). The embed prints them rather than recomputing
 * them in the browser for the same reason a leaderboard ranks on them: they
 * are what the engine would actually run, and a second derivation is a second
 * chance to disagree.
 *
 * ── One schema, not two ──────────────────────────────────────────────────
 *
 * `circuits.ts` instantiates its response shapes twice, once per timestamp
 * codec, because a `Date` and its ISO-8601 rendering cannot be one Zod schema.
 * Nothing here is a timestamp, so there is nothing to parameterise: `apps/api`
 * serialises through this object and `apps/web` parses with the same one.
 */

import { CircuitSchema } from '@qsim/schema'
import { z } from 'zod'

/**
 * Who to credit, and nothing else.
 *
 * No `id` and no `avatarUrl` — see the header for both. No `displayName`
 * either, and that one is a decision about the *query* rather than about this
 * shape: `circuitCardSelect` in `@qsim/db` fetches `{ id, username,
 * avatarUrl }` for an author, and widening it so an embed could print a
 * friendlier name would widen it for every gallery card in the product, on
 * every listing, to serve one caption. The username is a name its owner chose
 * and is the handle their profile lives at, so it is a credit that works.
 */
export const EmbedAuthor = z.object({
  username: z.string(),
})

/** The circuit as a third party's page receives it. */
export const EmbedCircuit = z.object({
  /**
   * The handle this embed was addressed by, echoed back.
   *
   * It is here for one job: the page can print the canonical address of the
   * circuit as text, so a reader of a blog post can find the original. It is
   * not a leak of the kind `id` would be — the caller already presented it.
   */
  slug: z.string(),
  title: z.string(),
  qubitCount: z.int(),
  gateCount: z.int(),
  depth: z.int(),
  author: EmbedAuthor,
  /**
   * The document itself, straight through `CircuitSchema`.
   *
   * The whole circuit and not `CircuitPreview`: a thumbnail throws away
   * parameters, control polarity and classical links (see `preview.ts`), and
   * an embed is the drawing rather than an icon of it. It is also what the
   * page simulates, which a preview could not be.
   */
  circuit: CircuitSchema,
})

/**
 * The envelope, for the reason `circuits.ts` gives for its own: a field can be
 * added beside the resource — a rendered-at stamp, a licence — without the
 * body changing shape.
 */
export const EmbedCircuitResponse = z.object({ embed: EmbedCircuit })

export type EmbedAuthorRef = z.infer<typeof EmbedAuthor>
export type EmbedCircuitView = z.infer<typeof EmbedCircuit>
export type EmbedCircuitResponseBody = z.infer<typeof EmbedCircuitResponse>
