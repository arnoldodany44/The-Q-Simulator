/**
 * Random circuits over the whole gate catalog, for the round trip.
 *
 * ── WHY RANDOM AT ALL ────────────────────────────────────────────────────
 *
 * The presets are six circuits somebody chose, and every one of them uses the
 * gates a teaching example uses. What they never contain is a negative control
 * on a `ry`, a `cswap` whose controls sit either side of its targets, a `u`
 * with three unlovely angles, or a barrier across a gap — and each of those is
 * a line in the exporter and a line in the importer that a fixed suite would
 * exercise only if somebody remembered to. Drawing from the catalog with a
 * seeded generator exercises all of them, in combinations nobody would write
 * down, and reports the seed when it fails so the case is reproducible.
 *
 * Not a test file, so it is excluded from the declaration build — see the
 * `exclude` list in tsconfig.build.json — and it is not re-exported from
 * index.ts, so no consumer can reach it.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  GATES,
  MAX_CLBITS,
  safeParseCircuit,
  type Circuit,
  type ControlSpec,
  type GateId,
  type Operation,
} from '@qsim/schema'

/** Deterministic, tiny, and good enough: mulberry32. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RandomCircuitOptions {
  readonly qubits: number
  readonly clbits: number
  readonly operations: number
  /** Gates to leave out. The round trip excludes `iswap`; see `roundtrip.test.ts`. */
  readonly without?: readonly GateId[]
}

/**
 * A contract-valid circuit built from the catalog.
 *
 * Columns are assigned as-soon-as-possible, which is both what the editor
 * produces and what the importer reconstructs — so a difference in columns
 * after a round trip would be a real difference rather than an artefact of the
 * fixture being laid out unusually.
 *
 * Conditions are only placed on a bit some earlier operation measured, because
 * an operation conditioned on a bit nothing writes is legal and uninteresting:
 * it is the *interaction* between a measurement and a later conditional that
 * the column scheduling has to get right.
 */
export function randomCircuit(
  random: () => number,
  options: RandomCircuitOptions
): Circuit {
  const { qubits, clbits } = options
  const without = new Set(options.without ?? [])
  const candidates = (Object.keys(GATES) as GateId[]).filter((gate) => {
    if (without.has(gate)) return false
    if (GATES[gate].arity !== 'variable' && GATES[gate].arity > qubits) {
      return false
    }
    if (gate === 'measure' && clbits === 0) return false
    return true
  })

  const qubitFree = new Array<number>(qubits).fill(0)
  const clbitFree = new Array<number>(clbits).fill(0)
  const written = new Set<number>()
  const operations: Operation[] = []

  for (let index = 0; index < options.operations; index++) {
    const gate = pick(random, candidates)
    const meta = GATES[gate]

    const arity =
      meta.arity === 'variable' ? 1 + Math.floor(random() * qubits) : meta.arity
    const extra =
      meta.acceptsControls && random() < 0.35 ? 1 + Math.floor(random() * 2) : 0
    const wanted = arity + meta.controlCount + extra
    if (wanted > qubits) continue

    const wires = shuffle(random, range(qubits)).slice(0, wanted)
    const targets = wires.slice(0, arity)
    const controls: ControlSpec[] = wires.slice(arity).map((qubit) => ({
      qubit,
      // Negative controls only on the ones the catalog allows them on; a
      // built-in control of `ccx` is positive by definition.
      state: meta.acceptsControls && random() < 0.3 ? 0 : 1,
    }))

    const params = Array.from({ length: meta.paramCount }, () =>
      // A mixture of exact π fractions and arbitrary doubles: the first
      // exercises the `pi/2` spelling on the way out and its reading on the
      // way in, the second the shortest-round-trip decimal.
      random() < 0.5
        ? (Math.PI * (1 + Math.floor(random() * 7))) /
          (1 + Math.floor(random() * 8))
        : (random() - 0.5) * 12
    )

    const clbitTargets =
      meta.clbitCount === 0
        ? undefined
        : [Math.floor(random() * Math.min(clbits, MAX_CLBITS))]

    const readable = [...written].filter(
      (clbit) => !(clbitTargets ?? []).includes(clbit)
    )
    const condition: Operation['condition'] =
      readable.length > 0 && random() < 0.25
        ? {
            clbit: pick(random, readable),
            equals: random() < 0.5 ? 0 : 1,
          }
        : undefined

    const touched = [...targets, ...controls.map((control) => control.qubit)]
    let column = 0
    for (const qubit of touched)
      column = Math.max(column, qubitFree[qubit] ?? 0)
    for (const clbit of [
      ...(clbitTargets ?? []),
      ...(condition === undefined ? [] : [condition.clbit]),
    ]) {
      column = Math.max(column, clbitFree[clbit] ?? 0)
    }
    for (const qubit of touched) qubitFree[qubit] = column + 1
    for (const clbit of clbitTargets ?? []) {
      clbitFree[clbit] = column + 1
      written.add(clbit)
    }

    operations.push({
      id: `op_${String(operations.length + 1)}`,
      gate,
      targets,
      ...(controls.length === 0 ? {} : { controls }),
      ...(params.length === 0 ? {} : { params }),
      column,
      ...(clbitTargets === undefined ? {} : { clbitTargets }),
      ...(condition === undefined ? {} : { condition }),
    })
  }

  const circuit: Circuit = {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits,
    operations,
  }
  const parsed = safeParseCircuit(circuit)
  if (!parsed.ok) {
    // The generator builds valid circuits by construction; if it ever does not,
    // the fixture is the bug and the suite should say so rather than report a
    // round-trip failure that is really a bad input.
    throw new Error(
      `the random circuit generator produced an invalid circuit: ` +
        `${parsed.issues.map((issue) => issue.message).join('; ')}`
    )
  }
  return parsed.circuit
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T
}

function shuffle<T>(random: () => number, values: readonly T[]): T[] {
  const out = [...values]
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[out[index], out[other]] = [out[other] as T, out[index] as T]
  }
  return out
}

function range(size: number): number[] {
  return Array.from({ length: size }, (_, index) => index)
}
