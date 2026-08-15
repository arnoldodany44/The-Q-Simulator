import { nanoid } from 'nanoid'

/**
 * The public handle of a circuit — specification §11.
 *
 * ── Why the slug carries a security requirement at all ────────────────────
 *
 * An UNLISTED circuit has no other protection. It is not in the gallery, it
 * is not in anybody's listing, and it answers to an anonymous caller. The
 * only thing standing between it and the world is that nobody can produce its
 * address by accident or by trying. So the slug is not a nicety like a blog
 * permalink; it *is* the access control, and it has to be sized as one.
 *
 * ── The size, and what it buys ────────────────────────────────────────────
 *
 * 21 characters from nanoid's 64-symbol URL-safe alphabet, which is
 * 21 × log2(64) = **126 bits**. Three numbers follow from that:
 *
 *  - **Guessing one particular circuit.** 2^126 ≈ 8.5 × 10^37 candidates. The
 *    API's own limiter allows 300 requests per minute per caller, so a single
 *    attacker gets ~1.6 × 10^8 guesses per year. Even a hypothetical attacker
 *    unbounded by that, running 10^9 guesses a second, needs ~10^21 years.
 *  - **Guessing *any* circuit**, which is the number that actually matters —
 *    an enumerator does not care which unlisted circuit it finds. With 10^9
 *    circuits stored, each guess hits with probability 10^9 / 2^126 ≈ 1.2 ×
 *    10^-29. At 10^9 guesses a second that is still ~10^12 years.
 *  - **Collisions.** The birthday bound puts a 50% chance of a single
 *    collision at ~2^63 ≈ 9.2 × 10^18 slugs. The unique index on
 *    `Circuit.slug` is the backstop regardless, and the repository retries a
 *    fresh slug on a conflict, so a collision costs one wasted insert rather
 *    than an error.
 *
 * 126 bits is far past the point where a shorter slug would still be safe —
 * 64 bits already resists an online attacker. It is chosen because it is
 * nanoid's default (no custom alphabet to get wrong, and the generator is the
 * audited path), because 21 characters is still a comfortable URL, and
 * because the entropy budget is the one thing here that cannot be raised
 * later: every slug already minted keeps whatever it was born with.
 *
 * ── What the alphabet is not ──────────────────────────────────────────────
 *
 * It is not the human-readable alphabet `users.ts` uses for username
 * suffixes. A username is read off someone's screen and retyped, so `0`/`O`
 * ambiguity matters there. A slug is copied, pasted and clicked, never
 * transcribed, so the wider alphabet is free entropy.
 */

/** Characters in a slug. See the entropy argument above before changing it. */
export const CIRCUIT_SLUG_LENGTH = 21

/** Entropy of a generated slug, in bits: 21 characters × 6 bits each. */
export const CIRCUIT_SLUG_ENTROPY_BITS = 126

/**
 * Shape of a slug as it may appear in a URL.
 *
 * Deliberately a range rather than the exact length: it is validated at the
 * edge to keep a megabyte of path from reaching a query, not to re-decide
 * what this module generates. Pinning it to exactly 21 would make any future
 * change of `CIRCUIT_SLUG_LENGTH` retroactively invalidate every slug already
 * handed out, which is the one thing a permanent public handle may not do.
 */
export const CIRCUIT_HANDLE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** A fresh, unguessable public handle. Uniqueness is the database's job. */
export function generateCircuitSlug(): string {
  return nanoid(CIRCUIT_SLUG_LENGTH)
}

/**
 * Whether a path segment could be a circuit handle — a slug or a cuid — at
 * all. Cheap enough to run before touching the database, which is the point:
 * an indexed lookup is not free, and a handle nobody could have minted should
 * never become one.
 */
export function isCircuitHandle(value: string): boolean {
  return CIRCUIT_HANDLE_PATTERN.test(value)
}
