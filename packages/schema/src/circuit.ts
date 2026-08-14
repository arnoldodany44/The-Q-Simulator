/**
 * The circuit JSON contract — specification §6.
 *
 * The editor produces this shape, the engine consumes it, the API stores it
 * in `CircuitVersion.data` and the QASM converters translate to and from it.
 * Because it crosses the wire, it is validated with these same Zod schemas
 * on both sides.
 *
 * Two decisions worth knowing before you edit anything here:
 *
 * 1. Every object is `strictObject`, so an unknown key is an error rather
 *    than silently dropped data. `clbitTarget` instead of `clbitTargets`
 *    would otherwise parse fine and quietly produce a circuit that measures
 *    into nowhere.
 * 2. The TypeScript types are *inferred* from the schemas, never written
 *    twice. A hand-written interface next to a Zod schema drifts, and the
 *    drift shows up as a runtime rejection of something the compiler said
 *    was fine.
 *
 * The schemas only describe shape. Everything a shape cannot express — a
 * qubit index that exceeds the register, two gates fighting over the same
 * column — lives in `validate.ts`.
 */

import { z } from 'zod'

/**
 * Version of the circuit JSON contract.
 *
 * Bump only for breaking shape changes, and add a migration when you do —
 * saved circuits in the database carry this number and must keep loading.
 * A migration parses the old payload with the old version's schema, which
 * is why the field is pinned to an exact literal rather than a range.
 */
export const CIRCUIT_SCHEMA_VERSION = 1

/**
 * Upper bound on qubits, from the memory table in specification §5.1: a
 * statevector costs 2ⁿ × 16 bytes, so 28 qubits is already 4 GB. The browser
 * gives up much earlier (~20 qubits), but that is a client limit, not a
 * format limit — a circuit built against a server must still parse in the
 * editor, if only to be shown as too large to run here.
 */
export const MAX_QUBITS = 28

/**
 * Upper bound on classical bits. Measurement results travel as bitstrings,
 * so this is a readability limit rather than a memory one.
 */
export const MAX_CLBITS = 64

/**
 * Upper bound on `column`. Bounded so a corrupt or hostile payload cannot
 * ask the editor to lay out billions of empty columns; `normalizeColumns()`
 * keeps real circuits far below it.
 */
export const MAX_COLUMNS = 4096

/**
 * Names that survive a round trip through OpenQASM, which has no way to
 * spell a parameter called `2 theta`. Applied to parameter names and to
 * custom gate names for the same reason.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const IdentifierSchema = z.string().max(64).regex(IDENTIFIER)

/**
 * A qubit index is bounded by the format here and by the circuit's own
 * `qubits` in `validate.ts`. The shape check exists so that a garbage index
 * is rejected even when the circuit that would reveal it is itself invalid.
 */
const QubitIndexSchema = z
  .int()
  .min(0)
  .max(MAX_QUBITS - 1)

const ClbitIndexSchema = z
  .int()
  .min(0)
  .max(MAX_CLBITS - 1)

/** A single classical bit value. */
const BitValueSchema = z.literal([0, 1])

/**
 * A control with an explicit trigger state. `state: 0` is a negative
 * control: the gate fires when the control qubit reads |0⟩ (§3.1).
 */
export const ControlSpecSchema = z.strictObject({
  qubit: QubitIndexSchema,
  state: BitValueSchema,
})

/**
 * Both control spellings are accepted, because `controls: [1]` is what a
 * human writes and what the vast majority of circuits need. It means
 * `{ qubit: 1, state: 1 }`; use `normalizeControl()` before reading one.
 */
export const ControlSchema = z.union([QubitIndexSchema, ControlSpecSchema])

/**
 * A gate parameter: either a literal angle in radians or the name of an
 * entry in the circuit's `parameters`, which is what makes sweeps possible.
 */
export const ParamValueSchema = z.union([z.number(), IdentifierSchema])

/** A named parameter with the value the circuit is currently simulated at. */
export const ParameterSchema = z.strictObject({
  name: IdentifierSchema,
  value: z.number(),
})

/**
 * A classical condition: run this operation only if `clbit` reads `equals`.
 * One bit rather than a whole register — teleportation needs exactly this,
 * and anything richer can wait until a circuit actually demands it.
 */
export const ConditionSchema = z.strictObject({
  clbit: ClbitIndexSchema,
  equals: BitValueSchema,
})

/**
 * One placed gate.
 *
 * `id` is the editor's handle on the operation: selection, undo and error
 * messages all key on it, so it must be unique within its operation list.
 * `column` is the time coordinate — see the note on `depth()`.
 */
export const OperationSchema = z.strictObject({
  id: z.string().min(1).max(64),
  gate: z.string().min(1).max(64),
  targets: z.array(QubitIndexSchema).min(1).max(MAX_QUBITS),
  controls: z.array(ControlSchema).max(MAX_QUBITS).optional(),
  params: z.array(ParamValueSchema).optional(),
  column: z
    .int()
    .min(0)
    .max(MAX_COLUMNS - 1),
  clbitTargets: z.array(ClbitIndexSchema).max(MAX_CLBITS).optional(),
  condition: ConditionSchema.optional(),
})

/**
 * A reusable subcircuit. It has its own qubit numbering, `0..qubits-1`, and
 * no classical register of its own: custom gates are unitary blocks, so a
 * measurement inside one has nowhere to write.
 */
export const CustomGateSchema = z.strictObject({
  qubits: z.int().min(1).max(MAX_QUBITS),
  operations: z.array(OperationSchema),
  symbol: z.string().min(1).max(8).optional(),
})

/**
 * The whole document.
 *
 * `clbits` defaults to 0 because a circuit without a classical register
 * simply omits it, and every consumer would otherwise write `?? 0`.
 * `operations` has no default on purpose: it is the payload, and a document
 * that forgot it is far more likely to be a bug than an empty circuit.
 */
export const CircuitSchema = z.strictObject({
  schemaVersion: z.literal(CIRCUIT_SCHEMA_VERSION),
  qubits: z.int().min(1).max(MAX_QUBITS),
  clbits: z.int().min(0).max(MAX_CLBITS).default(0),
  qubitLabels: z.array(z.string().min(1).max(32)).max(MAX_QUBITS).optional(),
  parameters: z.array(ParameterSchema).optional(),
  operations: z.array(OperationSchema),
  customGates: z.record(IdentifierSchema, CustomGateSchema).optional(),
})

export type ControlSpec = z.infer<typeof ControlSpecSchema>
export type Control = z.infer<typeof ControlSchema>
export type ParamValue = z.infer<typeof ParamValueSchema>
export type Parameter = z.infer<typeof ParameterSchema>
export type Condition = z.infer<typeof ConditionSchema>
export type Operation = z.infer<typeof OperationSchema>
export type CustomGate = z.infer<typeof CustomGateSchema>

/** A parsed circuit: what every consumer downstream of validation works on. */
export type Circuit = z.infer<typeof CircuitSchema>

/**
 * A circuit as it may be *written*. Identical to `Circuit` except that
 * defaulted fields may be omitted — use it to type JSON literals and API
 * request bodies, and `Circuit` for everything after parsing.
 */
export type CircuitInput = z.input<typeof CircuitSchema>
