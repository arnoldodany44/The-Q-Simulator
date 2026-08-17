/**
 * @qsim/wasm — the optional Rust/WebAssembly accelerator for the statevector
 * engine. Specification §5.6, phase 2.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE RELATIONSHIP TO @qsim/core, WHICH IS THE WHOLE DESIGN
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `@qsim/core` does not depend on this package and never will. It has zero
 * runtime dependencies (§12.3), it is what runs on the server, in a worker,
 * and in any browser where WebAssembly is switched off, and it is the
 * *definition* of what the engine computes. This package depends on it, one
 * way, and attaches through the `StatevectorKernel` seam it exposes.
 *
 * The consequences are worth stating plainly, because they are the reason the
 * arrows point this way:
 *
 *   - Deleting this package changes nothing but speed.
 *   - A disagreement between the two is resolved in favour of `@qsim/core`,
 *     by definition and not by judgement. `loadKernel` proves agreement
 *     before installing and refuses to install without it.
 *   - Nothing here can make a circuit produce a different answer. It can only
 *     make it produce the same answer sooner, or decline and let TypeScript
 *     produce it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE THE STATEVECTOR LIVES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * In WebAssembly linear memory, with JavaScript holding views onto it. Not on
 * the JS heap. At 20 qubits the state is 16 MB and WebAssembly cannot address
 * the JS heap, so a design that passed the state across would copy 32 MB per
 * gate — more than the 2.4–5.9 ms an entire TypeScript gate costs at that
 * size, which makes the accelerator slower than what it accelerates. The full
 * argument, and the view-detachment hazard that comes with the choice, is in
 * `session.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * USING IT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ```ts
 * const loaded = await loadKernel({
 *   load: async () => fetch(url).then((r) => r.arrayBuffer()),
 * })
 * if (loaded.ok) {
 *   const handle = loaded.session.allocState(20)
 *   // handle.statevector is an ordinary Statevector; hand it to runFromState
 *   // and every gate goes through WASM. Release it when done.
 * }
 * // If !loaded.ok, do nothing: the engine is already correct without this.
 * ```
 *
 * The artifact is built by `pnpm --filter @qsim/wasm build:wasm`, which needs
 * a Rust toolchain and wasm-pack. Checkouts without one are expected and
 * supported — `loadKernel` reports `no-artifact` and the engine runs in
 * TypeScript.
 */

export {
  ABI_VERSION,
  KernelAbiError,
  asKernelExports,
  instantiateKernel,
} from './exports.js'
export type { KernelExports } from './exports.js'

export {
  detectCapabilities,
  hasSharedMemory,
  hasSimd,
  hasWebAssembly,
  preferredArtifact,
} from './detect.js'
export type { Capabilities } from './detect.js'

export { DetachedStateError, createSession, detachState } from './session.js'
export type { KernelSession, StateHandle } from './session.js'

export { createExtras, createKernel } from './kernel.js'
export type { KernelExtras } from './kernel.js'

export {
  EQUIVALENCE_TOLERANCE,
  describeReport,
  maxDeviation,
  verifyEquivalence,
} from './equivalence.js'
export type {
  EquivalenceCase,
  EquivalenceOptions,
  EquivalenceReport,
} from './equivalence.js'

export { loadKernel } from './load.js'
export type {
  FailedLoad,
  LoadFailure,
  LoadOptions,
  LoadResult,
  LoadedKernel,
} from './load.js'
