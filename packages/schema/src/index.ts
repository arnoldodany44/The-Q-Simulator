/**
 * @qsim/schema — the circuit JSON contract (specification §6).
 *
 * Every part of the system agrees on this shape: the editor produces it, the
 * engine consumes it, the API stores it in `CircuitVersion.data`, and the
 * QASM converters translate to and from it. It is validated with the same
 * Zod schemas on both sides of the wire.
 *
 * Where things live:
 *   - `circuit.ts`  the shape: Zod schemas and the types inferred from them
 *   - `gates.ts`    the gate catalog: arity, parameters, category, symbol
 *   - `validate.ts` the rules a shape cannot express, and the parse entry points
 *   - `helpers.ts`  pure functions over a circuit
 *   - `expand.ts`   custom gates flattened into primitives, and the column map
 *   - `preview.ts`  the bounded thumbnail a gallery card draws
 *   - `text.ts`     what a string must not contain to be storable at all
 *
 * Start at `parseCircuit` for untrusted input, `validateCircuit` for a
 * circuit you already hold in memory.
 */

export {
  CIRCUIT_SCHEMA_VERSION,
  CircuitSchema,
  ConditionSchema,
  ControlSchema,
  ControlSpecSchema,
  CustomGateSchema,
  MAX_CLBITS,
  MAX_COLUMNS,
  MAX_CUSTOM_GATE_DEPTH,
  MAX_CUSTOM_GATE_PARAMS,
  MAX_QUBITS,
  OperationSchema,
  ParamValueSchema,
  ParameterSchema,
} from './circuit.js'
export type {
  Circuit,
  CircuitInput,
  Condition,
  Control,
  ControlSpec,
  CustomGate,
  Operation,
  ParamValue,
  Parameter,
} from './circuit.js'

export {
  GATES,
  GATE_IDS,
  VARIABLE_ARITY,
  isGateId,
  lookupGate,
} from './gates.js'
export type { GateArity, GateCategory, GateId, GateMeta } from './gates.js'

export {
  CircuitValidationError,
  formatIssues,
  parseCircuit,
  safeParseCircuit,
  validateCircuit,
} from './validate.js'
export type {
  CircuitParseResult,
  ValidationCode,
  ValidationIssue,
} from './validate.js'

export {
  isStorableText,
  storableProse,
  storableText,
  TEXT_ISSUE_CONTROL_CHARACTER,
  TEXT_ISSUE_LONE_SURROGATE,
} from './text.js'

export {
  controlsOf,
  depth,
  emptyCircuit,
  gateCount,
  gatesUsed,
  normalizeColumns,
  normalizeControl,
  pruneUnusedDefinitions,
  qubitsOf,
  resolveParams,
} from './helpers.js'

export {
  CircuitExpansionError,
  MAX_EXPANDED_COLUMNS,
  MAX_EXPANDED_OPERATIONS,
  customGateUsage,
  expandCircuit,
  expandedFromColumn,
  expandedThroughColumn,
  inlineOperation,
  safeExpandCircuit,
  sourceColumnOf,
  sourceOperationId,
  usesCustomGates,
} from './expand.js'
export type {
  ColumnSpan,
  CustomGateUsage,
  ExpandedCircuit,
  ExpansionCode,
} from './expand.js'

export {
  CircuitPreviewSchema,
  PREVIEW_MAX_COLUMNS,
  PREVIEW_MAX_QUBITS,
  PreviewOperationSchema,
  previewOf,
  safeParsePreview,
} from './preview.js'
export type { CircuitPreview, PreviewOperation } from './preview.js'
