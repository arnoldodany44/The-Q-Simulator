import { describe, expect, it } from 'vitest'

import { CIRCUIT_SCHEMA_VERSION } from './index.js'

describe('circuit contract', () => {
  it('pins the schema version that saved circuits are stamped with', () => {
    expect(CIRCUIT_SCHEMA_VERSION).toBe(1)
  })
})
