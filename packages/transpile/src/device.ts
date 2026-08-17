/**
 * What a device is, as far as this package needs to know.
 *
 * Two numbers describe a quantum processor and only one of them is ever
 * quoted. "156 qubits" is the one on the press release. The other is the
 * coupling map, and on the machine this package was built against it holds
 * 176 undirected pairs out of the 12 090 a fully connected 156-qubit device
 * would have — **1.46 %**. Every qubit has one, two or three neighbours. The
 * shortest cycle in the whole lattice is twelve qubits long, which is a
 * compact way of saying there are no triangles and no squares anywhere on the
 * chip: three qubits that all have to talk to each other cannot be placed at
 * all, no matter how many are free.
 *
 * That is why placement is a search over a graph and not an assignment, and
 * why a refusal is sometimes the only true answer.
 *
 * ── CALIBRATION IS DATA, NOT A CONSTANT ──────────────────────────────────
 *
 * Qubits are not interchangeable. On the snapshot in `testing/heron.ts` the
 * best `cz` pair has an error of 1.0e-3 and the median is 3.4e-3 — a factor of
 * three and a half between "a good pair" and "a typical pair" — while seven
 * pairs report an error of exactly 1.0, meaning the calibration failed and the
 * gate does not work at all. One qubit's readout error is 0.50, which is a
 * coin. Choosing where to put a two-qubit circuit is therefore a real quality
 * decision and it costs one metadata request, no QPU time.
 *
 * These properties are *hours* old the moment they are read, so they live in a
 * `DeviceTarget` a caller passes in rather than in a table here. Nothing in
 * this package ever assumes a device it has not been handed.
 */

import { BASIS_GATE_IDS } from './basis.js'
import { TranspileRefusal } from './refusal.js'

/**
 * An error rate at or above this counts as "this operation does not work".
 *
 * A backend reports exactly `1` for a pair whose two-qubit gate failed
 * calibration — not 0.9, not "null", the number one — and a placement that
 * chose such a pair would produce a job that runs, returns, and means nothing.
 * They are removed from the graph rather than merely penalised, because a
 * circuit that fits *only* on a broken pair has no placement, and saying so is
 * the honest answer.
 */
export const UNUSABLE_ERROR = 1

/** One undirected coupled pair. `a < b`, always. */
export interface CoupledPair {
  readonly a: number
  readonly b: number
  /** Two-qubit gate error on this pair, if the calibration is known. */
  readonly error?: number
}

/** Per-qubit calibration. Every field is optional; absent means unknown. */
export interface DeviceQubit {
  /** One-qubit (`sx`) gate error. */
  readonly gateError?: number
  /** Probability a measurement reports the wrong bit. */
  readonly readoutError?: number
}

/** A backend, as a value. Built by `ibm.ts` from what the REST API answers. */
export interface DeviceTarget {
  readonly name: string
  readonly qubits: number
  /** The backend's own basis gate list, checked against what is emitted. */
  readonly basisGates?: readonly string[]
  readonly coupling: readonly CoupledPair[]
  /** Indexed by physical qubit; may be shorter than `qubits`. */
  readonly qubitProperties?: readonly DeviceQubit[]
  /** When the calibration was taken, ISO 8601, for the job's provenance. */
  readonly calibratedAt?: string
  /** Jobs waiting, which decides whether a result arrives today. */
  readonly queueLength?: number
}

/** The coupling map with the questions placement asks, answered once. */
export interface DeviceGraph {
  readonly target: DeviceTarget
  readonly qubits: number
  /** Usable pairs only — see `UNUSABLE_ERROR`. */
  readonly edges: readonly CoupledPair[]
  readonly neighbours: readonly (readonly number[])[]
  /** Physical qubits that can run a gate at all, ascending. */
  readonly usableQubits: readonly number[]
  readonly maxDegree: number
  /**
   * Length of the shortest cycle, or `Infinity` for a forest. Twelve on a
   * heavy-hex lattice, which is what makes a Toffoli unplaceable there.
   */
  readonly girth: number
  /** Pairs dropped for a failed calibration, so a refusal can name them. */
  readonly excludedPairs: readonly CoupledPair[]
  readonly excludedQubits: readonly number[]
  /** False when the target carried no error rates and every cost is a guess. */
  readonly calibrated: boolean
  /** Two-qubit error on a usable pair, or `undefined` if it is not one. */
  errorOf(a: number, b: number): number | undefined
  areAdjacent(a: number, b: number): boolean
}

/**
 * Build the derived graph, dropping everything the calibration says is broken.
 *
 * Throws `TranspileRefusal` when the target is malformed or when its declared
 * basis cannot run what this package emits — a mismatch there means every
 * program produced would be rejected by the backend, and finding that out
 * before a job is submitted is the whole point of checking.
 */
export function deviceGraph(target: DeviceTarget): DeviceGraph {
  if (!Number.isInteger(target.qubits) || target.qubits < 1) {
    throw new TranspileRefusal(
      'device-basis-mismatch',
      `Device "${target.name}" reports ${target.qubits} qubits.`,
      { device: target.name, qubits: target.qubits }
    )
  }
  assertBasis(target)

  const properties = target.qubitProperties ?? []
  const excludedQubits: number[] = []
  const usable: boolean[] = []
  for (let qubit = 0; qubit < target.qubits; qubit++) {
    const error = properties[qubit]?.gateError
    const ok = error === undefined || error < UNUSABLE_ERROR
    usable[qubit] = ok
    if (!ok) excludedQubits.push(qubit)
  }

  const edges: CoupledPair[] = []
  const excludedPairs: CoupledPair[] = []
  const seen = new Set<string>()
  let calibrated = false
  for (const pair of target.coupling) {
    const a = Math.min(pair.a, pair.b)
    const b = Math.max(pair.a, pair.b)
    if (a === b) continue
    if (a < 0 || b >= target.qubits) {
      throw new TranspileRefusal(
        'device-basis-mismatch',
        `Device "${target.name}" couples qubits ${pair.a} and ${pair.b}, ` +
          `which are outside its own register of ${target.qubits}.`,
        { device: target.name, a: pair.a, b: pair.b, qubits: target.qubits }
      )
    }
    const key = `${String(a)}-${String(b)}`
    if (seen.has(key)) continue
    seen.add(key)
    if (pair.error !== undefined) calibrated = true

    const broken =
      (pair.error !== undefined && pair.error >= UNUSABLE_ERROR) ||
      usable[a] !== true ||
      usable[b] !== true
    const normalised: CoupledPair =
      pair.error === undefined ? { a, b } : { a, b, error: pair.error }
    if (broken) excludedPairs.push(normalised)
    else edges.push(normalised)
  }

  const neighbours: number[][] = Array.from(
    { length: target.qubits },
    (): number[] => []
  )
  const errors = new Map<string, number | undefined>()
  for (const edge of edges) {
    ;(neighbours[edge.a] as number[]).push(edge.b)
    ;(neighbours[edge.b] as number[]).push(edge.a)
    errors.set(`${String(edge.a)}-${String(edge.b)}`, edge.error)
  }
  for (const list of neighbours) list.sort((left, right) => left - right)

  let maxDegree = 0
  for (const list of neighbours) maxDegree = Math.max(maxDegree, list.length)

  return {
    target,
    qubits: target.qubits,
    edges,
    neighbours,
    usableQubits: usable.flatMap((ok, qubit) => (ok ? [qubit] : [])),
    maxDegree,
    girth: girthOf(neighbours),
    excludedPairs,
    excludedQubits,
    calibrated: calibrated || properties.length > 0,
    errorOf(a, b) {
      return errors.get(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
    },
    areAdjacent(a, b) {
      return (neighbours[a] ?? []).includes(b)
    },
  }
}

function assertBasis(target: DeviceTarget): void {
  const declared = target.basisGates
  if (declared === undefined) return
  // The contract spells the identity `i` and every backend and OpenQASM 3
  // spell it `id`; the serialiser renames it, so both are accepted here.
  const missing = BASIS_GATE_IDS.filter(
    (gate) =>
      !declared.includes(gate) && !(gate === 'i' && declared.includes('id'))
  )
  if (missing.length > 0) {
    throw new TranspileRefusal(
      'device-basis-mismatch',
      `Device "${target.name}" runs [${declared.join(', ')}], which does not ` +
        `include [${missing.join(', ')}]. This package compiles to ` +
        `[${BASIS_GATE_IDS.join(', ')}] and has nothing else to offer, so a ` +
        `program for this backend would be rejected on arrival.`,
      { device: target.name, missing: missing.join(', ') }
    )
  }
}

/**
 * Length of the shortest cycle, by breadth-first search from every vertex.
 *
 * For an unweighted graph this is exact: the shortest cycle through a vertex
 * `s` is found when a BFS rooted at `s` meets an edge (u, v) whose endpoints
 * are already both discovered and are not parent and child, and the cycle it
 * closes has length `dist(u) + dist(v) + 1`. Running it from every vertex
 * therefore finds the global minimum.
 *
 * `Infinity` for a forest, which is a real answer: a device with no cycle at
 * all can hold no interaction cycle either, and a chain circuit still fits.
 */
export function girthOf(neighbours: readonly (readonly number[])[]): number {
  let girth = Infinity
  const size = neighbours.length
  const distance = new Int32Array(size)
  const parent = new Int32Array(size)

  for (let root = 0; root < size; root++) {
    if ((neighbours[root] ?? []).length === 0) continue
    distance.fill(-1)
    parent.fill(-1)
    distance[root] = 0
    const queue = [root]
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head] as number
      // Nothing deeper than half the best cycle can improve on it.
      if ((distance[u] as number) * 2 >= girth) break
      for (const v of neighbours[u] ?? []) {
        if (distance[v] === -1) {
          distance[v] = (distance[u] as number) + 1
          parent[v] = u
          queue.push(v)
        } else if (v !== parent[u]) {
          girth = Math.min(
            girth,
            (distance[u] as number) + (distance[v] as number) + 1
          )
        }
      }
    }
  }
  return girth
}
