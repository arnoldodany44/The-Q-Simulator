/**
 * IBM's backend metadata, read into a `DeviceTarget`.
 *
 * No network here and none possible: this package touches neither Node nor the
 * DOM (§12.3 rule 2), so what it offers is the *translation* and the caller
 * does the fetching. That split is deliberate — the three requests involved
 * (`/backends`, `/backends/{name}/configuration`, `/backends/{name}/
 * properties`) are metadata and cost no QPU time, but they need a bearer token
 * and a CRN, and neither of those may exist in a package the browser bundles.
 *
 * ── WHAT EACH DOCUMENT CONTRIBUTES ───────────────────────────────────────
 *
 *   configuration  the wiring: `n_qubits`, `basis_gates`, and `coupling_map`
 *                  as *directed* pairs — 352 of them for 176 undirected edges,
 *                  every edge listed both ways round.
 *   properties     the calibration: per-qubit `readout_error`, and per-gate
 *                  `gate_error` for each `sx` and each `cz`. Both directions
 *                  of a `cz` are listed and, on every device measured, carry
 *                  identical numbers — the gate is symmetric and so is its
 *                  error — so the pair keeps one value.
 *
 * ── THE PARSING IS DEFENSIVE, BECAUSE THE INPUT IS SOMEBODY ELSE'S ───────
 *
 * Every field is read through an optional path and a missing one becomes
 * `undefined` rather than a throw or a zero. A zero would be worse than
 * missing: it would claim a perfect gate, and the placement search would
 * cheerfully choose the qubits it knows least about.
 */

import type { CoupledPair, DeviceQubit, DeviceTarget } from './device.js'

/** The subset of `/backends/{name}/configuration` that matters here. */
export interface IbmConfiguration {
  readonly backend_name?: string
  readonly n_qubits?: number
  readonly basis_gates?: readonly string[]
  readonly coupling_map?: readonly (readonly number[])[]
}

/** One `{ name, value }` row of a properties document. */
export interface IbmProperty {
  readonly name?: string
  readonly value?: number
}

/** The subset of `/backends/{name}/properties` that matters here. */
export interface IbmProperties {
  readonly last_update_date?: string
  readonly qubits?: readonly (readonly IbmProperty[])[]
  readonly gates?: readonly {
    readonly gate?: string
    readonly qubits?: readonly number[]
    readonly parameters?: readonly IbmProperty[]
  }[]
}

/** Extra facts that live in the `/backends` listing rather than the two above. */
export interface IbmBackendStatus {
  readonly queueLength?: number
}

/**
 * A `DeviceTarget` from what the Quantum API answers.
 *
 * `properties` is optional so that a topology-only target still works: the
 * placement search then has no calibration to prefer with and says so through
 * `DeviceGraph.calibrated`, rather than inventing error rates.
 */
export function deviceTargetFromIbm(
  configuration: IbmConfiguration,
  properties?: IbmProperties,
  status?: IbmBackendStatus
): DeviceTarget {
  const qubits = configuration.n_qubits ?? 0
  const twoQubitErrors = new Map<string, number>()
  const oneQubitErrors = new Map<number, number>()

  for (const gate of properties?.gates ?? []) {
    const error = valueOf(gate.parameters, 'gate_error')
    if (error === undefined) continue
    const wires = gate.qubits ?? []
    if (gate.gate === 'cz' && wires.length === 2) {
      const [a, b] = wires as [number, number]
      twoQubitErrors.set(pairKey(a, b), error)
      continue
    }
    if (gate.gate === 'sx' && wires.length === 1) {
      oneQubitErrors.set(wires[0] as number, error)
    }
  }

  const coupling: CoupledPair[] = []
  const seen = new Set<string>()
  for (const pair of configuration.coupling_map ?? []) {
    const a = pair[0]
    const b = pair[1]
    if (a === undefined || b === undefined || a === b) continue
    const key = pairKey(a, b)
    if (seen.has(key)) continue
    seen.add(key)
    const error = twoQubitErrors.get(key)
    coupling.push(
      error === undefined
        ? { a: Math.min(a, b), b: Math.max(a, b) }
        : { a: Math.min(a, b), b: Math.max(a, b), error }
    )
  }

  const qubitProperties: DeviceQubit[] = []
  for (let qubit = 0; qubit < qubits; qubit++) {
    const gateError = oneQubitErrors.get(qubit)
    const readoutError = valueOf(properties?.qubits?.[qubit], 'readout_error')
    qubitProperties.push({
      ...(gateError === undefined ? {} : { gateError }),
      ...(readoutError === undefined ? {} : { readoutError }),
    })
  }

  return {
    name: configuration.backend_name ?? 'unknown',
    qubits,
    ...(configuration.basis_gates === undefined
      ? {}
      : { basisGates: configuration.basis_gates }),
    coupling,
    ...(properties === undefined ? {} : { qubitProperties }),
    ...(properties?.last_update_date === undefined
      ? {}
      : { calibratedAt: properties.last_update_date }),
    ...(status?.queueLength === undefined
      ? {}
      : { queueLength: status.queueLength }),
  }
}

function pairKey(a: number, b: number): string {
  return `${String(Math.min(a, b))}-${String(Math.max(a, b))}`
}

function valueOf(
  rows: readonly IbmProperty[] | undefined,
  name: string
): number | undefined {
  const row = (rows ?? []).find((candidate) => candidate.name === name)
  return typeof row?.value === 'number' && Number.isFinite(row.value)
    ? row.value
    : undefined
}
