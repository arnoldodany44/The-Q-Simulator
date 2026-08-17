/**
 * Statevector ownership across the WebAssembly boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DECISION: THE STATE LIVES IN LINEAR MEMORY, AND JAVASCRIPT BORROWS IT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A `Statevector` is `{ qubits, size, re, im }` with two `Float64Array`. A
 * `Float64Array` over a `WebAssembly.Memory` buffer satisfies that interface
 * exactly as well as one over the JS heap — same type, same indexing, same
 * everything. So a state allocated inside the kernel *is* an ordinary
 * statevector as far as the rest of `@qsim/core` is concerned:
 * `probabilities`, `sampleShots`, `blochVectors`, `partialTrace` and the
 * runner all take it unmodified, with no adapter and no copy.
 *
 * That is the whole trick, and the reason for it is arithmetic:
 *
 *   - WebAssembly cannot address the JavaScript heap. "Pass the statevector"
 *     therefore always means "copy the statevector".
 *   - At 20 qubits the state is 16 MB. Copying it in and back out around each
 *     gate is 32 MB of `memcpy` per gate.
 *   - The measured TypeScript cost of an entire one-qubit gate at 20 qubits is
 *     2.4 ms (high target) to 5.9 ms (target 0). 32 MB of copying is in that
 *     same range or above it.
 *
 * A copy-per-gate kernel would therefore be *slower than the TypeScript it
 * replaces*, with the arithmetic done perfectly. There is no tuning that
 * rescues it; the boundary has to be crossed O(1) times per gate, not O(2ⁿ)
 * bytes. Hence: allocate in linear memory once, evolve in place for the whole
 * circuit, and copy only if the caller explicitly asks for a heap-owned
 * result (`detachState`).
 *
 * Ownership is one-directional and explicit. The Rust allocator owns the
 * bytes, a `StateHandle` owns the claim on them, and `release()` is the only
 * way they go back. There is no finalizer: `FinalizationRegistry` is not
 * guaranteed to run, and a leak in linear memory is not collectable by the JS
 * GC that would be waiting for it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE HAZARD: GROWTH DETACHES VIEWS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Growing a `WebAssembly.Memory` replaces its `ArrayBuffer` and **detaches
 * every existing view**. A detached `Float64Array` has length 0 and reads
 * from it return `undefined` — so a kernel loop would compute with `undefined`
 * and write `NaN`, and a TypeScript fallback loop would do the same. Not a
 * crash: a silently wrong state, which is the single outcome this project is
 * organised to prevent.
 *
 * Growth happens when the Rust allocator needs pages, which means it happens
 * inside `alloc_state` — so allocating a *second* state can detach the views
 * of the first. Checkpoints make that a real sequence, not a hypothetical.
 *
 * Three defences, all here, because this is where the views live:
 *
 *  1. The `statevector` getter re-derives its views whenever `memory.buffer`
 *     is no longer the object they were built from. Re-deriving is two object
 *     allocations and no copy, so a handle heals across a growth instead of
 *     rotting — which is why the getter must be read, never cached.
 *  2. Every handle carries the `ptr` implicitly, as `re.byteOffset` — the
 *     views are self-describing, so a re-derived view lands on the same bytes
 *     with no bookkeeping to get out of step.
 *  3. `ownedPointer()` proves a statevector belongs to this session before any
 *     kernel call touches it, and distinguishes "not mine" (decline, fall back
 *     to TypeScript) from "detached" (throw, because continuing would compute
 *     with `undefined`). Those two must never be confused: one is routine, the
 *     other is a bug that has to surface.
 */

import type { Statevector } from '@qsim/core'

import type { KernelExports } from './exports.js'

const BYTES_PER_DOUBLE = 8

/** Raised when a view into linear memory has been invalidated by growth. */
export class DetachedStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DetachedStateError'
  }
}

/**
 * A statevector living in the kernel's linear memory.
 *
 * Read `statevector` fresh on each use rather than caching it. It is a getter
 * that re-derives its views after a memory growth, and a cached copy from
 * before one is detached — see defence 1 above.
 */
export interface StateHandle {
  readonly qubits: number
  readonly size: number
  /** Byte offset of the real half in linear memory; the imaginary half follows. */
  readonly pointer: number
  /** The state as `@qsim/core` sees it. Never cache across an allocation. */
  readonly statevector: Statevector
  /** Whether these bytes are still ours. False after `release()`. */
  readonly live: boolean
  /** Return the bytes to the kernel allocator. Idempotent. */
  readonly release: () => void
}

/**
 * A plain region of linear memory the caller owns.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * `extras.probabilities` writes 2ⁿ doubles through a pointer, so its output has
 * to live in linear memory — and the session handed out exactly two regions, a
 * whole statevector and the 32-double gate staging buffer. Neither is an output
 * region: the first is twice the size and the wrong shape, and the second is
 * where the next gate's matrix goes and where `reducedDensity` already writes.
 * So the accelerated Born-rule path — 3.2 ms at 20 qubits, one of the three
 * costs `kernel.ts` names as its reason for existing — was unreachable as
 * shipped, and the only way to call it was to allocate a second full state and
 * borrow half of it.
 *
 * The ABI has one allocator and it allocates statevectors, so that is what this
 * uses: `alloc_state(q)` reserves 2·2^q doubles, and `q` is chosen as the
 * smallest that covers the request. For the case this exists for — 2ⁿ doubles —
 * the fit is exact, with no waste at all.
 */
export interface BufferHandle {
  /** The region, as doubles. Re-derived after a growth; never cache it. */
  readonly doubles: Float64Array
  /** Return the bytes to the kernel allocator. Idempotent. */
  readonly release: () => void
}

/** Owns one WebAssembly instance and the statevectors allocated inside it. */
export interface KernelSession {
  /** `'wasm-simd128'` or `'wasm'` — reported by the kernel itself. */
  readonly id: string
  readonly exports: KernelExports
  /**
   * Reserve a state in |0…0⟩, or `undefined` when linear memory cannot
   * provide it. `undefined` is a normal outcome — the caller allocates on the
   * JS heap instead and the engine runs in TypeScript.
   */
  readonly allocState: (qubits: number) => StateHandle | undefined
  /**
   * The pointer for `state`, or `undefined` when it is not ours.
   *
   * Throws `DetachedStateError` when the state *was* ours and its views have
   * since been invalidated, because the alternative is arithmetic on
   * `undefined`.
   */
  readonly ownedPointer: (state: Statevector) => number | undefined
  /**
   * Reserve `doubles` contiguous doubles in linear memory, for an accelerated
   * output. `undefined` when memory cannot provide them.
   *
   * Not a statevector: `ownedPointer` will not accept a view of one of these,
   * because it is not a state and no gate may be applied to it.
   */
  readonly allocBuffer: (doubles: number) => BufferHandle | undefined
  /** A 32-double view onto the matrix staging area. */
  readonly matrixScratch: () => Float64Array
  /** Free every state and buffer this session still holds. */
  readonly dispose: () => void
}

/**
 * Wrap an instantiated kernel.
 *
 * One session per instance, and one instance per thread: linear memory is not
 * shared between workers unless it was created shared, and this phase does not
 * create it shared (see `detect.ts` on why the accelerator belongs inside the
 * worker that already owns the simulation).
 */
export function createSession(exports: KernelExports): KernelSession {
  const id = exports.has_simd() ? 'wasm-simd128' : 'wasm'
  const handles = new Set<StateHandle>()
  const buffers = new Set<BufferHandle>()

  /**
   * The statevector objects this session has vended and has not taken back.
   *
   * ── LAYOUT IS NOT LIVENESS, AND ONLY ONE OF THEM IS SAFETY ──────────────
   *
   * `ownedPointer` used to prove *layout*: two equal halves in the live buffer,
   * imaginary immediately after real, eight-byte aligned. A `Statevector` read
   * from a handle and kept across `release()` satisfies every one of those — the
   * getter that throws is bypassed, because the object already exists — so a
   * gate offered the stale object was accepted, and Rust's allocator hands the
   * same address back on the next allocation of the same size. The kernel then
   * writes into whatever state now lives there. `crate/src/lib.rs`'s `check()`
   * cannot catch it: it validates that the pointer is non-null and the qubit
   * count is in range, and there is no live-handle map on that side.
   *
   * So the map is here, on the side that already owns handing the object out
   * and taking it back. Identity and not address, because an address is exactly
   * what a recycling allocator reuses.
   */
  const vended = new WeakMap<Statevector, { pointer: number; size: number }>()

  const bufferOf = (): ArrayBuffer => exports.memory.buffer

  function allocState(qubits: number): StateHandle | undefined {
    if (!Number.isInteger(qubits) || qubits < 1) return undefined
    const pointer = exports.alloc_state(qubits)
    // Zero is the crate's "could not reserve" answer, and it is also a
    // pointer no allocation can legitimately have.
    if (pointer === 0) return undefined

    const size = 2 ** qubits
    let buffer: ArrayBuffer | undefined
    let cached: Statevector | undefined
    let live = true

    const statevector = (): Statevector => {
      if (!live) {
        throw new DetachedStateError(
          `This statevector was released back to the kernel allocator. ` +
            `Allocate a new one; the bytes may already belong to another state.`
        )
      }
      const current = bufferOf()
      // Identity comparison, not a length check: growth produces a *new*
      // buffer, and the old one is detached rather than resized.
      if (cached === undefined || buffer !== current) {
        buffer = current
        // The previous object's views are detached and it is no longer this
        // handle's statevector, so it stops being one this session vouches for.
        if (cached !== undefined) vended.delete(cached)
        cached = {
          qubits,
          size,
          re: new Float64Array(current, pointer, size),
          im: new Float64Array(
            current,
            pointer + size * BYTES_PER_DOUBLE,
            size
          ),
        }
        vended.set(cached, { pointer, size })
      }
      return cached
    }

    const handle: StateHandle = {
      qubits,
      size,
      pointer,
      get statevector() {
        return statevector()
      },
      get live() {
        return live
      },
      release: () => {
        if (!live) return
        live = false
        // Withdrawn *before* the bytes go back, so there is no instant in which
        // a stale object is both reachable and backed by memory somebody else
        // may already own.
        if (cached !== undefined) vended.delete(cached)
        cached = undefined
        handles.delete(handle)
        exports.free_state(pointer, qubits)
      },
    }
    handles.add(handle)
    return handle
  }

  /**
   * The smallest statevector width whose allocation covers `doubles`.
   *
   * `alloc_state(q)` reserves 2·2^q doubles, so the condition is
   * `2·2^q ≥ doubles`. Computed by doubling rather than with `Math.log2`,
   * because this decides how many bytes a kernel is told it may write and a
   * floating-point logarithm off by one ulp at a power of two would decide it
   * wrongly.
   */
  function widthFor(doubles: number): number | undefined {
    let qubits = 1
    while (2 * 2 ** qubits < doubles) {
      qubits += 1
      // The crate refuses anything above 27 (`check()` in lib.rs).
      if (qubits > 27) return undefined
    }
    return qubits
  }

  function allocBuffer(doubles: number): BufferHandle | undefined {
    if (!Number.isInteger(doubles) || doubles < 1) return undefined
    const qubits = widthFor(doubles)
    if (qubits === undefined) return undefined
    const pointer = exports.alloc_state(qubits)
    if (pointer === 0) return undefined

    let live = true
    const handle: BufferHandle = {
      get doubles() {
        if (!live) {
          throw new DetachedStateError(
            `This buffer was released back to the kernel allocator. ` +
              `Allocate a new one; the bytes may already belong to something ` +
              `else.`
          )
        }
        // Re-derived on every read, for the reason the statevector getter is:
        // a growth detaches every view and a cached one is silently useless.
        return new Float64Array(bufferOf(), pointer, doubles)
      },
      release: () => {
        if (!live) return
        live = false
        buffers.delete(handle)
        exports.free_state(pointer, qubits)
      },
    }
    buffers.add(handle)
    return handle
  }

  function ownedPointer(state: Statevector): number | undefined {
    const re = state.re
    const im = state.im
    const current = bufferOf()

    /*
     * LIVENESS FIRST. A statevector this session did not vend, or vended and
     * has since taken back, is declined — whatever its bytes look like. See
     * `vended` above: layout alone was satisfied by a released object sitting
     * on an address the allocator had already handed to somebody else.
     */
    if (!vended.has(state)) {
      // A JS-heap state is the ordinary case and is declined; a *detached* one
      // still throws, because nothing can compute with it and quietly falling
      // back would mean arithmetic on `undefined`.
      if (state.size > 0 && (re.byteLength === 0 || im.byteLength === 0)) {
        throw new DetachedStateError(
          `This statevector's views into WebAssembly memory were detached or ` +
            `released. Re-read it from its StateHandle.statevector getter, ` +
            `which re-derives the views, or allocate a new state.`
        )
      }
      return undefined
    }

    if (re.buffer === current && im.buffer === current) {
      // Ours, and live. Confirm the layout is the one `alloc_state` produces
      // before returning a pointer the kernel will write through: two equal
      // halves, imaginary immediately after real, both the declared length.
      const bytes = state.size * BYTES_PER_DOUBLE
      if (
        re.length === state.size &&
        im.length === state.size &&
        im.byteOffset === re.byteOffset + bytes &&
        re.byteOffset % BYTES_PER_DOUBLE === 0
      ) {
        return re.byteOffset
      }
      return undefined
    }

    // A detached buffer reports zero length. Distinguishing this from "a
    // perfectly good JS-heap statevector" is the whole point of the check: a
    // heap state is declined and runs in TypeScript, a detached one cannot be
    // computed with at all and must not be quietly handed to either kernel.
    if (state.size > 0 && (re.byteLength === 0 || im.byteLength === 0)) {
      throw new DetachedStateError(
        `This statevector's views into WebAssembly memory were detached by a ` +
          `memory growth — most likely another state was allocated while this ` +
          `one was held. Re-read it from its StateHandle.statevector getter, ` +
          `which re-derives the views.`
      )
    }

    return undefined
  }

  function matrixScratch(): Float64Array {
    return new Float64Array(bufferOf(), exports.matrix_ptr(), 32)
  }

  function dispose(): void {
    // Copied first: `release()` mutates the set it is iterating.
    for (const handle of [...handles]) handle.release()
    for (const buffer of [...buffers]) buffer.release()
  }

  return {
    id,
    exports,
    allocState,
    allocBuffer,
    ownedPointer,
    matrixScratch,
    dispose,
  }
}

/**
 * A JS-heap copy of a statevector, independent of linear memory.
 *
 * The one place a copy is correct. Two callers need it: anything transferring
 * a result out of the worker (an unshared WASM buffer is not transferable),
 * and anything holding a state across an allocation that might grow memory.
 * Once per run against 2ⁿ per gate, which is the ratio the whole design is
 * built around.
 */
export function detachState(state: Statevector): Statevector {
  return {
    qubits: state.qubits,
    size: state.size,
    re: Float64Array.from(state.re),
    im: Float64Array.from(state.im),
  }
}
