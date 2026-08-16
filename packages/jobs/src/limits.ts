/**
 * What the server will run, how long it may take, and who waits for it.
 *
 * Two questions live here and they are not the same question:
 *
 *   1. **May this run at all?** — §11's resource limits. A server simulation
 *      is a stranger handing you arbitrary work to execute, so qubits, gates,
 *      shots and wall-clock are all bounded, and the bound is checked before
 *      a byte is allocated.
 *   2. **Does the caller wait for it, or get a run id?** — §8's "síncrono si
 *      es chico, encolado si es grande".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE SECOND THRESHOLD COMES FROM, AND WHY IT IS NOT A ROUND NUMBER
 *
 * §4 calls two-level simulation the most important decision in the project:
 * the browser runs everything it can, and the server exists for a circuit past
 * the client ceiling, for an authoritative run, and for hardware. That
 * sentence *is* the threshold, read backwards.
 *
 * The browser already runs a statevector to twenty qubits and a density matrix
 * to twelve (`MAX_CLIENT_QUBITS` and `MAX_DENSITY_CLIENT_QUBITS` in
 * `apps/web`; the second is the engine's own `MAX_DENSITY_QUBITS`). So a
 * request that arrives here *below* those ceilings did not arrive because it
 * was too big — it arrived because it has to be authoritative, or because the
 * caller is a script with no Web Worker. Work of that size is work a laptop
 * tab finishes while someone is still looking at it, and making its caller
 * poll would add two round trips to something that takes less time than one.
 *
 * Above the ceiling the argument inverts, and sharply. The smallest circuit
 * that can legitimately be here is twenty-one qubits: two million amplitudes,
 * thirty-two megabytes, and a couple of hundred million kernel operations for
 * an ordinary circuit — seconds, not milliseconds. Holding an HTTP connection
 * open for that is how a platform gateway times out at thirty seconds and the
 * client is left unable to tell "slow" from "lost", with the work still
 * running and nothing to name it by. So past the ceiling the answer is a run
 * id, always, even when the machine happens to be fast today.
 *
 * The ceiling is per mode because the browser's is: twelve for ρ, twenty for
 * everything else. A round number shared by both would either refuse
 * thirteen-qubit density work the server exists to take, or promise a
 * synchronous answer for a 4ⁿ evolution.
 *
 * ── The second half of the threshold, which is time and not size ──────────
 *
 * Register size alone is not enough, because a *sampled* run's cost is linear
 * in its shots: a twelve-qubit trajectories run with a hundred thousand shots
 * is small by every register measure and takes minutes. So "immediate" also
 * requires that the estimated work fit the window the caller is actually going
 * to wait — `workBudgetFor(syncWaitMs)`. Anything else is queued from the
 * start, which is honest, rather than waited on and then abandoned, which
 * looks like a failure.
 */

import { MAX_DENSITY_QUBITS, MAX_QUBITS } from '@qsim/core'
import { MAX_COLUMNS } from '@qsim/schema'
import { isSampledMode, type SimulationMode } from './run.js'

/* ─────────────────────────── the client ceilings ────────────────────── */

/**
 * The browser's statevector ceiling, restated.
 *
 * A restatement and not an import: `apps/web` owns the browser's copy and
 * `apps/api`/`apps/worker` may not import an app (§12.3). The number is 20
 * because a 20-qubit state is 16 MB and a tab holds several of them at once
 * (the checkpoint cache), which is the argument written at `MAX_CLIENT_QUBITS`
 * — this file only needs to know *that* it is 20, and `clientCeilingsAgree`
 * below is what a consumer holding both copies asserts with.
 *
 * `Math.min` with the engine's own ceiling for the same reason the browser
 * takes it: this limit may only ever get stricter than the engine's, never
 * looser, whatever either is tuned to later.
 */
export const CLIENT_STATEVECTOR_QUBITS = Math.min(20, MAX_QUBITS)

/**
 * The browser's ρ ceiling, which is the engine's ρ ceiling.
 *
 * Not a second number: at twelve qubits ρ is 256 MB, and that is a fact about
 * 4ⁿ rather than about a browser, so the client and the server refuse at the
 * same place and `@qsim/core` is where it is decided.
 */
export const CLIENT_DENSITY_QUBITS = MAX_DENSITY_QUBITS

/** The register size above which this mode is past what a browser can do. */
export function clientCeilingFor(mode: SimulationMode): number {
  return mode === 'DENSITY_MATRIX'
    ? CLIENT_DENSITY_QUBITS
    : CLIENT_STATEVECTOR_QUBITS
}

/**
 * Whether a consumer's own copy of the browser ceiling matches this one.
 *
 * Exists so the drift is detectable at all. Nothing here can import
 * `apps/web`, so the only defence against the two numbers parting company is a
 * consumer that holds both and says so — which is what `apps/api`'s contract
 * test does, in the same shape as its `Visibility` assertion.
 */
export function clientCeilingsAgree(
  statevectorQubits: number,
  densityQubits: number
): boolean {
  return (
    statevectorQubits === CLIENT_STATEVECTOR_QUBITS &&
    densityQubits === CLIENT_DENSITY_QUBITS
  )
}

/* ─────────────────────────── the server ceilings ────────────────────── */

/**
 * Largest register the server will evolve, by default.
 *
 * §5.1's table is the whole argument: 24 qubits is 256 MB of amplitudes and 28
 * is 4 GB. Twenty-eight is the *arithmetic* ceiling — it is what the index
 * type and the engine's `MAX_QUBITS` allow — and it is not a promise anybody
 * can keep on a container with a gigabyte of RAM. 256 MB is also exactly the
 * budget `@qsim/core` already applies to a density matrix
 * (`DENSITY_BUDGET_BYTES`), so taking the same number for a statevector is one
 * decision applied twice rather than two decisions.
 *
 * Configurable upwards on a machine that has the memory, and clamped to
 * `MAX_QUBITS` by `serverCeilingFor` so configuration cannot exceed the engine.
 */
export const DEFAULT_SERVER_QUBITS = 24

/**
 * Most operations a server circuit may carry.
 *
 * `@qsim/schema` bounds a circuit at 28 qubits and `MAX_COLUMNS` columns, and
 * a full one is around 114 000 operations — a bound on *the document*, sized
 * so the editor cannot produce something the parser chokes on. It says nothing
 * about the cost of running it, which is why the work budget below exists. This
 * is the cheap gate in front of that: an integer comparison that refuses a
 * pathological circuit before the work estimate has to multiply by 2ⁿ.
 */
export const MAX_SERVER_OPERATIONS = 4 * MAX_COLUMNS

/**
 * The shot range, restated from §3.2 and from the browser's own protocol.
 *
 * Same range on both sides deliberately: a run that a user could have taken in
 * the tab and chose to send to the server must not silently mean something
 * different, and a histogram of a hundred thousand draws is already
 * indistinguishable from the exact distribution printed beside it.
 */
export const MIN_SHOTS = 1
export const MAX_SHOTS = 100_000

/** A shot count the engine will accept, whatever it was handed. */
export function clampShots(shots: number): number {
  if (!Number.isFinite(shots)) return MIN_SHOTS
  return Math.min(MAX_SHOTS, Math.max(MIN_SHOTS, Math.round(shots)))
}

/**
 * The register ceiling actually applied, given whatever the operator
 * configured.
 *
 * ρ is clamped to the engine's own ceiling rather than to the configured one,
 * because 4ⁿ does not become affordable by being asked nicely: a thirteen-qubit
 * ρ is a gigabyte whatever `WORKER_MAX_QUBITS` says.
 */
export function serverCeilingFor(
  mode: SimulationMode,
  configuredQubits: number = DEFAULT_SERVER_QUBITS
): number {
  if (mode === 'DENSITY_MATRIX') return MAX_DENSITY_QUBITS
  return Math.min(configuredQubits, MAX_QUBITS)
}

/* ──────────────────────────── the cost model ────────────────────────── */

/**
 * What a run costs, in units of "one kernel pass over one amplitude".
 *
 * The three modes have genuinely different exponents and the model says so
 * rather than folding them into one constant:
 *
 *   STATEVECTOR     `operations × 2ⁿ`. One in-place pass per gate (§5.2).
 *   TRAJECTORIES    `shots × operations × 2ⁿ`. Every shot restarts at |0…0⟩
 *                   and walks the whole circuit — exactly the model
 *                   `trajectoryWork` uses in the browser, and for the same
 *                   reason: `runNoisy` and `run(…, trajectoriesMode)` make it
 *                   true by construction rather than by fit.
 *   DENSITY_MATRIX  `operations × 4ⁿ`. ρ has 4ⁿ entries and a gate touches all
 *                   of them, twice over for ρ → UρU†; the channel applications
 *                   are a bounded multiple folded into the unit cost.
 *
 * The operation count floors at one so an empty circuit still costs its
 * allocation, which is the one case where under-estimating is easiest.
 */
export function simulationWork(input: {
  mode: SimulationMode
  qubits: number
  operations: number
  shots: number | null
}): number {
  const operations = Math.max(1, input.operations)
  if (input.mode === 'DENSITY_MATRIX') return operations * 4 ** input.qubits
  const perShot = operations * 2 ** input.qubits
  if (!isSampledMode(input.mode)) return perShot
  return Math.max(1, input.shots ?? 1) * perShot
}

/**
 * Milliseconds one work unit costs, per mode, on the reference machine.
 *
 * DERIVED FROM A MEASUREMENT, NOT PREFERRED. `apps/web`'s protocol records the
 * sampled-noise figure from three runs spanning three orders of magnitude of
 * work — 3.5, 3.6 and 4.8 ·10⁻⁵ ms per unit at 13, 16 and 20 qubits, flat to
 * within a factor of 1.4 — and 5·10⁻⁵ is the round number above all three.
 * That path does considerably more per unit than a bare gate: a sampled Kraus
 * operator per channel per wire, plus the draw itself, which is where the order
 * of magnitude between the two rows below comes from.
 *
 * The statevector figure is the one that decides most admissions, so it is not
 * left as an inference: `simulate.perf.test.ts` in `apps/worker` measures it
 * and fails if the real cost is more than a small multiple of this. A cost
 * model that has quietly drifted is worse than none, because it refuses
 * cheap work and admits expensive work with equal confidence.
 */
export const UNIT_COST_MS: Record<SimulationMode, number> = {
  STATEVECTOR: 5e-6,
  TRAJECTORIES: 5e-5,
  DENSITY_MATRIX: 5e-6,
}

/** Estimated wall-clock for a run, in milliseconds. */
export function estimatedDurationMs(input: {
  mode: SimulationMode
  qubits: number
  operations: number
  shots: number | null
}): number {
  return simulationWork(input) * UNIT_COST_MS[input.mode]
}

/**
 * The work that fits in a window, with the headroom the browser's budget uses.
 *
 * Targeting *half* the window leaves a machine twice as slow as the reference
 * still inside it — the same discipline as `TRAJECTORY_WORK_BUDGET`, and the
 * same reason: the unit costs above are measurements of one machine, and a
 * shared container is not that machine.
 */
export function workBudgetFor(windowMs: number, mode: SimulationMode): number {
  return windowMs / 2 / UNIT_COST_MS[mode]
}

/* ─────────────────────────── the wall-clock bound ───────────────────── */

/**
 * How long a queued job may run before it is killed.
 *
 * A minute is long enough for the largest register this server accepts to
 * finish an ordinary circuit and short enough that a mistaken admission costs
 * one minute of one child rather than an afternoon of the queue. It is a
 * *hard* bound and not a hint: `apps/worker` runs the simulation in a child
 * process precisely so that this timer has something it can act on — see the
 * argument in that app's `pool.ts`, which is the crux of the whole milestone.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 60_000

/**
 * How long `POST /simulate` will hold a request open waiting for a small run.
 *
 * Two seconds, and the number is bounded from both directions. Below it lies
 * the round trip itself — a client on mobile data spends a few hundred
 * milliseconds before the request even arrives, so a window much shorter than
 * this would return a run id for work that had already finished. Above it lies
 * the platform: Railway's edge and every reverse proxy in front of it have
 * their own idle timeouts, and a request that routinely sits for ten seconds
 * is one deploy away from being cut at the knees with no error the client can
 * distinguish from a crash.
 *
 * It is also the input to `workBudgetFor`, so lengthening the wait genuinely
 * widens what is offered synchronously rather than just making the timeout
 * later.
 */
export const DEFAULT_SYNC_WAIT_MS = 2_000

/* ──────────────────────────────── routing ──────────────────────────── */

export type SimulationRoute = 'immediate' | 'queued'

export interface RouteInput {
  readonly mode: SimulationMode
  readonly qubits: number
  readonly operations: number
  readonly shots: number | null
}

/**
 * Whether the caller waits for this run or receives a run id.
 *
 * Both halves must hold. The register must be one the browser could have
 * handled — that is the §4 argument at the top of this file — *and* the
 * estimated work must fit the window the caller is actually going to wait, so
 * that a small register with a hundred thousand shots is queued rather than
 * waited on and then given up on.
 *
 * Nothing here decides whether the run is *allowed*; `checkLimits` does that,
 * and it runs first. A route is only meaningful for work that will happen.
 */
export function routeOf(
  input: RouteInput,
  syncWaitMs: number = DEFAULT_SYNC_WAIT_MS
): SimulationRoute {
  if (input.qubits > clientCeilingFor(input.mode)) return 'queued'
  if (simulationWork(input) > workBudgetFor(syncWaitMs, input.mode)) {
    return 'queued'
  }
  return 'immediate'
}

/* ──────────────────────────── admission control ─────────────────────── */

/**
 * Why a run was refused before it started.
 *
 * Every code carries the number that was refused and the ceiling it was
 * refused against, because the client has to be able to say which — and to say
 * it in three languages, from a code, with the numbers interpolated (D2). The
 * same discipline as `NoiseRefusal` in the browser's worker protocol.
 */
export const LIMIT_CODES = [
  'too-many-qubits',
  'too-many-operations',
  'too-many-shots',
  'work-budget-exceeded',
] as const

export type LimitCode = (typeof LIMIT_CODES)[number]

export interface LimitRefusal {
  readonly code: LimitCode
  /** The quantity that was refused. */
  readonly value: number
  /** The ceiling it was refused against, in the same unit as `value`. */
  readonly limit: number
}

export interface LimitCeilings {
  /** Largest register, before the per-mode clamp in `serverCeilingFor`. */
  readonly maxQubits?: number
  /** Wall-clock bound the work budget is derived from. */
  readonly timeoutMs?: number
}

/**
 * §11's resource limits, applied in one place and before anything is
 * allocated.
 *
 * Order matters and is cheapest-first: qubits and operations are integer
 * comparisons, and they run before `simulationWork` multiplies anything by
 * 4ⁿ — which, for a register the first check would have refused, is an
 * arithmetic overflow waiting to be interpreted as a small number.
 *
 * Returns the first refusal or `null`. Called by `apps/api` to decide a 413,
 * and again by `apps/worker` before it runs — not because the API is
 * untrusted, but because the queue is: a job in Redis is a job anything with
 * the connection string can add, and the process that spends the CPU is the
 * one that has to be sure.
 */
export function checkLimits(
  input: RouteInput,
  ceilings: LimitCeilings = {}
): LimitRefusal | null {
  const timeoutMs = ceilings.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
  const maxQubits = serverCeilingFor(input.mode, ceilings.maxQubits)

  if (input.qubits > maxQubits) {
    return { code: 'too-many-qubits', value: input.qubits, limit: maxQubits }
  }
  if (input.operations > MAX_SERVER_OPERATIONS) {
    return {
      code: 'too-many-operations',
      value: input.operations,
      limit: MAX_SERVER_OPERATIONS,
    }
  }
  if (input.shots !== null && input.shots > MAX_SHOTS) {
    return { code: 'too-many-shots', value: input.shots, limit: MAX_SHOTS }
  }

  const budget = workBudgetFor(timeoutMs, input.mode)
  const work = simulationWork(input)
  if (work > budget) {
    return {
      code: 'work-budget-exceeded',
      value: Math.round(work),
      limit: Math.round(budget),
    }
  }

  return null
}
