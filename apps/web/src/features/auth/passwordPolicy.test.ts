// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  emailProblem,
  newPasswordProblem,
  passwordByteLength,
} from './passwordPolicy.js'

/**
 * The rule is the project's, and the test's job is to stop it drifting away
 * from the project in either direction.
 *
 * Too *lax* costs a round trip and a server rejection the form said could not
 * happen. Too *strict* is worse and quieter: it refuses passwords the account
 * would have taken, and it does so with a sentence that teaches the user a
 * rule nobody enforces. The boundary case below — exactly six characters,
 * accepted — is the one that catches an off-by-one in the direction nobody
 * notices, because a six-character password simply appears to be rejected for
 * no reason.
 */

describe('the new-password rule', () => {
  it('mirrors the project: six characters, and nothing else', () => {
    /*
     * Read off the live project rather than chosen. Asking the auth server to
     * accept a one-character password answers:
     *   weak_password / "Password should be at least 6 characters."
     *   reasons: ["length"]
     * One reason, so there is no character-class requirement to mirror.
     */
    expect(MIN_PASSWORD_LENGTH).toBe(6)
  })

  it('accepts a password of exactly the minimum length', () => {
    expect(newPasswordProblem('abcdef')).toBeNull()
  })

  it('rejects one character short, and says which problem it is', () => {
    expect(newPasswordProblem('abcde')).toBe('passwordTooShort')
  })

  it('distinguishes empty from short', () => {
    // Two different sentences: "you left this blank" and "this is too short"
    // are different instructions, and merging them loses the first.
    expect(newPasswordProblem('')).toBe('passwordRequired')
  })

  it('demands no digit, no symbol and no capital', () => {
    // The project sets no `password_required_characters`. Inventing one here
    // is the drift this file exists to prevent.
    expect(newPasswordProblem('aaaaaa')).toBeNull()
    expect(newPasswordProblem('      ')).toBeNull()
  })

  it('counts what Supabase counts', () => {
    // Six astral characters are twelve UTF-16 code units, which is what the
    // server measures. Accepting is the safe direction: nothing this passes
    // can be refused upstream for being short.
    expect(newPasswordProblem('👋👋👋')).toBeNull()
  })
})

/**
 * The other end of the rule, which the client did not have.
 *
 * `PUT /auth/v1/user` accepts exactly 72 and refuses 73 with
 * `validation_failed` / "Password cannot be longer than 72 characters" —
 * bcrypt's limit, on every Supabase project. Unmapped, that came back
 * `UNKNOWN` and the screen whose whole job is setting a password said
 * "sign-in did not work", under a hint promising nothing else was required.
 * Retrying could never succeed.
 */
describe('the ceiling', () => {
  it('mirrors the project: seventy-two, counted in bytes', () => {
    expect(MAX_PASSWORD_BYTES).toBe(72)
  })

  it('accepts a password of exactly the maximum', () => {
    expect(newPasswordProblem('a'.repeat(72))).toBeNull()
  })

  it('rejects one character past it, and says which problem it is', () => {
    expect(newPasswordProblem('a'.repeat(73))).toBe('passwordTooLong')
  })

  it('counts bytes, because that is what the server counts', () => {
    /*
     * Twenty emoji: forty UTF-16 code units, eighty UTF-8 bytes. Measured
     * against the live project, they are refused — so counting code units
     * here would accept a passphrase the server cannot store, which is the
     * dead end this rule exists to prevent.
     */
    const emoji = '👋'.repeat(20)
    expect(emoji.length).toBe(40)
    expect(passwordByteLength(emoji)).toBe(80)
    expect(newPasswordProblem(emoji)).toBe('passwordTooLong')
  })

  it('leaves a long ASCII passphrase alone while it fits', () => {
    // What a diceware phrase or a password manager produces, and the case the
    // unmapped code turned into an unrecoverable form.
    const phrase = 'correct horse battery staple correct horse battery'
    expect(passwordByteLength(phrase)).toBeLessThanOrEqual(MAX_PASSWORD_BYTES)
    expect(newPasswordProblem(phrase)).toBeNull()
  })
})

describe('the email check', () => {
  it('accepts an ordinary address', () => {
    expect(emailProblem('ada@example.test')).toBeNull()
  })

  it('ignores surrounding whitespace, which is what pasting produces', () => {
    expect(emailProblem('  ada@example.test  ')).toBeNull()
  })

  it('separates blank from malformed', () => {
    expect(emailProblem('')).toBe('emailRequired')
    expect(emailProblem('   ')).toBe('emailRequired')
    expect(emailProblem('ada')).toBe('emailMalformed')
    expect(emailProblem('@example.test')).toBe('emailMalformed')
    expect(emailProblem('ada@')).toBe('emailMalformed')
  })

  it('does not try to be the authority on what an address may contain', () => {
    /*
     * All three are legal and all three are rejected by most hand-written
     * email regular expressions. The auth server decides; this check only
     * catches the typo the user can see.
     */
    expect(emailProblem('ada+circuits@example.test')).toBeNull()
    expect(emailProblem("o'hara@example.test")).toBeNull()
    expect(emailProblem('ada@localhost')).toBeNull()
  })
})
