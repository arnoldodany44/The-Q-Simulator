/**
 * A line-by-line transliteration of `crate/src/lib.rs` and
 * `crate/src/kernel.rs` into JavaScript, over a real `WebAssembly.Memory`.
 *
 * WHY THIS EXISTS AND HOW IT DIFFERS FROM `src/testing/reference-exports.ts`.
 *
 * The package already ships a linear-memory stand-in, and it says plainly that
 * it proves nothing about the Rust: its gate loops are written from the index
 * formula (`for i in 0..size, skip where the target bit is set`) precisely so
 * that they are an *independent* derivation of the pairing. That is the right
 * tool for testing the bridge, and the wrong one for testing the crate — an
 * error in `kernel.rs`'s `base`/`offset` walk, in its control fold, or in its
 * `upper`/`lower` two-qubit nesting cannot be seen by a stand-in that does not
 * contain those loops.
 *
 * This file contains those loops. Every counter, every `while`, every
 * `stride << 1`, and the arithmetic association inside `pair` are transcribed
 * from `kernel.rs` as written, and the argument guards are transcribed from
 * `lib.rs` as written — including the ones `lib.rs` has and the stand-in does
 * not (there is no allocation registry on the Rust side; `check()` validates
 * only that the pointer is non-null and the qubit count is in range).
 *
 * Running the workspace's own `verifyEquivalence` against this therefore
 * compares `apply.ts` with the algorithm the crate actually implements, on the
 * one machine in the pipeline that has no Rust toolchain. It is not a
 * substitute for executing the compiled artifact — a miscompilation, an
 * `f64`-contraction flag, or a wasm-bindgen marshalling mistake still needs
 * the real `.wasm` — but it moves the crate's *arithmetic* from untested to
 * tested.
 *
 * `free_state` does not recycle. The crate returns the block to Rust's
 * allocator, which may hand the same address out again; leaking here keeps a
 * released pointer from silently becoming a live one, which is a separate
 * hazard and not the one under test.
 */

import type { KernelExports } from '../../exports.js'

const BYTES_PER_PAGE = 65536
const BYTES_PER_DOUBLE = 8
const MATRIX_DOUBLES = 32

/** `KERNEL_ABI_VERSION` in lib.rs. */
const ABI_VERSION = 1
/** `MAX_QUBITS` in lib.rs — lower than the engine's 28, on purpose. */
const MAX_QUBITS = 27

export interface TransliterationOptions {
  /** What `has_simd()` reports. */
  readonly simd?: boolean
  /** Report a different ABI version. */
  readonly abiVersion?: number
  /** Make `alloc_state` return the crate's null answer. */
  readonly refuseAllocation?: boolean
  /** Initial pages; small so that growth, and view detachment, really happen. */
  readonly initialPages?: number
  /**
   * Hand a freed block out again on the next same-sized request, which is what
   * Rust's allocator does and what the shipped stand-in's liveness map hides.
   */
  readonly recycleFreed?: boolean
}

export function createTransliteratedExports(
  options: TransliterationOptions = {}
): KernelExports {
  const memory = new WebAssembly.Memory({
    initial: options.initialPages ?? 1,
  })

  // Never hand out 0: that is the crate's "could not reserve" answer.
  let bump = BYTES_PER_DOUBLE
  let matrixScratch = 0
  const freed = new Map<number, number[]>()

  const buffer = (): ArrayBuffer => memory.buffer

  function reserve(doubles: number): number {
    const bytes = doubles * BYTES_PER_DOUBLE
    if (options.recycleFreed === true) {
      const recycled = freed.get(doubles)?.pop()
      if (recycled !== undefined) return recycled
    }
    const pointer =
      bump + ((BYTES_PER_DOUBLE - (bump % BYTES_PER_DOUBLE)) % BYTES_PER_DOUBLE)
    const end = pointer + bytes
    if (end > buffer().byteLength) {
      const needed = Math.ceil((end - buffer().byteLength) / BYTES_PER_PAGE)
      try {
        memory.grow(needed)
      } catch {
        // `try_reserve_exact` failing is a null return, not an abort.
        return 0
      }
    }
    bump = end
    return pointer
  }

  const doubles = (pointer: number, count: number): Float64Array =>
    new Float64Array(buffer(), pointer, count)

  /** `halves()` in lib.rs. */
  function halves(pointer: number, size: number): [Float64Array, Float64Array] {
    return [
      doubles(pointer, size),
      doubles(pointer + size * BYTES_PER_DOUBLE, size),
    ]
  }

  /** `check()` in lib.rs: non-null pointer, qubit count in 1..=MAX_QUBITS. */
  function check(pointer: number, qubits: number): number | undefined {
    if (pointer === 0 || qubits < 1 || qubits > MAX_QUBITS) return undefined
    return 1 << qubits
  }

  /** `check_controls()` in lib.rs. */
  function checkControls(qubits: number, mask: number, value: number): boolean {
    const all = (1 << qubits) - 1
    return (mask & ~all) === 0 && (value & ~mask) === 0
  }

  function matrixPointer(): number {
    if (matrixScratch === 0) matrixScratch = reserve(MATRIX_DOUBLES)
    return matrixScratch
  }

  return {
    memory,

    abi_version: () => options.abiVersion ?? ABI_VERSION,
    has_simd: () => options.simd ?? false,

    alloc_state(qubits: number): number {
      if (options.refuseAllocation === true) return 0
      if (qubits < 1 || qubits > MAX_QUBITS) return 0
      const size = 1 << qubits
      const pointer = reserve(size * 2)
      if (pointer === 0) return 0
      const [re, im] = halves(pointer, size)
      re.fill(0)
      im.fill(0)
      re[0] = 1 // amplitude of |0…0⟩
      return pointer
    },

    free_state(pointer: number, qubits: number): void {
      // `free_state` in lib.rs validates only that the pointer is non-null and
      // the qubit count is in range; there is no registry of live handles.
      if (pointer === 0 || qubits < 1 || qubits > MAX_QUBITS) return
      if (options.recycleFreed !== true) return
      const count = (1 << qubits) * 2
      const bucket = freed.get(count) ?? []
      bucket.push(pointer)
      freed.set(count, bucket)
    },

    matrix_ptr: matrixPointer,

    apply_controlled(
      pointer: number,
      qubits: number,
      target: number,
      mask: number,
      value: number
    ): boolean {
      const size = check(pointer, qubits)
      if (size === undefined) return false
      if (target >= qubits) return false
      if (!checkControls(qubits, mask, value)) return false
      if ((mask & (1 << target)) !== 0) return false

      const matrix = doubles(matrixPointer(), MATRIX_DOUBLES)
      const [re, im] = halves(pointer, size)

      const m00r = matrix[0]
      const m00i = matrix[1]
      const m01r = matrix[2]
      const m01i = matrix[3]
      const m10r = matrix[4]
      const m10i = matrix[5]
      const m11r = matrix[6]
      const m11i = matrix[7]

      const stride = 1 << target

      // The `pair` closure of kernel.rs, association preserved.
      const pair = (i0: number, i1: number): void => {
        const a0r = re[i0]
        const a0i = im[i0]
        const a1r = re[i1]
        const a1i = im[i1]
        re[i0] = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i)
        im[i0] = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r)
        re[i1] = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i)
        im[i1] = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r)
      }

      if (mask === 0) {
        let base = 0
        while (base < size) {
          for (let offset = 0; offset < stride; offset++) {
            const i0 = base + offset
            pair(i0, i0 + stride)
          }
          base += stride << 1
        }
      } else {
        let base = 0
        while (base < size) {
          for (let offset = 0; offset < stride; offset++) {
            const i0 = base + offset
            if ((i0 & mask) === value) pair(i0, i0 + stride)
          }
          base += stride << 1
        }
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
      const size = check(pointer, qubits)
      if (size === undefined) return false
      if (q0 >= qubits || q1 >= qubits || q0 === q1) return false
      if (!checkControls(qubits, mask, value)) return false
      const bit0 = 1 << q0
      const bit1 = 1 << q1
      if ((mask & (bit0 | bit1)) !== 0) return false

      const [re, im] = halves(pointer, size)
      const lower = Math.min(bit0, bit1)
      const upper = Math.max(bit0, bit1)

      let upperBase = 0
      while (upperBase < size) {
        let middle = 0
        while (middle < upper) {
          for (let offset = 0; offset < lower; offset++) {
            const base = upperBase + middle + offset
            if ((base & mask) !== value) continue
            const i01 = base + bit0
            const i10 = base + bit1
            const tr = re[i01]
            const ti = im[i01]
            re[i01] = re[i10]
            im[i01] = im[i10]
            re[i10] = tr
            im[i10] = ti
          }
          middle += lower << 1
        }
        upperBase += upper << 1
      }
      return true
    },

    apply_iswap(
      pointer: number,
      qubits: number,
      q0: number,
      q1: number
    ): boolean {
      const size = check(pointer, qubits)
      if (size === undefined) return false
      if (q0 >= qubits || q1 >= qubits || q0 === q1) return false

      const [re, im] = halves(pointer, size)
      const bit0 = 1 << q0
      const bit1 = 1 << q1
      const lower = Math.min(bit0, bit1)
      const upper = Math.max(bit0, bit1)

      let upperBase = 0
      while (upperBase < size) {
        let middle = 0
        while (middle < upper) {
          for (let offset = 0; offset < lower; offset++) {
            const base = upperBase + middle + offset
            const i01 = base + bit0
            const i10 = base + bit1
            const a01r = re[i01]
            const a01i = im[i01]
            const a10r = re[i10]
            const a10i = im[i10]
            re[i01] = -a10i
            im[i01] = a10r
            re[i10] = -a01i
            im[i10] = a01r
          }
          middle += lower << 1
        }
        upperBase += upper << 1
      }
      return true
    },

    apply_2q(pointer: number, qubits: number, q0: number, q1: number): boolean {
      const size = check(pointer, qubits)
      if (size === undefined) return false
      if (q0 >= qubits || q1 >= qubits || q0 === q1) return false

      const matrix = doubles(matrixPointer(), MATRIX_DOUBLES)
      const [re, im] = halves(pointer, size)
      const bit0 = 1 << q0
      const bit1 = 1 << q1
      const lower = Math.min(bit0, bit1)
      const upper = Math.max(bit0, bit1)

      const index = [0, 0, 0, 0]
      const inR = [0, 0, 0, 0]
      const inI = [0, 0, 0, 0]
      const outR = [0, 0, 0, 0]
      const outI = [0, 0, 0, 0]

      let upperBase = 0
      while (upperBase < size) {
        let middle = 0
        while (middle < upper) {
          for (let offset = 0; offset < lower; offset++) {
            const base = upperBase + middle + offset
            index[0] = base
            index[1] = base + bit0
            index[2] = base + bit1
            index[3] = base + bit0 + bit1

            for (let k = 0; k < 4; k++) {
              inR[k] = re[index[k]]
              inI[k] = im[index[k]]
            }
            for (let row = 0; row < 4; row++) {
              let sumR = 0
              let sumI = 0
              for (let column = 0; column < 4; column++) {
                const at = (row * 4 + column) * 2
                const mr = matrix[at]
                const mi = matrix[at + 1]
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
          middle += lower << 1
        }
        upperBase += upper << 1
      }
      return true
    },

    norm_squared(pointer: number, qubits: number): number {
      const size = check(pointer, qubits)
      if (size === undefined) return -1
      const [re, im] = halves(pointer, size)
      let sum = 0
      for (let i = 0; i < size; i++) sum += re[i] * re[i] + im[i] * im[i]
      return sum
    },

    scale(pointer: number, qubits: number, factor: number): boolean {
      const size = check(pointer, qubits)
      if (size === undefined) return false
      const [re, im] = halves(pointer, size)
      for (let i = 0; i < size; i++) {
        re[i] *= factor
        im[i] *= factor
      }
      return true
    },

    probabilities(pointer: number, qubits: number, out: number): boolean {
      const size = check(pointer, qubits)
      if (size === undefined) return false
      if (out === 0) return false
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
      const size = check(pointer, qubits)
      if (size === undefined) return false
      if (qubit >= qubits || out === 0) return false
      const [re, im] = halves(pointer, size)
      const stride = 1 << qubit

      let rho00 = 0
      let rho11 = 0
      let re01 = 0
      let im01 = 0

      let base = 0
      while (base < size) {
        for (let offset = 0; offset < stride; offset++) {
          const zero = base + offset
          const one = zero + stride
          const zr = re[zero]
          const zi = im[zero]
          const or = re[one]
          const oi = im[one]
          rho00 += zr * zr + zi * zi
          rho11 += or * or + oi * oi
          re01 += zr * or + zi * oi
          im01 += zi * or - zr * oi
        }
        base += stride << 1
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
