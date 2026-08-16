import type { CustomGate } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  MAX_DEFINITION_JSON_BYTES,
  CustomGateTooLargeError,
  canEditCustomGate,
  countersFor,
  customGateHandleFilter,
  definitionIssues,
  listableCustomGateFilter,
  parseStoredDefinition,
  toDefinitionJson,
} from './custom-gates.js'

const BELL: CustomGate = {
  qubits: 2,
  symbol: 'B',
  operations: [
    { id: 'b1', gate: 'h', targets: [0], column: 0 },
    { id: 'b2', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

describe('definitionIssues', () => {
  it('accepts a definition the contract accepts', () => {
    expect(definitionIssues('bellPair', BELL)).toEqual([])
  })

  it('rejects a body that leaves its own register', () => {
    const issues = definitionIssues('bad', {
      qubits: 1,
      operations: [{ id: 'a', gate: 'h', targets: [3], column: 0 }],
    })
    expect(issues.map((issue) => issue.code)).toContain('qubit-out-of-range')
  })

  it('rejects a measurement, because a block has no classical register', () => {
    const issues = definitionIssues('bad', {
      qubits: 1,
      operations: [
        {
          id: 'a',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
      ],
    })
    expect(issues.map((issue) => issue.code)).toContain(
      'custom-gate-not-unitary'
    )
  })

  it('rejects a parameter the definition does not declare', () => {
    const issues = definitionIssues('turn', {
      qubits: 1,
      operations: [
        { id: 'a', gate: 'rz', targets: [0], params: ['theta'], column: 0 },
      ],
    })
    expect(issues.map((issue) => issue.code)).toContain('unknown-parameter')
  })

  it('accepts one that does declare it', () => {
    expect(
      definitionIssues('turn', {
        qubits: 1,
        params: ['theta'],
        operations: [
          { id: 'a', gate: 'rz', targets: [0], params: ['theta'], column: 0 },
        ],
      })
    ).toEqual([])
  })

  /*
   * The library rule: an entry stands on its own. Storing a block that names
   * another block would make a row's meaning depend on rows this table
   * deliberately does not join to.
   */
  it('rejects a body that uses another block', () => {
    const issues = definitionIssues('outer', {
      qubits: 2,
      operations: [{ id: 'a', gate: 'inner', targets: [0, 1], column: 0 }],
    })
    expect(issues).not.toEqual([])
    expect(issues[0]?.message).toContain('stand on its own')
  })

  it('rejects something that is not a definition at all', () => {
    expect(definitionIssues('x', { qubits: 0 })).not.toEqual([])
    expect(definitionIssues('x', null)).not.toEqual([])
  })
})

describe('countersFor', () => {
  it('counts what the block really runs', () => {
    expect(countersFor(BELL)).toEqual({
      qubitCount: 2,
      paramCount: 0,
      gateCount: 2,
    })
  })

  it('counts structure as structure', () => {
    expect(
      countersFor({
        qubits: 1,
        params: ['a'],
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'barrier', targets: [0], column: 1 },
        ],
      }).gateCount
    ).toBe(1)
  })
})

describe('the storage crossing', () => {
  it('round-trips a definition', () => {
    // Through JSON on purpose: `toDefinitionJson` types its result as the
    // value Prisma writes, and what comes back out of Postgres is whatever
    // survived the serialisation.
    const stored: unknown = JSON.parse(JSON.stringify(toDefinitionJson(BELL)))
    expect(parseStoredDefinition(stored as never)).toEqual(BELL)
  })

  it('refuses a definition past the size cap', () => {
    const huge: CustomGate = {
      qubits: 1,
      operations: Array.from({ length: 4000 }, (_, index) => ({
        id: `op_${index}`,
        gate: 'h',
        targets: [0],
        column: index,
      })),
    }
    expect(() => toDefinitionJson(huge)).toThrow(CustomGateTooLargeError)
    expect(
      new TextEncoder().encode(JSON.stringify(huge)).length
    ).toBeGreaterThan(MAX_DEFINITION_JSON_BYTES)
  })
})

describe('visibility', () => {
  it('lists only public blocks for a stranger', () => {
    expect(listableCustomGateFilter(null)).toEqual({ visibility: 'PUBLIC' })
  })

  it('lists a signed-in caller their own whatever the visibility', () => {
    expect(listableCustomGateFilter('u1')).toEqual({
      OR: [{ visibility: 'PUBLIC' }, { ownerId: 'u1' }],
    })
  })

  /*
   * The same asymmetry `collectionHandleFilter` documents: an id reaches an
   * UNLISTED block because the id is the only handle it has, and no response
   * carries the id of a block the reader may not list.
   */
  it('reaches an unlisted block by id and never a private one', () => {
    const anonymous = customGateHandleFilter('g1', null)
    expect(JSON.stringify(anonymous)).toContain('UNLISTED')
    expect(JSON.stringify(anonymous)).not.toContain('ownerId')

    expect(JSON.stringify(customGateHandleFilter('g1', 'u1'))).toContain(
      'ownerId'
    )
  })

  it('gives write access to the owner alone', () => {
    expect(canEditCustomGate({ ownerId: 'u1' }, 'u1')).toBe(true)
    expect(canEditCustomGate({ ownerId: 'u1' }, 'u2')).toBe(false)
    expect(canEditCustomGate({ ownerId: 'u1' }, null)).toBe(false)
  })
})
