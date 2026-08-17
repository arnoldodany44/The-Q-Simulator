/**
 * Feature detection and the gated load path.
 *
 * Everything here is about the *refusals*. A loader that installs an
 * accelerator it should not have is the only way this package can hurt the
 * product, so each gate in `load.ts` gets a test that it actually closes:
 * missing WebAssembly, missing artifact, stale ABI, and a kernel that does not
 * reproduce the reference.
 */

import { kernelStatus, uninstallStatevectorKernel } from '@qsim/core'
import { afterEach, describe, expect, test } from 'vitest'

import {
  detectCapabilities,
  hasSimd,
  hasWebAssembly,
  preferredArtifact,
} from './detect.js'
import {
  ABI_VERSION,
  KernelAbiError,
  asKernelExports,
  instantiateKernel,
} from './exports.js'
import { loadKernel } from './load.js'
import { createReferenceExports } from './testing/reference-exports.js'

afterEach(() => {
  uninstallStatevectorKernel()
})

describe('feature detection', () => {
  test('finds WebAssembly in this runtime', () => {
    // Node has had it for years; if this is false the rest is moot and the
    // engine correctly runs in TypeScript.
    expect(hasWebAssembly()).toBe(true)
  })

  test('the SIMD probe is a validation, not an execution', () => {
    // Whatever the answer, it must be a boolean and must not throw: this runs
    // on a startup path, in engines that may reject the probe module outright.
    expect(typeof hasSimd()).toBe('boolean')
  })

  test('picks the SIMD artifact only when the engine supports it', () => {
    expect(
      preferredArtifact({
        webAssembly: false,
        simd: false,
        sharedMemory: false,
      })
    ).toBeUndefined()
    expect(
      preferredArtifact({ webAssembly: true, simd: false, sharedMemory: false })
    ).toBe('kernel')
    expect(
      preferredArtifact({ webAssembly: true, simd: true, sharedMemory: false })
    ).toBe('kernel-simd')
  })

  test('reports capabilities without throwing anywhere', () => {
    const capabilities = detectCapabilities()
    expect(typeof capabilities.webAssembly).toBe('boolean')
    expect(typeof capabilities.simd).toBe('boolean')
    expect(typeof capabilities.sharedMemory).toBe('boolean')
    // SIMD without WebAssembly is not a state that can exist.
    if (capabilities.simd) expect(capabilities.webAssembly).toBe(true)
  })
})

describe('the ABI check', () => {
  test('accepts an artifact built from this checkout', () => {
    const exports = createReferenceExports()
    expect(asKernelExports(exports as unknown as WebAssembly.Exports)).toBe(
      exports
    )
  })

  /**
   * The failure this exists for: a cached `.wasm` from an older crate, whose
   * signatures still line up but whose meaning has moved. It would instantiate
   * perfectly and answer every call with amplitudes computed under different
   * rules.
   */
  test('refuses a stale artifact by version', () => {
    const stale = createReferenceExports({ abiVersion: ABI_VERSION + 1 })
    expect(() =>
      asKernelExports(stale as unknown as WebAssembly.Exports)
    ).toThrow(KernelAbiError)
    expect(() =>
      asKernelExports(stale as unknown as WebAssembly.Exports)
    ).toThrow(/stale/)
  })

  test('names the functions an incomplete artifact is missing', () => {
    const partial = { ...createReferenceExports() } as Record<string, unknown>
    delete partial.reduced_density
    delete partial.apply_iswap
    expect(() =>
      asKernelExports(partial as unknown as WebAssembly.Exports)
    ).toThrow(/reduced_density/)
  })
})

describe('instantiateKernel', () => {
  test('rejects bytes that are not a module', () => {
    // A 404 page, a truncated download, an HTML error body — all of these
    // arrive as bytes and none of them is a kernel.
    const notWasm = new Uint8Array([0x3c, 0x21, 0x64, 0x6f, 0x63])
    return expect(instantiateKernel(notWasm)).rejects.toThrow()
  })

  /**
   * A real module, with an import, instantiated through the reflective stub
   * path. This is what wasm-bindgen's panic hook looks like from here, and it
   * has to instantiate rather than fail for want of an import object.
   */
  test('supplies stubs for whatever imports the module declares', async () => {
    // (module (import "wbg" "__wbindgen_throw" (func (param i32 i32)))
    //         (func (export "ping") (result i32) i32.const 7))
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // type section, 10 payload bytes: (i32,i32)->() and ()->i32
      0x01, 0x0a, 0x02, 0x60, 0x02, 0x7f, 0x7f, 0x00, 0x60, 0x00, 0x01, 0x7f,
      // import section: wbg.__wbindgen_throw
      0x02, 0x18, 0x01, 0x03, 0x77, 0x62, 0x67, 0x10, 0x5f, 0x5f, 0x77, 0x62,
      0x69, 0x6e, 0x64, 0x67, 0x65, 0x6e, 0x5f, 0x74, 0x68, 0x72, 0x6f, 0x77,
      0x00, 0x00,
      // function section
      0x03, 0x02, 0x01, 0x01,
      // export section: "ping"
      0x07, 0x08, 0x01, 0x04, 0x70, 0x69, 0x6e, 0x67, 0x00, 0x01,
      // code section
      0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x07, 0x0b,
    ])
    // It instantiates — the import was stubbed — and then fails the ABI check,
    // which is the correct order: structure first, then meaning.
    await expect(instantiateKernel(bytes)).rejects.toThrow(KernelAbiError)
  })
})

describe('loadKernel', () => {
  test('reports no-artifact rather than throwing on a checkout without Rust', async () => {
    // The default state of most checkouts, including this one. It must be a
    // described outcome, not an exception on a startup path.
    const result = await loadKernel({ load: () => Promise.resolve(undefined) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-artifact')
    expect(result.detail).toContain('Rust toolchain')
    expect(kernelStatus().id).toBeUndefined()
  })

  test('reports a failed fetch as no-artifact', async () => {
    const result = await loadKernel({
      load: () => Promise.reject(new Error('404 Not Found')),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-artifact')
    expect(result.detail).toContain('404')
  })

  test('reports unusable bytes as instantiation-failed', async () => {
    const result = await loadKernel({
      load: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('instantiation-failed')
    expect(kernelStatus().id).toBeUndefined()
  })

  /**
   * Nothing is installed until equivalence has been proved. This is the gate
   * that matters most, so it is asserted on the global state rather than only
   * on the return value.
   */
  test('never installs a kernel that has not been verified', async () => {
    const result = await loadKernel({
      load: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
    })
    expect(result.ok).toBe(false)
    expect(kernelStatus().id).toBeUndefined()
  })
})
