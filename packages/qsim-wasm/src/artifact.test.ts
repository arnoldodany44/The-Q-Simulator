/**
 * The real `.wasm`, when there is one.
 *
 * Every other suite in this package runs against the linear-memory stand-in
 * in `src/testing/`, which proves the bridge and proves nothing about the
 * Rust. This is the suite that closes that gap, and it is the reason the CI
 * job builds the crate at all: it loads the compiled artifact and holds it to
 * the same standard the stand-in is held to — reproduce `apply.ts`, over the
 * whole gate catalogue, to 1e-12.
 *
 * ON A CHECKOUT WITHOUT RUST there is no artifact and these tests record that
 * they were skipped rather than passing quietly. That distinction is the
 * whole design of this file: a green run here must mean "the kernel was
 * checked", never "there was nothing to check". CI asserts the artifact exists
 * before running this, so the skip branch can only be taken locally.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { kernelStatus, uninstallStatevectorKernel } from '@qsim/core'
import { afterEach, describe, expect, test } from 'vitest'

import { describeReport, verifyEquivalence } from './equivalence.js'
import { hasSimd } from './detect.js'
import { loadKernel } from './load.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg')

afterEach(() => {
  uninstallStatevectorKernel()
})

/**
 * The artifact as a standalone `ArrayBuffer`, or `undefined` when it has not
 * been built.
 *
 * The exact-range copy is not a typing convenience. `readFile` hands back a
 * `Buffer` carved out of a shared allocation pool, so its `.buffer` is
 * routinely far larger than the file and starts at a non-zero `byteOffset`.
 * Passing that whole pool to `WebAssembly.compile` would hand it bytes of
 * some unrelated read.
 */
async function bytesOf(name: string): Promise<ArrayBuffer | undefined> {
  try {
    const data = await readFile(join(PKG, `${name}.wasm`))
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  } catch {
    return undefined
  }
}

function announceSkip(name: string): void {
  console.error(
    `\nSKIPPED: pkg/${name}.wasm is not built.\n` +
      `  Build it with \`pnpm --filter @qsim/wasm build:wasm\` (needs a Rust\n` +
      `  toolchain). CI builds it and asserts it exists before running this,\n` +
      `  so this branch is local-only.\n`
  )
}

describe('the compiled kernel', () => {
  test('reproduces the TypeScript reference over the gate catalogue', async () => {
    const bytes = await bytesOf('kernel')
    if (bytes === undefined) {
      announceSkip('kernel')
      expect(bytes).toBeUndefined()
      return
    }

    const loaded = await loadKernel({
      load: () => Promise.resolve(bytes),
      // Far more than the startup check runs. This is the one place with the
      // time to be thorough, and it is the last line before an artifact ships.
      equivalence: { qubits: 9, gates: 4000 },
    })
    expect(loaded.ok, loaded.ok ? '' : loaded.detail).toBe(true)
    if (!loaded.ok) return

    console.error(`\n  ${describeReport(loaded.report)}`)
    // Same claim as everywhere else in this package: not "within tolerance"
    // but identical. Rust does not reassociate floating point unless asked,
    // and `kernel.rs` is written with the same association as `apply.ts`.
    expect(loaded.report.worstDeviation).toBe(0)
    expect(loaded.report.declined).toBe(0)
    expect(kernelStatus().id).toBe('wasm')
    loaded.dispose()
  })

  test('holds across several register sizes', async () => {
    const bytes = await bytesOf('kernel')
    if (bytes === undefined) {
      expect(bytes).toBeUndefined()
      return
    }
    const loaded = await loadKernel({
      load: () => Promise.resolve(bytes),
      install: false,
    })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    for (const qubits of [1, 2, 5, 12]) {
      const report = verifyEquivalence(loaded.session, loaded.kernel, {
        qubits,
        gates: 300,
      })
      expect(report.agreed, `${qubits} qubits: ${describeReport(report)}`).toBe(
        true
      )
    }
    loaded.dispose()
  })

  /**
   * The SIMD artifact is a *different compilation of the same source*, so it
   * has to give the same answer to the last bit. If it does not, LLVM
   * reassociated something it was not supposed to, and that is a defect in
   * the build flags rather than in the kernel.
   */
  test('the SIMD build agrees with the scalar build exactly', async () => {
    const bytes = await bytesOf('kernel-simd')
    if (bytes === undefined) {
      announceSkip('kernel-simd')
      expect(bytes).toBeUndefined()
      return
    }
    if (!hasSimd()) {
      console.error('\nSKIPPED: this runtime has no WebAssembly SIMD.\n')
      expect(hasSimd()).toBe(false)
      return
    }

    const loaded = await loadKernel({
      load: () => Promise.resolve(bytes),
      equivalence: { qubits: 9, gates: 2000 },
      install: false,
    })
    expect(loaded.ok, loaded.ok ? '' : loaded.detail).toBe(true)
    if (!loaded.ok) return

    expect(loaded.session.id).toBe('wasm-simd128')
    expect(loaded.report.worstDeviation).toBe(0)
    loaded.dispose()
  })
})
