/**
 * The WebAssembly ABI, as TypeScript sees it.
 *
 * This interface is the other half of the contract written in `crate/src/
 * lib.rs`. Both sides are hand-maintained and `ABI_VERSION` is what keeps
 * them honest: a `.wasm` is a build artifact that outlives its checkout —
 * cached by CI, copied into a bundle, served from a CDN — so the one failure
 * this module must make impossible is instantiating a stale artifact whose
 * signatures still line up but whose meaning has moved.
 *
 * Every function is numeric in and numeric out. That is not a simplification,
 * it is the performance design: wasm-bindgen marshals nothing for numbers, so
 * the emitted JS is a direct call into the instance and the per-gate boundary
 * cost is a call rather than a conversion. Anything that would have crossed as
 * an array crosses as a pointer instead — see `session.ts` for where the
 * statevector lives and why it never crosses at all.
 */

/**
 * Must equal `KERNEL_ABI_VERSION` in `crate/src/lib.rs`. Bump both together,
 * on any change to what an exported signature means.
 */
export const ABI_VERSION = 1

/**
 * The functions the crate exports, plus the memory they operate in.
 *
 * A state handle is the pair `(ptr, qubits)`. Real parts occupy `1 << qubits`
 * doubles at `ptr`, imaginary parts the same count immediately after.
 *
 * The gate functions return `false` — declined — rather than throwing when an
 * argument is out of range. Declining is a normal outcome that the bridge
 * turns into a fall-back to TypeScript; see `kernel.ts`.
 */
export interface KernelExports {
  readonly memory: WebAssembly.Memory
  readonly abi_version: () => number
  readonly has_simd: () => boolean
  /** Reserves 2·2ⁿ doubles in |0…0⟩. Returns 0 when it cannot. */
  readonly alloc_state: (qubits: number) => number
  readonly free_state: (ptr: number, qubits: number) => void
  /** A 32-double scratch region gate matrices are staged through. */
  readonly matrix_ptr: () => number
  readonly apply_controlled: (
    ptr: number,
    qubits: number,
    target: number,
    mask: number,
    value: number
  ) => boolean
  readonly apply_swap: (
    ptr: number,
    qubits: number,
    q0: number,
    q1: number,
    mask: number,
    value: number
  ) => boolean
  readonly apply_iswap: (
    ptr: number,
    qubits: number,
    q0: number,
    q1: number
  ) => boolean
  readonly apply_2q: (
    ptr: number,
    qubits: number,
    q0: number,
    q1: number
  ) => boolean
  /** Σ|aᵢ|². Negative for an invalid handle, which a real norm cannot be. */
  readonly norm_squared: (ptr: number, qubits: number) => number
  readonly scale: (ptr: number, qubits: number, factor: number) => boolean
  readonly probabilities: (ptr: number, qubits: number, out: number) => boolean
  /** Writes `[rho00, rho11, re01, im01]` into the four doubles at `out`. */
  readonly reduced_density: (
    ptr: number,
    qubits: number,
    qubit: number,
    out: number
  ) => boolean
}

const REQUIRED: readonly (keyof KernelExports)[] = [
  'memory',
  'abi_version',
  'has_simd',
  'alloc_state',
  'free_state',
  'matrix_ptr',
  'apply_controlled',
  'apply_swap',
  'apply_iswap',
  'apply_2q',
  'norm_squared',
  'scale',
  'probabilities',
  'reduced_density',
]

/** Raised when an artifact does not match what this checkout expects. */
export class KernelAbiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KernelAbiError'
  }
}

/**
 * Check that an instance's exports are the ABI this bridge was written
 * against, and narrow them to `KernelExports`.
 *
 * Every name is verified rather than trusted, because the failure this
 * prevents is not a crash. A module missing `reduced_density` would install
 * fine and then throw "not a function" halfway through an analysis refresh; a
 * module built from an older crate would answer every call and quietly return
 * amplitudes computed under different rules.
 */
export function asKernelExports(source: WebAssembly.Exports): KernelExports {
  const missing = REQUIRED.filter((name) => source[name] === undefined)
  if (missing.length > 0) {
    throw new KernelAbiError(
      `The WebAssembly kernel is missing ${missing.join(', ')}. ` +
        `Rebuild it from packages/qsim-wasm/crate.`
    )
  }
  const exports = source as unknown as KernelExports
  const found = exports.abi_version()
  if (found !== ABI_VERSION) {
    throw new KernelAbiError(
      `The WebAssembly kernel reports ABI version ${found}, but this build ` +
        `speaks version ${ABI_VERSION}. The artifact is stale — rebuild it ` +
        `from packages/qsim-wasm/crate.`
    )
  }
  return exports
}

/**
 * Instantiate a `.wasm` from its bytes, with no build-time coupling to the
 * artifact.
 *
 * The bytes are a parameter rather than an import for a portability reason
 * that is not negotiable: this package has to load in a Web Worker, in a Node
 * process and in a Vitest run, and those three fetch bytes in three different
 * ways (`fetch`, `fs.readFile`, a bundler's `?url`). A static import of
 * `../pkg/kernel_bg.wasm` would also make the whole workspace fail to
 * typecheck on a machine with no Rust toolchain, which is the machine most
 * contributors are on.
 *
 * IMPORTS ARE STUBBED BY REFLECTION. wasm-bindgen emits a small import for
 * panic propagation (`__wbindgen_throw`) even from a crate that never calls
 * it, and the set of such imports changes between its versions. Rather than
 * hard-code them and break on an upgrade, every declared import is read off
 * the compiled module and given a stub that throws. A stub that is ever
 * *called* means the kernel panicked, and turning that into a JavaScript
 * exception is exactly right: the bridge catches it and **uninstalls the
 * kernel**, so the rest of the process computes in TypeScript.
 *
 * The gate that raised it is not silently retried in TypeScript, and
 * `kernel.ts`'s `KernelTrapError` carries the argument: with
 * `panic = "abort"` in the release profile a panic is a trap from inside the
 * gate loop, so an unknown number of amplitudes have already been rewritten and
 * re-applying the gate would produce an answer that is wrong and says nothing.
 * The run stops; the next one is accelerated by nothing and correct.
 */
export async function instantiateKernel(
  bytes: BufferSource
): Promise<KernelExports> {
  const module = await WebAssembly.compile(bytes)
  const imports: WebAssembly.Imports = {}
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const namespace: WebAssembly.ModuleImports = (imports[descriptor.module] ??=
      {})
    namespace[descriptor.name] = (): never => {
      throw new Error(
        `The WebAssembly kernel called host import ` +
          `"${descriptor.module}.${descriptor.name}", which means it ` +
          `panicked. The engine falls back to TypeScript.`
      )
    }
  }
  const instance = await WebAssembly.instantiate(module, imports)
  return asKernelExports(instance.exports)
}
