/**
 * Gate catalog — what every gate *is*, in one table.
 *
 * The palette, the validator, the engine's dispatch table and the QASM
 * exporters all read arity and parameter counts from here. A second copy of
 * this information anywhere else is how a gate ends up taking two qubits in
 * the editor and one in the exporter.
 *
 * Covers specification §3.1. `symbol` is the label shown to the user, and it
 * is deliberately never translated (decision D2): `CNOT` and `√X` are the
 * notation the whole literature uses, so translating them would break the
 * correspondence with Qiskit.
 */

/**
 * How a gate behaves, not what it computes.
 *
 *  - `single`       one qubit, no parameters
 *  - `parametrised` one qubit, driven by angles
 *  - `two`/`three`  fixed multi-qubit shapes
 *  - `structural`   not unitary: annotations, reset, measurement
 */
export type GateCategory =
  'single' | 'parametrised' | 'two' | 'three' | 'structural'

/** `barrier` is the only gate that spans an arbitrary number of qubits. */
export const VARIABLE_ARITY = 'variable'

/** Number of target qubits a gate takes. */
export type GateArity = number | typeof VARIABLE_ARITY

/** Every gate the format knows about. Custom gates are named separately. */
export type GateId =
  | 'i'
  | 'x'
  | 'y'
  | 'z'
  | 'h'
  | 's'
  | 'sdg'
  | 't'
  | 'tdg'
  | 'sx'
  | 'rx'
  | 'ry'
  | 'rz'
  | 'p'
  | 'u'
  | 'cx'
  | 'cz'
  | 'swap'
  | 'iswap'
  | 'crz'
  | 'cp'
  | 'ccx'
  | 'cswap'
  | 'barrier'
  | 'reset'
  | 'measure'

export interface GateMeta {
  readonly id: GateId
  /** Display label. Invariant across locales — see the file header. */
  readonly symbol: string
  readonly category: GateCategory
  /** Target qubits, i.e. the length `operations[].targets` must have. */
  readonly arity: GateArity
  /** Controls the gate carries by definition: 1 for `cx`, 2 for `ccx`. */
  readonly controlCount: number
  /**
   * Whether the user may add controls beyond `controlCount`. Only 1-qubit
   * gates may (§3.1); a "controlled SWAP with four extra controls" is not a
   * thing the editor offers, so the validator rejects it rather than letting
   * the engine meet a shape it was never written for.
   */
  readonly acceptsControls: boolean
  readonly paramCount: number
  /** Parameter names in positional order — the labels the editor shows. */
  readonly paramNames: readonly string[]
  /** Classical bits written: 1 for `measure`, 0 for everything else. */
  readonly clbitCount: number
}

function single(id: GateId, symbol: string): GateMeta {
  return {
    id,
    symbol,
    category: 'single',
    arity: 1,
    controlCount: 0,
    acceptsControls: true,
    paramCount: 0,
    paramNames: [],
    clbitCount: 0,
  }
}

function parametrised(
  id: GateId,
  symbol: string,
  paramNames: readonly string[]
): GateMeta {
  return {
    id,
    symbol,
    category: 'parametrised',
    arity: 1,
    controlCount: 0,
    acceptsControls: true,
    paramCount: paramNames.length,
    paramNames,
    clbitCount: 0,
  }
}

function multi(
  id: GateId,
  symbol: string,
  category: 'two' | 'three',
  arity: number,
  controlCount: number,
  paramNames: readonly string[] = []
): GateMeta {
  return {
    id,
    symbol,
    category,
    arity,
    controlCount,
    acceptsControls: false,
    paramCount: paramNames.length,
    paramNames,
    clbitCount: 0,
  }
}

function structural(
  id: GateId,
  symbol: string,
  arity: GateArity,
  clbitCount: number
): GateMeta {
  return {
    id,
    symbol,
    category: 'structural',
    arity,
    controlCount: 0,
    acceptsControls: false,
    paramCount: 0,
    paramNames: [],
    clbitCount,
  }
}

/**
 * The catalog. Typing it as a total record over `GateId` means adding an id
 * to the union without adding its metadata is a compile error.
 *
 * On the two-qubit entries: `cx`, `cz`, `crz` and `cp` are stored as a
 * one-qubit gate plus one control, which is why `arity` is 1 and
 * `controlCount` is 1. `swap` and `iswap` have no control at all — they act
 * on two targets symmetrically.
 */
export const GATES: Readonly<Record<GateId, GateMeta>> = {
  i: single('i', 'I'),
  x: single('x', 'X'),
  y: single('y', 'Y'),
  z: single('z', 'Z'),
  h: single('h', 'H'),
  s: single('s', 'S'),
  sdg: single('sdg', 'S†'),
  t: single('t', 'T'),
  tdg: single('tdg', 'T†'),
  sx: single('sx', '√X'),

  rx: parametrised('rx', 'Rx', ['theta']),
  ry: parametrised('ry', 'Ry', ['theta']),
  rz: parametrised('rz', 'Rz', ['theta']),
  p: parametrised('p', 'P', ['phi']),
  u: parametrised('u', 'U', ['theta', 'phi', 'lambda']),

  cx: multi('cx', 'CNOT', 'two', 1, 1),
  cz: multi('cz', 'CZ', 'two', 1, 1),
  swap: multi('swap', 'SWAP', 'two', 2, 0),
  iswap: multi('iswap', 'iSWAP', 'two', 2, 0),
  crz: multi('crz', 'CRz', 'two', 1, 1, ['theta']),
  cp: multi('cp', 'CP', 'two', 1, 1, ['phi']),

  ccx: multi('ccx', 'CCX', 'three', 1, 2),
  cswap: multi('cswap', 'CSWAP', 'three', 2, 1),

  barrier: structural('barrier', '⋮', VARIABLE_ARITY, 0),
  reset: structural('reset', '|0⟩', 1, 0),
  measure: structural('measure', 'M', 1, 1),
}

/** Every catalog id, in palette order. */
export const GATE_IDS = Object.keys(GATES) as readonly GateId[]

/** Whether `value` names a built-in gate. Custom gates answer `false`. */
export function isGateId(value: string): value is GateId {
  return Object.hasOwn(GATES, value)
}

/** Metadata for a gate name, or `undefined` if it is not a built-in. */
export function lookupGate(gate: string): GateMeta | undefined {
  return isGateId(gate) ? GATES[gate] : undefined
}
