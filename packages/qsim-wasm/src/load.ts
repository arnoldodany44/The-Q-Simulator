/**
 * The one supported way to turn a `.wasm` artifact into an accelerated engine.
 *
 * Every step that could produce a wrong answer is a gate, and failing any of
 * them means the engine stays in TypeScript rather than proceeding carefully:
 *
 *   1. WebAssembly exists here at all                     (`detect.ts`)
 *   2. the bytes compile and instantiate
 *   3. the artifact speaks this checkout's ABI            (`exports.ts`)
 *   4. the kernel reproduces `apply.ts` to 1e-12          (`equivalence.ts`)
 *   5. only then is it installed into `@qsim/core`
 *
 * Step 4 is the one that is unusual and the one that is not optional. It is
 * about a millisecond of eight-qubit arithmetic against the possibility of
 * shipping a silently wrong amplitude to somebody whose engine, or CPU, was
 * not the one CI compiled on.
 *
 * FAILURE IS NEVER AN EXCEPTION HERE. `loadKernel` returns a result describing
 * what happened. A browser with WebAssembly switched off, a 404 on the
 * artifact and a kernel that disagrees are all the same outcome from the
 * product's point of view — the simulator works, in TypeScript, exactly as it
 * did before phase 2 existed — and a rejected promise on a startup path would
 * turn a supported configuration into an error report.
 */

import {
  installStatevectorKernel,
  uninstallStatevectorKernel,
  type StatevectorKernel,
} from '@qsim/core'

import { detectCapabilities, type Capabilities } from './detect.js'
import { instantiateKernel, type KernelExports } from './exports.js'
import {
  describeReport,
  verifyEquivalence,
  type EquivalenceOptions,
  type EquivalenceReport,
} from './equivalence.js'
import { createExtras, createKernel, type KernelExtras } from './kernel.js'
import { createSession, type KernelSession } from './session.js'

/** Why the accelerator is not running, when it is not. */
export type LoadFailure =
  | 'no-webassembly'
  | 'no-artifact'
  | 'instantiation-failed'
  | 'abi-mismatch'
  | 'equivalence-failed'

export interface LoadedKernel {
  readonly ok: true
  readonly session: KernelSession
  readonly kernel: StatevectorKernel
  readonly extras: KernelExtras
  readonly report: EquivalenceReport
  readonly capabilities: Capabilities
  /** Uninstall from `@qsim/core` and free every state. */
  readonly dispose: () => void
}

export interface FailedLoad {
  readonly ok: false
  readonly reason: LoadFailure
  readonly detail: string
  readonly capabilities: Capabilities
}

export type LoadResult = LoadedKernel | FailedLoad

export interface LoadOptions {
  /**
   * The artifact. A function so the caller decides how bytes are obtained —
   * `fetch` in a browser, `readFile` in Node, a bundler's `?url` in a build —
   * and so nothing is fetched at all when `detect.ts` has already said no.
   *
   * Return `undefined` for "there is no artifact here", which is the normal
   * state of a checkout on a machine without a Rust toolchain.
   */
  readonly load: () => Promise<BufferSource | undefined>
  /** Passed through to `verifyEquivalence`. */
  readonly equivalence?: EquivalenceOptions
  /** Install into `@qsim/core` on success. Default true. */
  readonly install?: boolean
}

/**
 * Load, verify and (by default) install a WASM kernel.
 *
 * The caller keeps the returned handle: `dispose()` is the only thing that
 * frees the statevectors held in linear memory, because there is no finalizer
 * that can be relied upon to do it.
 */
export async function loadKernel(options: LoadOptions): Promise<LoadResult> {
  const capabilities = detectCapabilities()
  if (!capabilities.webAssembly) {
    return {
      ok: false,
      reason: 'no-webassembly',
      detail:
        'WebAssembly is unavailable in this runtime. The engine runs in ' +
        'TypeScript, which is phase 1 of the performance plan and complete ' +
        'on its own.',
      capabilities,
    }
  }

  let bytes: BufferSource | undefined
  try {
    bytes = await options.load()
  } catch (error) {
    return {
      ok: false,
      reason: 'no-artifact',
      detail: `Could not read the kernel artifact: ${messageOf(error)}`,
      capabilities,
    }
  }
  if (bytes === undefined) {
    return {
      ok: false,
      reason: 'no-artifact',
      detail:
        'No kernel artifact was supplied. Build one with ' +
        '`pnpm --filter @qsim/wasm build:wasm`, which needs a Rust toolchain.',
      capabilities,
    }
  }

  let exports: KernelExports
  try {
    exports = await instantiateKernel(bytes)
  } catch (error) {
    const detail = messageOf(error)
    return {
      ok: false,
      // An ABI mismatch is a stale artifact and is worth naming separately: it
      // is fixed by rebuilding, where an instantiation failure usually is not.
      reason: detail.includes('ABI version')
        ? 'abi-mismatch'
        : 'instantiation-failed',
      detail,
      capabilities,
    }
  }

  const session = createSession(exports)
  const kernel = createKernel(session)

  let report: EquivalenceReport
  try {
    report = verifyEquivalence(session, kernel, options.equivalence)
  } catch (error) {
    session.dispose()
    return {
      ok: false,
      reason: 'equivalence-failed',
      detail: `The equivalence check threw: ${messageOf(error)}`,
      capabilities,
    }
  }

  if (!report.agreed) {
    session.dispose()
    return {
      ok: false,
      reason: 'equivalence-failed',
      detail: describeReport(report),
      capabilities,
    }
  }

  const extras = createExtras(session)
  if (options.install !== false) installStatevectorKernel(kernel)

  return {
    ok: true,
    session,
    kernel,
    extras,
    report,
    capabilities,
    dispose: () => {
      uninstallStatevectorKernel()
      session.dispose()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
