// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { NOISE_PROFILE_IDS } from '@qsim/core'
import { describe, expect, it } from 'vitest'

import { SUPPORTED_LANGUAGES } from '../../i18n/index.js'
import {
  NOISE_REFUSAL_CODES,
  SIMULATION_ERROR_CODES,
} from '../simulation/protocol.js'
import { NOISE_FIELDS } from './noiseSettings.js'

/**
 * The same guard `authCatalog.test.ts` gives Supabase's failure codes, applied
 * to the noise panel's keys.
 *
 * The failure mode it catches: `NoisePanel.tsx` builds its catalog keys from
 * ids — `noise.field.${id}.label`, `noise.profile.${id}.name` — because eight
 * fields with three strings each and five profiles with two would be
 * thirty-eight cases across six `switch` statements, which is the point at
 * which a lookup table stops being safer than a template. The cost of that is
 * that a missing key is invisible to everything else in the toolchain:
 *
 *   - `i18next/no-literal-string` sees a `t()` call and asks no more.
 *   - `locale-parity.test.ts` compares the three catalogs against each other,
 *     and they agree perfectly when all three are equally missing the key.
 *   - the component tests render whatever i18next returns, which for a missing
 *     key is the key itself — a string, which renders.
 *
 * So this compares the catalogs against the *id lists* instead, in both
 * directions, read off disk rather than imported for the reason the other two
 * catalog tests do it: a file that exists but was never registered still gets
 * caught.
 */

const LOCALES_DIR = join(import.meta.dirname, '..', '..', 'i18n', 'locales')

function readCatalog(
  language: string,
  namespace: string
): Record<string, unknown> {
  const path = join(LOCALES_DIR, language, `${namespace}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function block(
  language: string,
  namespace: string,
  path: string
): Record<string, unknown> {
  let node: unknown = readCatalog(language, namespace)
  for (const part of path.split('.')) {
    expect(
      typeof node === 'object' && node !== null,
      `${language}/${namespace}.json is missing ${path}`
    ).toBe(true)
    node = (node as Record<string, unknown>)[part]
  }
  expect(
    typeof node === 'object' && node !== null,
    `${language}/${namespace}.json → ${path} is not a block`
  ).toBe(true)
  return node as Record<string, unknown>
}

describe('the noise catalog', () => {
  it.each(SUPPORTED_LANGUAGES)(
    'has exactly one block per form field in "%s"',
    (language) => {
      expect(
        Object.keys(block(language, 'analysis', 'noise.field')).sort()
      ).toEqual(NOISE_FIELDS.map((field) => field.id).sort())
    }
  )

  it.each(SUPPORTED_LANGUAGES)(
    'gives every field a label, a unit and a sentence in "%s"',
    (language) => {
      for (const field of NOISE_FIELDS) {
        const entry = block(language, 'analysis', `noise.field.${field.id}`)
        expect(Object.keys(entry).sort(), field.id).toEqual([
          'help',
          'label',
          'unit',
        ])
        // The sentence is what turns a form into a lesson: "T1 = 100" is a
        // number, "how long a qubit stays excited" is something a reader can
        // predict with. A one-word help is a field nobody explained.
        expect(
          String(entry.help).split(/\s+/u).length,
          field.id
        ).toBeGreaterThan(6)
      }
    }
  )

  it.each(SUPPORTED_LANGUAGES)(
    'has exactly one block per device profile in "%s"',
    (language) => {
      expect(
        Object.keys(block(language, 'analysis', 'noise.profile'))
          .filter((key) => key !== 'label')
          .sort()
      ).toEqual([...NOISE_PROFILE_IDS].sort())
    }
  )

  it.each(SUPPORTED_LANGUAGES)(
    'gives every profile a name and an explanation in "%s"',
    (language) => {
      for (const id of NOISE_PROFILE_IDS) {
        const entry = block(language, 'analysis', `noise.profile.${id}`)
        expect(Object.keys(entry).sort(), id).toEqual(['help', 'name'])
        expect(String(entry.help).split(/\s+/u).length, id).toBeGreaterThan(6)
      }
    }
  )

  it.each(SUPPORTED_LANGUAGES)(
    'has a sentence for every simulation failure the worker can report in "%s"',
    (language) => {
      // Every code, not only the new ones: the noise refusals travel through
      // the same `errors` block the simulation failures do, so this is the
      // guard that whole block never had.
      const errors = block(language, 'simulation', 'errors')
      expect(Object.keys(errors).sort()).toEqual(
        [...SIMULATION_ERROR_CODES, ...NOISE_REFUSAL_CODES].sort()
      )
      for (const [code, sentence] of Object.entries(errors)) {
        expect(String(sentence), code).not.toBe(code)
        expect(String(sentence).trim().length, code).toBeGreaterThan(0)
      }
    }
  )

  it('names the ceiling and the alternative in every language', () => {
    /*
     * §3.3's ceiling must never reach a reader as a bare "too large". The
     * refusal has to say which limit it hit and what to do instead, and the
     * interpolation values are what carry the numbers — a sentence that lost
     * them would be a sentence that names no register and no limit.
     */
    for (const language of SUPPORTED_LANGUAGES) {
      const panel = String(
        block(language, 'analysis', 'noise.refusal').tooLarge
      )
      expect(panel, language).toContain('{{qubits}}')
      expect(panel, language).toContain('{{limit}}')

      const worker = String(
        block(language, 'simulation', 'errors')['density-too-large']
      )
      expect(worker, language).toContain('{{qubits}}')
      expect(worker, language).toContain('{{limit}}')

      // And the way out is a control, so it needs a label of its own.
      expect(
        String(block(language, 'analysis', 'noise.refusal').switch).trim()
          .length,
        language
      ).toBeGreaterThan(0)
    }
  })
})
