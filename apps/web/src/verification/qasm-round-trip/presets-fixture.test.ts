// @vitest-environment node
/**
 * The presets fixture the `@qsim/qasm` round-trip suite reads is still the
 * presets.
 *
 * §12.3 forbids a package importing from an app, so the round trip over the six
 * shipped examples runs inside `packages/qasm` against a JSON copy of them. A
 * copy rots, which would leave that suite quietly proving nothing about the
 * circuits anybody actually opens — so this test, on the app's side of the
 * boundary, compares the two. It reads the file rather than importing it, so no
 * module edge is created in either direction.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

import { PRESETS } from '../../features/circuit-editor/presets'

it('matches the shipped presets exactly', () => {
  const path = new URL(
    '../../../../../packages/qasm/src/verification/qasm-round-trip/presets.fixture.json',
    import.meta.url
  )
  const fixture: unknown = JSON.parse(readFileSync(path, 'utf8'))
  expect(fixture).toStrictEqual(
    JSON.parse(
      JSON.stringify(
        PRESETS.map((preset) => ({ id: preset.id, circuit: preset.circuit }))
      )
    )
  )
})
