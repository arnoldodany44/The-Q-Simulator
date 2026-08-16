/**
 * What a fork carries with it into the editor — M1.5b.
 *
 * ── Why the attribution is carried and not fetched ────────────────────────
 *
 * Because the API deliberately will not tell us. `Circuit.forkedFromId` is
 * recorded on the row and appears in no response: it is a handle to a
 * *different* circuit with a different visibility, and publishing it once
 * handed every anonymous reader of a fork a working handle to the UNLISTED
 * circuit it came from — readable title, description and full history, with no
 * way for the owner to notice or revoke it. The argument is written out on
 * `CircuitCardResponse` in @qsim/contract, and `idAddressableCircuitFilter` in
 * @qsim/db is the other half of the fix. A resolved, visibility-checked
 * `forkedFrom` object is a Phase 2 shape.
 *
 * Until then the honest claim is a narrower one, and it is exactly the claim a
 * browser tab can support: *this tab just forked that circuit, whose title and
 * author it was showing at the time*. It travels in history state — not in the
 * URL, for the reason `features/auth/paths.ts` gives about `?next=` — so it
 * survives the navigation, disappears on a reload, and asserts nothing the
 * server would have to vouch for.
 *
 * Pure, and its own module so that the reading of it can be tested without a
 * router and without rendering anything.
 */

/** The history-state key a fork navigation writes and the editor reads. */
export const FORKED_FROM_STATE_KEY = 'forkedFrom'

/** What this tab knows about the circuit a fork was made from. */
export interface ForkAttribution {
  readonly title: string
  readonly username: string
}

/**
 * Reads the attribution a fork navigation recorded, or `null`.
 *
 * Total and suspicious, because history state is attacker-influenceable in
 * exactly the way a URL is: a crafted link can push an entry carrying any
 * shape at all. The values are rendered as text and nothing branches on them,
 * so the worst a forged one could do is put a sentence on screen that the
 * reader did not earn — and refusing anything that is not two non-empty
 * strings keeps even that off it.
 */
export function forkAttributionFrom(state: unknown): ForkAttribution | null {
  if (typeof state !== 'object' || state === null) return null
  const carried = (state as Record<string, unknown>)[FORKED_FROM_STATE_KEY]
  if (typeof carried !== 'object' || carried === null) return null

  const { title, username } = carried as Record<string, unknown>
  if (typeof title !== 'string' || typeof username !== 'string') return null
  if (title === '' || username === '') return null
  return { title, username }
}
