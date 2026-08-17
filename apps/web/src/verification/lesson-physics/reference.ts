/**
 * An independent, deliberately slow reference simulator.
 *
 * Nothing here imports `@qsim/core`. Every gate is written from its textbook
 * definition, every operator is materialised as a dense 2ⁿ × 2ⁿ matrix, and
 * the state is evolved by ordinary matrix–vector multiplication. That is the
 * point: it is the obviously-correct method, so a disagreement between it and
 * the engine is evidence about the engine rather than about a shared mistake.
 *
 * Little-endian (D1): bit q of basis index i is `(i >> q) & 1`, and a ket is
 * printed highest qubit first.
 */

export interface C {
  re: number
  im: number
}

const c = (re: number, im = 0): C => ({ re, im })
const mul = (a: C, b: C): C =>
  c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const add = (a: C, b: C): C => c(a.re + b.re, a.im + b.im)
const conj = (a: C): C => c(a.re, -a.im)
const abs2 = (a: C): number => a.re * a.re + a.im * a.im
const phase = (t: number): C => c(Math.cos(t), Math.sin(t))

const SQ = Math.SQRT1_2

/** One-qubit matrices, written from the definitions, row-major [[a,b],[c,d]]. */
export function oneQubitMatrix(gate: string, params: number[]): [C, C, C, C] {
  const t = params[0] ?? 0
  switch (gate) {
    case 'i':
      return [c(1), c(0), c(0), c(1)]
    case 'x':
      return [c(0), c(1), c(1), c(0)]
    case 'y':
      return [c(0), c(0, -1), c(0, 1), c(0)]
    case 'z':
      return [c(1), c(0), c(0), c(-1)]
    case 'h':
      return [c(SQ), c(SQ), c(SQ), c(-SQ)]
    case 's':
      return [c(1), c(0), c(0), c(0, 1)]
    case 'sdg':
      return [c(1), c(0), c(0), c(0, -1)]
    case 't':
      return [c(1), c(0), c(0), phase(Math.PI / 4)]
    case 'tdg':
      return [c(1), c(0), c(0), phase(-Math.PI / 4)]
    case 'sx':
      return [c(0.5, 0.5), c(0.5, -0.5), c(0.5, -0.5), c(0.5, 0.5)]
    case 'rx':
      return [
        c(Math.cos(t / 2)),
        c(0, -Math.sin(t / 2)),
        c(0, -Math.sin(t / 2)),
        c(Math.cos(t / 2)),
      ]
    case 'ry':
      return [
        c(Math.cos(t / 2)),
        c(-Math.sin(t / 2)),
        c(Math.sin(t / 2)),
        c(Math.cos(t / 2)),
      ]
    case 'rz':
      return [phase(-t / 2), c(0), c(0), phase(t / 2)]
    case 'p':
      return [c(1), c(0), c(0), phase(t)]
    default:
      throw new Error(`reference: unknown one-qubit gate ${gate}`)
  }
}

export interface RefOp {
  gate: string
  targets: number[]
  controls?: number[]
  params?: number[]
}

/** The full 2ⁿ × 2ⁿ operator of one placed gate, built entry by entry. */
function operatorOf(op: RefOp, n: number): C[][] {
  const dim = 1 << n
  const m: C[][] = Array.from({ length: dim }, () =>
    Array.from({ length: dim }, () => c(0))
  )
  const controls = op.controls ?? []
  const fires = (i: number): boolean =>
    controls.every((q) => ((i >> q) & 1) === 1)

  if (op.gate === 'swap') {
    const [a, b] = op.targets as [number, number]
    for (let i = 0; i < dim; i += 1) {
      const bitA = (i >> a) & 1
      const bitB = (i >> b) & 1
      let j = i
      if (bitA !== bitB) j = i ^ (1 << a) ^ (1 << b)
      m[fires(i) ? j : i]![i] = c(1)
    }
    return m
  }

  if (op.gate === 'cx' || op.gate === 'cz' || op.gate === 'cp') {
    const base = op.gate === 'cx' ? 'x' : op.gate === 'cz' ? 'z' : 'p'
    return operatorOf(
      { ...op, gate: base, controls: [...controls, ...op.targets.slice(1)] },
      n
    )
  }

  const [m00, m01, m10, m11] = oneQubitMatrix(op.gate, op.params ?? [])
  const q = op.targets[0]!
  for (let i = 0; i < dim; i += 1) {
    if (!fires(i)) {
      m[i]![i] = c(1)
      continue
    }
    const bit = (i >> q) & 1
    const zero = i & ~(1 << q)
    const one = i | (1 << q)
    if (bit === 0) {
      m[zero]![i] = add(m[zero]![i]!, m00)
      m[one]![i] = add(m[one]![i]!, m10)
    } else {
      m[zero]![i] = add(m[zero]![i]!, m01)
      m[one]![i] = add(m[one]![i]!, m11)
    }
  }
  return m
}

/** Evolve `state` by one operator. Plain matrix–vector product. */
function applyOperator(m: C[][], state: C[]): C[] {
  return m.map((row) =>
    row.reduce(
      (acc, entry, column) => add(acc, mul(entry, state[column]!)),
      c(0)
    )
  )
}

/** The statevector after `ops` run in the given order, from |0…0⟩. */
export function refRun(n: number, ops: readonly RefOp[]): C[] {
  const dim = 1 << n
  let state: C[] = Array.from({ length: dim }, (_, i) =>
    i === 0 ? c(1) : c(0)
  )
  for (const op of ops) state = applyOperator(operatorOf(op, n), state)
  return state
}

export function refProbabilities(state: readonly C[]): number[] {
  return state.map(abs2)
}

/** Ket label for a basis index, printed highest qubit first (D1). */
export function ket(index: number, n: number): string {
  let out = ''
  for (let q = n - 1; q >= 0; q -= 1) out += (index >> q) & 1
  return out
}

/** ρ of one qubit, traced out by summing over every other index. */
export function refReduced(
  state: readonly C[],
  qubit: number,
  n: number
): C[][] {
  const dim = 1 << n
  const rho: C[][] = [
    [c(0), c(0)],
    [c(0), c(0)],
  ]
  for (let i = 0; i < dim; i += 1) {
    for (let j = 0; j < dim; j += 1) {
      // Same value on every qubit but `qubit`: otherwise the trace kills it.
      if ((i & ~(1 << qubit)) !== (j & ~(1 << qubit))) continue
      const a = (i >> qubit) & 1
      const b = (j >> qubit) & 1
      rho[a]![b] = add(rho[a]![b]!, mul(state[i]!, conj(state[j]!)))
    }
  }
  return rho
}

/** (x, y, z) = (2·Re ρ01, −2·Im ρ01, ρ00 − ρ11). */
export function refBloch(
  state: readonly C[],
  qubit: number,
  n: number
): [number, number, number] {
  const rho = refReduced(state, qubit, n)
  return [
    2 * rho[0]![1]!.re,
    -2 * rho[0]![1]!.im,
    rho[0]![0]!.re - rho[1]![1]!.re,
  ]
}

/** Von Neumann entropy in bits of one qubit, from the 2×2 eigenvalues. */
export function refEntropy(
  state: readonly C[],
  qubit: number,
  n: number
): number {
  const rho = refReduced(state, qubit, n)
  const tr = rho[0]![0]!.re + rho[1]![1]!.re
  const det =
    rho[0]![0]!.re * rho[1]![1]!.re -
    rho[0]![0]!.im * rho[1]![1]!.im -
    abs2(rho[0]![1]!)
  const disc = Math.max(0, (tr * tr) / 4 - det)
  const lo = tr / 2 - Math.sqrt(disc)
  const hi = tr / 2 + Math.sqrt(disc)
  const term = (l: number): number =>
    l <= 1e-14 ? 0 : -l * (Math.log(l) / Math.LN2)
  return term(lo) + term(hi)
}

/** |⟨a|b⟩|², the quantity a `state` objective reads. */
export function refFidelity(a: readonly C[], b: readonly C[]): number {
  let re = 0
  let im = 0
  for (let i = 0; i < a.length; i += 1) {
    const t = mul(conj(a[i]!), b[i]!)
    re += t.re
    im += t.im
  }
  return re * re + im * im
}
