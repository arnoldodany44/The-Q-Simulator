// @vitest-environment node
/**
 * Every reason the transpiler can refuse a circuit is a sentence the reader
 * gets, in all three languages.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS FOR
 *
 * A refusal reaches the browser as `HARDWARE_UNRUNNABLE` with the real reason
 * in `details`, and the panel rendered only the top-level message. There are
 * eleven reasons; that message describes one of them — connectivity. So a
 * circuit refused for any of the other ten was told to try a shallower circuit
 * or another backend.
 *
 * The Bell example is what exposed it. It has no measurement, so a device would
 * return no bits and the refusal is `no-measurement`; the advice on screen was
 * about wiring, and neither suggestion in it could ever have helped. Five of the
 * six worked examples have no measurement, so this was the *common* case, not an
 * edge one.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE CODES ARE READ OUT OF THE SOURCE
 *
 * `RefusalCode` is a TypeScript union, so there is no runtime value to import —
 * and `.dependency-cruiser.cjs` keeps `apps/web` out of `packages/transpile`
 * anyway, which is why the panel carries its own copy of the list. Two copies of
 * a list is a thing that drifts, and drift here is silent: a twelfth reason
 * would reach the browser, match nothing, and fall back to the sentence about
 * connectivity.
 *
 * So this reads the union from the transpiler's own source, over the file system
 * and not through an import — no module edge is created in either direction, the
 * same seam `qasm-round-trip/presets-fixture.test.ts` uses for the same reason.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const LANGUAGES = ['en', 'es', 'fr'] as const

/** The union arm comments in `refusal.ts` are `| 'code'` lines. */
function codesFromTranspiler(): readonly string[] {
  const source = readFileSync(
    new URL(
      '../../../../../packages/transpile/src/refusal.ts',
      import.meta.url
    ),
    'utf8'
  )
  const union = /export type RefusalCode =([\s\S]*?)\n\n/.exec(source)
  expect(union, 'the RefusalCode union moved or changed shape').not.toBeNull()
  const codes = [...(union?.[1] ?? '').matchAll(/\|\s*'([a-z-]+)'/g)].map(
    (match) => match[1] ?? ''
  )
  return codes
}

/** The set the panel matches against, read the same way. */
function codesFromPanel(): readonly string[] {
  const source = readFileSync(
    new URL(
      '../../features/hardware/SubmitToHardwarePanel.tsx',
      import.meta.url
    ),
    'utf8'
  )
  const block = /const REFUSAL_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(source)
  expect(block, 'REFUSAL_CODES moved or changed shape').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(
    (match) => match[1] ?? ''
  )
}

function catalogue(language: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../i18n/locales/${language}/hardware.json`, import.meta.url),
      'utf8'
    )
  ) as Record<string, unknown>
}

describe('the refusal codes', () => {
  const fromTranspiler = codesFromTranspiler()

  it('are found in the transpiler at all', () => {
    // A regular expression that quietly matched nothing would make every
    // assertion below vacuously true.
    expect(fromTranspiler.length).toBeGreaterThan(5)
  })

  it('are exactly the set the panel recognises', () => {
    // Either direction is a defect. A code the panel does not know falls back to
    // the sentence about connectivity, which is the bug this file exists for; a
    // code the panel knows and the transpiler no longer emits is a sentence
    // nobody can ever be shown, which rots.
    expect([...codesFromPanel()].sort()).toEqual([...fromTranspiler].sort())
  })

  for (const language of LANGUAGES) {
    it(`each have a ${language} sentence`, () => {
      const refusal = catalogue(language).refusal
      const table =
        typeof refusal === 'object' && refusal !== null
          ? (refusal as Record<string, unknown>)
          : {}
      const missing = fromTranspiler.filter(
        (code) => typeof table[code] !== 'string'
      )
      expect(missing, `no ${language} sentence for these`).toEqual([])
    })

    it(`say something different for each reason in ${language}`, () => {
      // Eleven reasons pointing at one sentence is the state this started from.
      const refusal = catalogue(language).refusal as Record<string, string>
      const sentences = fromTranspiler.map((code) => refusal[code])
      expect(new Set(sentences).size).toBe(fromTranspiler.length)
    })
  }
})
