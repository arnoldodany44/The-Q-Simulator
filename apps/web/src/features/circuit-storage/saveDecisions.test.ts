import {
  MAX_DESCRIPTION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from '@qsim/contract'
import { describe, expect, it } from 'vitest'

import {
  descriptionProblem,
  messageProblem,
  optionalText,
  racedOn,
  staleAgainst,
  titleProblem,
} from './saveDecisions'

/**
 * The rules, without a component or a network around them.
 *
 * The two conflict checks are the reason this file exists: they are three
 * lines each and they are the whole of the client's answer to two tabs editing
 * one circuit, so they are worth pinning at the level where the arithmetic is
 * visible.
 */

describe('the fields the form validates', () => {
  it('refuses a title that is only whitespace, as the contract would', () => {
    // `TitleSchema` trims before `.min(1)`. Accepting it here would mean the
    // form said yes and the API said 400 on a field it had already approved.
    expect(titleProblem('   ')).toBe('title-required')
    expect(titleProblem('')).toBe('title-required')
    expect(titleProblem(' Bell pair ')).toBeNull()
  })

  it('measures against the contract limits and not a copy of them', () => {
    expect(titleProblem('x'.repeat(MAX_TITLE_LENGTH))).toBeNull()
    expect(titleProblem('x'.repeat(MAX_TITLE_LENGTH + 1))).toBe(
      'title-too-long'
    )

    expect(descriptionProblem('x'.repeat(MAX_DESCRIPTION_LENGTH))).toBeNull()
    expect(descriptionProblem('x'.repeat(MAX_DESCRIPTION_LENGTH + 1))).toBe(
      'description-too-long'
    )

    expect(messageProblem('x'.repeat(MAX_MESSAGE_LENGTH))).toBeNull()
    expect(messageProblem('x'.repeat(MAX_MESSAGE_LENGTH + 1))).toBe(
      'message-too-long'
    )
  })

  it('sends an empty optional field as absence, not as an empty string', () => {
    expect(optionalText('')).toBeNull()
    expect(optionalText('  \n ')).toBeNull()
    expect(optionalText('  a Bell pair ')).toBe('a Bell pair')
  })
})

describe('the pre-flight check', () => {
  it('passes when the server is still where this document started', () => {
    expect(staleAgainst(4, 4)).toBeNull()
  })

  it('reports both numbers when somebody else has saved', () => {
    /*
     * The case the server cannot catch: `POST /circuits/:id/versions` takes no
     * base version, allocates the next number and retries past a collision, so
     * a save from a tab that started at version 2 succeeds against a server at
     * version 5 and becomes version 6. Nothing is destroyed, and nobody is
     * told — which is exactly what this refuses to let happen.
     */
    expect(staleAgainst(2, 5)).toEqual({ base: 2, server: 5 })
  })

  it('treats a server number below the base as a conflict too', () => {
    // Impossible through the API, since versions are only ever appended. If it
    // ever happens the premise is wrong, and stopping beats guessing.
    expect(staleAgainst(5, 2)).toEqual({ base: 5, server: 2 })
  })
})

describe('the post-flight check', () => {
  it('is satisfied by the number the save was promised', () => {
    expect(racedOn(3, 4)).toBeNull()
  })

  it('catches a save that slipped past the pre-flight', () => {
    // The window between the read and the write is small and not zero, and the
    // response says exactly which number was allocated.
    expect(racedOn(3, 6)).toEqual({ base: 3, landed: 6 })
  })
})
