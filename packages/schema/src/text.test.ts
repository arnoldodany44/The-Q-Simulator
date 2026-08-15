import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isStorableText, storableProse, storableText } from './text.js'
import { CircuitSchema } from './circuit.js'

const NUL = String.fromCharCode(0)
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800)

/**
 * What a JavaScript string may hold that PostgreSQL may not.
 *
 * Every case here was a 500 before: the shape check passed, the driver
 * refused, Prisma reported P2010, and nothing mapped it. One character an
 * attacker can type must not be a server fault.
 */
describe('storableText', () => {
  const schema = storableText(z.string().min(1).max(64))

  it('refuses U+0000, which a text column cannot hold at all', () => {
    expect(schema.safeParse(`probe${NUL}nul`).success).toBe(false)
  })

  it('refuses the rest of the C0 range and DEL', () => {
    for (const code of [0x01, 0x08, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x9f]) {
      expect(
        schema.safeParse(`a${String.fromCharCode(code)}b`).success,
        `U+${code.toString(16)}`
      ).toBe(false)
    }
  })

  it('refuses a lone surrogate rather than storing U+FFFD instead', () => {
    // Accepted, this is silent corruption: Node encodes it lossily on the way
    // to the wire, so what comes back out is not what went in.
    expect(schema.safeParse(`broken${LONE_HIGH_SURROGATE}`).success).toBe(false)
    // A well-formed pair is ordinary text and stays welcome.
    expect(schema.safeParse('a 𝄞 clef').success).toBe(true)
  })

  it('leaves ordinary text alone, including outside ASCII', () => {
    for (const value of ['Bell pair', '|ψ⟩', 'états liés', '量子回路']) {
      expect(schema.safeParse(value).success, value).toBe(true)
    }
  })

  it('reports a code the client can branch on, not just "custom"', () => {
    const result = schema.safeParse(`a${NUL}b`)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(
      result.error.issues.some(
        (issue) =>
          (issue as { params?: Record<string, unknown> }).params?.qsim ===
          'control_character'
      )
    ).toBe(true)
  })
})

describe('storableProse', () => {
  const schema = storableProse(z.string().max(4000))

  it('keeps the paragraph breaks a description is written with', () => {
    expect(
      schema.safeParse('first line\nsecond line\twith a tab').success
    ).toBe(true)
  })

  it('still refuses U+0000 and a lone surrogate', () => {
    expect(schema.safeParse(`a${NUL}b`).success).toBe(false)
    expect(schema.safeParse(`a${LONE_HIGH_SURROGATE}b`).success).toBe(false)
  })
})

describe('the circuit document', () => {
  it('refuses a NUL wherever a string reaches the jsonb column', () => {
    /*
     * `CircuitVersion.data` is `jsonb`, which refuses the escape separately
     * from `text` and with a different SQLSTATE. An operation id is not
     * something a person types, which is exactly why it was missed.
     */
    const base = { schemaVersion: 1 as const, qubits: 2, operations: [] }

    expect(
      CircuitSchema.safeParse({
        ...base,
        operations: [{ id: `a${NUL}b`, gate: 'h', targets: [0], column: 0 }],
      }).success
    ).toBe(false)
    expect(
      CircuitSchema.safeParse({
        ...base,
        operations: [{ id: 'a', gate: `h${NUL}`, targets: [0], column: 0 }],
      }).success
    ).toBe(false)
    expect(
      CircuitSchema.safeParse({ ...base, qubitLabels: [`q${NUL}0`, 'q1'] })
        .success
    ).toBe(false)
    expect(
      CircuitSchema.safeParse({
        ...base,
        customGates: {
          wide: { qubits: 1, operations: [], symbol: `s${NUL}` },
        },
      }).success
    ).toBe(false)
  })

  it('still accepts a clean circuit with labels and a symbol', () => {
    expect(
      CircuitSchema.safeParse({
        schemaVersion: 1,
        qubits: 2,
        operations: [{ id: 'op-0', gate: 'h', targets: [0], column: 0 }],
        qubitLabels: ['|ψ⟩', 'q1'],
        customGates: { wide: { qubits: 1, operations: [], symbol: 'W' } },
      }).success
    ).toBe(true)
  })
})

describe('isStorableText', () => {
  it('answers the same question outside a Zod pipeline', () => {
    expect(isStorableText('ordinary')).toBe(true)
    expect(isStorableText(`a${NUL}b`)).toBe(false)
    expect(isStorableText('a\nb')).toBe(false)
    expect(isStorableText('a\nb', true)).toBe(true)
  })
})
