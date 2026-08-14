/**
 * The circuit runner — work plan M0.4, specification §5.6 item 3.
 *
 * This is the seam where the circuit JSON contract (§6) meets the kernel: it
 * walks a circuit's operations in column order, turns each one into a call
 * into `apply.ts` or `measure.ts`, and returns a result in one of the two
 * execution modes of §5.3.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE CIRCUIT TYPES ARE MIRRORED RATHER THAN IMPORTED.
 *
 * `@qsim/schema` owns the contract, but this package has zero dependencies
 * (§12.3) — that is what lets it run unchanged inside a Web Worker and be
 * extracted to its own repository later. So the shapes it consumes are
 * declared here instead, structurally identical to the schema's. TypeScript is
 * structural, so a `Circuit` produced by `parseCircuit()` is accepted by
 * `run()` with no adapter and no cast, and the first module that imports both
 * (the worker of M0.6) is where any divergence between the two would stop
 * compiling.
 *
 * The runner deliberately does **not** re-validate the circuit —
 * `validateCircuit()` already does that, and duplicating it here would be a
 * second copy of the rules to keep in step. What it does check is the handful
 * of shapes whose violation would otherwise be *silent physics*: a `cx` with
 * no control applies an unconditional X, produces a perfectly normalised
 * state, and nothing downstream would ever mention it. Parameter arity is in
 * that set too, and is enforced one layer down at the `matrixFor` seam, so the
 * count and the finiteness of an angle are checked in a single place.
 *
 * ────────────────────────────────────────────────────────────────────────
 * COLUMNS ARE TIME, AND A COLUMN IS ONE INSTANT.
 *
 * Operations are grouped by `column` and the columns are run in ascending
 * order; gaps are empty instants and cost nothing. Within a column the
 * contract guarantees the operations touch disjoint qubits, so their order in
 * `operations` cannot change the quantum state — gates on disjoint qubits
 * commute.
 *
 * The classical register is the one thing that could break that, so conditions
 * read the register **as it entered the column**, not as it stands mid-column.
 * A measurement's write becomes visible to the next column. Without that rule
 * a circuit that measures into c0 and gates on c0 in the same column would
 * give a different answer depending on the order the editor happened to append
 * the two operations, which is precisely the kind of bug nobody finds.
 *
 * ────────────────────────────────────────────────────────────────────────
 * MODES. `analytic` refuses any circuit containing a `measure` or a condition
 * and returns the final statevector. `trajectories` runs the whole circuit
 * once per shot, each trajectory with its own collapses, and returns the
 * tallied classical register. See the header of `measure.ts` for why these
 * cannot be the same thing. `runTrajectory()` exposes a single trajectory,
 * state and register both, which is what the timeline of M0.8 needs to scrub
 * through a circuit that measures.
 */

import { apply1q, applyControlled, applyISwap, applySwap } from './apply.js'
import type { ControlSpec } from './apply.js'
import { GATE_MATRICES, isOneQubitGateId, matrixFor } from './gates.js'
import {
  MidCircuitMeasurementError,
  analyticMode,
  assertMidCircuitAllowed,
  collapse,
  marginalProbability,
  measureQubit,
  trajectoriesMode,
  type AnalyticResult,
  type ExecutionOptions,
  type RunResult,
  type ShotCounts,
  type TrajectoriesOptions,
} from './measure.js'
import type { Rng } from './rng.js'
import {
  RENORMALIZE_INTERVAL,
  alloc,
  clone,
  renormalize,
  reset as resetToGround,
  type Statevector,
} from './statevector.js'

/* ─────────────────────── the contract, mirrored ─────────────────────── */

/** Run this operation only if classical bit `clbit` reads `equals` (§6). */
export interface ConditionLike {
  readonly clbit: number
  readonly equals: 0 | 1
}

/** A named angle the circuit is currently simulated at. */
export interface ParameterLike {
  readonly name: string
  readonly value: number
}

/**
 * One placed operation. A bare number in `controls` is a positive control, and
 * `params` entries may be literal radians or the name of a `ParameterLike` —
 * both spellings come straight from the contract.
 */
export interface OperationLike {
  readonly id: string
  readonly gate: string
  readonly targets: readonly number[]
  readonly controls?: readonly (number | ControlSpec)[]
  readonly params?: readonly (number | string)[]
  readonly column: number
  readonly clbitTargets?: readonly number[]
  readonly condition?: ConditionLike
}

/**
 * Everything the runner reads out of a circuit. `qubitLabels`, `customGates`
 * and `schemaVersion` are absent because simulation does not use them; a
 * schema `Circuit` carrying those extra fields is still assignable to this.
 */
export interface CircuitLike {
  readonly qubits: number
  readonly clbits?: number
  readonly parameters?: readonly ParameterLike[]
  readonly operations: readonly OperationLike[]
}

/**
 * A circuit the engine cannot execute: an unknown gate, a shape the kernel was
 * never written for, an index outside a register.
 *
 * Carries `operationId` because the editor's only way to show the problem is
 * to highlight the offending gate on the canvas, and a message string is not
 * something a UI can act on.
 */
export class CircuitRunError extends Error {
  readonly operationId: string | undefined

  constructor(message: string, operationId?: string) {
    super(message)
    this.name = 'CircuitRunError'
    this.operationId = operationId
  }
}

/* ──────────────────────────── checkpoints ───────────────────────────── */

/**
 * How many columns apart checkpoints are taken by default.
 *
 * WHY 8. Two costs pull in opposite directions. A checkpoint costs a full copy
 * of the state — `2ⁿ × 16 bytes`, i.e. 16 MB at the 20 qubits the browser can
 * still handle — so checkpointing every column is out of the question. Not
 * checkpointing at all means every edit re-simulates the whole circuit. With
 * an interval of K, an edit costs at most K columns of replay and a circuit of
 * C columns holds C/K copies: at K = 8 a 40-column circuit keeps six copies
 * and an edit anywhere replays at most eight columns, which is under the
 * 150 ms budget the live editor has even at 20 qubits. K is a constructor
 * argument because that trade moves with the register size — a worker running
 * 24 qubits should raise it, a teaching circuit of 6 qubits could lower it to
 * 1 and never notice.
 */
export const DEFAULT_CHECKPOINT_INTERVAL = 8

/**
 * Default ceiling on how many checkpoints one cache keeps. At 20 qubits this
 * is a 128 MB budget; the editor of M0.5 grows circuits without bound, and a
 * cache that grows with them would be the tab's largest allocation by far.
 */
export const DEFAULT_CHECKPOINT_LIMIT = 8

/**
 * A cached state and the column it belongs to.
 *
 * `column` is **the last column already applied**: the state is what the
 * circuit holds once every operation in columns `0..column` has run. That
 * choice is what makes the invalidation rule exact — editing column `c`
 * changes the state after `c` and everything later, and leaves every
 * checkpoint before `c` untouched, so "drop the checkpoints at column ≥ c" is
 * both sufficient and not wasteful.
 */
export interface Checkpoint {
  readonly column: number
  readonly state: Statevector
}

/** Tuning for `createCheckpoints`. */
export interface CheckpointOptions {
  /** Columns between checkpoints. Defaults to `DEFAULT_CHECKPOINT_INTERVAL`. */
  readonly interval?: number
  /** Ceiling on stored copies. Defaults to `DEFAULT_CHECKPOINT_LIMIT`. */
  readonly limit?: number
}

/**
 * The incremental cache of §5.6.3, owned by the caller and passed back in on
 * every run. It is mutable on purpose: the states inside it are megabytes
 * each, so this is a buffer pool, not a value to spread into React state.
 *
 * ANALYTIC ONLY. A trajectory's collapses are random, so a cached mid-circuit
 * state would freeze one particular roll of the dice and bias every shot that
 * resumed from it. `run()` in trajectories mode never reads or writes a cache.
 */
export interface CheckpointCache {
  readonly interval: number
  readonly limit: number
  /** Ascending by column. Replaced wholesale, never mutated in place. */
  entries: readonly Checkpoint[]
  /** Register size the cached states belong to; a change empties the cache. */
  qubits: number
}

/** An empty cache. One per circuit being edited. */
export function createCheckpoints(
  options: CheckpointOptions = {}
): CheckpointCache {
  const interval = options.interval ?? DEFAULT_CHECKPOINT_INTERVAL
  const limit = options.limit ?? DEFAULT_CHECKPOINT_LIMIT
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError(
      `A checkpoint interval must be a positive integer, got ${interval}.`
    )
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `A checkpoint limit must be a positive integer, got ${limit}.`
    )
  }
  return { interval, limit, entries: [], qubits: 0 }
}

/**
 * Drop every checkpoint at column `column` or later — what an edit to that
 * column makes stale. `invalidateFrom(cache, 0)` empties the cache.
 *
 * The editor must call this before resuming, and it must call it with the
 * *earliest* column the edit touched: moving a gate from column 9 to column 3
 * invalidates from 3, and changing the value of a parameter invalidates from
 * the first column that reads it. Getting that wrong does not throw — it
 * silently resumes from a state the edit already contradicted, which is why
 * the tests pin exactly that failure.
 */
export function invalidateFrom(cache: CheckpointCache, column: number): void {
  cache.entries = cache.entries.filter((entry) => entry.column < column)
}

/** Which columns the cache currently holds, ascending. For UI and tests. */
export function checkpointColumns(cache: CheckpointCache): number[] {
  return cache.entries.map((entry) => entry.column)
}

/* ────────────────────────────── running ─────────────────────────────── */

/** One trajectory: the state it ended in and the bits it wrote. */
export interface TrajectoryRun {
  readonly state: Statevector
  /** One entry per classical bit, indexed by clbit number. */
  readonly register: Uint8Array
}

/**
 * Run a whole circuit from |0…0⟩.
 *
 * `checkpoints` is optional and only used in analytic mode; passing it **resets**
 * the cache and repopulates it for this circuit, so the next edit can resume
 * through `runFrom()`. The reset is not housekeeping: a full run starts at
 * |0…0⟩ and reads nothing, so afterwards every entry in the cache must be a
 * state *this* circuit reaches. Keeping the entries of a previous circuit that
 * this one does not happen to overwrite — the ordinary case of deleting a tail
 * or moving a gate to another wire — would leave `runFrom()` and
 * `stateAfterColumn()` resuming from a perfectly normalised state no operation
 * of this circuit ever produced, which nothing downstream can detect.
 */
export function run(
  circuit: CircuitLike,
  options: ExecutionOptions = analyticMode(),
  checkpoints?: CheckpointCache
): RunResult {
  const plan = planColumns(circuit)
  if (options.mode === 'trajectories') {
    return {
      mode: 'trajectories',
      shots: options.shots,
      counts: tallyTrajectories(circuit, plan, options),
    }
  }

  rejectMidCircuit(circuit)
  // After the rejection, so a circuit analytic mode refuses leaves the caller's
  // cache exactly as it found it.
  if (checkpoints !== undefined) resetCache(checkpoints, circuit.qubits)
  const machine = createMachine(circuit)
  const context = createContext(circuit, options, plan.length, checkpoints)
  evolve(machine, plan, 0, plan.length, context)
  return { mode: 'analytic', state: machine.state }
}

/**
 * Re-simulate after an edit at `fromColumn`, resuming from the latest
 * checkpoint that is still valid instead of starting over. The result is the
 * same final state `run()` would produce; only the work differs.
 *
 * Call `invalidateFrom(checkpoints, fromColumn)` first. This function cannot
 * do it for you: it has no way to know which column changed, and doing it
 * defensively here would throw away the checkpoint the *next* edit needs.
 */
export function runFrom(
  checkpoints: CheckpointCache,
  circuit: CircuitLike,
  fromColumn: number
): AnalyticResult {
  const plan = planColumns(circuit)
  const { machine, start } = resume(checkpoints, circuit, plan, fromColumn)
  const options = analyticMode()
  const context = createContext(circuit, options, plan.length, checkpoints)
  evolve(machine, plan, start, plan.length, context)
  return { mode: 'analytic', state: machine.state }
}

/**
 * The state once every column up to and including `column` has run — the
 * primitive the timeline scrubber of M0.8 steps through.
 *
 * It uses and extends the same cache, so scrubbing forward costs one column
 * per step once the checkpoints are warm rather than a full re-simulation per
 * position. The returned state is the caller's own copy; nothing in the cache
 * aliases it.
 */
export function stateAfterColumn(
  checkpoints: CheckpointCache,
  circuit: CircuitLike,
  column: number
): Statevector {
  const plan = planColumns(circuit)
  let through = 0
  while (through < plan.length && plan[through].column <= column) through++

  // `column + 1` because a checkpoint *at* `column` is exactly the answer.
  const { machine, start } = resume(checkpoints, circuit, plan, column + 1)
  const options = analyticMode()
  const context = createContext(circuit, options, plan.length, checkpoints)
  evolve(machine, plan, start, through, context)
  return machine.state
}

/**
 * One independent trajectory: collapses drawn from `rng`, classical register
 * filled in as the circuit measures.
 *
 * This is what `run()` repeats once per shot, exposed because a single
 * trajectory is the only meaningful "final state" a measuring circuit has —
 * the scrubber and any per-shot inspection need it, and tallying counts would
 * throw it away.
 */
export function runTrajectory(circuit: CircuitLike, rng: Rng): TrajectoryRun {
  const plan = planColumns(circuit)
  const options = trajectoriesMode(1, rng)
  const machine = createMachine(circuit)
  const context = createContext(circuit, options, plan.length, undefined)
  evolve(machine, plan, 0, plan.length, context)
  return { state: machine.state, register: machine.register }
}

/**
 * A classical register as a bitstring, highest clbit first — the same reading
 * order `formatKet` uses for basis states, so a histogram of counts and a
 * table of amplitudes are never printed back to front from one another.
 */
export function formatRegister(register: Uint8Array): string {
  let out = ''
  for (let clbit = register.length - 1; clbit >= 0; clbit--) {
    out += register[clbit]
  }
  return out
}

/* ─────────────────────────── the machinery ──────────────────────────── */

/**
 * How close to 0 or 1 a marginal has to be for a `reset` to count as
 * deterministic. Below this the discarded branch is float noise from D6's
 * drift, not physics: the tolerance for the whole engine is 1e-10, so anything
 * this small was never a real amplitude.
 */
const CERTAINTY_TOLERANCE = 1e-12

const NO_CONTROLS: readonly ControlSpec[] = []
const NO_PARAMS: readonly number[] = []
const NO_PARAMETERS: readonly ParameterLike[] = []

/** The operations of one instant, plus the column number they carry. */
interface PlannedColumn {
  readonly column: number
  readonly operations: readonly OperationLike[]
}

/** The mutable state of a run in progress. */
interface Machine {
  readonly state: Statevector
  readonly register: Uint8Array
  /** The register as it entered the current column — see the header. */
  readonly snapshot: Uint8Array
  /** Gates applied since the last renormalisation (decision D6). */
  gates: number
}

/** Everything a single operation needs that is not the operation itself. */
interface RunContext {
  readonly options: ExecutionOptions
  readonly parameters: readonly ParameterLike[]
  readonly clbits: number
  readonly checkpoints: CheckpointCache | undefined
  /** Number of planned columns, for the end-anchored checkpoint below. */
  readonly columns: number
}

function clbitCount(circuit: CircuitLike): number {
  return circuit.clbits ?? 0
}

function createMachine(circuit: CircuitLike, state?: Statevector): Machine {
  const clbits = clbitCount(circuit)
  return {
    state: state ?? alloc(circuit.qubits),
    register: new Uint8Array(clbits),
    snapshot: new Uint8Array(clbits),
    gates: 0,
  }
}

function createContext(
  circuit: CircuitLike,
  options: ExecutionOptions,
  columns: number,
  checkpoints: CheckpointCache | undefined
): RunContext {
  return {
    options,
    parameters: circuit.parameters ?? NO_PARAMETERS,
    clbits: clbitCount(circuit),
    checkpoints,
    columns,
  }
}

/**
 * Group operations by column, ascending. Rebuilt on every run rather than
 * cached: it is O(operations log operations) against the O(2ⁿ) of a single
 * gate, so at any size where the plan would matter the state already dominates
 * it by orders of magnitude — and a stale plan after an edit would be a
 * correctness bug rather than a slow one.
 */
function planColumns(circuit: CircuitLike): PlannedColumn[] {
  const byColumn = new Map<number, OperationLike[]>()
  for (const operation of circuit.operations) {
    const bucket = byColumn.get(operation.column)
    if (bucket === undefined) byColumn.set(operation.column, [operation])
    else bucket.push(operation)
  }
  return [...byColumn.keys()]
    .sort((a, b) => a - b)
    .map((column) => ({ column, operations: byColumn.get(column) ?? [] }))
}

/**
 * Reject a circuit analytic mode cannot honour, before allocating anything.
 *
 * The check is a whole-circuit scan rather than a test at the operation, so
 * the error arrives immediately instead of after 30 columns of work, and so a
 * partial run (`stateAfterColumn`) refuses a circuit whose measurement sits
 * beyond the column it was asked for. Half an answer to a question with no
 * answer is worse than the error.
 */
function rejectMidCircuit(circuit: CircuitLike): void {
  for (const operation of circuit.operations) {
    if (operation.gate === 'measure') {
      throw new MidCircuitMeasurementError(
        `operation "${operation.id}", a measurement in column ${operation.column}`
      )
    }
    if (operation.condition !== undefined) {
      throw new MidCircuitMeasurementError(
        `operation "${operation.id}" in column ${operation.column}, which is ` +
          `conditioned on classical bit ${operation.condition.clbit}`
      )
    }
  }
}

/** Start a resumed run: the machine to run in, and where in the plan to go on. */
function resume(
  cache: CheckpointCache,
  circuit: CircuitLike,
  plan: readonly PlannedColumn[],
  boundary: number
): { machine: Machine; start: number } {
  rejectMidCircuit(circuit)
  prepareCache(cache, circuit.qubits)

  let checkpoint: Checkpoint | undefined
  for (const entry of cache.entries) {
    if (entry.column >= boundary) break
    checkpoint = entry
  }
  if (checkpoint === undefined) {
    return { machine: createMachine(circuit), start: 0 }
  }

  // The cached state is cloned, never handed out or run on: a caller keeping
  // the result of one run must not be able to corrupt the cache with it.
  const machine = createMachine(circuit, clone(checkpoint.state))
  let start = 0
  while (start < plan.length && plan[start].column <= checkpoint.column) start++
  return { machine, start }
}

/**
 * A cache built for a different register holds nothing usable.
 *
 * This is the guard a *resume* needs: it keeps the entries of the same register
 * because resuming from them is the whole point. A full run needs the stronger
 * `resetCache` — see `run()`.
 */
function prepareCache(cache: CheckpointCache, qubits: number): void {
  if (cache.qubits === qubits) return
  cache.entries = []
  cache.qubits = qubits
}

/**
 * Hand the cache to a full run: it now describes that circuit and nothing else.
 *
 * Discarding costs nothing. For a fixed circuit the columns `run()` checkpoints
 * are determined by the plan, and the entries any partial call could have left
 * for that same circuit are a subset of them — same plan, same alignment, same
 * end anchor — so everything dropped here is re-recorded by the run that
 * follows.
 */
function resetCache(cache: CheckpointCache, qubits: number): void {
  cache.entries = []
  cache.qubits = qubits
}

function evolve(
  machine: Machine,
  plan: readonly PlannedColumn[],
  from: number,
  through: number,
  context: RunContext
): void {
  for (let index = from; index < through; index++) {
    const planned = plan[index]
    machine.snapshot.set(machine.register)
    for (const operation of planned.operations) {
      applyOperation(machine, operation, context)
    }
    recordCheckpoint(context, index, planned.column, machine.state)
  }
}

/**
 * Store a copy of the state if this column is a checkpoint column.
 *
 * Two placements, and the second one is the interesting one:
 *
 *  - every `interval` columns, which bounds the replay cost of an edit
 *    anywhere in the circuit;
 *  - at the second-to-last column, because the edit a live editor sees most
 *    often by far is at the end — you place a gate and immediately drag its
 *    parameter. Invalidation correctly drops the checkpoint at the edited
 *    column, so without this anchor that most common edit would replay a full
 *    interval every time instead of a single column.
 */
function recordCheckpoint(
  context: RunContext,
  index: number,
  column: number,
  state: Statevector
): void {
  const cache = context.checkpoints
  if (cache === undefined) return
  const aligned = (index + 1) % cache.interval === 0
  const anchored = index === context.columns - 2
  if (!aligned && !anchored) return

  const kept = cache.entries.filter((entry) => entry.column !== column)
  const at = kept.findIndex((entry) => entry.column > column)
  const entry: Checkpoint = { column, state: clone(state) }
  const entries =
    at === -1
      ? [...kept, entry]
      : [...kept.slice(0, at), entry, ...kept.slice(at)]
  cache.entries = thin(entries, cache.limit)
}

/**
 * Halve an overfull cache by dropping every second checkpoint, keeping the
 * last one.
 *
 * Halving rather than evicting the oldest: the checkpoints are a ruler laid
 * along the circuit, and dropping one end of it would leave the beginning with
 * no coverage at all. What survives is the same ruler at twice the spacing,
 * which is exactly the trade a smaller memory budget buys. The last entry is
 * kept unconditionally because it is the end anchor above.
 *
 * Halving alone cannot honour a limit of 1, and iterating it does not help:
 * index 0 always satisfies the stride and the last index is always kept, so it
 * is stationary at two entries — double the copies a caller asked for, which at
 * the 24 qubits that make a limit of 1 worth asking for is 256 MB over budget.
 * Hence the trim from the front afterwards, leaving just the end anchor.
 */
function thin(
  entries: readonly Checkpoint[],
  limit: number
): readonly Checkpoint[] {
  if (entries.length <= limit) return entries
  const last = entries.length - 1
  const halved = entries.filter((_, index) => index % 2 === 0 || index === last)
  return halved.length <= limit ? halved : halved.slice(halved.length - limit)
}

function applyOperation(
  machine: Machine,
  operation: OperationLike,
  context: RunContext
): void {
  if (!passesCondition(machine, operation, context)) return

  switch (operation.gate) {
    case 'barrier':
      // A barrier is an instruction to a compiler, not to the state. It still
      // occupies its column, so the columns around it keep their order and
      // their checkpoints — it is a no-op, not an absence.
      return
    case 'reset':
      resetQubit(machine, operation, context)
      return
    case 'measure':
      measureInto(machine, operation, context)
      return
    default:
      applyUnitary(machine, operation, context)
  }
}

function passesCondition(
  machine: Machine,
  operation: OperationLike,
  context: RunContext
): boolean {
  const condition = operation.condition
  if (condition === undefined) return true
  requireTrajectories(
    context,
    `operation "${operation.id}", which is conditioned on classical bit ` +
      `${condition.clbit}`
  )
  checkClbit(operation, condition.clbit, context, 'is conditioned on')
  return machine.snapshot[condition.clbit] === condition.equals
}

function applyUnitary(
  machine: Machine,
  operation: OperationLike,
  context: RunContext
): void {
  const state = machine.state
  const gate = operation.gate
  const controls = controlsOf(operation)

  if (isOneQubitGateId(gate)) {
    // The identity is a placeholder in the editor, and running it through the
    // kernel would be 2ⁿ reads and writes to change nothing. Controls cannot
    // make it do something either.
    if (gate === 'i') return
    const [target] = requireTargets(operation, 1)
    const matrix = matrixFor(gate, resolveParams(operation, context))
    applyControlled(state, matrix, target, controls)
    countGate(machine)
    return
  }

  switch (gate) {
    // `cx`, `cz`, `ccx`, `crz` and `cp` are stored as a one-qubit gate plus
    // controls (`GATES.cx.controlCount === 1`), so they reach the state
    // through the same controlled walk. Materialising a 4×4 for them is what
    // §5.2 forbids.
    case 'cx':
    case 'ccx': {
      const [target] = requireTargets(operation, 1)
      requireControls(operation, controls, gate === 'ccx' ? 2 : 1)
      applyControlled(state, GATE_MATRICES.x, target, controls)
      break
    }
    case 'cz': {
      const [target] = requireTargets(operation, 1)
      requireControls(operation, controls, 1)
      applyControlled(state, GATE_MATRICES.z, target, controls)
      break
    }
    case 'crz':
    case 'cp': {
      const [target] = requireTargets(operation, 1)
      requireControls(operation, controls, 1)
      const params = resolveParams(operation, context)
      // Via `matrixFor` rather than `rzMatrix`/`pMatrix` directly, so the
      // parameter count and finiteness are checked in one place.
      const matrix = matrixFor(gate === 'crz' ? 'rz' : 'p', params)
      applyControlled(state, matrix, target, controls)
      break
    }
    case 'swap':
    case 'cswap': {
      const [first, second] = requireTargets(operation, 2)
      requireControls(operation, controls, gate === 'cswap' ? 1 : 0)
      applySwap(state, first, second, controls)
      break
    }
    case 'iswap': {
      const [first, second] = requireTargets(operation, 2)
      requireControls(operation, controls, 0)
      applyISwap(state, first, second)
      break
    }
    default:
      throw new CircuitRunError(
        `Operation "${operation.id}" uses gate "${gate}", which the engine ` +
          `does not know. Custom gates are not expanded yet, so a circuit ` +
          `that uses one cannot be simulated.`,
        operation.id
      )
  }
  countGate(machine)
}

/**
 * Reset to |0⟩ — measure and flip if the answer was 1.
 *
 * That is genuinely random in general, so a reset in the middle of a
 * superposition needs trajectories mode for the same reason a measurement
 * does. The two deterministic cases are let through, because they are the
 * common ones: resetting a qubit that is already |0⟩ (the idiom for "start
 * here") or one that is certainly |1⟩ costs no randomness at all, and
 * rejecting them would make analytic mode refuse circuits that have no
 * ambiguity in them.
 */
function resetQubit(
  machine: Machine,
  operation: OperationLike,
  context: RunContext
): void {
  const [target] = requireTargets(operation, 1)
  const state = machine.state
  const probabilityOfOne = marginalProbability(state, target)

  if (probabilityOfOne <= CERTAINTY_TOLERANCE) {
    // Already |0⟩ to within D6's drift; collapse only clears the residue.
    collapse(state, target, 0)
    return
  }
  if (probabilityOfOne >= 1 - CERTAINTY_TOLERANCE) {
    collapse(state, target, 1)
    apply1q(state, GATE_MATRICES.x, target)
    return
  }

  const options = requireTrajectories(
    context,
    `operation "${operation.id}", a reset of qubit ${target} that is in ` +
      `superposition`
  )
  if (measureQubit(state, target, options.rng) === 1) {
    apply1q(state, GATE_MATRICES.x, target)
  }
}

function measureInto(
  machine: Machine,
  operation: OperationLike,
  context: RunContext
): void {
  const [target] = requireTargets(operation, 1)
  const clbits = operation.clbitTargets ?? []
  if (clbits.length !== 1) {
    throw new CircuitRunError(
      `Operation "${operation.id}" measures qubit ${target} into ` +
        `${clbits.length} classical bit(s); a measurement writes exactly one.`,
      operation.id
    )
  }
  const clbit = clbits[0]
  checkClbit(operation, clbit, context, 'writes to')

  const options = requireTrajectories(
    context,
    `operation "${operation.id}", a measurement in column ${operation.column}`
  )
  machine.register[clbit] = measureQubit(machine.state, target, options.rng)
}

/**
 * D6: every gate is unitary in exact arithmetic and drifts by about an ulp in
 * Float64, so the norm is restored on a fixed interval instead of after every
 * gate — two extra passes over 2ⁿ amplitudes every 64 gates rather than every
 * one.
 *
 * The counter restarts at a resumed run, so an incremental re-simulation
 * renormalises at different points than a full one. The difference is the
 * order of the last bits of the mantissa, orders of magnitude below the 1e-12
 * the incremental tests demand.
 */
function countGate(machine: Machine): void {
  machine.gates++
  if (machine.gates < RENORMALIZE_INTERVAL) return
  renormalize(machine.state)
  machine.gates = 0
}

/**
 * Repeat the whole circuit once per shot and tally the classical register.
 *
 * One machine is allocated and returned to |0…0⟩ between shots: at 20 qubits a
 * fresh pair of arrays per shot would be 16 MB of garbage per trajectory, and
 * `reset()` reuses the buffers for the same result.
 */
function tallyTrajectories(
  circuit: CircuitLike,
  plan: readonly PlannedColumn[],
  options: TrajectoriesOptions
): ShotCounts {
  if (clbitCount(circuit) === 0) {
    throw new CircuitRunError(
      `A trajectories run reports counts of the classical register, and this ` +
        `circuit declares no classical bits. Add a measurement writing to a ` +
        `clbit, or run in analytic mode and sample the final state with ` +
        `sampleShots().`
    )
  }

  const machine = createMachine(circuit)
  const context = createContext(circuit, options, plan.length, undefined)
  const tally = new Map<string, number>()
  for (let shot = 0; shot < options.shots; shot++) {
    resetToGround(machine.state)
    machine.register.fill(0)
    machine.gates = 0
    evolve(machine, plan, 0, plan.length, context)
    const label = formatRegister(machine.register)
    tally.set(label, (tally.get(label) ?? 0) + 1)
  }

  // No sort: a plain object hoists "10" in front of "00" whatever the insertion
  // order, so sorting here would be dead work dressed up as a guarantee. See
  // `ShotCounts` in `measure.ts`; `orderedCounts()` is the display contract.
  const counts: Record<string, number> = {}
  for (const [label, count] of tally) {
    counts[label] = count
  }
  return counts
}

/**
 * The trajectories options, once the mode has been checked. The assertion
 * narrows, so the RNG an operation needs is only reachable by passing the
 * check — see `assertMidCircuitAllowed` in `measure.ts`.
 */
function requireTrajectories(
  context: RunContext,
  description: string
): TrajectoriesOptions {
  const options = context.options
  assertMidCircuitAllowed(options, description)
  return options
}

/** A bare number in `controls` means a positive control (§6). */
function controlsOf(operation: OperationLike): readonly ControlSpec[] {
  const controls = operation.controls
  if (controls === undefined || controls.length === 0) return NO_CONTROLS
  return controls.map((control) =>
    typeof control === 'number' ? { qubit: control, state: 1 } : control
  )
}

/**
 * Parameters as plain numbers, resolving symbolic references against the
 * circuit's `parameters` — the last step before a gate becomes a matrix.
 */
function resolveParams(
  operation: OperationLike,
  context: RunContext
): readonly number[] {
  const params = operation.params
  if (params === undefined || params.length === 0) return NO_PARAMS
  return params.map((param) => {
    if (typeof param === 'number') return param
    const declared = context.parameters.find(
      (candidate) => candidate.name === param
    )
    if (declared === undefined) {
      throw new CircuitRunError(
        `Operation "${operation.id}" references parameter "${param}", which ` +
          `the circuit does not declare.`,
        operation.id
      )
    }
    return declared.value
  })
}

function requireTargets(
  operation: OperationLike,
  expected: number
): readonly number[] {
  if (operation.targets.length !== expected) {
    throw new CircuitRunError(
      `Operation "${operation.id}" applies "${operation.gate}" to ` +
        `${operation.targets.length} target qubit(s); that gate takes ` +
        `${expected}.`,
      operation.id
    )
  }
  return operation.targets
}

/**
 * A controlled gate that arrives without its controls is the dangerous shape:
 * the kernel would happily apply the bare gate to every index, and the result
 * is a normalised state that is simply not the circuit the user drew.
 */
function requireControls(
  operation: OperationLike,
  controls: readonly ControlSpec[],
  expected: number
): void {
  if (controls.length !== expected) {
    throw new CircuitRunError(
      `Operation "${operation.id}" gives "${operation.gate}" ` +
        `${controls.length} control(s); that gate takes exactly ${expected}.`,
      operation.id
    )
  }
}

function checkClbit(
  operation: OperationLike,
  clbit: number,
  context: RunContext,
  role: string
): void {
  if (!Number.isInteger(clbit) || clbit < 0 || clbit >= context.clbits) {
    throw new CircuitRunError(
      `Operation "${operation.id}" ${role} classical bit ${clbit}, but the ` +
        `circuit has ${context.clbits} classical bit(s).`,
      operation.id
    )
  }
}
