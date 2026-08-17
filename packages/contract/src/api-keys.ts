/**
 * The public API's own credential — §3.5, §7's `ApiKey`, §11.
 *
 * §3.5: «API pública con API keys: crear circuitos, correr simulaciones y
 * consultar resultados desde fuera.»
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SHAPE OF THE SECRET, AND WHY EVERY PART OF IT IS A DECISION
 *
 * A key is `qsk_` followed by 43 characters of base64url — 32 bytes from a
 * CSPRNG, unpadded. Four properties, none of them decoration:
 *
 *   1. **A fixed, distinctive prefix.** A leaked key has to be recognisable
 *      *as a credential of this product* by someone who has never heard of it:
 *      a reviewer skimming a diff, an operator reading a log, a secret scanner
 *      crawling a public repository. `qsk_` is four characters that appear in
 *      no natural text and in no other vendor's format, so one grep finds
 *      every one of them.
 *   2. **A fixed total length.** 47 characters, always. That is what turns
 *      "find the keys" into a single regex with no false positives worth
 *      mentioning — `API_KEY_PATTERN` below is publishable as a scanning rule,
 *      and this file is where a scanner author would read it from.
 *   3. **base64url and nothing else.** The alphabet survives a URL, a shell
 *      argument, a `.env` file, a YAML scalar and a JSON string without
 *      quoting or escaping, so nobody is ever tempted to "fix" a key by
 *      wrapping it. No `+`, no `/`, no `=`.
 *   4. **256 bits of entropy.** Not because anyone can guess a key online —
 *      the rate limiter answers that — but because the stored form is a plain
 *      SHA-256 (see `apps/api/src/api-keys/secret.ts` for the whole argument),
 *      and a plain hash is only sound over a secret with no structure to
 *      attack. 32 random bytes have none.
 *
 * There is deliberately **no checksum** in the format, unlike GitHub's. A
 * checksum lets a scanner drop false positives before reporting, which is
 * worth having when the prefix is three characters and the tail is free-form;
 * here the prefix is four characters *and* the length is fixed *and* the
 * alphabet is closed, so the false-positive rate is already dominated by
 * strings that were deliberately written to look like keys. What a checksum
 * would add is a second algorithm that two implementations can disagree about,
 * and the failure mode of that disagreement is a valid key rejected as
 * malformed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SECRET APPEARS IN EXACTLY ONE RESPONSE, ONCE, FOR EVER
 *
 * `ApiKeyCreatedEnvelope` is the only schema in this package with a field that
 * can hold a key, and it is the response of `POST /api-keys` alone. Every
 * other shape here is `ApiKeyResponse`, which has no such field — not a
 * masked one, not a truncated one, not a "last four". The server stores a
 * hash and cannot produce the key again even for its owner, so a second
 * endpoint could not exist however hard someone asked for one.
 *
 * What the list *does* carry is `keyPrefix`: the literal first
 * `API_KEY_HINT_LENGTH` characters of the key, which is `qsk_` plus six.
 * That is a deliberate, bounded disclosure and it is not the "last four"
 * convention borrowed from card numbers that `hardware.ts` refuses next door.
 * The difference is what the remainder is worth: a card number is fifteen
 * digits of structure, so four of them narrows it enormously, while a key is
 * 258 bits of uniform randomness, so revealing six base64url characters leaves
 * 222 bits — a number that is not meaningfully smaller than 258 to anybody
 * doing anything. And the disclosure buys the one thing a list of credentials
 * has to offer: telling two of them apart when the labels have gone stale.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY SCOPES, AND WHY EXACTLY THESE THREE
 *
 * All-or-nothing would have been cheaper to write and is the wrong trade. A
 * key is pasted into a CI job, a notebook, a script somebody's colleague runs;
 * the interesting question is never "is this person allowed" — the key acts as
 * its user and can never exceed them — but "how much does this *particular*
 * copy of their authority cost when it leaks". A read-only key in a public
 * notebook is an embarrassment. The same notebook with an unscoped key is
 * somebody deleting every circuit its owner has.
 *
 * Three scopes, because three is what the surface actually divides into:
 *
 *   `read`      every GET of the public surface — the caller's circuits, their
 *               versions, the gallery, collections, a finished run.
 *   `write`     everything that creates, edits or destroys a document.
 *   `simulate`  `POST /simulate`, which is not a write (it stores a run, not a
 *               circuit) and is not a read (it consumes CPU that §11 puts a
 *               resource ceiling on). Separating it is what lets somebody hand
 *               out a key that can run their circuits without being able to
 *               change them.
 *
 * Two capabilities are **not** reachable by any scope, and their absence is
 * the security property rather than an omission:
 *
 *   - **Key management.** No key may create, list or revoke a key. A key that
 *     could mint keys turns one leak into permanent, self-renewing access that
 *     survives revoking the key that was leaked — the escalation that makes
 *     revocation meaningless. `/api-keys` is reachable with a session and
 *     nothing else.
 *   - **Hardware (§3.7).** No key may store a credential, list devices or
 *     submit a job. The Open Plan grants ten minutes of QPU time per
 *     twenty-eight days and does not refill on request (risk 4), so a leaked
 *     key with hardware access spends a resource its owner cannot buy back.
 *     A person deciding to spend that should be looking at the screen that
 *     says so.
 *
 * The general rule those two are instances of: a route is unreachable by a key
 * unless it *declares* a scope. `apps/api` enforces that at boot and a test
 * pins the exact list, so the public API can only grow on purpose.
 */

import { storableText } from '@qsim/schema'
import { z } from 'zod'
import { serverTimestamp, wireTimestamp } from './circuits.js'

/* ─────────────────────────────── the format ─────────────────────────── */

/**
 * What every key of this product starts with. Grep for it.
 *
 * `qsk` is "Q simulator key". Short enough to type, long enough that it does
 * not occur by accident, and it is the string a secret scanner matches on.
 */
export const API_KEY_PREFIX = 'qsk_'

/** Bytes of randomness behind the secret. See the header for why 32. */
export const API_KEY_SECRET_BYTES = 32

/**
 * Characters the base64url encoding of `API_KEY_SECRET_BYTES` occupies,
 * unpadded: `ceil(32 * 4 / 3)` = 43.
 *
 * Written as a computed constant rather than as `43` so that changing the byte
 * count cannot leave a pattern that no minted key matches — the one bug in a
 * format like this that would present as "every key is rejected".
 */
export const API_KEY_SECRET_LENGTH = Math.ceil((API_KEY_SECRET_BYTES * 4) / 3)

/** Total characters in a key: the prefix plus the secret. */
export const API_KEY_LENGTH = API_KEY_PREFIX.length + API_KEY_SECRET_LENGTH

/**
 * The scanning rule, and the gate every presented credential passes before
 * anything touches a database.
 *
 * Anchored, fixed-length and closed-alphabet, so it is safe to publish as a
 * detection pattern and cheap to run on every request. `apps/api` uses it as a
 * pre-filter precisely because the cheapest possible rejection of a
 * made-up token is the one that never becomes a query.
 */
export const API_KEY_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}[A-Za-z0-9_-]{${String(API_KEY_SECRET_LENGTH)}}$`
)

/**
 * How much of a key is stored in the clear and shown in a listing.
 *
 * The prefix plus six characters. See the header for why this is a bounded
 * disclosure worth making and not the card-number convention.
 */
export const API_KEY_HINT_LENGTH = API_KEY_PREFIX.length + 6

/** Whether a string has the shape of a key. Never whether it *is* one. */
export function isApiKeyFormat(value: string): boolean {
  return API_KEY_PATTERN.test(value)
}

/**
 * The displayable head of a key.
 *
 * Exported from the contract rather than computed in two places, because the
 * server derives it when minting and the browser renders it in a list, and a
 * mismatch would be a settings screen showing a prefix that matches no key
 * anybody holds.
 */
export function apiKeyHint(key: string): string {
  return key.slice(0, API_KEY_HINT_LENGTH)
}

/* ─────────────────────────────── the scopes ─────────────────────────── */

/**
 * What a key is allowed to do, in the order of increasing consequence.
 *
 * The order is the one a settings screen lists them in, and it is not
 * alphabetical: someone ticking boxes down a column should meet the harmless
 * one first.
 */
export const API_KEY_SCOPES = ['read', 'write', 'simulate'] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES)

const API_KEY_SCOPE_SET: ReadonlySet<string> = new Set(API_KEY_SCOPES)

/**
 * Narrows a string that came out of a database column.
 *
 * `ApiKey.scopes` is `TEXT[]`, so a row written by a future build — or by
 * anything with write access to the table — can hold a value this build has
 * never heard of. An unknown scope must be *dropped*, never passed through:
 * a scope check compares against this union, and a string that is not in it
 * grants nothing.
 */
export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && API_KEY_SCOPE_SET.has(value)
}

/* ──────────────────────────────── requests ──────────────────────────── */

/** Longest name a key may carry. A note to its owner, not an identifier. */
export const MAX_API_KEY_NAME_LENGTH = 60

/**
 * How many keys one account may hold at once, revoked ones excluded.
 *
 * Mirrors `MAX_ACTIVE_API_KEYS` in `@qsim/db`, which is the authority because
 * it is the side that can actually refuse an insert; this copy exists because
 * `apps/web` may not import that package (§12.3, rule 3) and a settings screen
 * has to be able to say "you are at twenty" before sending a request. `apps/api`
 * sees both and asserts they agree — the same arrangement `MAX_COLLECTION_ITEMS`
 * and `USERNAME_PATTERN` have, and for the same reason: a browser enforcing a
 * different ceiling than the server is a form that offers what the API refuses.
 */
export const MAX_ACTIVE_API_KEYS = 20

/**
 * Minting a key.
 *
 * `name` is required and not optional, which is the one piece of friction this
 * route deliberately keeps. A list of six keys called "API key" is a list
 * nobody can revoke safely — and the moment somebody cannot tell which key a
 * production job holds, the honest response to a leak stops being "revoke
 * that one" and becomes "revoke everything and find out what breaks".
 *
 * `scopes` is required and must be non-empty for the same family of reasons:
 * a default would be either too generous (and chosen by nobody) or too narrow
 * (and worked around by ticking every box out of irritation). Asking is
 * cheaper than either.
 */
export const CreateApiKeyBody = z.object({
  name: storableText(z.string().trim().min(1).max(MAX_API_KEY_NAME_LENGTH)),
  scopes: z
    .array(ApiKeyScopeSchema)
    .min(1, { error: 'at_least_one_scope' })
    .max(API_KEY_SCOPES.length)
    /*
     * Deduplicated here rather than trusted, so `['read','read']` cannot
     * become two rows' worth of storage or a listing that shows a scope twice.
     * A `Set` is the shortest honest spelling and preserves the order the
     * caller sent, which is what a client's own checkbox column produces.
     */
    .transform((scopes) => [...new Set(scopes)]),
})

export type CreateApiKeyRequest = z.input<typeof CreateApiKeyBody>

/* ─────────────────────────────── responses ──────────────────────────── */

/**
 * Both instantiations of every response in this file, once over the `Date` the
 * server holds and once over the ISO-8601 string the browser receives — the
 * arrangement every other module here uses, for the reason stated in
 * `circuits.ts`.
 */
function buildApiKeyResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  /**
   * A key as everyone but its creator ever sees it.
   *
   * There is no field here that could hold a secret. That is the whole schema
   * and it is enforced by the serialiser: `apps/api` serialises *through*
   * this, so a handler holding a row with a hash on it still cannot send one.
   *
   * `revokedAt` travels rather than the row being hidden, because a revoked
   * key is a fact somebody may need: "was this the key that leaked, and when
   * did I turn it off" is a question asked after the fact, and an API that
   * silently dropped the row would answer it with nothing.
   */
  const ApiKeyResponse = z.object({
    id: z.string(),
    name: z.string(),
    /** The first `API_KEY_HINT_LENGTH` characters. Never more. */
    keyPrefix: z.string(),
    scopes: z.array(ApiKeyScopeSchema),
    createdAt: timestamp,
    /**
     * When this key last authenticated a request, or `null` for one that never
     * has.
     *
     * The single most useful field on the whole resource, and the reason is
     * revocation: "which of these six can I turn off" is unanswerable from
     * names and dates, and answerable at a glance from a column where three
     * rows say "never". It is deliberately coarse — see the API's throttle —
     * so it says "this key is in use" rather than logging a request history.
     */
    lastUsedAt: timestamp.nullable(),
    /** When it was revoked. Set once, never cleared. */
    revokedAt: timestamp.nullable(),
  })

  return {
    ApiKeyResponse,
    ApiKeyListEnvelope: z.object({ apiKeys: z.array(ApiKeyResponse) }),
    ApiKeyEnvelope: z.object({ apiKey: ApiKeyResponse }),
    /**
     * The response of `POST /api-keys`, and the only place a key is ever
     * transmitted.
     *
     * `key` is the plaintext. It is in the body of a 201 and it exists nowhere
     * else in the system: not in a log (the API scrubs it), not in the
     * database (only a SHA-256 is stored), not in any other response. A client
     * that does not put it in front of a human at this moment has lost it, and
     * that is stated here because the schema is the only place both ends of
     * the call are looking.
     */
    ApiKeyCreatedEnvelope: z.object({
      apiKey: ApiKeyResponse,
      key: z.string(),
    }),
  }
}

export const serverApiKeyResponses = buildApiKeyResponses(serverTimestamp)
export const wireApiKeyResponses = buildApiKeyResponses(wireTimestamp)

export type ApiKey = z.infer<typeof wireApiKeyResponses.ApiKeyResponse>
export type ApiKeyList = z.infer<typeof wireApiKeyResponses.ApiKeyListEnvelope>
export type ApiKeyCreated = z.infer<
  typeof wireApiKeyResponses.ApiKeyCreatedEnvelope
>
