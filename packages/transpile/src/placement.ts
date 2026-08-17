/**
 * Layer two: which physical qubits the logical ones become.
 *
 * ── THE PROBLEM, STATED HONESTLY ─────────────────────────────────────────
 *
 * After decomposition every two-qubit operation is a `cz` on a pair of logical
 * qubits. Collect those pairs and you have the circuit's **interaction
 * graph**. The device's coupling map is another graph. A circuit runs, without
 * a single instruction being added to it, exactly when the first embeds in the
 * second — an injective map of logical qubits to physical ones under which
 * every interacting pair lands on a coupled pair.
 *
 * That is subgraph isomorphism, which is hard in general and trivial here: the
 * circuits this package is for have two, three or a handful of qubits, and the
 * device is sparse. Order the logical qubits so that each one after the first
 * of its component already has a placed neighbour, and the search branches
 * over that neighbour's *physical* neighbours — of which there are at most
 * three. So the tree is (qubits in the device) × 3^(k−1) and a two-qubit
 * circuit is 352 leaves.
 *
 * ── WHEN IT DOES NOT EMBED, THREE OF THE REASONS ARE CHEAP TO NAME ───────
 *
 * "No placement found" is true and useless. Three structural facts are
 * decidable before any search and each of them is a sentence worth reading:
 *
 *   • the circuit has more qubits than the device;
 *   • some logical qubit must talk to more neighbours than any physical qubit
 *     has — four partners on a lattice whose vertices have at most three;
 *   • the interaction graph contains a cycle shorter than the device's
 *     shortest. This is the Toffoli case and it is the interesting one: a
 *     Toffoli makes its three qubits interact pairwise, a triangle, and a
 *     heavy-hex lattice's shortest cycle is *twelve* qubits long. No amount of
 *     free hardware helps. The refusal names both numbers.
 *
 * Anything else falls through to the search, which either finds the cheapest
 * embedding or reports that it looked at all of them.
 *
 * ── "CHEAPEST" IS A FIDELITY, NOT A DISTANCE ─────────────────────────────
 *
 * Every candidate placement is scored as
 *
 *     cost = Σ −ln(1 − e)   over every operation the circuit will run
 *
 * which is −ln of the product of the per-operation success probabilities. So
 * `exp(−cost)` is an estimate of the probability that the whole circuit runs
 * without an error, and minimising the cost maximises it. The sum runs over
 * `cz` uses on each edge, `sx` and `x` pulses on each qubit, and the readout
 * of each measured qubit. `rz` contributes nothing, because the backend
 * reports `gate_error: 0` and `gate_length: 0` for every one of them: it is a
 * frame change, not a pulse.
 *
 * The estimate is optimistic — it ignores decoherence during idle time, and
 * errors that partially cancel — so it is reported as what it is, a number for
 * ranking placements against each other rather than a prediction.
 */

import type { DeviceGraph, DeviceQubit } from './device.js'
import { girthOf } from './device.js'
import type { Decomposition, Interaction } from './decompose.js'
import { TranspileRefusal } from './refusal.js'

/** How many search nodes to expand before giving up and saying so. */
export const DEFAULT_NODE_BUDGET = 500_000

export interface PlacementOptions {
  readonly nodeBudget?: number
}

/** Where each logical qubit went, and what it is expected to cost. */
export interface Placement {
  /** `layout[logical]` is the physical qubit it runs on. Total and injective. */
  readonly layout: readonly number[]
  /** Physical qubits actually used, ascending. */
  readonly physicalQubits: readonly number[]
  /** Σ −ln(1 − e) over every operation. Zero when nothing is calibrated. */
  readonly cost: number
  /** `exp(−cost)`: a ranking number, not a promise. See the header. */
  readonly estimatedFidelity: number
  /** The physical pairs the circuit will entangle on, with their error rates. */
  readonly couplings: readonly {
    readonly a: number
    readonly b: number
    readonly uses: number
    readonly error: number | undefined
  }[]
  /** False when the node budget stopped the search before it finished. */
  readonly exhaustive: boolean
  /** Placements examined. Small for the circuits this package is for. */
  readonly examined: number
}

/**
 * The cheapest embedding of this circuit's interaction graph in this device's
 * coupling map, or a refusal that says which of the four reasons applies.
 */
export function place(
  decomposition: Decomposition,
  device: DeviceGraph,
  options: PlacementOptions = {}
): Placement {
  const logicalQubits = decomposition.circuit.qubits
  assertFits(device, logicalQubits)

  const adjacency = adjacencyOf(decomposition.interactions, logicalQubits)
  assertDegree(decomposition, device, adjacency)
  assertGirth(decomposition, device, adjacency)

  const uses = usesOf(decomposition.interactions)
  const measured = new Set(decomposition.measured)
  const qubitCost = (logical: number, physical: number): number => {
    const properties = device.target.qubitProperties?.[physical]
    const pulses = decomposition.pulses[logical] ?? 0
    /*
     * `0 * Infinity` is NaN, and a NaN cost compares false against everything —
     * so a qubit with a failed *gate* calibration and no pulses on it would
     * have poisoned the search rather than been rejected by it. Unreachable in
     * practice, because `device.ts` removes such a qubit from the graph
     * entirely, but the multiplication is where it would have gone wrong.
     */
    const gates = pulses === 0 ? 0 : pulses * infidelity(properties?.gateError)
    return gates + (measured.has(logical) ? readoutCost(properties) : 0)
  }

  const order = searchOrder(adjacency, logicalQubits)
  const seeds = seedOrder(device, decomposition)

  const layout = new Array<number>(logicalQubits).fill(-1)
  const used = new Set<number>()
  const budget = options.nodeBudget ?? DEFAULT_NODE_BUDGET

  let best: number[] | null = null
  let bestCost = Infinity
  let examined = 0
  let exhausted = false

  const step = (index: number, cost: number): void => {
    if (exhausted) return
    if (cost >= bestCost) return
    if (index === order.length) {
      best = [...layout]
      bestCost = cost
      return
    }
    if (++examined > budget) {
      exhausted = true
      return
    }

    const entry = order[index] as OrderEntry
    const candidates =
      entry.anchor === null
        ? seeds
        : (device.neighbours[layout[entry.anchor] as number] ?? [])

    for (const physical of candidates) {
      if (used.has(physical)) continue
      let extra = qubitCost(entry.qubit, physical)
      let fits = true
      for (const placed of entry.placedNeighbours) {
        const other = layout[placed] as number
        if (!device.areAdjacent(physical, other)) {
          fits = false
          break
        }
        const key = pairKey(entry.qubit, placed)
        extra +=
          (uses.get(key) ?? 0) * infidelity(device.errorOf(physical, other))
      }
      if (!fits) continue

      layout[entry.qubit] = physical
      used.add(physical)
      step(index + 1, cost + extra)
      used.delete(physical)
      layout[entry.qubit] = -1
      if (exhausted) return
    }
  }

  step(0, 0)

  if (best === null) {
    throw exhausted
      ? new TranspileRefusal(
          'search-exhausted',
          `No placement of this circuit on "${device.target.name}" was found ` +
            `within ${budget} candidates. That is a statement about the ` +
            `search, not a proof that none exists.`,
          { device: device.target.name, budget, qubits: logicalQubits }
        )
      : new TranspileRefusal(
          'no-placement',
          `The circuit's ${decomposition.interactions.length} interacting ` +
            `pair(s) cannot all be placed on adjacent qubits of ` +
            `"${device.target.name}". Every one of the ${examined} candidate ` +
            `placements was examined. The device couples ` +
            `${device.edges.length} pairs out of the ` +
            `${(device.qubits * (device.qubits - 1)) / 2} a fully connected ` +
            `register would have.`,
          {
            device: device.target.name,
            pairs: decomposition.interactions.length,
            examined,
            couplings: device.edges.length,
          },
          decomposition.interactions.flatMap((pair) => pair.operationIds)
        )
  }

  const settled: number[] = best
  fillIdleQubits(settled, device, decomposition)

  return finish(
    settled,
    decomposition,
    device,
    uses,
    bestCost,
    examined,
    !exhausted
  )
}

/* ────────────────────────── the cheap refusals ───────────────────────── */

function assertFits(device: DeviceGraph, logicalQubits: number): void {
  if (logicalQubits > device.usableQubits.length) {
    throw new TranspileRefusal(
      'too-many-qubits',
      `The circuit needs ${logicalQubits} qubits and "${device.target.name}" ` +
        `offers ${device.usableQubits.length} that its calibration says work ` +
        `(of ${device.qubits} in total).`,
      {
        device: device.target.name,
        needed: logicalQubits,
        available: device.usableQubits.length,
        total: device.qubits,
      }
    )
  }
}

function assertDegree(
  decomposition: Decomposition,
  device: DeviceGraph,
  adjacency: readonly (readonly number[])[]
): void {
  for (const [qubit, partners] of adjacency.entries()) {
    if (partners.length <= device.maxDegree) continue
    throw new TranspileRefusal(
      'degree-exceeded',
      `Qubit ${qubit} of the circuit has to interact with ` +
        `${partners.length} other qubits (${partners.join(', ')}). No qubit ` +
        `on "${device.target.name}" has more than ${device.maxDegree} ` +
        `neighbours, so there is nowhere to put it — and no choice of the ` +
        `other qubits changes that.`,
      {
        device: device.target.name,
        qubit,
        needed: partners.length,
        available: device.maxDegree,
      },
      operationsTouching(decomposition.interactions, qubit)
    )
  }
}

function assertGirth(
  decomposition: Decomposition,
  device: DeviceGraph,
  adjacency: readonly (readonly number[])[]
): void {
  const circuitGirth = girthOf(adjacency)
  if (circuitGirth >= device.girth) return
  throw new TranspileRefusal(
    'cycle-too-short',
    `The circuit makes ${circuitGirth} qubits interact in a closed loop, and ` +
      `the shortest loop on "${device.target.name}" is ${device.girth} qubits ` +
      `long — a lattice with no triangles and no squares in it anywhere. ` +
      `Mapping the loop onto the chip would need extra operations to carry ` +
      `states between qubits that are not wired together, and those are the ` +
      `noisiest instructions the device has, so this is refused rather than ` +
      `answered badly.`,
    {
      device: device.target.name,
      circuitGirth,
      deviceGirth: device.girth,
    },
    decomposition.interactions.flatMap((pair) => pair.operationIds)
  )
}

/* ─────────────────────────── the search order ────────────────────────── */

interface OrderEntry {
  readonly qubit: number
  /** A logical qubit already placed and adjacent to this one, or null. */
  readonly anchor: number | null
  /** Every already-placed logical neighbour, whose adjacency must all hold. */
  readonly placedNeighbours: readonly number[]
}

/**
 * Logical qubits in an order where each one after a component's first already
 * has a placed neighbour, so the branching factor is the device's degree
 * rather than its size. Components start at their highest-degree vertex, which
 * is the one whose constraint is hardest and therefore prunes soonest.
 */
function searchOrder(
  adjacency: readonly (readonly number[])[],
  qubits: number
): readonly OrderEntry[] {
  const order: OrderEntry[] = []
  const placed = new Set<number>()
  const remaining = new Set<number>()
  for (let qubit = 0; qubit < qubits; qubit++) {
    if ((adjacency[qubit] ?? []).length > 0) remaining.add(qubit)
  }

  while (remaining.size > 0) {
    let root = -1
    for (const qubit of remaining) {
      if (
        root === -1 ||
        (adjacency[qubit] ?? []).length > (adjacency[root] ?? []).length
      ) {
        root = qubit
      }
    }
    const queue = [root]
    remaining.delete(root)
    order.push({ qubit: root, anchor: null, placedNeighbours: [] })
    placed.add(root)

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head] as number
      for (const next of adjacency[current] ?? []) {
        if (placed.has(next)) continue
        placed.add(next)
        remaining.delete(next)
        order.push({
          qubit: next,
          anchor: current,
          placedNeighbours: (adjacency[next] ?? []).filter((partner) =>
            placed.has(partner)
          ),
        })
        queue.push(next)
      }
    }
  }
  return order
}

/**
 * Physical qubits to try first for a component's root: the quietest ones.
 *
 * Order changes nothing about which placements are legal and everything about
 * how fast the search prunes — a good placement found early makes `bestCost` a
 * tight bound, and the bound is what cuts the tree.
 */
function seedOrder(
  device: DeviceGraph,
  decomposition: Decomposition
): readonly number[] {
  const anyMeasurement = decomposition.measured.length > 0
  return [...device.usableQubits].sort((left, right) => {
    const cost = (qubit: number): number => {
      const properties = device.target.qubitProperties?.[qubit]
      return (
        infidelity(properties?.gateError) +
        (anyMeasurement ? infidelity(properties?.readoutError) : 0)
      )
    }
    return cost(left) - cost(right) || left - right
  })
}

/* ────────────────────────────── the rest ─────────────────────────────── */

/**
 * Logical qubits that no `cz` touches still need a home, because the document
 * declares them and the layout has to be total. They take the quietest
 * physical qubits left over, which costs nothing and matters when one of them
 * is measured.
 */
function fillIdleQubits(
  layout: number[],
  device: DeviceGraph,
  decomposition: Decomposition
): void {
  const used = new Set(layout.filter((physical) => physical >= 0))
  const spare = seedOrder(device, decomposition).filter(
    (qubit) => !used.has(qubit)
  )
  let next = 0
  for (const [logical, physical] of layout.entries()) {
    if (physical >= 0) continue
    const chosen = spare[next++]
    if (chosen === undefined) {
      throw new TranspileRefusal(
        'too-many-qubits',
        `The circuit declares qubit ${logical}, and "${device.target.name}" ` +
          `has no working physical qubit left to hold it.`,
        { device: device.target.name, qubit: logical }
      )
    }
    layout[logical] = chosen
    used.add(chosen)
  }
}

function finish(
  layout: readonly number[],
  decomposition: Decomposition,
  device: DeviceGraph,
  uses: ReadonlyMap<string, number>,
  interactionCost: number,
  examined: number,
  exhaustive: boolean
): Placement {
  // The search only accumulated the cost of the qubits it placed, so idle
  // wires are added here. They are free unless one is measured.
  let cost = interactionCost
  const measured = new Set(decomposition.measured)
  const counted = new Set<number>()
  for (const entry of decomposition.interactions) {
    counted.add(entry.a)
    counted.add(entry.b)
  }
  for (let logical = 0; logical < layout.length; logical++) {
    if (counted.has(logical)) continue
    const physical = layout[logical] as number
    const properties = device.target.qubitProperties?.[physical]
    cost +=
      (decomposition.pulses[logical] ?? 0) * infidelity(properties?.gateError) +
      (measured.has(logical) ? infidelity(properties?.readoutError) : 0)
  }

  const couplings = decomposition.interactions.map((entry) => {
    const a = layout[entry.a] as number
    const b = layout[entry.b] as number
    return {
      a: Math.min(a, b),
      b: Math.max(a, b),
      uses: uses.get(pairKey(entry.a, entry.b)) ?? entry.count,
      error: device.errorOf(a, b),
    }
  })

  return {
    layout,
    physicalQubits: [...layout].sort((left, right) => left - right),
    cost,
    estimatedFidelity: Math.exp(-cost),
    couplings,
    exhaustive,
    examined,
  }
}

/* ───────────────────────────── small parts ───────────────────────────── */

function adjacencyOf(
  interactions: readonly Interaction[],
  qubits: number
): readonly (readonly number[])[] {
  const adjacency: number[][] = Array.from(
    { length: qubits },
    (): number[] => []
  )
  for (const entry of interactions) {
    ;(adjacency[entry.a] as number[]).push(entry.b)
    ;(adjacency[entry.b] as number[]).push(entry.a)
  }
  return adjacency
}

function usesOf(
  interactions: readonly Interaction[]
): ReadonlyMap<string, number> {
  const uses = new Map<string, number>()
  for (const entry of interactions)
    uses.set(pairKey(entry.a, entry.b), entry.count)
  return uses
}

function operationsTouching(
  interactions: readonly Interaction[],
  qubit: number
): readonly string[] {
  return interactions
    .filter((entry) => entry.a === qubit || entry.b === qubit)
    .flatMap((entry) => entry.operationIds)
}

function pairKey(a: number, b: number): string {
  return `${String(Math.min(a, b))}-${String(Math.max(a, b))}`
}

/**
 * `−ln(1 − e)`, the additive form of a success probability.
 *
 * An unknown error contributes nothing, which is the only defensible choice:
 * treating it as zero would claim a perfect gate and treating it as one would
 * make an uncalibrated device unusable. `DeviceGraph.calibrated` is what tells
 * a caller which of the two situations they are in.
 */
function infidelity(error: number | undefined): number {
  if (error === undefined || !Number.isFinite(error) || error <= 0) return 0
  return error >= 1 ? Infinity : -Math.log(1 - error)
}

/**
 * The largest penalty a *readout* may contribute, as an infidelity.
 *
 * `−ln(1 − (1 − 1e-9))`, which is about 20.7 — larger than the sum of every
 * real cost any plausible circuit accumulates, and finite.
 */
const UNREADABLE_PENALTY = -Math.log(1e-9)

/**
 * What it costs to *read* a qubit, which is never a reason to refuse a circuit.
 *
 * ── WHY THIS IS NOT `infidelity` ─────────────────────────────────────────
 *
 * A backend reports `readout_error: 1` for a qubit whose readout calibration
 * failed, and `infidelity` answers `Infinity` for that — which is right for a
 * *gate* error, where `device.ts` removes the qubit from the graph by name and
 * a circuit that fits only on broken hardware genuinely has no placement.
 *
 * Applied to readout it was a silent refusal of the wrong thing. `step()`
 * prunes any branch whose cost is not strictly below the best so far, and the
 * best starts at `Infinity`, so an infinite-cost placement could never be
 * *recorded* — `best` stayed null, `exhausted` stayed false, and a measured
 * Bell pair on a device whose every qubit read badly came back as
 * `no-placement`, a code whose message interpolates coupling-map numbers. The
 * user was told their circuit's connectivity did not fit a device that couples
 * it fine.
 *
 * A readout error is a *quality* number: the qubits still compute, the answer
 * is just not worth reading. So the penalty saturates instead of diverging.
 * Any finite value larger than every real cost preserves the ordering the
 * search wants — pick the readable qubits when there are any — while leaving a
 * placement that exists findable, which is the honest outcome when the only
 * fault is that the machine's readout needs recalibrating.
 */
function readoutCost(properties: DeviceQubit | undefined): number {
  const value = infidelity(properties?.readoutError)
  return Number.isFinite(value) ? value : UNREADABLE_PENALTY
}
