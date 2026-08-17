// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LESSON_FOCUS_SELECTORS, LESSON_FOCUS_TARGETS } from './format'

/**
 * The one place the lesson feature reaches into somebody else's markup.
 *
 * A step points at a region of the live panel by the class name §10's
 * stylesheet gives it (`format.ts`, decision 2), and the player finds it with
 * `querySelector`. Nothing about that arrangement fails loudly: rename
 * `.histogram` in `features/analysis` and every "show me" button in every
 * lesson silently stops doing anything, in every language, with no error in
 * the console and no failing test anywhere near the change.
 *
 * So the coupling is asserted from the outside. Each selector has to be a
 * class some component actually writes, and each has to be a class the
 * stylesheet actually styles — two different mistakes, and the second is what
 * would leave the outline invisible on a target that resolves perfectly.
 *
 * Scanning source text rather than rendering is deliberate. Four of the six
 * targets only exist once a simulation has answered, and a worker is exactly
 * what a Vitest run does not have — so a rendering test could cover the canvas
 * and the histogram and would quietly cover nothing at all for the Bloch
 * spheres, the Q-sphere, the amplitude table and the entanglement metrics.
 */

const FEATURES = join(import.meta.dirname, '..')
const STYLESHEET = join(import.meta.dirname, '..', '..', 'index.css')

/** Every `.tsx` under `features/`, read once. */
function componentSources(): string {
  const parts: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (
        entry.name.endsWith('.tsx') &&
        !entry.name.includes('.test.')
      ) {
        parts.push(readFileSync(path, 'utf8'))
      }
    }
  }
  walk(FEATURES)
  return parts.join('\n')
}

const sources = componentSources()
const stylesheet = readFileSync(STYLESHEET, 'utf8')

describe('the regions a lesson step can point at', () => {
  it('names every target', () => {
    expect(Object.keys(LESSON_FOCUS_SELECTORS).sort()).toEqual(
      [...LESSON_FOCUS_TARGETS].sort()
    )
  })

  it('uses a plain class selector for each, so the player can scope it', () => {
    for (const selector of Object.values(LESSON_FOCUS_SELECTORS)) {
      expect(selector).toMatch(/^\.[a-z][a-z0-9-]*$/)
    }
  })

  it.each(LESSON_FOCUS_TARGETS)(
    '"%s" points at a class some component actually renders',
    (target) => {
      const className = LESSON_FOCUS_SELECTORS[target].slice(1)
      /*
       * The class as it is written in JSX. Anchored to a quote on the left so
       * `.bloch` does not match `bloch__caption`, and allowed a space or a
       * quote on the right so it matches both `className="bloch"` and a
       * multi-class attribute.
       */
      const written = new RegExp(`["'\`]${className}(["'\`\\s])`)
      expect(
        written.test(sources),
        `no component renders className "${className}"`
      ).toBe(true)
    }
  )

  it.each(LESSON_FOCUS_TARGETS)(
    '"%s" is a class the stylesheet knows',
    (target) => {
      const selector = LESSON_FOCUS_SELECTORS[target]
      /*
       * At the start of a line and followed by `{` or `,`: four of the six are
       * written as one member of a grouped rule (`.qsphere,` on its own line),
       * so a check for `"<selector> {"` would have reported three false
       * failures and taught the next reader to loosen it further.
       */
      const styled = new RegExp(`^\\${selector}\\s*[,{]`, 'm')
      expect(
        styled.test(stylesheet),
        `${selector} is not styled — the outline would land on an unstyled box`
      ).toBe(true)
    }
  )
})
