/**
 * Profiles and settings, as the wire carries them — §3.4, §8, milestone M1.9.
 *
 * ── What a profile response may contain ───────────────────────────────────
 *
 * The user shape is `PublicUserResponse` from `circuits.ts` and there is no
 * second one, not even for `GET /me`. `email` is absent from it, and the way
 * that stays true is that no other projection of a user exists to reach for:
 * `@qsim/db` selects through `publicUserSelect`, this package describes that
 * and nothing else, and Fastify serialises responses *through* these schemas,
 * so a handler holding a row with an address in it still cannot send one.
 *
 * A signed-in caller reading their own settings does not need the API to tell
 * them their address either — it is a claim in the token they authenticated
 * with, and `apps/web` reads it off the Supabase session.
 *
 * ── The username is a public address ──────────────────────────────────────
 *
 * It appears in a URL (`/users/:username`), so it is validated here against
 * the same alphabet `@qsim/db`'s `USERNAME_PATTERN` accepts — re-declared for
 * the reason `Visibility` is re-declared: `apps/web` may not import
 * `@qsim/db` (§12.3), and a browser enforcing a wider alphabet than the server
 * is a settings form that offers to save something the API refuses.
 * `apps/api` imports both and asserts they agree.
 *
 * ── Why the avatar is a choice and not a URL ──────────────────────────────
 *
 * `UpdateProfileBody` has no `avatarUrl`. A URL accepted from a request body
 * would be rendered by every other reader's browser — a public profile is
 * read by strangers — which makes it a way to log who looked at whom, and a
 * `javascript:` or `data:` value one component away from being a stored XSS.
 * (`verify.ts` in `apps/api` already had to restrict the scheme of the
 * provider's own claim for the second of those.)
 *
 * So the caller picks a *source* instead. `provider` means "the picture the
 * identity I signed in with hands out", which the API reads off the verified
 * token and never off the body; `generated` means "none — draw me one", which
 * `apps/web` does deterministically from the user id. Both are values a user
 * can choose and neither is a string an attacker can supply.
 */

import { storableText } from '@qsim/schema'
import { z } from 'zod'
import { serverCircuitResponses, wireCircuitResponses } from './circuits.js'

/** Longest display name accepted. Longer than any name, shorter than a bio. */
export const MAX_DISPLAY_NAME_LENGTH = 80

export const MIN_USERNAME_LENGTH = 3
export const MAX_USERNAME_LENGTH = 32

/**
 * The alphabet a username may use: lowercase, digits, underscore, hyphen.
 *
 * Mirrors `USERNAME_PATTERN` in `@qsim/db`, which is the authority because it
 * is what `ensureUser` can actually mint. `apps/api` asserts the two agree, in
 * the same way and for the same reason it does for `Visibility` and the tag
 * cap.
 */
export const USERNAME_PATTERN = new RegExp(
  `^[a-z0-9_-]{${String(MIN_USERNAME_LENGTH)},${String(MAX_USERNAME_LENGTH)}}$`
)

export const UsernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_PATTERN, { error: 'invalid_username' })

/**
 * A display name, or `null` for "I have none".
 *
 * ── Why the empty string is refused rather than accepted ──────────────────
 *
 * There was no minimum here, so `PATCH /me {"displayName": "   "}` answered
 * 200 and stored `""` — and the public profile's only name heading is
 * `displayName ?? username`, which `??` does not fall through for an empty
 * string. The result was an `<h2>` with no text in it at all: measured, the
 * heading's `innerText` and `innerHTML` were both empty.
 *
 * "Blank" and "none" are different requests and this API keeps them different.
 * `null` is how a name is cleared — the settings form already sends exactly
 * that for an empty field — and a string of spaces is a request that means
 * nothing, refused the way an empty PATCH is refused below rather than quietly
 * turned into something else.
 */
const DisplayNameSchema = storableText(
  z
    .string()
    .trim()
    .min(1, { error: 'empty_display_name' })
    .max(MAX_DISPLAY_NAME_LENGTH)
).nullable()

/** Where a profile picture comes from. Never a URL — see the header. */
export const AVATAR_SOURCES = ['provider', 'generated'] as const
export type AvatarSource = (typeof AVATAR_SOURCES)[number]
export const AvatarSourceSchema = z.enum(AVATAR_SOURCES)

/**
 * A settings change. Every field is optional and at least one must be present
 * — an empty PATCH is a request that means nothing, and answering 200 to it
 * would tell a client its form worked when nothing was sent.
 *
 * `displayName: null` clears it, which is a thing a person can ask for and is
 * not the same request as omitting the field.
 */
export const UpdateProfileBody = z
  .object({
    displayName: DisplayNameSchema.optional(),
    username: UsernameSchema.optional(),
    avatar: AvatarSourceSchema.optional(),
    /**
     * "Do not print my name on a challenge leaderboard" (§3.6, Phase 3).
     *
     * The one field here that is a *setting* rather than a description of the
     * person, which is why it is not part of the user shape below: a
     * preference is not a public fact, and on `PublicUserResponse` it would be
     * published in every circuit byline to strangers who have no use for it.
     */
    leaderboardOptOut: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'at least one field must be present',
  })

export type UpdateProfileRequest = z.input<typeof UpdateProfileBody>

/**
 * Deleting an account: the caller retypes their own username.
 *
 * Not a password — this API has never seen one (§11 delegates that to
 * Supabase) — and not a bare `DELETE`, because the one irreversible route in
 * the product should not be reachable by a single mistyped `fetch`. The value
 * is compared on the server against the row being deleted, so a client cannot
 * decide what counts as confirmation.
 */
export const DeleteAccountBody = z.object({ confirm: z.string() })

export type DeleteAccountRequest = z.input<typeof DeleteAccountBody>

/**
 * The three responses of this file, instantiated twice like every other shape
 * in this package — once with the server's `Date` timestamps and once with the
 * browser's ISO-8601 ones. Here the timestamp only appears *inside* the user
 * shape, so that shape is the whole parameter and there is nothing else to
 * vary.
 */
function buildUserResponses<User extends z.ZodType>(user: User) {
  /*
   * A deletion answers with a body rather than 204, because "your account is
   * gone" is the one message a user genuinely wants evidence for — and
   * because these counts are the only place the orphan sweep in `@qsim/db`
   * becomes visible. `orphanedCollectionItems` is the one number here that
   * describes a change to somebody else's data.
   */
  const AccountDeletionResponse = z.object({
    deleted: z.object({
      circuits: z.int(),
      collections: z.int(),
      comments: z.int(),
      stars: z.int(),
      simulationRuns: z.int(),
      hardwareJobs: z.int(),
      orphanedCollectionItems: z.int(),
    }),
  })

  return {
    /**
     * `GET /me` and `PATCH /me`. The same *user* shape a stranger sees, plus
     * the settings that are nobody else's business.
     *
     * `leaderboardOptOut` is a sibling of `user` rather than a field on it, and
     * the split is the whole privacy design in one line: the user shape is what
     * this API is willing to print beside somebody's work, and a preference is
     * not that. Putting it inside would publish it on every gallery card, since
     * `PublicUserResponse` is what a byline serialises through. Here it can
     * only leave the process on the three routes that require the caller to be
     * the subject.
     */
    AccountResponse: z.object({ user, leaderboardOptOut: z.boolean() }),
    /**
     * `GET /users/:username`.
     *
     * The two counts are the profile's whole content beyond the name, and both
     * are computed through the §11 filters — `circuitCount` through the very
     * `where` the gallery listing uses. An aggregate is a listing: a count
     * that skipped the filter would report a stranger's private work in a
     * single integer, which is smaller than a leak and is still one. So the
     * number an anonymous reader sees is the number of cards they would get if
     * they paged to the end, and the owner reading their own profile sees
     * their own larger one.
     */
    ProfileResponse: z.object({
      user,
      circuitCount: z.int(),
      collectionCount: z.int(),
    }),
    AccountDeletionResponse,
  }
}

export const serverUserResponses = buildUserResponses(
  serverCircuitResponses.PublicUserResponse
)

export const wireUserResponses = buildUserResponses(
  wireCircuitResponses.PublicUserResponse
)

export type Account = z.infer<typeof wireUserResponses.AccountResponse>
export type Profile = z.infer<typeof wireUserResponses.ProfileResponse>
export type AccountDeletion = z.infer<
  typeof wireUserResponses.AccountDeletionResponse
>
