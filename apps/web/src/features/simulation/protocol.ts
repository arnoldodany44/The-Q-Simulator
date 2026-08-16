/**
 * The wire between the editor and the simulation worker — M0.6, §5.6.
 *
 * Both sides import this file and nothing else of each other's, so the
 * protocol is a compile error away from drifting. It carries three things
 * that are worth reading before anything else in this folder:
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERY MESSAGE CARRIES A REQUEST ID, AND IDS ONLY GO UP.
 *
 * A simulation takes long enough that a user can edit twice before the first
 * answer comes back. Without an id, the second answer and the first are
 * indistinguishable, and the editor eventually paints the result of a circuit
 * the user has already changed — the defect that makes an editor feel haunted,
 * and one that is invisible until someone edits fast. With a monotonic id, a
 * stale answer is arithmetic: `response.id !== inFlight` means drop it. The
 * scheduler does exactly that, and its test pins it.
 *
 * The monotonicity is load-bearing on the worker side too: a `cancel` can only
 * ever name a request that was already issued, so the worker collapses the set
 * of cancelled ids into a single watermark.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE STATE TRAVELS AS RAW BUFFERS, TWO WAYS.
 *
 * A 20-qubit state is 16 MB. Structured-cloning that on every edit would copy
 * it twice — once out of the worker and once into the main thread — so the
 * state moves either through a `SharedArrayBuffer` (no copy at all, when the
 * page is cross-origin isolated) or through transferred `ArrayBuffer`s (no
 * copy either, but the worker loses its own view of them). §5.1 chose two
 * parallel `Float64Array` over an array of objects precisely so this is
 * possible.
 *
 * The fallback is not a nicety. COOP/COEP are set for the dev server and must
 * be set on the deployment too, but a deployment that forgets them has to
 * degrade in speed, never break — which is why `encodeState` takes the
 * capability as an argument instead of reading the global, and why both paths
 * are tested.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ERRORS ARE CODES, NOT SENTENCES.
 *
 * Same rule as the circuit store: a worker cannot translate, it has no
 * i18next instance and no idea what language the tab is in. It reports a code
 * plus the numbers a message might interpolate, and `useSimulation` renders it
 * through the `simulation` catalog in all three languages (D2). `detail` is
 * the engine's own English prose — for the console, never for a user.
 */

import {
  MAX_DENSITY_QUBITS,
  MAX_QUBITS,
  type NoiseProfile,
  type ShotCounts,
  type Statevector,
} from '@qsim/core'
import type { Circuit } from '@qsim/schema'

/** Monotonically increasing, minted by the scheduler. Never reused. */
export type RequestId = number

/**
 * Largest register the browser will simulate.
 *
 * 20 qubits is 16 MB of amplitudes, plus as much again for every checkpoint
 * the cache keeps — comfortable in a tab, and the point where §3.1 hands the
 * job to the server. `MAX_QUBITS` is the engine's own ceiling (28, where a
 * state is 4 GB); taking the minimum means this limit can only ever get
 * stricter than the engine's, never looser than it, whatever either side is
 * tuned to later.
 */
export const MAX_CLIENT_QUBITS = Math.min(20, MAX_QUBITS)

/**
 * The shot range §3.2 asks for: 1 to 100 000.
 *
 * The ceiling is a real one rather than a round number. Sampling is O(2ⁿ) to
 * build the cumulative distribution and O(shots · n) to draw from it, so at the
 * 20-qubit ceiling 100 000 shots is two million comparisons on top of an
 * eight-megabyte sweep — tens of milliseconds on the worker, and nothing at all
 * on the main thread. Ten times that would still answer, and it would answer
 * with a distribution indistinguishable from the exact one printed beside it,
 * which is the opposite of what the control is for.
 */
export const MIN_SHOTS = 1
export const MAX_SHOTS = 100_000

/**
 * A shot count the engine will accept, whatever it was handed.
 *
 * Applied on both sides on purpose. The control cannot produce an out-of-range
 * value, but a request can also arrive from a restored URL or a future API, and
 * `sampleShots` answers a fractional or negative count with a `RangeError` —
 * which would reach the user as `worker-failed`, a bug report about a broken
 * simulator for what is really a number out of range.
 */
export function clampShots(shots: number): number {
  if (!Number.isFinite(shots)) return MIN_SHOTS
  return Math.min(MAX_SHOTS, Math.max(MIN_SHOTS, Math.round(shots)))
}

/* ─────────────────────────────── requests ───────────────────────────── */

/**
 * Sample the final state of an analytic run — §3.2's shots control.
 *
 * This is deliberately *not* the trajectories mode below. Trajectories re-run
 * the whole circuit once per shot because a mid-circuit measurement makes each
 * run a different vector (§5.3); sampling draws from one state that already
 * exists and leaves it untouched. So the two answer different questions: this
 * one asks "what would a real device have read, given exactly this state", and
 * it can therefore be shown *beside* the exact distribution rather than instead
 * of it. That comparison is the whole teaching point, and it is only honest
 * because both halves come out of the same run — see `AnalyticResponse`.
 */
export interface SampleSpec {
  /** Within `[MIN_SHOTS, MAX_SHOTS]`. `clampShots` is what guarantees it. */
  readonly shots: number
  /** Seeded, so the same circuit and the same seed give the same counts. */
  readonly seed: number
}

/* ────────────────────────── the noise mode (§3.3) ───────────────────── */

/**
 * How a noisy run is evaluated: by summing over the Kraus operators, or by
 * sampling one of them per gate per shot.
 *
 * The two answer the same question at different prices, and §5.4 says so
 * plainly. `density` evolves ρ and is exact — no shot noise, a fidelity good
 * to every digit printed, and a ρ to draw the heat map from — at 4ⁿ × 16 bytes,
 * which is 256 MB at twelve qubits and four times that per qubit after.
 * `trajectories` keeps one statevector and pays in shots instead: 2ⁿ whatever
 * the shot count, so it is the only mode a noisy eighteen-qubit circuit runs in
 * at all, and its frequencies approach the exact distribution as 1/√shots.
 *
 * The name is on the wire rather than inferred from the register size, because
 * "which method ran" is a fact the panel states to the reader — a fidelity read
 * to four digits off ten thousand shots would be four digits of noise.
 */
export type NoiseMethod = 'density' | 'trajectories'

/** The two methods, as an array first so the union cannot drift from it. */
export const NOISE_METHODS = ['density', 'trajectories'] as const

/**
 * Largest register the browser will build a ρ for.
 *
 * `MAX_DENSITY_QUBITS` is the engine's own ceiling and this takes the minimum
 * with the client's, exactly as `MAX_CLIENT_QUBITS` does with `MAX_QUBITS`: the
 * limit here can only ever get stricter than the engine's, never looser,
 * whatever either side is tuned to later. §3.3 puts the mode at "10 to 12
 * qubits" and calls that fine because it is a study mode rather than a scale
 * mode — so the number is not a disappointment to be hidden, it is a fact the
 * panel prints beside the alternative (`trajectories`, which has no such
 * ceiling).
 */
export const MAX_DENSITY_CLIENT_QUBITS = Math.min(
  MAX_DENSITY_QUBITS,
  MAX_CLIENT_QUBITS
)

/* ─────────────── the sampled method's ceiling, which is time ────────────── */

/**
 * What a sampled noisy run costs, in units of "one kernel pass over one
 * amplitude": `shots × operations × 2ⁿ`.
 *
 * WHY THE ALTERNATIVE NEEDS A CEILING OF ITS OWN. The density method's limit is
 * memory and it is refused at twelve qubits. The refusal offers trajectories,
 * and trajectories really do escape the 4ⁿ — they keep one statevector, 16 MB
 * at the twenty-qubit client ceiling. What they do not escape is *time*:
 * `runNoisy` restarts every shot from |0…0⟩ and walks the whole circuit, so the
 * cost is exactly linear in shots and exactly proportional to 2ⁿ. At twenty
 * qubits and the panel's default two thousand shots that is on the order of an
 * hour, in a worker `simulation.worker.ts` says cannot be pre-empted: no
 * histogram, no amplitude table, no answer to any later edit, for as long as it
 * runs. That is the frozen tab §3.3 forbids, relocated one thread over — and it
 * was reachable in two clicks, because the ceiling's own button switches the
 * method without touching the shot count.
 *
 * The cost model is the one `runNoisy` makes true by construction rather than a
 * fit: one plan walk per shot, one O(2ⁿ) kernel pass per operation, plus a
 * bounded number of channel passes per operation folded into the constant.
 */
export function trajectoryWork(qubits: number, operations: number): number {
  // An empty circuit still resets and samples a 2ⁿ statevector per shot, so the
  // operation count floors at one rather than at zero — otherwise the budget
  // below would divide by zero and offer an unbounded run for the one circuit
  // where the cost is easiest to under-estimate.
  return Math.max(1, operations) * 2 ** qubits
}

/**
 * The work a sampled run may cost, in `trajectoryWork` units.
 *
 * DERIVED, NOT PREFERRED. Measured on the reference machine with the teaching
 * profile, a unit costs about 5·10⁻⁵ ms (13 qubits: 200 shots × 25 operations
 * in 1417 ms; 16 qubits: 200 × 31 in 14 671 ms; 20 qubits: 50 × 39 in 97 128
 * ms — 3.5, 3.6 and 4.8 ·10⁻⁵ respectively, flat to within a factor of 1.4
 * across three orders of magnitude of work). Thirty seconds is the loosest wait
 * under which a live editor is still live, and is the bound
 * `offered-alternative.perf.test.ts` defends. Targeting *half* of it leaves a
 * machine twice as slow as the reference still inside the bound:
 *
 *     15 000 ms ÷ 5·10⁻⁵ ms = 3·10⁸ units.
 */
export const TRAJECTORY_WORK_BUDGET = 3e8

/**
 * The fewest shots at which a sampled distribution is still a reading.
 *
 * A frequency drawn from N shots carries a standard error of 1/(2√N): 5 % at a
 * hundred draws, 11 % at twenty. The teaching profile exists so that a Bell pair
 * *visibly* stops being a Bell pair, which is a change of order ten per cent —
 * so below a hundred shots the sampling error is the size of the effect the
 * mode was opened to show, and the chart would be a picture of its own noise.
 * That is the plausible-and-wrong histogram §3.3 is written against, so a run
 * that cannot afford a hundred shots is refused rather than drawn small.
 */
export const MIN_TRAJECTORY_SHOTS = 100

/**
 * The most shots a sampled run of this size may draw.
 *
 * Falls with 2ⁿ and with the length of the circuit, which is exactly how the
 * cost rises. Clamped into `[MIN_SHOTS, MAX_SHOTS]` at the top so a tiny
 * circuit is bounded by §3.2's range rather than by arithmetic, and the result
 * may legitimately come back *below* `MIN_TRAJECTORY_SHOTS` — that is the
 * signal `trajectoriesFit` turns into a refusal.
 */
export function maxTrajectoryShots(qubits: number, operations: number): number {
  const affordable = Math.floor(
    TRAJECTORY_WORK_BUDGET / trajectoryWork(qubits, operations)
  )
  return Math.min(MAX_SHOTS, Math.max(MIN_SHOTS, affordable))
}

/**
 * Whether a sampled run of this size can still say anything — the trajectories
 * counterpart of `densityFits`.
 *
 * Asked before anything is dispatched, on both sides of the thread boundary, for
 * the reason the density ceiling is asked twice: the panel's copy decides what
 * to offer a reader, and the worker's is the side that would spend the minutes.
 */
export function trajectoriesFit(qubits: number, operations: number): boolean {
  return maxTrajectoryShots(qubits, operations) >= MIN_TRAJECTORY_SHOTS
}

/**
 * Ask for §3.3's noisy run alongside the ideal one.
 *
 * IT TRAVELS ON THE ANALYTIC REQUEST, IN ONE MESSAGE, and that is the whole
 * reason this is a field rather than a request of its own. §3.3's comparison is
 * "ideal against noisy", so the two halves have to describe the same circuit;
 * asking for them separately would let an edit land in between, and the panel
 * would draw the noisy distribution of one circuit against the ideal
 * distribution of another — a discrepancy that looks exactly like noise and is
 * not. `SampleSpec` above is a field for exactly the same reason, and the
 * argument is the same one that made shot sampling a passenger in M0.7c.
 *
 * It rides on the *analytic* branch and only there. A circuit that measures
 * before it ends has no single ideal state (§5.3), so there is nothing for a
 * noisy distribution to be compared against, and the panel says so rather than
 * asking for half of a comparison.
 */
export interface NoiseSpec {
  /** The device, in the units a device reports itself in (`@qsim/core`). */
  readonly profile: NoiseProfile
  /** Corrupt the outcome with the profile's readout error. */
  readonly readout: boolean
  readonly method: NoiseMethod
  /** Shots for the trajectories method. Ignored by the density one. */
  readonly shots: number
  /** Seeded, so the same circuit and the same seed give the same counts. */
  readonly seed: number
}

/**
 * A window on ρ, big enough to draw and small enough to send.
 *
 * ρ IS NEVER TRANSFERRED WHOLE. At the ceiling it is 256 MB, and the heat map
 * of §3.2 draws a few hundred cells — so what crosses the thread boundary is
 * the block the map draws and nothing else. The states are chosen by
 * population, largest first, which is the same rule `buildHistogram` picks bars
 * by, and what the cap leaves out is reported rather than dropped: `hidden` and
 * `hiddenPopulation` are what the visible notice quotes.
 */
export interface DensityBlock {
  /** Basis-state indices of the rows and columns kept, ascending. */
  readonly indices: readonly number[]
  /** `formatKet` labels for those indices, in the same order. */
  readonly labels: readonly string[]
  /** Row-major over `indices` × `indices`: entry (r, c) is at `r*k + c`. */
  readonly re: Float64Array
  readonly im: Float64Array
  /** Basis states carrying population that the cap left out. */
  readonly hidden: number
  /** The population those states hold between them. */
  readonly hiddenPopulation: number
  /** The cap this block was built with, for the notice to quote. */
  readonly limit: number
}

/**
 * The noisy half of a result: the distribution, the fidelity against the ideal
 * run in the same message, and — for the density method — ρ's own numbers.
 */
export interface NoiseReading {
  /** Which method actually ran. Never assumed from the register size. */
  readonly method: NoiseMethod
  /**
   * The noisy distribution over basis states, readout error included, for the
   * density method. Null for a trajectories run, which answers with counts.
   *
   * Bounded by `MAX_DENSITY_CLIENT_QUBITS`, so this array is at most 4096
   * doubles — which is why it may be sent whole where the 2²⁰ one a
   * trajectories run would imply may not.
   */
  readonly distribution: Float64Array | null
  /** The tally of a trajectories run, keyed by ket label. Null otherwise. */
  readonly counts: ShotCounts | null
  /** Shots drawn. Null for the density method, which draws none. */
  readonly shots: number | null
  /**
   * F(p_ideal, p_noisy) — the classical fidelity of the two histograms §3.3
   * puts side by side, computed on the worker where both distributions exist
   * whole.
   */
  readonly distributionFidelity: number
  /**
   * ½ Σ |p_ideal − p_noisy| — the share of the probability that moved.
   *
   * A fidelity says how *similar* two distributions are and saturates: 0.98
   * and 0.99 both read as "close". This says how much changed hands, which is
   * the quantity §3.3's comparison is drawing — the sum of every gain, which is
   * also the sum of every loss.
   */
  readonly totalVariation: number
  /**
   * ⟨ψ|ρ|ψ⟩ — how much of the ideal *state* survived, which is a stricter
   * question than whether the histogram still looks right. Null for a
   * trajectories run, which never forms a ρ.
   */
  readonly stateFidelity: number | null
  /** Tr(ρ²): 1 for a pure state, 1/2ⁿ for a maximally mixed one. Null as above. */
  readonly purity: number | null
  /** The block of ρ the heat map draws. Null for a trajectories run. */
  readonly density: DensityBlock | null
}

/**
 * Why a noisy run did not happen.
 *
 * Three of the four are limits a reader can act on, so all three carry their
 * numbers — the panel names the register, names the limit, and names what to do
 * instead. `noise-failed` is the remaining one: a bug in this app, phrased the
 * way `worker-failed` is.
 *
 *   `density-too-large`       ρ is 4ⁿ and the register is past twelve. The way
 *                             out is the sampled method.
 *   `trajectories-too-large`  the sampled method's own ceiling, which is time
 *                             rather than memory: at this register and this
 *                             circuit length the run could not afford enough
 *                             shots to mean anything (`maxTrajectoryShots`).
 *   `noise-out-of-memory`     a register the ceiling accepted on a device that
 *                             could not honour it anyway — twelve qubits is one
 *                             contiguous 256 MB reservation, and a phone or a
 *                             loaded tab can refuse it. Distinct from
 *                             `density-too-large` because the limit that bit is
 *                             the machine's and not this app's, and distinct
 *                             from `noise-failed` because it is not a bug and
 *                             the reader has somewhere to go.
 */
export const NOISE_REFUSAL_CODES = [
  'density-too-large',
  'trajectories-too-large',
  'noise-out-of-memory',
  'noise-failed',
] as const

export type NoiseRefusalCode = (typeof NOISE_REFUSAL_CODES)[number]

export interface NoiseRefusal {
  readonly code: NoiseRefusalCode
  /** Register size that was refused. Interpolated into the message. */
  readonly qubits?: number
  /**
   * The ceiling it was refused against. Interpolated into the message.
   *
   * Qubits for `density-too-large` and `noise-out-of-memory`, shots for
   * `trajectories-too-large` — each sentence names its own unit, because the
   * two ceilings are limits on different quantities and a shared field that
   * pretended otherwise would produce "past the 100-qubit ceiling".
   */
  readonly limit?: number
  /** Shots the sampled method could actually have afforded. Interpolated. */
  readonly shots?: number
  /** Operations in the circuit that was refused. Interpolated. */
  readonly operations?: number
  /** The engine's own English message. For the console, never for a user. */
  readonly detail: string
}

/**
 * The noisy half of an answer, which may be a refusal.
 *
 * A REFUSAL IS CARRIED, NEVER THROWN. The ideal run in the same message is
 * perfectly good, and a register too large for ρ still has a histogram, an
 * amplitude table, Bloch spheres and a Q-sphere. Failing the whole request
 * would take all of them away to report a ceiling on one panel — which is the
 * "tab that freezes" §3.3 forbids, wearing the opposite mask.
 */
export type NoisePayload =
  | { readonly ok: true; readonly reading: NoiseReading }
  | { readonly ok: false; readonly refusal: NoiseRefusal }

interface SimulateBase {
  readonly kind: 'simulate'
  readonly id: RequestId
  readonly circuit: Circuit
  /**
   * The earliest column the edits since the worker's last answer touched —
   * what `invalidateFrom` needs so the run resumes instead of restarting.
   *
   * Getting this too high is silent wrong physics: the runner resumes from a
   * checkpoint the edit already contradicted and returns a perfectly
   * normalised state that belongs to no circuit. Too low only costs time. The
   * scheduler therefore accumulates a minimum and only clears it when an
   * analytic result proves the worker's cache caught up.
   *
   * MEANINGFUL ONLY FOR AN `AnalyticRequest`. A trajectories run never reads
   * the checkpoint cache — it starts from |0…0⟩ every shot, deliberately — so
   * `runJob` ignores this field there and a trajectories request carrying it
   * is evidence of nothing about what the cache holds.
   */
  readonly fromColumn: number
  /**
   * Whether the main thread can accept a `SharedArrayBuffer` in reply.
   *
   * Honoured by the worker rather than assumed: it answers with a shared
   * buffer only when this flag *and* its own scope allow one, so a deployment
   * whose document and worker chunk are isolated differently degrades to the
   * transfer path instead of failing the request.
   */
  readonly sharedMemory: boolean
}

/** One run, one final statevector. Refused if the circuit measures (§5.3). */
export interface AnalyticRequest extends SimulateBase {
  readonly mode: 'analytic'
  /**
   * Stop after this column and answer with the state as it stood there — the
   * timeline scrubber of M0.8 — or `null` for the whole circuit.
   *
   * `-1` is a position too, and a meaningful one: it is the state before
   * column 0 has run, which is where playback starts and which is the only
   * way to *see* the ground state a circuit departs from. Nothing here clamps
   * it up to 0.
   *
   * WHY THIS IS NOT "SEND A SHORTER CIRCUIT". Truncating the circuit on the
   * main thread would be one line here and would wreck the thing that makes
   * scrubbing affordable: the worker's checkpoint cache is keyed to a circuit,
   * and every step would arrive looking like an edit that deleted the tail,
   * invalidating the checkpoints the next step needs. Asking the *same*
   * circuit for an earlier column instead leaves the cache intact and lets
   * `stateAfterColumn` resume from it — which is what the engine grew that
   * function for.
   *
   * Required rather than optional, for the same reason `sample` is: a field
   * that can be forgotten is a field that will be, and a request built
   * somewhere new would silently answer a different question.
   */
  readonly throughColumn: number | null
  /**
   * Draw shots from the final state as well, or `null` for the exact
   * distribution alone.
   *
   * Required rather than optional so that every construction site answers the
   * question. A simulator has no reason to add shot noise nobody asked for
   * (§5.3), so the default is `null` — but the default has to be *chosen*,
   * because the alternative is a field that silently disappears from a request
   * built somewhere new and takes the comparison with it.
   */
  readonly sample: SampleSpec | null
  /**
   * Run the circuit again under a noise model and answer with both (§3.3), or
   * `null` for the ideal run alone.
   *
   * Required rather than optional for the same reason `sample` is, and with a
   * sharper consequence: a request built somewhere new that silently dropped
   * this field would leave §3.3's comparison drawing an ideal distribution
   * against nothing while the noise panel above it still showed a profile
   * selected. The default is `null`, and nothing is simulated twice until a
   * reader asks for it.
   */
  readonly noise: NoiseSpec | null
}

/** `shots` independent runs, tallied into counts. Seeded, so it repeats. */
export interface TrajectoriesRequest extends SimulateBase {
  readonly mode: 'trajectories'
  readonly shots: number
  readonly seed: number
  /**
   * Stop after this column, `-1` for "before column 0", or `null` for the whole
   * circuit — the same scrub position the analytic branch takes, and required
   * for the same reason.
   *
   * WHAT IT MEANS HERE, WHICH IS NOT WHAT IT MEANS ABOVE. A measuring circuit
   * has no single state at a column: each of the shots collapses somewhere
   * else, which is why this mode answers with a tally rather than a vector. But
   * the *register* at a column is perfectly well defined — it is what those
   * shots wrote into it by then — and that tally is exactly what the panel
   * draws. So a scrub position truncates the run rather than the state: every
   * shot executes columns 0…`throughColumn` and stops, and the counts describe
   * that instant.
   *
   * Without this the timeline was a live control wired to nothing on every
   * circuit that measures: the bar moved, announced a position and painted a
   * playhead, and the panel below it went on describing the whole circuit
   * while its status line said "this describes the circuit on screen".
   *
   * No checkpoint cache is involved either way (`job.ts`): a trajectory's
   * collapses are random, so there is nothing to resume from.
   */
  readonly throughColumn: number | null
}

export type SimulateRequest = AnalyticRequest | TrajectoriesRequest

/**
 * Give up on a request. The worker drops it if it has not started, and
 * withholds the answer if it has — see `simulation.worker.ts` for what this
 * can and cannot interrupt.
 */
export interface CancelRequest {
  readonly kind: 'cancel'
  readonly id: RequestId
}

export type SimulationRequest = SimulateRequest | CancelRequest

/* ────────────────────────────── responses ───────────────────────────── */

/** How the amplitudes crossed the thread boundary. Diagnostic, not a choice. */
export type TransportKind = 'shared' | 'transfer'

/**
 * A statevector in transit. Structurally one `Statevector` short of its
 * methods — `decodeState` is the only sanctioned way back, so no consumer
 * hand-rolls the reconstruction.
 */
export interface StatePayload {
  readonly qubits: number
  readonly size: number
  readonly re: Float64Array
  readonly im: Float64Array
  readonly transport: TransportKind
}

/**
 * Counts drawn from the state this response carries, echoing the request that
 * asked for them.
 *
 * `shots` and `seed` travel back rather than being read off the control,
 * because the control is on the main thread and moves while the worker runs.
 * A panel that labelled these counts with the shot count currently in the
 * slider would, for one frame after every drag, print "100 000 shots" over a
 * histogram drawn from a thousand — and the reader would conclude that
 * sampling error does not shrink after all.
 */
export interface SamplePayload extends SampleSpec {
  readonly counts: ShotCounts
}

export interface AnalyticResponse {
  readonly kind: 'result'
  readonly id: RequestId
  readonly mode: 'analytic'
  readonly state: StatePayload
  /**
   * The scrub position this state answers for, echoed back from the request.
   *
   * Echoed for the same reason `SamplePayload` echoes its shot count: the
   * scrubber is on the main thread and moves while the worker runs. A panel
   * that captioned this state with the position currently under the bar would,
   * for one frame after every step, print "up to column 4" over the state at
   * column 3 — and a reader watching interference appear a column late has no
   * way to tell that from the physics.
   */
  readonly throughColumn: number | null
  /**
   * The column the run resumed from, 0 for a run that started at |0…0⟩. The
   * incremental cache of §5.6.3 is invisible from the outside otherwise, and
   * a cache that silently stopped working would only show up as a slow
   * editor.
   */
  readonly resumedFromColumn: number
  /**
   * What the request's `sample` asked for, drawn from the very state above.
   *
   * One message carries both halves precisely so that they cannot disagree.
   * Sampling in a second round trip would have let an edit land between the
   * two, and the panel would have drawn an empirical histogram of one circuit
   * against the exact distribution of another — a discrepancy that looks
   * exactly like sampling error and is not.
   */
  readonly sampling: SamplePayload | null
  /**
   * What the request's `noise` asked for, run on the very circuit above.
   *
   * One message carries both halves precisely so they cannot disagree — see
   * `NoiseSpec`. A refusal travels here too rather than as an `ErrorResponse`,
   * because the ideal half of this message is still an answer.
   */
  readonly noise: NoisePayload | null
  readonly durationMs: number
}

export interface TrajectoriesResponse {
  readonly kind: 'result'
  readonly id: RequestId
  readonly mode: 'trajectories'
  readonly shots: number
  readonly counts: ShotCounts
  /** The scrub position these counts answer for, echoed back — see above. */
  readonly throughColumn: number | null
  readonly durationMs: number
}

export interface ErrorResponse {
  readonly kind: 'error'
  readonly id: RequestId
  readonly failure: SimulationFailure
}

export type SimulationResponse =
  AnalyticResponse | TrajectoriesResponse | ErrorResponse

/* ─────────────────────────────── failures ───────────────────────────── */

/**
 * Every way a simulation can fail to produce an answer.
 *
 * These are the UI's vocabulary, so they are deliberately about what the user
 * did rather than about where the exception came from: `too-many-qubits` is a
 * circuit that needs the server, `unsupported-operation` is a gate the engine
 * cannot run yet, `worker-failed` is a bug in this app.
 */
export const SIMULATION_ERROR_CODES = [
  'too-many-qubits',
  'invalid-circuit',
  'measurement-in-analytic-mode',
  'no-classical-bits',
  'unsupported-operation',
  'worker-unavailable',
  'worker-failed',
] as const

export type SimulationErrorCode = (typeof SIMULATION_ERROR_CODES)[number]

export interface SimulationFailure {
  readonly code: SimulationErrorCode
  /** Register size that was refused. Interpolated into the message. */
  readonly qubits?: number
  /** The ceiling it was refused against. Interpolated into the message. */
  readonly limit?: number
  /** The gate to highlight on the canvas, when the engine named one. */
  readonly operationId?: string
  /** The engine's own English message. For the console, never for a user. */
  readonly detail: string
}

/* ──────────────────────────── state transport ───────────────────────── */

/** The capability check, taking its scope as an argument so tests can lie. */
export interface SharedMemoryScope {
  readonly crossOriginIsolated?: boolean
  readonly SharedArrayBuffer?: unknown
}

/**
 * Whether this context can pass a `SharedArrayBuffer` between threads.
 *
 * Both halves matter: the constructor can exist while the page is not
 * cross-origin isolated, in which case posting one throws. COOP/COEP are set
 * in `vite.config.ts` for the dev server and must be set on the deployment
 * too; where they are missing this returns false and the transfer path takes
 * over, one copy slower and otherwise identical.
 */
export function sharedMemoryAvailable(
  scope: SharedMemoryScope = globalThis
): boolean {
  return (
    scope.SharedArrayBuffer !== undefined && scope.crossOriginIsolated === true
  )
}

export interface EncodedState {
  readonly payload: StatePayload
  /** Buffers to hand to `postMessage`. Empty on the shared path. */
  readonly transfer: readonly Transferable[]
}

/**
 * Pack a state for the trip out of the worker.
 *
 * SHARED PATH: a fresh pair of buffers per result, never a pool. The main
 * thread may still be reading the previous answer when the next run lands, and
 * a reused buffer would rewrite the histogram under it — a data race with no
 * lock in sight, on the one structure in this app large enough to make pooling
 * tempting.
 *
 * TRANSFER PATH: the engine's own buffers are handed over rather than copied,
 * which detaches them inside the worker. That is safe because the runner's
 * checkpoint cache stores `clone()`s, so no cached state aliases the one being
 * returned; the worker keeps nothing that points at these bytes.
 */
export function encodeState(state: Statevector, shared: boolean): EncodedState {
  if (shared) {
    return {
      payload: {
        qubits: state.qubits,
        size: state.size,
        re: sharedCopy(state.re),
        im: sharedCopy(state.im),
        transport: 'shared',
      },
      transfer: [],
    }
  }

  return {
    payload: {
      qubits: state.qubits,
      size: state.size,
      re: state.re,
      im: state.im,
      transport: 'transfer',
    },
    // The engine allocates plain `ArrayBuffer`s, so this cast narrows a union
    // that only ever holds one of its members here.
    transfer: [state.re.buffer as ArrayBuffer, state.im.buffer as ArrayBuffer],
  }
}

/** The received payload as a `Statevector` the engine's readers accept. */
export function decodeState(payload: StatePayload): Statevector {
  return {
    qubits: payload.qubits,
    size: payload.size,
    re: payload.re,
    im: payload.im,
  }
}

/* ───────────────────────────── decoded result ───────────────────────── */

/** A finished simulation, as the UI consumes it. */
export type SimulationOutcome =
  | {
      readonly mode: 'analytic'
      readonly state: Statevector
      readonly resumedFromColumn: number
      /** The column this state stops after, or null for the whole circuit. */
      readonly throughColumn: number | null
      /** Counts drawn from `state`, or null when none were asked for. */
      readonly sampling: SamplePayload | null
      /** §3.3's noisy run of the same circuit, or null when none was asked for. */
      readonly noise: NoisePayload | null
    }
  | {
      readonly mode: 'trajectories'
      readonly shots: number
      readonly counts: ShotCounts
      /** The column this tally stops after, or null for the whole circuit. */
      readonly throughColumn: number | null
    }

/** Turns a successful response into the shape the analysis panel reads. */
export function decodeResult(
  response: AnalyticResponse | TrajectoriesResponse
): SimulationOutcome {
  if (response.mode === 'analytic') {
    return {
      mode: 'analytic',
      state: decodeState(response.state),
      resumedFromColumn: response.resumedFromColumn,
      throughColumn: response.throughColumn,
      sampling: response.sampling,
      noise: response.noise,
    }
  }
  return {
    mode: 'trajectories',
    shots: response.shots,
    counts: response.counts,
    throughColumn: response.throughColumn,
  }
}

function sharedCopy(values: Float64Array): Float64Array {
  const copy = new Float64Array(new SharedArrayBuffer(values.byteLength))
  copy.set(values)
  return copy
}
