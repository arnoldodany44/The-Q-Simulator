/**
 * A JavaScript implementation of the kernel ABI, over a real
 * `WebAssembly.Memory`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHAT IT DOES NOT PROVE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The `.wasm` artifact is built by `wasm-pack` and needs a Rust toolchain.
 * Most checkouts do not have one, and this one did not: the crate is
 * compiled in CI. Without something standing in its place, every file in this
 * package would be untested code that has never once been executed — and the
 * bridge, not the arithmetic, is where the interesting mistakes live.
 *
 * So this implements the same ABI against the same kind of memory. It
 * exercises, for real:
 *
 *   - allocation and freeing inside a linear memory that actually grows
 *   - **view detachment**, which is the one way this design fails silently;
 *     the allocator here grows on demand precisely so the tests can watch a
 *     held statevector be invalidated and see the bridge notice
 *   - pointer arithmetic, and the layout claim that the imaginary half sits
 *     immediately after the real half
 *   - the matrix staging buffer, including that it is rewritten per gate
 *   - control folding into `(mask, value)`, negative controls included
 *   - the decline paths, and that a declined call leaves the state untouched
 *   - `ownedPointer`'s three-way answer: mine, not mine, detached
 *
 * It does **not** prove anything about the Rust. The arithmetic below is
 * JavaScript, so an equivalence run against it compares TypeScript with
 * TypeScript. What it establishes is that when the real artifact arrives, the
 * only untested thing left is `kernel.rs` — which has its own `cargo test`
 * suite and, more importantly, faces this same `verifyEquivalence` in CI.
 *
 * To keep even the arithmetic comparison from being circular, the gate loops
 * here are written from the index formula directly — walk every index, act on
 * the ones whose target bit is clear — rather than reusing the
 * `base`/`offset` walk of `apply.ts`. A pairing or endianness mistake in the
 * bridge therefore has two independent formulations to disagree with.
 */

import type { KernelExports } from '../exports.js'

const BYTES_PER_PAGE = 65536
const BYTES_PER_DOUBLE = 8
const MATRIX_DOUBLES = 32
const ABI_VERSION = 1

export interface ReferenceOptions {
  /** What `has_simd()` reports, so the loader's artifact choice is testable. */
  readonly simd?: boolean
  /** Report a different ABI version, to test the staleness refusal. */
  readonly abiVersion?: number
  /** Refuse every allocation, to test the out-of-memory fall-back. */
  readonly refuseAllocation?: boolean
  /** Initial pages. Small by default so that growth actually happens. */
  readonly initialPages?: number
}

/**
 * Build a stand-in for the compiled kernel.
 *
 * The returned object is a `KernelExports` and nothing about it is special to
 * the tests: `createSession`, `createKernel` and `loadKernel` take it exactly
 * as they take the real thing.
 */
export function createReferenceExports(
  options: ReferenceOptions = {}
): KernelExports {
  const memory = new WebAssembly.Memory({
    initial: options.initialPages ?? 1,
  })

  // A bump allocator with an exact-fit free list. Crude on purpose: the point
  // is that it *grows linear memory*, which is what detaches views, and a
  // sophisticated allocator would grow less often and test less.
  let bump = BYTES_PER_DOUBLE // never hand out 0; that is the crate's "no"
  const free = new Map<number, number[]>()
  const liveSizes = new Map<number, number>()
  let matrixScratch = 0

  const buffer = (): ArrayBuffer => memory.buffer

  function reserve(doubles: number): number {
    const bytes = doubles * BYTES_PER_DOUBLE
    const reusable = free.get(doubles)
    const recycled = reusable?.pop()
    if (recycled !== undefined) return recycled

    // Align to 8 so the Float64Array views are constructible.
    const pointer =
      bump + ((BYTES_PER_DOUBLE - (bump % BYTES_PER_DOUBLE)) % BYTES_PER_DOUBLE)
    const end = pointer + bytes
    if (end > buffer().byteLength) {
      const needed = Math.ceil((end - buffer().byteLength) / BYTES_PER_PAGE)
      try {
        // THIS is the call that detaches every outstanding view.
        memory.grow(needed)
      } catch {
        return 0
      }
    }
    bump = end
    return pointer
  }

  function doubles(pointer: number, count: number): Float64Array {
    return new Float64Array(buffer(), pointer, count)
  }

  /** The `(re, im)` halves of a state handle, derived fresh after any growth. */
  function halves(pointer: number, size: number): [Float64Array, Float64Array] {
    return [
      doubles(pointer, size),
      doubles(pointer + size * BYTES_PER_DOUBLE, size),
    ]
  }

  function checkState(pointer: number, qubits: number): number | undefined {
    if (
      pointer === 0 ||
      !Number.isInteger(qubits) ||
      qubits < 1 ||
      qubits > 27
    ) {
      return undefined
    }
    if (liveSizes.get(pointer) !== qubits) return undefined
    return 2 ** qubits
  }

  function matrixPointer(): number {
    if (matrixScratch === 0) matrixScratch = reserve(MATRIX_DOUBLES)
    return matrixScratch
  }

  function checkControls(qubits: number, mask: number, value: number): boolean {
    const all = qubits >= 31 ? 0x7fffffff : (1 << qubits) - 1
    return (mask & ~all) === 0 && (value & ~mask) === 0
  }

  return {
    memory,

    abi_version: () => options.abiVersion ?? ABI_VERSION,
    has_simd: () => options.simd ?? false,

    alloc_state(qubits: number): number {
      if (options.refuseAllocation === true) return 0
      if (!Number.isInteger(qubits) || qubits < 1 || qubits > 27) return 0
      const size = 2 ** qubits
      const pointer = reserve(size * 2)
      if (pointer === 0) return 0
      const [re, im] = halves(pointer, size)
      re.fill(0)
      im.fill(0)
      re[0] = 1 // |0…0⟩
      liveSizes.set(pointer, qubits)
      return pointer
    },

    free_state(pointer: number, qubits: number): void {
      if (liveSizes.get(pointer) !== qubits) return
      liveSizes.delete(pointer)
      const count = 2 ** qubits * 2
      const bucket = free.get(count) ?? []
      bucket.push(pointer)
      free.set(count, bucket)
    },

    matrix_ptr: matrixPointer,

    apply_controlled(
      pointer: number,
      qubits: number,
      target: number,
      mask: number,
      value: number
    ): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined) return false
      if (!Number.isInteger(target) || target < 0 || target >= qubits) {
        return false
      }
      if (!checkControls(qubits, mask, value)) return false
      if ((mask & (1 << target)) !== 0) return false

      const m = doubles(matrixPointer(), MATRIX_DOUBLES)
      const m00r = m[0]
      const m00i = m[1]
      const m01r = m[2]
      const m01i = m[3]
      const m10r = m[4]
      const m10i = m[5]
      const m11r = m[6]
      const m11i = m[7]

      const [re, im] = halves(pointer, size)
      const stride = 1 << target
      // Written from the definition rather than as a strided walk: visit every
      // index, act on the ones where the target bit is clear. Same pairs, an
      // independent derivation of them.
      for (let i0 = 0; i0 < size; i0++) {
        if ((i0 & stride) !== 0) continue
        if ((i0 & mask) !== value) continue
        const i1 = i0 | stride
        const a0r = re[i0]
        const a0i = im[i0]
        const a1r = re[i1]
        const a1i = im[i1]
        re[i0] = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i)
        im[i0] = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r)
        re[i1] = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i)
        im[i1] = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r)
      }
      return true
    },

    apply_swap(
      pointer: number,
      qubits: number,
      q0: number,
      q1: number,
      mask: number,
      value: number
    ): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined) return false
      if (q0 >= qubits || q1 >= qubits || q0 === q1 || q0 < 0 || q1 < 0) {
        return false
      }
      if (!checkControls(qubits, mask, value)) return false
      const bit0 = 1 << q0
      const bit1 = 1 << q1
      if ((mask & (bit0 | bit1)) !== 0) return false

      const [re, im] = halves(pointer, size)
      for (let i = 0; i < size; i++) {
        // Each unordered pair once: take the index with q0 set and q1 clear.
        if ((i & bit0) === 0 || (i & bit1) !== 0) continue
        const base = i & ~bit0
        if ((base & mask) !== value) continue
        const partner = base | bit1
        const tr = re[i]
        const ti = im[i]
        re[i] = re[partner]
        im[i] = im[partner]
        re[partner] = tr
        im[partner] = ti
      }
      return true
    },

    apply_iswap(
      pointer: number,
      qubits: number,
      q0: number,
      q1: number
    ): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined) return false
      if (q0 >= qubits || q1 >= qubits || q0 === q1 || q0 < 0 || q1 < 0) {
        return false
      }
      const bit0 = 1 << q0
      const bit1 = 1 << q1
      const [re, im] = halves(pointer, size)
      for (let i = 0; i < size; i++) {
        if ((i & bit0) === 0 || (i & bit1) !== 0) continue
        const partner = (i & ~bit0) | bit1
        const a01r = re[i]
        const a01i = im[i]
        const a10r = re[partner]
        const a10i = im[partner]
        re[i] = -a10i
        im[i] = a10r
        re[partner] = -a01i
        im[partner] = a01r
      }
      return true
    },

    apply_2q(pointer: number, qubits: number, q0: number, q1: number): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined) return false
      if (q0 >= qubits || q1 >= qubits || q0 === q1 || q0 < 0 || q1 < 0) {
        return false
      }
      const m = doubles(matrixPointer(), MATRIX_DOUBLES)
      const [re, im] = halves(pointer, size)
      const bit0 = 1 << q0
      const bit1 = 1 << q1

      for (let base = 0; base < size; base++) {
        if ((base & bit0) !== 0 || (base & bit1) !== 0) continue
        const index = [base, base + bit0, base + bit1, base + bit0 + bit1]
        const inR = index.map((k) => re[k])
        const inI = index.map((k) => im[k])
        const outR = [0, 0, 0, 0]
        const outI = [0, 0, 0, 0]
        for (let row = 0; row < 4; row++) {
          let sumR = 0
          let sumI = 0
          for (let column = 0; column < 4; column++) {
            const at = (row * 4 + column) * 2
            const mr = m[at]
            const mi = m[at + 1]
            sumR += mr * inR[column] - mi * inI[column]
            sumI += mr * inI[column] + mi * inR[column]
          }
          outR[row] = sumR
          outI[row] = sumI
        }
        for (let k = 0; k < 4; k++) {
          re[index[k]] = outR[k]
          im[index[k]] = outI[k]
        }
      }
      return true
    },

    norm_squared(pointer: number, qubits: number): number {
      const size = checkState(pointer, qubits)
      if (size === undefined) return -1
      const [re, im] = halves(pointer, size)
      let sum = 0
      for (let i = 0; i < size; i++) sum += re[i] * re[i] + im[i] * im[i]
      return sum
    },

    scale(pointer: number, qubits: number, factor: number): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined) return false
      const [re, im] = halves(pointer, size)
      for (let i = 0; i < size; i++) {
        re[i] *= factor
        im[i] *= factor
      }
      return true
    },

    probabilities(pointer: number, qubits: number, out: number): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined || out === 0) return false
      const [re, im] = halves(pointer, size)
      const target = doubles(out, size)
      for (let i = 0; i < size; i++) {
        target[i] = re[i] * re[i] + im[i] * im[i]
      }
      return true
    },

    reduced_density(
      pointer: number,
      qubits: number,
      qubit: number,
      out: number
    ): boolean {
      const size = checkState(pointer, qubits)
      if (size === undefined || out === 0) return false
      if (qubit < 0 || qubit >= qubits) return false
      const [re, im] = halves(pointer, size)
      const stride = 1 << qubit
      let rho00 = 0
      let rho11 = 0
      let re01 = 0
      let im01 = 0
      for (let zero = 0; zero < size; zero++) {
        if ((zero & stride) !== 0) continue
        const one = zero | stride
        const zr = re[zero]
        const zi = im[zero]
        const or = re[one]
        const oi = im[one]
        rho00 += zr * zr + zi * zi
        rho11 += or * or + oi * oi
        re01 += zr * or + zi * oi
        im01 += zi * or - zr * oi
      }
      const target = doubles(out, 4)
      target[0] = rho00
      target[1] = rho11
      target[2] = re01
      target[3] = im01
      return true
    },
  }
}
