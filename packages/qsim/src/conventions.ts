/**
 * Qubit ordering — decision D1. Read this before touching anything numeric.
 *
 * THE Q SIMULATOR USES LITTLE-ENDIAN QUBIT ORDERING:
 * qubit 0 is the LEAST significant bit of the statevector index.
 *
 * For a statevector index `i`, the value of qubit `q` is `(i >> q) & 1`.
 *
 * Worked example, 3 qubits. Index 5 is binary 101, so:
 *
 *   index 5 = 0b101
 *             │││
 *             ││└── qubit 0 = 1
 *             │└─── qubit 1 = 0
 *             └──── qubit 2 = 1
 *
 * Written as a ket in the conventional left-to-right order (highest qubit
 * first, the way Qiskit prints it), index 5 is |101⟩ = |q2 q1 q0⟩.
 *
 * WHY THIS MATTERS: this is the same convention Qiskit uses. Choosing the
 * opposite would make every exported circuit produce mirrored results on
 * real hardware, and that bug is close to invisible — the simulation stays
 * self-consistent, so only a comparison against Qiskit reveals it. The
 * specification calls bit ordering the number one source of bugs in this
 * kind of engine, so it is fixed here, in code, and asserted in tests.
 */

/** Number of complex amplitudes in an `n`-qubit statevector: 2ⁿ. */
export function stateSize(qubitCount: number): number {
  return 1 << qubitCount
}

/** Value (0 or 1) of `qubit` within statevector index `index`. */
export function bitOf(index: number, qubit: number): 0 | 1 {
  return ((index >> qubit) & 1) as 0 | 1
}

/** `index` with `qubit` forced to 1. */
export function setBit(index: number, qubit: number): number {
  return index | (1 << qubit)
}

/** `index` with `qubit` forced to 0. */
export function clearBit(index: number, qubit: number): number {
  return index & ~(1 << qubit)
}

/** `index` with `qubit` flipped. */
export function flipBit(index: number, qubit: number): number {
  return index ^ (1 << qubit)
}

/**
 * Ket label for a statevector index, printed highest-qubit-first so it reads
 * the way Qiskit and the literature print it: `formatKet(5, 3) === "101"`.
 */
export function formatKet(index: number, qubitCount: number): string {
  let out = ''
  for (let q = qubitCount - 1; q >= 0; q--) out += bitOf(index, q)
  return out
}
