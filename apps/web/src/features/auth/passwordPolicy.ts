/**
 * The rules the *server* applies to a new password, and nothing else.
 *
 * ── Why this is a measured number and not a good idea ─────────────────────
 *
 * A client that demands more than the server does is worse than one that
 * demands nothing. It rejects passwords the account would have accepted, it
 * teaches the user a rule that is not true, and — the part that actually
 * costs — it drifts: the day somebody raises the policy in the Supabase
 * dashboard, the form still enforces yesterday's rule and the *server's*
 * rejection arrives as a surprise the form said could not happen. "At least
 * eight characters, one digit and one symbol" is the shape of that mistake,
 * and it is invented in a component every time.
 *
 * So the number below was read off the project rather than chosen. Asking
 * `POST /auth/v1/signup` for an impossible password — one character, which no
 * Supabase configuration can accept, so nothing is created — answers:
 *
 *     422 {"code":422,"error_code":"weak_password",
 *          "msg":"Password should be at least 6 characters.",
 *          "weak_password":{"reasons":["length"]}}
 *
 * One reason, `length`. No character-class requirement, because
 * `password_required_characters` is empty on this project. Six is therefore
 * the whole of the *minimum*.
 *
 * ── There is a ceiling too, and it is counted in bytes ────────────────────
 *
 * A rule the client not having is the mirror of a rule it invents, and it
 * costs more: `PUT /auth/v1/user` accepts exactly 72 characters and answers 73
 * with
 *
 *     400 {"error_code":"validation_failed",
 *          "msg":"Password cannot be longer than 72 characters"}
 *
 * — bcrypt's input limit, which every Supabase project has. `validation_failed`
 * had no entry in `authErrors.ts`, so the code came back `UNKNOWN` and the
 * screen whose entire job is setting a password said "sign-in did not work",
 * directly under a hint promising nothing else was required. Retrying could
 * never succeed.
 *
 * "72 characters" is the server's wording and not what the server counts.
 * Measured: twenty emoji — forty JS code units, eighty UTF-8 bytes — are also
 * refused, so the limit is on the encoded bytes. This counts the same thing,
 * which is what makes it a check rather than an approximation.
 *
 * The two limits are deliberately counted differently. The minimum stays in
 * code units, which is permissive — no password this accepts can be refused
 * for being short. The maximum is in bytes, which is conservative — no
 * password this accepts can be refused for being long. Both err toward letting
 * the server have the last word.
 *
 * ── This check is a courtesy, not a control ───────────────────────────────
 *
 * §11: the server decides. `WEAK_PASSWORD` is in `AUTH_FAILURE_CODES` and
 * every form renders it, so a policy raised in the dashboard tomorrow still
 * produces a translated sentence — this only spares the user a round trip for
 * a rejection that is certain. When the two disagree, the server wins and the
 * user sees the server's answer.
 *
 * ── And why sign-in does not use it ───────────────────────────────────────
 *
 * A policy applies to passwords being *set*. An account created before the
 * policy changed still has its old password, and a sign-in form that refused
 * to submit it would lock out the exact user who most needs to get in — with
 * a message blaming them for a rule that did not exist when they registered.
 * Sign-in checks that the field is not empty and lets the server judge.
 */

/** Read from the project, not chosen. See the header. */
export const MIN_PASSWORD_LENGTH = 6

/**
 * The ceiling, in UTF-8 bytes. Also read from the project — bcrypt's limit,
 * which Supabase reports as a character count and enforces on bytes.
 */
export const MAX_PASSWORD_BYTES = 72

/** The i18n key naming what is wrong with a candidate, or `null` if nothing. */
export type PasswordProblem =
  'passwordRequired' | 'passwordTooShort' | 'passwordTooLong'

/**
 * Encoded length, which is what the server measures. Built once: a
 * `TextEncoder` per keystroke on a password field is a needless allocation on
 * the hottest input in the app.
 */
const utf8 = new TextEncoder()

/** What the server counts, so the client and the server agree on "too long". */
export function passwordByteLength(value: string): number {
  return utf8.encode(value).length
}

/**
 * Judges a password that is about to be *set*.
 *
 * The minimum is counted in code units, which is what Supabase counts. It
 * differs from the number of characters a reader would see for anything
 * outside the BMP — an emoji is two — and the disagreement is in the
 * permissive direction here, so no password this accepts can be refused by the
 * server for being short. The maximum is counted in bytes for the opposite
 * reason; see the header.
 */
export function newPasswordProblem(value: string): PasswordProblem | null {
  if (value === '') return 'passwordRequired'
  if (value.length < MIN_PASSWORD_LENGTH) return 'passwordTooShort'
  if (passwordByteLength(value) > MAX_PASSWORD_BYTES) return 'passwordTooLong'
  return null
}

/**
 * The one thing a client can say about an email address without inventing a
 * rule: an address has an `@` with something on each side, and no spaces.
 *
 * Deliberately not a validating regular expression. The grammar in RFC 5322
 * admits quoted local parts and comments, every "email regex" in circulation
 * rejects addresses that exist, and the authority on whether this project
 * will accept an address is the auth server — which answers
 * `email_address_invalid`, a code with a sentence in three catalogs. What is
 * caught here is the typo the user can see for themselves.
 */
export function emailProblem(
  value: string
): 'emailRequired' | 'emailMalformed' | null {
  if (value.trim() === '') return 'emailRequired'
  return /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? null : 'emailMalformed'
}
