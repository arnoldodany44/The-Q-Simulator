/**
 * Runtime feature detection.
 *
 * The engine has to run in three places with three different answers here: a
 * modern browser worker (WebAssembly with SIMD), an older or locked-down
 * browser (no WebAssembly at all — some enterprise policies and some content
 * blockers switch it off), and Node on the server. None of those is an error
 * case. Phase 1 of §5.6 is pure TypeScript in a Web Worker and it stays the
 * answer wherever phase 2 will not run.
 *
 * WHY SIMD IS A SEPARATE ARTIFACT AND NOT A BRANCH. `simd128` is a *compile
 * target feature*: a module built with it contains v128 instructions in its
 * body, and an engine without the proposal rejects it at validation, before a
 * single line runs. There is no way to ship one module that uses SIMD where
 * available and scalar code elsewhere. So CI builds two, and this file is what
 * decides which one to fetch — a distinction worth stating because "detect and
 * branch" is the intuition and it is wrong here.
 */

/**
 * A 29-byte module whose body is `i32.const 0; i8x16.splat; drop`.
 *
 * `i8x16.splat` is a v128 instruction, so validation succeeds only where the
 * SIMD proposal is implemented. `WebAssembly.validate` neither instantiates
 * nor executes it — this is a type check on 29 bytes, costing microseconds,
 * which is why it is safe to run on the startup path.
 */
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00,
  0x00, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x41, 0x00, 0xfd,
  0x0f, 0x1a, 0x0b,
])

/** What this runtime can offer the accelerator. */
export interface Capabilities {
  /** WebAssembly exists and can compile and instantiate a module. */
  readonly webAssembly: boolean
  /** The 128-bit SIMD proposal — picks which artifact to load. */
  readonly simd: boolean
  /**
   * `SharedArrayBuffer` plus cross-origin isolation.
   *
   * Not required by this phase, and deliberately so. Reported because it
   * decides something the caller has to know: a statevector in *unshared*
   * linear memory cannot be transferred to another thread, so the accelerator
   * has to live in whichever worker already owns the simulation rather than
   * on the main thread handing results across. `apps/web` already serves the
   * COOP/COEP headers this reports on, for the transferable-state reason in
   * `statevector.ts`.
   */
  readonly sharedMemory: boolean
}

/** Whether `WebAssembly` exists and is usable, rather than merely defined. */
export function hasWebAssembly(): boolean {
  try {
    return (
      typeof WebAssembly === 'object' &&
      typeof WebAssembly.validate === 'function' &&
      typeof WebAssembly.compile === 'function' &&
      typeof WebAssembly.Memory === 'function'
    )
  } catch {
    // A property access can throw under some hardened runtimes. That is an
    // answer, not a failure: no WebAssembly here.
    return false
  }
}

/** Whether this engine implements 128-bit SIMD. */
export function hasSimd(): boolean {
  if (!hasWebAssembly()) return false
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

/** Whether shared memory is available and the context is cross-origin isolated. */
export function hasSharedMemory(): boolean {
  try {
    if (typeof SharedArrayBuffer !== 'function') return false
    // `crossOriginIsolated` is absent in Node, where shared memory needs no
    // isolation because there is no origin to be isolated from.
    const isolated = (globalThis as { crossOriginIsolated?: boolean })
      .crossOriginIsolated
    return isolated === undefined || isolated
  } catch {
    return false
  }
}

/** Everything above, in one call, for logging and for artifact selection. */
export function detectCapabilities(): Capabilities {
  const webAssembly = hasWebAssembly()
  return {
    webAssembly,
    simd: webAssembly && hasSimd(),
    sharedMemory: hasSharedMemory(),
  }
}

/**
 * Which artifact to fetch: the SIMD build where the engine supports it, the
 * baseline build otherwise, and nothing at all where WebAssembly is absent.
 *
 * The names match what `pnpm --filter @qsim/wasm build:wasm` writes into
 * `pkg/`, so a caller can turn this straight into a URL or a file path.
 */
export function preferredArtifact(
  capabilities: Capabilities = detectCapabilities()
): 'kernel-simd' | 'kernel' | undefined {
  if (!capabilities.webAssembly) return undefined
  return capabilities.simd ? 'kernel-simd' : 'kernel'
}
