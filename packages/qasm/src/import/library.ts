/**
 * `stdgates.inc`, `qelib1.inc` and the language built-ins, as lowerings.
 *
 * ── WHY THE INCLUDE IS NOT FETCHED ───────────────────────────────────────
 *
 * `include "stdgates.inc";` names a file. This package has no file system by
 * construction (§12.3: no Node APIs, so it runs identically in a browser worker
 * and in the API) and would not want one if it had: fetching a path out of an
 * untrusted upload is the whole of §11's argument in one line. So the two
 * standard libraries are *known*, by their published definitions, and the
 * `include` statement is read for its name and otherwise ignored.
 *
 * Where a library gate is a composition — `cu` is a phase and a controlled `U`,
 * `u3` is a global phase and a `U` — it lowers to exactly that composition,
 * entry for entry. An importer that approximated would produce a circuit
 * differing from the file by something nobody can see.
 *
 * ── THE ONE PLACE THE TWO VERSIONS MEAN DIFFERENT THINGS ─────────────────
 *
 * `U(θ, φ, λ)` is built into both dialects and is **not the same matrix**:
 *
 *   OpenQASM 2:  U = Rz(φ)·Ry(θ)·Rz(λ), which carries a factor e^(−i(φ+λ)/2)
 *   OpenQASM 3:  U = [[cos(θ/2),          −e^(iλ)sin(θ/2)     ],
 *                     [e^(iφ)sin(θ/2),  e^(i(φ+λ))cos(θ/2)]]
 *
 * The second is the catalog's `u` and Qiskit's `UGate`. The first is the same
 * matrix with a global phase in front, which is why `stdgates.inc` defines the
 * deprecated `u3` as `gphase(−(φ+λ)/2); U(θ,φ,λ);` — that *is* version 2's `U`.
 *
 * So a file's declared version changes what its own `U` means. Reading a
 * version-2 file as version 3 gives a circuit that agrees on every measurement
 * — right up until one of those gates is controlled, at which point the dropped
 * phase is the entire answer. That is why `detectVersion` exists and why the
 * version is never asked of the user: the difference is invisible to a reader
 * and decisive to a simulator.
 *
 * ── GLOBAL PHASES ARE CARRIED, NOT DISCARDED ─────────────────────────────
 *
 * `u2` and `u3` lower to a `gphase` primitive *plus* a gate rather than to the
 * gate alone. The phase is dropped at the very end, once it is known that
 * nothing controls it — see `modifiers.ts`. Dropping it here instead would be
 * right for every uncontrolled file and wrong for `ctrl @ u3`, which is the
 * shape the exporter's own header warns about from the other side.
 *
 * The deprecated `u0`, `cu1` and `cu3` are version-2 only, and that is load
 * bearing rather than tidy: version 2 has no modifiers at all, so the small
 * global-phase differences between `qelib1.inc`'s literal text and the matrices
 * every toolchain means by those names can never become observable. A custom
 * gate cannot be controlled either (the contract refuses it), so a definition
 * containing one is safe for the same reason.
 *
 * ── LENIENCY, DELIBERATELY ───────────────────────────────────────────────
 *
 * A file that uses `h` without including a library is not a legal program, and
 * every toolchain reads it anyway. The tables below are therefore available
 * regardless of what was included: an importer that refused files the rest of
 * the world accepts is not being strict, it is filing a bug report against
 * itself. What is *not* lenient is the resolution order — a `gate` definition
 * in the file always wins over the library entry of the same name, because a
 * file that defines `gate u3` means its own, and declaring what it uses is
 * exactly what Qiskit's OpenQASM output does.
 */

import { unsupportedError, type QasmPosition } from './errors.js'
import { gatePrim, KERNEL_ARITY, type KernelId, type Prim } from './prim.js'
import type { QasmVersion } from './ast.js'

/**
 * One entry of a standard library.
 *
 * `passThrough` is set for the entries that are a single catalog gate with its
 * arguments handed straight to it — most of them. It exists for one job: a
 * `gate` definition may only become a *contract* custom gate if its body can be
 * written with the definition's formal parameters left symbolic, and that is
 * possible exactly when no arithmetic has to happen to them. `u3` does
 * arithmetic (it computes a phase from two of its angles), so a definition
 * calling `u3(theta, phi, lambda)` cannot carry `theta` forward as a name and
 * is inlined at its call sites instead. Deriving that from the entry rather
 * than from a second hand-kept list is what stops the two from disagreeing.
 */
export interface LibraryGate {
  readonly params: number
  readonly qubits: number
  /** The gate as primitives, over the qubit indices it was applied to. */
  readonly lower: (
    params: readonly number[],
    qubits: readonly number[]
  ) => Prim[]
  readonly passThrough:
    { readonly kernel: KernelId; readonly controlCount: number } | undefined
}

/**
 * A library gate that is one catalog kernel, its leading `controlCount`
 * operands as positive controls, and its arguments passed along unchanged.
 *
 * Everything in `stdgates.inc` except `u2`, `u3`, `cu` and `gphase` has this
 * shape, which is why the table below reads as a list rather than as code.
 */
function form(kernel: KernelId, controlCount = 0, params = 0): LibraryGate {
  return {
    params,
    qubits: controlCount + KERNEL_ARITY[kernel],
    passThrough: { kernel, controlCount },
    lower: (values, qubits) => [
      gatePrim(
        kernel,
        qubits.slice(controlCount),
        qubits
          .slice(0, controlCount)
          .map((qubit) => ({ qubit, state: 1 as const })),
        values
      ),
    ],
  }
}

/** A one-qubit-or-wider kernel with no controls of its own. */
function trivial(kernel: KernelId, params = 0): LibraryGate {
  return form(kernel, 0, params)
}

/** A kernel with the first operand as a positive control. */
function controlled(kernel: KernelId, params = 0): LibraryGate {
  return form(kernel, 1, params)
}

/** `U(θ, φ, λ)` with no phase — OpenQASM 3's built-in, and the catalog's `u`. */
const UNPHASED_U: LibraryGate = trivial('u', 3)

/**
 * `u3(θ, φ, λ)` — `U` with `stdgates.inc`'s global phase in front, which is
 * also, exactly, OpenQASM 2's built-in `U`.
 */
const PHASED_U: LibraryGate = {
  params: 3,
  qubits: 1,
  passThrough: undefined,
  lower: (values, qubits) => {
    const [theta = 0, phi = 0, lambda = 0] = values
    return [
      { kind: 'gphase', angle: -(phi + lambda) / 2 },
      gatePrim('u', qubits, [], [theta, phi, lambda]),
    ]
  },
}

/** `u2(φ, λ) = u3(π/2, φ, λ)`. */
const U2: LibraryGate = {
  params: 2,
  qubits: 1,
  passThrough: undefined,
  lower: (values, qubits) =>
    PHASED_U.lower([Math.PI / 2, values[0] ?? 0, values[1] ?? 0], qubits),
}

/**
 * `cu(θ, φ, λ, γ) c, t` — `stdgates.inc` defines it as
 * `p(γ) c; ctrl @ U(θ, φ, λ) c, t;`, which is what this emits and nothing more.
 */
const CU: LibraryGate = {
  params: 4,
  qubits: 2,
  passThrough: undefined,
  lower: (values, qubits) => {
    const [theta = 0, phi = 0, lambda = 0, gamma = 0] = values
    const control = qubits[0] as number
    return [
      gatePrim('p', [control], [], [gamma]),
      gatePrim(
        'u',
        qubits.slice(1),
        [{ qubit: control, state: 1 }],
        [theta, phi, lambda]
      ),
    ]
  },
}

/**
 * `cu3(θ, φ, λ) c, t` of `qelib1.inc` — the controlled version of the *phased*
 * `u3`, so its global phase becomes a `p` on the control qubit. `qelib1` writes
 * it out as five gates around two CNOTs; that sequence multiplies out to this,
 * and this is the form the catalog holds exactly.
 */
const CU3: LibraryGate = {
  params: 3,
  qubits: 2,
  passThrough: undefined,
  lower: (values, qubits) => {
    const [theta = 0, phi = 0, lambda = 0] = values
    return CU.lower([theta, phi, lambda, -(phi + lambda) / 2], qubits)
  },
}

/**
 * Entries both dialects have.
 *
 * `qelib1.inc` and `stdgates.inc` overlap almost entirely; `LIBRARY_2` and
 * `LIBRARY_3` add only what is theirs alone. Sharing the table is what stops
 * the two dialects from drifting into two meanings of `cz`.
 */
const SHARED: Readonly<Record<string, LibraryGate>> = {
  id: trivial('i'),
  x: trivial('x'),
  y: trivial('y'),
  z: trivial('z'),
  h: trivial('h'),
  s: trivial('s'),
  sdg: trivial('sdg'),
  t: trivial('t'),
  tdg: trivial('tdg'),
  sx: trivial('sx'),

  p: trivial('p', 1),
  rx: trivial('rx', 1),
  ry: trivial('ry', 1),
  rz: trivial('rz', 1),

  cx: controlled('x'),
  // `CX` is version 2's built-in CNOT and version 3's compatibility alias.
  CX: controlled('x'),
  cy: controlled('y'),
  cz: controlled('z'),
  ch: controlled('h'),
  cp: controlled('p', 1),
  crx: controlled('rx', 1),
  cry: controlled('ry', 1),
  crz: controlled('rz', 1),

  swap: trivial('swap'),

  ccx: form('x', 2),
  cswap: form('swap', 1),
  cu: CU,

  // `u1` is `U(0, 0, λ)` in both published libraries and carries no phase of
  // its own in `stdgates.inc`; it is the catalog's `p`. `u2` and `u3` do carry
  // one — see `PHASED_U`.
  u1: trivial('p', 1),
  u2: U2,
  u3: PHASED_U,

  /*
   * ── Names no published library declares, accepted anyway ──────────────
   *
   * Every one of them is a gate this catalog holds *exactly*, under a name
   * Qiskit uses and `stdgates.inc` does not. A file that emits them normally
   * declares them too — Qiskit's own output writes `gate iswap a, b { … }` and
   * then calls it, and such a file resolves through its own definition and
   * never through these entries, because a file's definitions win. What these
   * catch is the hand-written file that says `ccz q[0], q[1], q[2];` and means
   * it.
   *
   * The alternative is not neutrality, it is a false statement: `KNOWN_
   * UNSUPPORTED` below tells a reader that this simulator's catalog has no
   * entry for the gate they wrote, and for these it would not be true. A
   * one-qubit gate takes arbitrary controls (§3.1), so `ccz` *is* `z` with two
   * of them and `c4x` *is* `x` with four — the same operation the editor draws
   * and the same one the exporter writes back out as `ctrl @ ctrl @ z`.
   */
  iswap: trivial('iswap'),
  cs: controlled('s'),
  csdg: controlled('sdg'),
  csx: controlled('sx'),
  ccz: form('z', 2),
  c3x: form('x', 3),
  c4x: form('x', 4),
  c3sqrtx: form('sx', 3),
}

/** `qelib1.inc`, plus OpenQASM 2's built-ins. */
export const LIBRARY_2: Readonly<Record<string, LibraryGate>> = {
  ...SHARED,
  // The version-2 built-in carries a global phase. See the file header.
  U: PHASED_U,
  // `u0(γ)` is qelib1's idle: a wait of γ time units, which a document with no
  // notion of duration can only record as the identity it is.
  u0: {
    params: 1,
    qubits: 1,
    passThrough: undefined,
    lower: (_values, qubits) => [gatePrim('i', qubits)],
  },
  // `cu1` is the matrix diag(1, 1, 1, e^{iλ}), which is `cp`, and `cu3` is the
  // controlled phased `u3`. Both are version-2 spellings only.
  cu1: controlled('p', 1),
  cu3: CU3,
}

/** `stdgates.inc`, plus OpenQASM 3's built-ins. */
export const LIBRARY_3: Readonly<Record<string, LibraryGate>> = {
  ...SHARED,
  // The version-3 built-in is the bare matrix. See the file header.
  U: UNPHASED_U,
  gphase: {
    params: 1,
    qubits: 0,
    passThrough: undefined,
    lower: (values) => [{ kind: 'gphase', angle: values[0] ?? 0 }],
  },
  phase: trivial('p', 1),
  cphase: controlled('p', 1),
}

/**
 * Standard gate names this importer recognises and cannot express.
 *
 * The distinction from "unknown gate" is the whole of §3.5's promise about
 * error messages: `rzz` is a real gate in a real library, and a reader who
 * wrote it needs to hear that this simulator's catalog has no entry for it —
 * not that they misspelled something.
 *
 * Every one of them could be decomposed into catalog gates. None is,
 * deliberately: a decomposition performed silently on import means the circuit
 * on screen is not the circuit in the file, the gate count differs, and the
 * difference is invisible. The exporter takes the same position from the other
 * side, where it writes `iswap` out as a decomposition *under a comment naming
 * it*.
 */
export const KNOWN_UNSUPPORTED: Readonly<Record<string, string>> = {
  sxdg: 'the inverse square root of X',
  rxx: 'a two-qubit XX rotation',
  ryy: 'a two-qubit YY rotation',
  rzz: 'a two-qubit ZZ rotation',
  rzx: 'a two-qubit ZX rotation',
  xx_minus_yy: 'a two-qubit XX−YY rotation',
  xx_plus_yy: 'a two-qubit XX+YY rotation',
  ecr: 'an echoed cross-resonance gate',
  dcx: 'a double-CNOT gate',
  rccx: 'a simplified Toffoli',
  rc3x: 'a simplified three-controlled X',
}

/** The library a program's version brings with it. */
export function libraryFor(
  version: QasmVersion
): Readonly<Record<string, LibraryGate>> {
  return version === 2 ? LIBRARY_2 : LIBRARY_3
}

/**
 * Refuses a name that is a standard gate this catalog has no entry for.
 *
 * Called before "unknown gate", so the more specific sentence wins.
 */
export function rejectKnownUnsupported(name: string, at: QasmPosition): void {
  const description = KNOWN_UNSUPPORTED[name]
  if (description === undefined) return
  throw unsupportedError(
    at,
    name,
    `"${name}" is ${description}. It is a real gate in the standard ` +
      `libraries, and this simulator's catalog has no entry for it — so the ` +
      `circuit cannot record what the file asks for.`
  )
}
