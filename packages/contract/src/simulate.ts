/**
 * The simulation routes' wire contract — §8, §4.
 *
 * ── The endpoint has two successful answers and that is the contract ──────
 *
 * §8 says `POST /simulate` is "síncrono si es chico, encolado si es grande",
 * so the one route answers in two shapes and a client has to handle both:
 *
 *   `201 Created`  the run is finished. `status` is DONE (or FAILED), and
 *                  `result` is populated. Nothing further to poll.
 *   `202 Accepted` the run is queued. `status` is QUEUED, `result` is null,
 *                  and `GET /simulate/:runId` is where the answer appears.
 *
 * They share one envelope on purpose. A client that reads `run.status` and
 * `run.result` needs no branch on the status code at all — it either has an
 * answer or it polls — and the *same* envelope comes back from the GET, so
 * there is one shape for "a run" in the whole system rather than three.
 *
 * Which one you get is not a promise about speed, it is a decision made from
 * the circuit: see `routeOf` in `@qsim/jobs`, whose threshold is the browser's
 * own ceiling. A client cannot request one or the other, deliberately —
 * offering a `wait: true` flag would let a caller hold a connection open
 * across arbitrary work, which is the resource the flag was supposed to bound.
 *
 * ── Why the mode and status enums are re-declared ─────────────────────────
 *
 * Same reason as `visibility.ts`, and the same defence: `SimMode` and
 * `RunStatus` are Postgres types whose TypeScript mirror lives in `@qsim/db`,
 * which the browser may not import (§12.3 rule 3), and `@qsim/jobs` is a
 * server-side package the browser has no business bundling. So the values are
 * declared here for the wire, and `apps/api` — the one workspace that can see
 * all three — asserts they agree.
 */

import { CircuitSchema } from '@qsim/schema'
import { z } from 'zod'

/* ─────────────────────────────── vocabulary ─────────────────────────── */

/** Mirrors `SimMode` in the Prisma schema and `SimulationMode` in @qsim/jobs. */
export const SimulationMode = {
  /** One run, one exact final |ψ⟩. Refuses a circuit that measures (§5.3). */
  STATEVECTOR: 'STATEVECTOR',
  /** ρ evolved through the Kraus channels: exact, 4ⁿ, and capped at twelve. */
  DENSITY_MATRIX: 'DENSITY_MATRIX',
  /** The circuit re-run once per shot, tallied. The mode for measurement. */
  TRAJECTORIES: 'TRAJECTORIES',
} as const

export type SimulationMode =
  (typeof SimulationMode)[keyof typeof SimulationMode]

export const SIMULATION_MODE_VALUES = [
  SimulationMode.STATEVECTOR,
  SimulationMode.DENSITY_MATRIX,
  SimulationMode.TRAJECTORIES,
] as const

export const SimulationModeSchema = z.enum(SimulationMode)

/** Mirrors `RunStatus` in the Prisma schema. */
export const RunStatus = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus]

export const RUN_STATUS_VALUES = [
  RunStatus.QUEUED,
  RunStatus.RUNNING,
  RunStatus.DONE,
  RunStatus.FAILED,
] as const

export const RunStatusSchema = z.enum(RunStatus)

/* ──────────────────────────────── request ───────────────────────────── */

/** §3.2's shot range, restated on the wire so a client can bound its own control. */
export const MIN_SHOTS = 1
export const MAX_SHOTS = 100_000

/** A 32-bit seed, which is what the engine's generator expands. */
export const MAX_SEED = 0xffffffff

/**
 * The device profiles a request may name.
 *
 * Ids only. A `NoiseProfile` is eight numbers that become Kraus operators and
 * not every eight numbers describe a physical device, so the wire carries a
 * choice from a closed set and the numbers are looked up on the server. This
 * list mirrors `NOISE_PROFILE_IDS` in `@qsim/core` minus `custom`, which is
 * the editor's own scratch profile and has no meaning across a network.
 */
export const NOISE_PROFILE_IDS = [
  'ideal',
  'superconducting',
  'trappedIon',
  'teaching',
] as const

export type NoiseProfileId = (typeof NOISE_PROFILE_IDS)[number]

export const NoiseProfileIdSchema = z.enum(NOISE_PROFILE_IDS)

/**
 * Ask the server to run a circuit.
 *
 * `circuit` is the document itself and is re-validated with `parseCircuit` in
 * the handler — `CircuitSchema` here is what makes a 400 name the field, not
 * what makes the payload safe (§11).
 *
 * `circuitId` is attribution and never input: it says which stored circuit
 * this run is *about*, so the run can be read back under the same visibility
 * rules as everything else. The server resolves it through the ordinary
 * readable-circuit filter and answers 404 if the caller may not see it, which
 * is what stops a run from being a side channel onto a private circuit. The
 * document still travels in full, because a run must describe the circuit as
 * it was at submission — a version appended while the job sat in the queue
 * must not change what the job computes.
 */
export const SimulateBody = z.object({
  circuit: CircuitSchema,
  mode: SimulationModeSchema.default(SimulationMode.STATEVECTOR),
  /**
   * Shots, or omitted. Means two different things by mode, deliberately: for
   * `TRAJECTORIES` it is how many times the whole circuit is re-run, and for
   * `STATEVECTOR` it is how many draws are taken from the single final state
   * (§5.3). `DENSITY_MATRIX` is exact and takes none.
   */
  shots: z.int().min(MIN_SHOTS).max(MAX_SHOTS).optional(),
  /**
   * The seed, or omitted for one the server mints and reports back.
   *
   * Reported back either way, in the result, because a run nobody can repeat
   * is not an authoritative answer — which is one of the three reasons §4
   * gives for the server to run anything at all.
   */
  seed: z.int().min(0).max(MAX_SEED).optional(),
  noiseProfileId: NoiseProfileIdSchema.optional(),
  /** Corrupt the outcome with the profile's readout error. Defaults to true. */
  readout: z.boolean().default(true),
  circuitId: z.string().min(1).max(64).optional(),
})

export type SimulateRequest = z.input<typeof SimulateBody>

/* ──────────────────────────────── response ──────────────────────────── */

/** One basis state in a stored result. Mirrors `SimulationOutcome` in @qsim/jobs. */
const SimulationOutcomeResponse = z.object({
  state: z.string(),
  probability: z.number().nullable(),
  count: z.int().nullable(),
})

/**
 * The bounded reading a finished run carries.
 *
 * Not the state. At the register sizes this endpoint exists for, the state is
 * hundreds of megabytes — see `result.ts` in `@qsim/jobs` for the whole
 * argument, including why `hiddenOutcomes` and `hiddenWeight` are what make a
 * truncated list honest rather than misleading.
 */
const SimulationResultResponse = z.object({
  resultVersion: z.literal(1),
  mode: SimulationModeSchema,
  qubits: z.int(),
  shots: z.int().nullable(),
  seed: z.int(),
  noiseProfileId: z.string().nullable(),
  outcomes: z.array(SimulationOutcomeResponse),
  hiddenOutcomes: z.int(),
  hiddenWeight: z.number(),
  purity: z.number().nullable(),
  durationMs: z.int(),
})

/**
 * How far a running job has got, or `null`.
 *
 * `total` is nullable and that is a feature: two of the three modes have no
 * honest subdivision to report, and a progress bar fed a fabricated number
 * stalls at ninety per cent and teaches the reader that this application's
 * progress bars lie. See `progress.ts` in `@qsim/jobs`.
 *
 * It is absent for a run that is not RUNNING, and may also be absent for one
 * that is: it lives in Redis rather than in Postgres, so a read that could not
 * reach the queue answers with the run and without the progress rather than
 * failing. A missing progress field is never an error.
 */
const RunProgressResponse = z.object({
  phase: z.enum(['validating', 'simulating', 'sampling', 'summarising']),
  completed: z.int().nullable(),
  total: z.int().nullable(),
})

function buildSimulateResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  /**
   * One run, whatever state it is in.
   *
   * The same shape from `POST` and from `GET`, which is what lets a client
   * write one renderer. `result` and `error` are both nullable and exactly one
   * of them is populated once `status` is terminal.
   */
  const RunResponse = z.object({
    id: z.string(),
    status: RunStatusSchema,
    mode: SimulationModeSchema,
    shots: z.int().nullable(),
    /** The stored circuit this run is about, or null for an unsaved one. */
    circuitId: z.string().nullable(),
    createdAt: timestamp,
    /**
     * Wall-clock the engine spent, once known. Null while queued.
     *
     * Deliberately the engine's own measure rather than the time from
     * submission: a run that waited four minutes behind other work did not
     * take four minutes, and reporting that it did would make the number
     * useless for the one thing anybody uses it for, which is comparing two
     * circuits.
     */
    durationMs: z.int().nullable(),
    /**
     * Roughly how long the engine will take, in milliseconds — or null.
     *
     * POPULATED BY `POST` AND NULL ON `GET`, which is a statement about what
     * each call has in hand rather than an oversight. The estimate comes from
     * the cost model in `@qsim/jobs`, whose inputs are the mode, the register
     * size, the operation count and the shots; the `POST` holds the circuit and
     * can compute it, and the stored row does not (§7 keeps the mode and the
     * shots, never the document). Recomputing it on a read would mean either
     * storing a number that a redeploy of the cost model makes wrong, or
     * fetching the circuit — which a run over an unsaved circuit does not have.
     *
     * A client that needs it holds the one it was given at submission, which is
     * the only moment it is useful: it is what turns "queued" into "about
     * fifteen seconds". Null means the honest thing — there is no estimate —
     * and the UI says elapsed time instead of inventing one, the same rule
     * `progress.total` follows.
     *
     * It is an estimate of ENGINE time, like `durationMs`, and excludes the
     * queue wait. A run that sat four minutes behind other work did not take
     * four minutes, and a client showing this beside a queue position is
     * describing two different things.
     */
    estimatedDurationMs: z.int().nullable(),
    result: SimulationResultResponse.nullable(),
    /**
     * Why it failed, as a code the client translates (D2). Null otherwise.
     *
     * A code and never the engine's prose, for the reason every error in this
     * API is a code: the message would be English on a French screen and would
     * live outside every catalog parity test.
     */
    error: z.string().nullable(),
    progress: RunProgressResponse.nullable(),
  })

  return {
    RunResponse,
    /** The envelope, so a field can be added beside the run without a reshape. */
    RunEnvelope: z.object({ run: RunResponse }),
  }
}

/** For Fastify's serialiser: takes the `Date` the handler returns. */
export const serverSimulateResponses = buildSimulateResponses(z.date())

/** For the browser: takes the ISO-8601 string and yields a `Date`. */
export const wireSimulateResponses = buildSimulateResponses(
  z.iso.datetime().transform((value) => new Date(value))
)

export type SimulationRun = z.output<
  (typeof wireSimulateResponses)['RunResponse']
>
export type RunEnvelope = z.output<
  (typeof wireSimulateResponses)['RunEnvelope']
>
