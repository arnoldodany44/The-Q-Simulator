/**
 * The speedup measurement — §5.6 phase 2 targets 3× to 10× on the statevector
 * path.
 *
 * This file measures three things, and it is worth being precise about which
 * of them is a *claim* and which is a *baseline*:
 *
 *  1. THE TYPESCRIPT BASELINE. What the engine costs today, per gate, at the
 *     sizes that matter. This is the number a WASM build has to beat, measured
 *     on the machine asking rather than quoted from a README, and it is
 *     produced whether or not any artifact exists.
 *
 *  2. THE COST OF THE SEAM. Routing the runner through `kernel.ts` adds one
 *     module-scoped read and one `undefined` check per gate. That is claimed
 *     to be free against O(2ⁿ); this measures it rather than asserting it, and
 *     also measures the *fallback* path, where a kernel is installed and
 *     declines — which is what every heap statevector does in production.
 *
 *  3. THE ACTUAL SPEEDUP, when `pkg/kernel.wasm` exists. On a checkout with no
 *     Rust toolchain it does not, and those cases report that they were
 *     skipped instead of quietly passing. A skipped performance test that
 *     printed a number would be the worst outcome here.
 *
 * Wall-clock assertions live in `*.perf.test.ts` and never in the default
 * suite: a timing measured while four other workspaces are building measures
 * the scheduler.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GATE_MATRICES,
  alloc,
  applyControlled,
  applyISwap,
  applySwap,
  installStatevectorKernel,
  uninstallStatevectorKernel,
  acceleratedApplyControlled,
  acceleratedApplyISwap,
  acceleratedApplySwap,
  type ControlSpec,
  type Statevector,
  type StatevectorKernel,
} from '@qsim/core'
import { afterEach, describe, expect, test } from 'vitest'

import { loadKernel, type LoadedKernel } from './load.js'
import { createKernel } from './kernel.js'
import { createSession } from './session.js'
import { createReferenceExports } from './testing/reference-exports.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARTIFACT = join(HERE, '..', 'pkg', 'kernel.wasm')

/** Median of `runs` timings, in milliseconds per call. */
function measure(runs: number, iterations: number, fn: () => void): number {
  // Warm up: V8 needs a few passes before the loop is optimised, and the
  // first is often 10× the steady state.
  for (let i = 0; i < 3; i++) fn()
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    samples.push((performance.now() - start) / iterations)
  }
  // Median, not mean: a GC pause or a scheduler hiccup lands in one sample and
  // the mean would carry it into the reported number.
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

function report(label: string, msPerCall: number): void {
  console.error(`  ${label.padEnd(46)} ${msPerCall.toFixed(4)} ms`)
}

const CONTROL: readonly ControlSpec[] = [{ qubit: 0, state: 1 }]

/** The operations benchmarked, each on a state of the given size. */
function workload(state: Statevector, apply: KernelLike): () => void {
  const top = state.qubits - 1
  return () => {
    apply.applyControlled(state, GATE_MATRICES.h, top, [])
    apply.applyControlled(state, GATE_MATRICES.h, 1, [])
    apply.applyControlled(state, GATE_MATRICES.x, top, CONTROL)
    apply.applySwap(state, 1, top, [])
    apply.applyISwap(state, 1, top)
  }
}

interface KernelLike {
  applyControlled: (
    state: Statevector,
    matrix: Float64Array,
    target: number,
    controls: readonly ControlSpec[]
  ) => unknown
  applySwap: (
    state: Statevector,
    q0: number,
    q1: number,
    controls: readonly ControlSpec[]
  ) => unknown
  applyISwap: (state: Statevector, q0: number, q1: number) => unknown
}

/** Straight into `apply.ts` — the engine as it was before this package. */
const REFERENCE: KernelLike = { applyControlled, applySwap, applyISwap }

/** The same gates through the accelerator seam in `@qsim/core`. */
const SEAM: KernelLike = {
  applyControlled: acceleratedApplyControlled,
  applySwap: acceleratedApplySwap,
  applyISwap: acceleratedApplyISwap,
}

afterEach(() => {
  uninstallStatevectorKernel()
})

describe('the TypeScript baseline', () => {
  test('gate cost by register size — the numbers WASM has to beat', () => {
    console.error('\nTypeScript kernel, five gates per iteration:')
    for (const qubits of [16, 18, 20]) {
      const state = alloc(qubits)
      applyControlled(state, GATE_MATRICES.h, 0, [])
      const ms = measure(5, qubits >= 20 ? 4 : 12, workload(state, REFERENCE))
      report(`${qubits} qubits (${2 ** qubits} amplitudes)`, ms)
      expect(ms).toBeGreaterThan(0)
    }
  })
})

/**
 * The seam is claimed to be free. "Free" is a measurable claim and this is the
 * measurement — if adding the accelerator hook made the *unaccelerated* engine
 * slower, the whole design would be a net loss for every user without WASM,
 * which is most of them.
 */
describe('the cost of the seam', () => {
  test('an uninstalled seam is indistinguishable from calling apply.ts', () => {
    const qubits = 18
    const direct = alloc(qubits)
    const seamed = alloc(qubits)
    applyControlled(direct, GATE_MATRICES.h, 0, [])
    applyControlled(seamed, GATE_MATRICES.h, 0, [])

    const bare = measure(5, 12, workload(direct, REFERENCE))
    const viaSeam = measure(5, 12, workload(seamed, SEAM))

    console.error('\nSeam overhead at 18 qubits:')
    report('direct apply.ts', bare)
    report('through kernel.ts, nothing installed', viaSeam)

    // Generous, deliberately: this asserts "not a different order of
    // magnitude", not a precise ratio, because a tight bound here would fail
    // on a loaded CI runner for reasons that have nothing to do with the seam.
    expect(viaSeam).toBeLessThan(bare * 3)
  })

  test('a declining kernel — the production fallback — stays cheap', () => {
    const qubits = 18
    const state = alloc(qubits)
    applyControlled(state, GATE_MATRICES.h, 0, [])

    const before = measure(5, 12, workload(state, REFERENCE))

    const declining: StatevectorKernel = {
      id: 'declines-everything',
      applyControlled: () => false,
      applySwap: () => false,
      applyISwap: () => false,
    }
    installStatevectorKernel(declining)
    const after = measure(5, 12, workload(state, SEAM))

    console.error('\nFallback overhead at 18 qubits:')
    report('no kernel', before)
    report('kernel installed, declines every gate', after)
    expect(after).toBeLessThan(before * 3)
  })
})

describe('the WebAssembly kernel', () => {
  /**
   * The artifact, or `undefined` on a checkout with no Rust toolchain.
   *
   * Copied to its exact range: `readFile` returns a `Buffer` from a shared
   * pool, so its `.buffer` usually holds unrelated bytes on either side.
   */
  async function artifact(): Promise<ArrayBuffer | undefined> {
    try {
      const data = await readFile(ARTIFACT)
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      )
    } catch {
      return undefined
    }
  }

  test('speedup against the TypeScript kernel', async () => {
    const bytes = await artifact()
    if (bytes === undefined) {
      console.error(
        `\nSKIPPED: no ${ARTIFACT}.\n` +
          `  The Rust toolchain is not installed here, so there is no kernel\n` +
          `  to measure. Build one with:\n` +
          `      pnpm --filter @qsim/wasm build:wasm\n` +
          `  The TypeScript baseline above is what it will be compared to.\n`
      )
      // Not a silent pass: the assertion records that the branch was taken.
      expect(bytes).toBeUndefined()
      return
    }

    const loaded = await loadKernel({ load: () => Promise.resolve(bytes) })
    expect(loaded.ok, loaded.ok ? '' : loaded.detail).toBe(true)
    if (!loaded.ok) return
    const live: LoadedKernel = loaded

    try {
      console.error('\nWASM vs TypeScript, five gates per iteration:')
      for (const qubits of [16, 18, 20]) {
        const heap = alloc(qubits)
        applyControlled(heap, GATE_MATRICES.h, 0, [])
        const baseline = measure(
          5,
          qubits >= 20 ? 4 : 12,
          workload(heap, REFERENCE)
        )

        const handle = live.session.allocState(qubits)
        expect(handle).toBeDefined()
        if (handle === undefined) return
        applyControlled(handle.statevector, GATE_MATRICES.h, 0, [])
        const accelerated = measure(5, qubits >= 20 ? 4 : 12, () => {
          // Re-read the getter each iteration; it is one identity check.
          workload(handle.statevector, live.kernel)()
        })
        handle.release()

        const speedup = baseline / accelerated
        report(
          `${qubits} qubits — TS ${baseline.toFixed(3)} / WASM ` +
            `${accelerated.toFixed(3)}`,
          accelerated
        )
        console.error(`  ${' '.repeat(46)} ${speedup.toFixed(2)}× speedup`)

        // Deliberately not asserting the 3–10× of §5.6. A CI runner under load
        // does not reproduce a desktop ratio, and a red build that means "the
        // runner was busy" trains people to ignore red builds. What is
        // asserted is that WASM is not *slower*, which would mean the design
        // failed rather than that the machine was busy.
        expect(speedup).toBeGreaterThan(0.9)
      }
    } finally {
      live.dispose()
    }
  })
})

/**
 * The harness itself, exercised against the linear-memory stand-in so that it
 * is known to work on the day a real artifact appears.
 *
 * This produces no performance claim and must not be read as one: the
 * stand-in is JavaScript, so any ratio here is JavaScript against JavaScript
 * plus a boundary. It is here to prove that the measurement path — allocate in
 * linear memory, evolve through the kernel, time it — runs end to end.
 */
describe('the measurement path (not a performance claim)', () => {
  test('runs end to end against the linear-memory stand-in', () => {
    const session = createSession(createReferenceExports())
    const kernel = createKernel(session)
    const handle = session.allocState(12)
    expect(handle).toBeDefined()
    if (handle === undefined) return

    const ms = measure(3, 5, workload(handle.statevector, kernel))
    expect(ms).toBeGreaterThan(0)
    session.dispose()
  })
})
