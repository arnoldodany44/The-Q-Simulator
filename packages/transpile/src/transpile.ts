/**
 * The two layers, joined.
 *
 * ```ts
 * const device = deviceGraph(deviceTargetFromIbm(configuration, properties))
 * const plan = transpile(circuit, device)
 * // plan.qasm      → what to submit
 * // plan.layout    → logical qubit i runs on physical qubit plan.layout[i]
 * // plan.placement → what it is expected to cost, and why those qubits
 * ```
 *
 * ── WHAT IS SUPPORTED, IN ONE PARAGRAPH ──────────────────────────────────
 *
 * Every gate in the catalog is decomposed: all fifteen one-qubit gates, `cx`,
 * `cz`, `crz`, `cp`, `swap`, `iswap`, `ccx` and `cswap`, plus any of the
 * one-qubit gates carrying up to two extra controls, positive or negative, and
 * `barrier`, `reset` and `measure` untouched. Whether a decomposed circuit
 * then *runs* is a separate question, answered by the coupling map: a circuit
 * places when its interaction graph embeds in the device's, which on a
 * heavy-hex lattice means any circuit whose qubits interact in a tree or in a
 * long cycle — chains, stars of degree up to three, and everything on two
 * qubits. It does not mean a Toffoli: three qubits interacting pairwise is a
 * triangle and the lattice has none. That case is refused with both numbers,
 * never routed around.
 *
 * ── NOTHING HERE REACHES A NETWORK ───────────────────────────────────────
 *
 * A `DeviceGraph` is a value the caller built from data it fetched. This
 * package runs identically in a browser worker, in the API and in a test with
 * a hand-written five-qubit device, which is also why every device-dependent
 * decision it makes is reproducible from the arguments alone.
 */

import { commentText } from '@qsim/qasm'
import { depth, type Circuit, type Operation } from '@qsim/schema'

import { decomposeCircuit, type Decomposition } from './decompose.js'
import type { DeviceGraph } from './device.js'
import { emitPhysicalQasm, type QasmStyle } from './emit.js'
import { place, type Placement } from './placement.js'
import { TranspileRefusal, type TranspileOutcome } from './refusal.js'

export interface TranspileOptions {
  /** Candidate placements to examine before giving up. */
  readonly nodeBudget?: number
  /** `hardware` writes `$53`; `register` writes a device-wide `q[53]`. */
  readonly style?: QasmStyle
  /** Written into the program's header comment. */
  readonly title?: string
  /**
   * Refuse a circuit that measures nothing. On by default, and not merely
   * pedantry: a hardware job returns classical bits and nothing else, so a
   * circuit with no measurement spends the account's QPU minutes to produce an
   * empty register. Pass `false` to transpile for inspection.
   */
  readonly requireMeasurement?: boolean
}

/** Everything the submission layer and the comparison view need. */
export interface TranspiledCircuit {
  readonly device: string
  /** The program to submit, over physical qubits. */
  readonly qasm: string
  /** `layout[logical]` is the physical qubit it runs on. */
  readonly layout: readonly number[]
  /** Physical qubits used, ascending; index `i` is qubit `i` of `placed`. */
  readonly physicalQubits: readonly number[]
  /**
   * The circuit in the native basis on the document's own numbering. Runs in
   * `@qsim/core` and is what an "ideal vs transpiled" comparison simulates.
   */
  readonly basis: Circuit
  /** The same circuit renumbered so qubit `i` is `physicalQubits[i]`. */
  readonly placed: Circuit
  readonly placement: Placement
  readonly decomposition: Omit<Decomposition, 'circuit'>
  readonly stats: TranspileStats
  /** False when the device carried no calibration and the cost is a guess. */
  readonly calibrated: boolean
  /** When the device's calibration was taken, if it said. */
  readonly calibratedAt: string | undefined
}

export interface TranspileStats {
  /** `sx` and `x`: the operations that are pulses and therefore cost error. */
  readonly pulses: number
  /** `rz`: frame changes, free in both time and error on this hardware. */
  readonly frameChanges: number
  readonly twoQubitGates: number
  readonly depth: number
  readonly operations: number
}

/** Compile a circuit for a device, or refuse with numbers. */
export function transpile(
  circuit: Circuit,
  device: DeviceGraph,
  options: TranspileOptions = {}
): TranspiledCircuit {
  const decomposition = decomposeCircuit(circuit)

  if (
    options.requireMeasurement !== false &&
    decomposition.measured.length === 0
  ) {
    throw new TranspileRefusal(
      'no-measurement',
      `The circuit measures nothing, so a hardware run would return an empty ` +
        `classical register. A backend answers with bits and with nothing ` +
        `else — there is no state vector to read on a real device.`,
      { qubits: circuit.qubits }
    )
  }

  const placement = place(decomposition, device, options)
  const placed = renumber(
    decomposition.circuit,
    placement.layout,
    placement.physicalQubits
  )

  const qasm = emitPhysicalQasm(placed, placement.physicalQubits, {
    ...(options.style === undefined ? {} : { style: options.style }),
    deviceQubits: device.qubits,
    header: header(circuit, device, placement, options),
  })

  const { circuit: _basis, ...summary } = decomposition
  return {
    device: device.target.name,
    qasm,
    layout: placement.layout,
    physicalQubits: placement.physicalQubits,
    basis: decomposition.circuit,
    placed,
    placement,
    decomposition: summary,
    stats: statsOf(decomposition),
    calibrated: device.calibrated,
    calibratedAt: device.target.calibratedAt,
  }
}

/** `transpile`, answering a refusal instead of throwing one. */
export function safeTranspile(
  circuit: Circuit,
  device: DeviceGraph,
  options: TranspileOptions = {}
): TranspileOutcome<TranspiledCircuit> {
  try {
    return { ok: true, value: transpile(circuit, device, options) }
  } catch (cause) {
    if (cause instanceof TranspileRefusal) return { ok: false, refusal: cause }
    throw cause
  }
}

/* ─────────────────────────────── details ─────────────────────────────── */

/**
 * The decomposed circuit with its qubits renumbered into placement order.
 *
 * Compact rather than device-wide, because the contract caps a register at 28
 * qubits and a 156-qubit document would not validate — and because a compact
 * circuit is one `@qsim/core` can still run, which is what makes the placed
 * program checkable without hardware. `emit.ts` restores the physical indices
 * when it writes the program.
 */
function renumber(
  circuit: Circuit,
  layout: readonly number[],
  physicalQubits: readonly number[]
): Circuit {
  const compact = new Map<number, number>()
  for (const [index, physical] of physicalQubits.entries()) {
    compact.set(physical, index)
  }
  const move = (logical: number): number => {
    const physical = layout[logical]
    const index = physical === undefined ? undefined : compact.get(physical)
    if (index === undefined) {
      throw new RangeError(`Qubit ${logical} has no place in the layout.`)
    }
    return index
  }

  const operations: Operation[] = circuit.operations.map((operation) => ({
    ...operation,
    targets: operation.targets.map(move),
    ...(operation.controls === undefined
      ? {}
      : {
          controls: operation.controls.map((control) =>
            typeof control === 'number'
              ? move(control)
              : { qubit: move(control.qubit), state: control.state }
          ),
        }),
  }))

  /*
   * Wire labels are dropped rather than permuted. They name the *logical*
   * qubits of the document — "alice", "bob" — and a header comment that
   * attached them to physical indices would be read as a claim about the chip.
   * `layout` carries the correspondence, unambiguously.
   */
  const { qubitLabels: _dropped, ...rest } = circuit
  return { ...rest, qubits: physicalQubits.length, operations }
}

function statsOf(decomposition: Decomposition): TranspileStats {
  let pulses = 0
  let frameChanges = 0
  for (const operation of decomposition.circuit.operations) {
    if (operation.gate === 'sx' || operation.gate === 'x') pulses++
    else if (operation.gate === 'rz') frameChanges++
  }
  return {
    pulses,
    frameChanges,
    twoQubitGates: decomposition.twoQubitGates,
    depth: depth(decomposition.circuit),
    operations: decomposition.circuit.operations.length,
  }
}

/**
 * The header comment.
 *
 * It carries the three things a reader of the submitted file cannot recover
 * from the statements: which device it was compiled for and against which
 * calibration, where each logical qubit went, and what the bit order means.
 * The last is not decoration — it is decision D1, and it is the claim that
 * lets somebody compare a returned bitstring against a simulated one.
 *
 * ── THE PROSE IS ASCII, DELIBERATELY ─────────────────────────────────────
 *
 * This project's own comments are full of arrows and em dashes and this one
 * is not, because these lines travel to somebody else's parser. OpenQASM 3
 * says a `//` comment runs to the end of the line and says nothing about its
 * encoding, so a Unicode arrow is *probably* fine — and "probably fine" is a
 * bad trade against a ten-minute QPU budget that does not refill on request.
 * The one exception is the caller's title, which is passed through
 * `commentText` (control characters out, whitespace collapsed) and otherwise
 * left alone: mangling a Spanish or French circuit name to keep a comment
 * seven-bit would be a worse bargain in the other direction.
 */
function header(
  circuit: Circuit,
  device: DeviceGraph,
  placement: Placement,
  options: TranspileOptions
): readonly string[] {
  const style = options.style ?? 'hardware'
  const spell = (physical: number): string =>
    style === 'hardware' ? `$${String(physical)}` : `q[${String(physical)}]`
  const title = commentText(options.title ?? '')

  const lines = [
    title === ''
      ? `Generated by The Q Simulator and transpiled for ${device.target.name}.`
      : `Generated by The Q Simulator - ${title} - transpiled for ` +
        `${device.target.name}.`,
    `Basis: rz, sx, x, id, cz. Every rz is a change of reference frame, ` +
      `which this hardware reports as taking no time and adding no error; ` +
      `sx and x are the pulses.`,
    `Layout: ${placement.layout
      .map(
        (physical, logical) => `qubit ${String(logical)} -> ${spell(physical)}`
      )
      .join(', ')}.`,
    `Little-endian, decision D1: qubit 0 is the least significant bit of the ` +
      `state index, and the classical register is the source document's own. ` +
      `Transpilation moved the qubits, not the bits they measure into, so ` +
      `bit k of a returned sample is c[k] here and there alike.`,
  ]

  if (device.calibrated) {
    lines.push(
      `Placed against the calibration read ` +
        `${device.target.calibratedAt ?? 'at an unstated time'}: estimated ` +
        `success probability ${placement.estimatedFidelity.toFixed(4)} over ` +
        `${String(placement.couplings.reduce((sum, pair) => sum + pair.uses, 0))} ` +
        `two-qubit gate(s). An estimate for ranking placements, not a promise.`
    )
  } else {
    lines.push(
      `No calibration was supplied with this device, so the qubits were ` +
        `chosen for connectivity alone.`
    )
  }

  if (circuit.qubitLabels !== undefined && circuit.qubitLabels.length > 0) {
    lines.push(
      `Wire names in the source document: ${circuit.qubitLabels
        .map((label, index) => `qubit ${String(index)} = ${commentText(label)}`)
        .join(', ')}.`
    )
  }
  return lines
}
