// @vitest-environment node
import { MAX_QUBITS, alloc, probabilities, type Statevector } from '@qsim/core'
import { describe, expect, it } from 'vitest'

import {
  MAX_CLIENT_QUBITS,
  decodeState,
  encodeState,
  sharedMemoryAvailable,
} from './protocol'

/**
 * The transport, both ways.
 *
 * The shared path is the fast one and the transfer path is the one a
 * deployment that forgot its COOP/COEP headers falls back to, so both are
 * tested here rather than "whichever this environment happens to support".
 * A fallback nobody exercises is a fallback that is broken on the day it is
 * needed.
 *
 * Node rather than jsdom: this file has no DOM in it, and `SharedArrayBuffer`
 * is unconditionally present here.
 */

/** A recognisable state: amplitudes that are neither 0 nor equal. */
function sample(): Statevector {
  const state = alloc(2)
  state.re[0] = 0.5
  state.re[1] = 0.5
  state.im[2] = 0.5
  state.im[3] = 0.5
  return state
}

describe('the client ceiling', () => {
  it('stops at 20 qubits', () => {
    expect(MAX_CLIENT_QUBITS).toBe(20)
  })

  it('can never exceed what the engine will allocate', () => {
    expect(MAX_CLIENT_QUBITS).toBeLessThanOrEqual(MAX_QUBITS)
  })
})

describe('shared memory detection', () => {
  it('needs the constructor and cross-origin isolation together', () => {
    expect(
      sharedMemoryAvailable({
        SharedArrayBuffer,
        crossOriginIsolated: true,
      })
    ).toBe(true)
  })

  it('refuses a page that is not cross-origin isolated', () => {
    expect(
      sharedMemoryAvailable({
        SharedArrayBuffer,
        crossOriginIsolated: false,
      })
    ).toBe(false)
  })

  it('refuses a runtime without SharedArrayBuffer', () => {
    expect(sharedMemoryAvailable({ crossOriginIsolated: true })).toBe(false)
  })
})

describe('encoding a state for the shared path', () => {
  it('copies the amplitudes into shared buffers', () => {
    const state = sample()
    const { payload, transfer } = encodeState(state, true)

    expect(payload.transport).toBe('shared')
    expect(payload.re.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(payload.im.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect([...payload.re]).toEqual([...state.re])
    expect([...payload.im]).toEqual([...state.im])
    // A SharedArrayBuffer is shared, never transferred; listing one would
    // make postMessage throw.
    expect(transfer).toEqual([])
  })

  it('leaves the engine its own state', () => {
    const state = sample()
    const { payload } = encodeState(state, true)
    payload.re[0] = 99

    expect(state.re[0]).toBe(0.5)
  })

  it('allocates fresh buffers per result rather than pooling them', () => {
    const state = sample()
    const first = encodeState(state, true)
    const second = encodeState(state, true)

    expect(first.payload.re.buffer).not.toBe(second.payload.re.buffer)
  })
})

describe('encoding a state for the transfer path', () => {
  it('hands over the engine buffers instead of copying them', () => {
    const state = sample()
    const { payload, transfer } = encodeState(state, false)

    expect(payload.transport).toBe('transfer')
    expect(payload.re).toBe(state.re)
    expect(payload.im).toBe(state.im)
    expect(transfer).toEqual([state.re.buffer, state.im.buffer])
  })
})

describe('decoding', () => {
  it.each([true, false])(
    'round trips the amplitudes with shared=%s',
    (shared) => {
      const state = sample()
      const decoded = decodeState(encodeState(state, shared).payload)

      expect(decoded.qubits).toBe(2)
      expect(decoded.size).toBe(4)
      // The decoded value is a Statevector as far as the engine's readers are
      // concerned, which is the only thing the analysis panel needs of it.
      expect([...probabilities(decoded)]).toEqual([0.25, 0.25, 0.25, 0.25])
    }
  )
})
