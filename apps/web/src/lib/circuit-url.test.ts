import {
  CIRCUIT_SCHEMA_VERSION,
  CircuitSchema,
  OperationSchema,
  safeParseCircuit,
  type Circuit,
} from '@qsim/schema'
import fc from 'fast-check'
import { deflateSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  BELL_PARAM_BUDGET,
  CIRCUIT_URL_PARAM,
  MAX_DECODED_BYTES,
  MAX_PARAM_LENGTH,
  PACKED_CIRCUIT_KEYS,
  PACKED_OPERATION_KEYS,
  circuitUrl,
  decode,
  encode,
  exceedsUrlBudget,
  readCircuitParam,
} from './circuit-url'

/**
 * The codec behind decision D4, tested from both ends: it has to be exact for
 * everything the contract accepts, and unshakeable for everything it does not.
 *
 * The hostile half is the reason this file is long. A `?c=` payload arrives
 * from whoever sent the link, so the interesting cases are all the ones that
 * are *not* a circuit — and the requirement is uniform: a code, never a throw,
 * never an unvalidated circuit.
 */

const BELL: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** A payload built from arbitrary bytes, the way a hostile link would be. */
function payloadOf(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/** A payload whose *decompressed* content is whatever you hand it. */
function deflatedPayload(bytes: Uint8Array): string {
  return payloadOf(deflateSync(bytes, { level: 9 }))
}

function jsonPayload(value: unknown): string {
  return deflatedPayload(new TextEncoder().encode(JSON.stringify(value)))
}

describe('encode / decode', () => {
  it('round-trips a Bell pair exactly', () => {
    const result = decode(encode(BELL))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.circuit).toEqual(BELL)
  })

  it('keeps a Bell pair inside the work plan budget', () => {
    const param = encode(BELL)
    // The DoD of M0.9 names this number, so the test names it too. It is the
    // payload that is budgeted, not the whole URL: an origin is not something
    // the encoder can shorten.
    expect(param.length).toBeLessThan(BELL_PARAM_BUDGET)
  })

  it('produces only base64url characters', () => {
    expect(encode(BELL)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is deterministic — the same circuit gives the same link', () => {
    expect(encode(BELL)).toBe(encode(BELL))
  })

  it('round-trips every optional field the contract has', () => {
    const maximal: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 3,
      clbits: 2,
      qubitLabels: ['alice', 'bob', 'carol'],
      parameters: [{ name: 'theta', value: 0.5 }],
      operations: [
        {
          id: 'op_1',
          gate: 'rz',
          targets: [0],
          // Both control spellings in one operation: the bare number and the
          // explicit negative control. The distinction is physics, so a round
          // trip that normalised one into the other would change the circuit.
          controls: [1, { qubit: 2, state: 0 }],
          params: ['theta'],
          column: 0,
        },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'x',
          targets: [2],
          column: 2,
          condition: { clbit: 1, equals: 1 },
        },
      ],
      customGates: {
        bell: {
          qubits: 2,
          symbol: 'B',
          operations: [{ id: 'inner_1', gate: 'h', targets: [0], column: 0 }],
        },
      },
    }
    // The fixture has to be a legal circuit, or the round trip proves nothing.
    expect(safeParseCircuit(maximal).ok).toBe(true)

    const result = decode(encode(maximal))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.circuit).toEqual(maximal)
  })

  it('keeps an empty optional array distinct from an absent one', () => {
    const withEmpty: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      parameters: [],
      operations: [{ id: 'op_1', gate: 'x', targets: [0], column: 0 }],
    }
    const result = decode(encode(withEmpty))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.circuit).toEqual(withEmpty)
    expect(result.circuit.parameters).toEqual([])
  })
})

/**
 * The guard against a contract that grows a field the packer never hears
 * about. The packed form is positional, so a new key would simply not be
 * written and every shared link would quietly lose it — a data-loss bug with
 * no symptom until someone opens their own link and finds it changed.
 */
describe('the packed form covers the contract', () => {
  it('packs every field of a circuit', () => {
    expect([...PACKED_CIRCUIT_KEYS].sort()).toEqual(
      Object.keys(CircuitSchema.shape).sort()
    )
  })

  it('packs every field of an operation', () => {
    expect([...PACKED_OPERATION_KEYS].sort()).toEqual(
      Object.keys(OperationSchema.shape).sort()
    )
  })
})

/**
 * Randomised circuits. The generator builds documents the contract accepts —
 * every index inside its register, one operation per qubit per column, ids
 * unique — because the claim under test is exactness over *legal* circuits,
 * and a generator that mostly produced illegal ones would spend its runs
 * proving that `safeParseCircuit` says no.
 */
const arbitraryCircuit = fc
  .record({
    qubits: fc.integer({ min: 1, max: 6 }),
    clbits: fc.integer({ min: 0, max: 4 }),
    operationCount: fc.integer({ min: 0, max: 12 }),
    seed: fc.integer({ min: 0, max: 2 ** 31 }),
    labelled: fc.boolean(),
  })
  .map(({ qubits, clbits, operationCount, seed, labelled }) => {
    // A tiny deterministic generator rather than more fast-check arbitraries:
    // the constraints between the fields (a control that is not a target, a
    // column that is still free on this wire) are easier to *construct* than
    // to filter for, and filtering would throw most runs away.
    let state = seed + 1
    const next = (bound: number): number => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state % bound
    }

    const operations: Circuit['operations'] = []
    const taken = new Set<string>()
    for (let index = 0; index < operationCount; index += 1) {
      const column = next(6)
      const target = next(qubits)
      if (taken.has(`${column}:${target}`)) continue
      const wantsControl = qubits > 1 && next(2) === 0
      const control = (target + 1 + next(qubits - 1)) % qubits
      if (wantsControl && taken.has(`${column}:${control}`)) continue
      taken.add(`${column}:${target}`)
      if (wantsControl) taken.add(`${column}:${control}`)

      operations.push({
        id: `op_${index}`,
        gate: wantsControl ? 'cx' : 'h',
        targets: [target],
        ...(wantsControl
          ? {
              controls:
                next(2) === 0
                  ? [control]
                  : [{ qubit: control, state: 0 as const }],
            }
          : {}),
        column,
      })
    }

    return {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits,
      clbits,
      ...(labelled
        ? {
            qubitLabels: Array.from(
              { length: qubits },
              (_, wire) => `w${wire}`
            ),
          }
        : {}),
      operations,
    } satisfies Circuit
  })

describe('round trip on randomised circuits', () => {
  it('returns the circuit it was given', () => {
    fc.assert(
      fc.property(arbitraryCircuit, (circuit) => {
        // The generator is only trusted as far as the contract agrees with it.
        expect(safeParseCircuit(circuit).ok).toBe(true)
        const result = decode(encode(circuit))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.circuit).toEqual(circuit)
      }),
      { numRuns: 300 }
    )
  })

  it('encodes to a payload the same encoder reproduces from the decoding', () => {
    fc.assert(
      fc.property(arbitraryCircuit, (circuit) => {
        const once = encode(circuit)
        const result = decode(once)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(encode(result.circuit)).toBe(once)
      }),
      { numRuns: 100 }
    )
  })
})

describe('a payload is untrusted input', () => {
  it('refuses an absent or empty parameter', () => {
    expect(decode(null)).toMatchObject({ ok: false, code: 'empty' })
    expect(decode(undefined)).toMatchObject({ ok: false, code: 'empty' })
    expect(decode('')).toMatchObject({ ok: false, code: 'empty' })
  })

  it('refuses an oversized parameter before decoding it', () => {
    const long = 'A'.repeat(MAX_PARAM_LENGTH + 1)
    expect(decode(long)).toMatchObject({ ok: false, code: 'too-long' })
  })

  it('refuses characters outside the base64url alphabet', () => {
    for (const hostile of ['not base64', 'a+b/c=', '<script>', '..%2F..']) {
      expect(decode(hostile)).toMatchObject({ ok: false, code: 'not-base64' })
    }
  })

  it('refuses bytes that are not a deflate stream', () => {
    const noise = payloadOf(Uint8Array.from({ length: 64 }, (_, i) => i * 7))
    expect(decode(noise)).toMatchObject({ ok: false, code: 'not-deflate' })
  })

  it('refuses a truncated payload at every truncation', () => {
    const whole = encode(BELL)
    for (let length = 1; length < whole.length; length += 1) {
      const result = decode(whole.slice(0, length))
      // Which code a given truncation produces depends on where the cut fell
      // — a short stream is `not-deflate`, a cut that happens to inflate into
      // half a document is `not-json`. What is pinned is the invariant: it
      // never throws, and it never yields a circuit.
      expect(result.ok).toBe(false)
    }
  })

  it('refuses a decompression bomb without allocating it', () => {
    // Half a megabyte of one repeated byte: a few hundred bytes on the wire
    // and past `MAX_DECODED_BYTES` when expanded. The cap is what makes this
    // a refusal instead of a memory spike.
    const bomb = new Uint8Array(MAX_DECODED_BYTES * 2).fill(0x61)
    const param = deflatedPayload(bomb)
    expect(param.length).toBeLessThanOrEqual(MAX_PARAM_LENGTH)
    expect(decode(param)).toMatchObject({ ok: false, code: 'too-large' })
  })

  it('accepts a payload that lands exactly on the size cap', () => {
    // The boundary in the other direction: `MAX_DECODED_BYTES` is a ceiling
    // that is allowed to be reached, so the extra byte of the guard buffer
    // must not make a legal payload of exactly that size look like a bomb.
    const padding = 'x'.repeat(24)
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [{ id: `op_${padding}`, gate: 'h', targets: [0], column: 0 }],
    }
    expect(decode(encode(circuit)).ok).toBe(true)
  })

  it('refuses bytes that are not valid UTF-8', () => {
    // A lone continuation byte: no lead byte can introduce it.
    const invalid = new Uint8Array([0x7b, 0x80, 0x7d])
    expect(decode(deflatedPayload(invalid))).toMatchObject({
      ok: false,
      code: 'not-json',
    })
  })

  it('refuses valid UTF-8 that is not JSON', () => {
    const text = new TextEncoder().encode('this is not json')
    expect(decode(deflatedPayload(text))).toMatchObject({
      ok: false,
      code: 'not-json',
    })
  })

  it('refuses JSON that is not a circuit, and says why', () => {
    for (const value of [null, 42, 'circuit', { hello: 'world' }, []]) {
      const result = decode(jsonPayload(value))
      expect(result).toMatchObject({ ok: false, code: 'not-a-circuit' })
      if (result.ok) continue
      expect(result.issues.length).toBeGreaterThan(0)
    }
  })

  it('refuses a packed circuit whose values are out of range', () => {
    // Shaped exactly like a packed circuit, and a shape check alone cannot
    // fault it — qubit 5 is a legal index for the *format*, whose ceiling is
    // MAX_QUBITS. It is illegal for this two-qubit register, which only the
    // semantic pass knows. Pinning the code proves that pass runs on a URL
    // payload and not merely `CircuitSchema`.
    const packed = [1, 2, 0, [['op_1', 'h', [5], 0]]]
    const result = decode(jsonPayload(packed))
    expect(result).toMatchObject({ ok: false, code: 'not-a-circuit' })
    if (result.ok) return
    expect(result.issues.map((issue) => issue.code)).toContain(
      'qubit-out-of-range'
    )
  })

  it('refuses an unknown schema version', () => {
    const packed = [99, 1, 0, [['op_1', 'h', [0], 0]]]
    expect(decode(jsonPayload(packed))).toMatchObject({
      ok: false,
      code: 'not-a-circuit',
    })
  })

  it('does not pollute Object.prototype through a custom gate name', () => {
    // `__proto__` matches the contract's identifier pattern, so it is a legal
    // custom gate name — and on an ordinary object it is a setter rather than
    // a property.
    const packed = [
      1,
      1,
      0,
      [['op_1', 'h', [0], 0]],
      null,
      null,
      { __proto__: [1, [], null] },
    ]
    decode(jsonPayload(packed))
    expect(({} as Record<string, unknown>).qubits).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('qubits')
  })
})

describe('url helpers', () => {
  it('replaces the parameter without disturbing the rest of the url', () => {
    const url = circuitUrl('https://example.test/new?lang=fr', 'PAYLOAD')
    expect(url).toBe('https://example.test/new?lang=fr&c=PAYLOAD')
    expect(readCircuitParam(new URL(url).search)).toBe('PAYLOAD')
  })

  it('removes the parameter when there is no circuit to share', () => {
    const url = circuitUrl('https://example.test/new?c=OLD&lang=fr', null)
    expect(url).toBe('https://example.test/new?lang=fr')
    expect(readCircuitParam(new URL(url).search)).toBeNull()
  })

  it('names the parameter the work plan names', () => {
    expect(CIRCUIT_URL_PARAM).toBe('c')
  })

  it('knows when a payload is past what a link may carry', () => {
    expect(exceedsUrlBudget(encode(BELL))).toBe(false)
    expect(exceedsUrlBudget('A'.repeat(MAX_PARAM_LENGTH + 1))).toBe(true)
  })
})
