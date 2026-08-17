/**
 * Where a challenge's words live — D2, §11, Phase 3.
 *
 * The API sends no prose. It sends a slug and a set of rules, and every word a
 * reader sees comes from `apps/web`'s three catalogs — the same arrangement
 * every error code in this app already has, and for the same reason: a sentence
 * written in the API is English in a place no catalog covers and no parity test
 * can see.
 *
 * `CHALLENGE_SLUGS` in `@qsim/contract` is the agreement that makes that safe.
 * The seed writes exactly that list, this catalog is asserted to cover exactly
 * that list, and `isChallengeSlug` narrows anything else — so an API deployed
 * ahead of this bundle produces a challenge that is skipped rather than a card
 * titled `challenges.catalog.x.title`.
 */

import { CHALLENGE_SLUGS, isChallengeSlug } from '@qsim/contract'
import type { Challenge } from '@qsim/contract'

export { CHALLENGE_SLUGS, isChallengeSlug }

/** The `challenges` catalog key for one of a challenge's own strings. */
export function challengeKey(slug: string, field: 'title' | 'prompt'): string {
  return `catalog.${slug}.${field}`
}

/**
 * The challenges this bundle can render, in the order the server sent them.
 *
 * Filtered rather than trusted — see the header. The order is the server's,
 * because `orderIndex` is the curriculum and the server is where it is
 * maintained; sorting here would be a second opinion about a sequence.
 */
export function renderable(items: readonly Challenge[]): Challenge[] {
  return items.filter((item) => isChallengeSlug(item.slug))
}
