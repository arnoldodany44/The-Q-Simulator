// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseCircuit } from '@qsim/schema'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { circuitToSvg } from '../../features/export/diagram'

/**
 * THE EXPORTED FILE IS THE APP'S OWN PALETTE, STILL.
 *
 * An exported SVG cannot use `var(--accent)`: it has no `:root` to resolve
 * against, and a custom property that does not resolve invalidates the whole
 * declaration — the gate would be drawn with no fill at all. So `diagram.tsx`
 * carries the six §10 tokens as literal hex, which is a copy, and a copy is a
 * thing that goes stale silently. The next person to correct a contrast ratio
 * in `index.css` (that has happened twice already — see the notes on `--wire`
 * and `--phase-lightness`) has no reason to suspect a second copy exists.
 *
 * This reads the stylesheet, pulls the tokens out of it, and holds the
 * exported file to them: every colour the app declares must appear in the
 * file, and every colour in the file must be one the app declares.
 */

const CSS = readFileSync(join(import.meta.dirname, '../../index.css'), 'utf8')

/** The tokens the exported stylesheet is built from. */
const TOKENS = [
  '--bg-panel',
  '--bg-elevated',
  '--wire',
  '--text',
  '--text-muted',
  '--accent',
] as const

const CIRCUIT = parseCircuit({
  schemaVersion: 1,
  qubits: 3,
  clbits: 1,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    {
      id: 'op_3',
      gate: 'x',
      targets: [2],
      controls: [{ qubit: 0, state: 0 }],
      column: 2,
    },
    { id: 'op_4', gate: 'barrier', targets: [0, 1, 2], column: 3 },
    {
      id: 'op_5',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 4,
    },
  ],
})

const { svg } = circuitToSvg(CIRCUIT, renderToStaticMarkup, {
  title: 'Quantum circuit',
  description: 'A circuit.',
})

/** `--wire: #5a65aa;` → `#5a65aa`, read from the `:root` block. */
function tokenValue(name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(CSS)
  expect(match, `${name} is not declared in index.css`).not.toBeNull()
  return match![1]!.toLowerCase()
}

describe('the exported diagram palette', () => {
  it.each(TOKENS)('uses the value index.css declares for %s', (token) => {
    expect(svg.toLowerCase()).toContain(tokenValue(token))
  })

  it('invents no colour of its own', () => {
    const declared = new Set(TOKENS.map(tokenValue))
    const used = new Set(
      (svg.toLowerCase().match(/#[0-9a-f]{3,8}/g) ?? []).map((hex) => hex)
    )
    for (const colour of used) {
      expect(declared.has(colour), `${colour} is not a token of §10`).toBe(true)
    }
  })

  it('resolves every colour without a stylesheet outside the file', () => {
    expect(svg).not.toContain('var(--')
    expect(svg).not.toContain('currentColor')
  })
})
