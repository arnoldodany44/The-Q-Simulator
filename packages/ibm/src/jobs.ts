/**
 * A job, on the way out and on the way back.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BODY, AND WHY IT IS BUILT BY A FUNCTION WITH TESTS
 *
 *     POST /jobs
 *     { "program_id": "sampler",
 *       "backend": "ibm_marrakesh",
 *       "params": { "pubs": [[<qasm3>, null, 500]],
 *                   "version": 2,
 *                   "support_qiskit": false } }
 *
 * A **pub** — a "primitive unified bloc" — is `[program, parameters, shots]`.
 * The middle element is `null` for a circuit with no free parameters, which is
 * every circuit this system submits: `@qsim/schema` resolves parameters into
 * angles before a document is ever transpiled, so there is nothing left to
 * bind. It is written as an explicit `null` rather than omitted, because a
 * two-element pub means "use the job's default shot count" and the shot count
 * is the one number in this request that must never be defaulted — it is what
 * the Open Plan's ten minutes are spent on.
 *
 * `version: 2` and `support_qiskit: false` are what the live service records on
 * a job submitted through the current API, verified by reading one back. The
 * second is the important one: `true` makes the results come home as a pickled
 * Qiskit object rather than as JSON, which this system could not read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE STATUS VOCABULARY IS THEIRS AND OURS, AND THEY ARE NOT THE SAME
 *
 * IBM answers `Queued`, `Running`, `Completed`, `Cancelled`, `Failed`. §7's
 * `JobStatus` is `SUBMITTED QUEUED RUNNING DONE FAILED CANCELLED`. The mapping
 * is small and it is here rather than in a route handler for the usual reason:
 * both the API and the worker need it, and a status mapped two ways is a row
 * that says DONE to one process and RUNNING to the other.
 *
 * SUBMITTED has no IBM counterpart on purpose. It is the state of a row this
 * system has created and has *not yet* sent anywhere — the window between the
 * database write and the first successful `POST /jobs`. Nothing at IBM can
 * report it because nothing at IBM knows about it yet, and that is exactly what
 * makes it worth having: a row stuck in SUBMITTED is a submission that failed
 * silently, which is a different incident from a job that failed at the device.
 */

import { z } from 'zod'

/** The Qiskit Runtime primitive this system submits to. */
export const SAMPLER_PROGRAM_ID = 'sampler'

/** The pub-list version the current API records on a submitted job. */
export const PUB_VERSION = 2

/**
 * A pub: the program, its parameter bindings, and its shot count.
 *
 * Typed as a tuple rather than as an array of unions so that a two-element pub
 * — the "use the default shots" form this system must never send — does not
 * type-check.
 */
export type SamplerPub = readonly [
  qasm: string,
  parameters: null,
  shots: number,
]

export interface SubmitJobInput {
  readonly backend: string
  /** OpenQASM 3 over *physical* qubits, from `emitPhysicalQasm`. */
  readonly qasm: string
  readonly shots: number
}

export interface SubmitJobBody {
  readonly program_id: string
  readonly backend: string
  readonly params: {
    readonly pubs: readonly SamplerPub[]
    readonly version: number
    readonly support_qiskit: boolean
  }
}

/**
 * The exact JSON `POST /jobs` receives.
 *
 * Returned rather than sent, so that the suites can assert on the request that
 * *would* have gone out. That is the whole testing strategy for this milestone:
 * the Open Plan's allowance is ten minutes per twenty-eight days and it is
 * shared with a demonstration, so what is verified is the request, not a
 * device's answer to it.
 */
export function submitJobBody(input: SubmitJobInput): SubmitJobBody {
  return {
    program_id: SAMPLER_PROGRAM_ID,
    backend: input.backend,
    params: {
      pubs: [[input.qasm, null, input.shots]],
      version: PUB_VERSION,
      support_qiskit: false,
    },
  }
}

/* ────────────────────────── what comes back ─────────────────────────── */

/** Every status the service reports, in its own spelling. */
export const IBM_JOB_STATUSES = [
  'Queued',
  'Running',
  'Completed',
  'Cancelled',
  'Failed',
] as const

export type IbmJobStatus = (typeof IBM_JOB_STATUSES)[number]

/** §7's `JobStatus`, mirrored here because this package may not import db. */
export const HARDWARE_JOB_STATUSES = [
  'SUBMITTED',
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const

export type HardwareJobStatus = (typeof HARDWARE_JOB_STATUSES)[number]

const STATUS_MAP: Readonly<Record<string, HardwareJobStatus>> = {
  Queued: 'QUEUED',
  Running: 'RUNNING',
  Completed: 'DONE',
  Cancelled: 'CANCELLED',
  Failed: 'FAILED',
}

/**
 * IBM's word for a status, as this system's.
 *
 * Case-insensitive on the way in — the service has spelled these both ways
 * across versions — and `null` for a word this build does not know, which the
 * caller treats as "no transition" rather than as a failure. A status nobody
 * recognises must not be able to move a row: guessing FAILED for an unknown
 * word would turn a service that added `Validating` into a wave of jobs marked
 * failed while they were running perfectly.
 */
export function hardwareStatusOf(status: string): HardwareJobStatus | null {
  const normalised = status.trim().toLowerCase()
  for (const [word, mapped] of Object.entries(STATUS_MAP)) {
    if (word.toLowerCase() === normalised) return mapped
  }
  return null
}

/** DONE, FAILED and CANCELLED. Nothing leaves any of the three. */
export function isTerminal(status: HardwareJobStatus): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED'
}

/**
 * The job document, as `GET /jobs/{id}` answers it.
 *
 * `params` is deliberately absent from this schema even though the service
 * sends it: it echoes back the whole submitted program, which this system
 * already has, and reading it would mean carrying a copy of every circuit
 * through every poll of every job. `state.status` and the flat `status` are
 * both read because both are present and the service has, in the past, updated
 * one before the other.
 */
export const JobDocumentSchema = z.object({
  id: z.string().min(1),
  backend: z.string().optional(),
  status: z.string().optional(),
  state: z
    .object({
      status: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  created: z.string().optional(),
  /**
   * A per-job queue position, if the service ever sends one.
   *
   * It does not, on the version measured: the job document carries `cost` and
   * `estimated_running_time_seconds` and no position at all. Both spellings are
   * accepted anyway, because the field is cheap to read and its absence is the
   * whole reason `HardwareJob.queuePosition` is nullable — see the poll in
   * `apps/worker`. What a person actually gets told is the *device's* queue
   * length, which the backend listing does report and which is the number that
   * decides the wait.
   */
  position: z.number().int().nonnegative().optional(),
  queue_position: z.number().int().nonnegative().optional(),
  /** Seconds of QPU time this job is expected to cost, when quoted. */
  estimated_running_time_seconds: z.number().nonnegative().optional(),
  usage: z
    .object({
      quantum_seconds: z.number().nonnegative().optional(),
      seconds: z.number().nonnegative().optional(),
    })
    .optional(),
})

export type JobDocument = z.infer<typeof JobDocumentSchema>

export interface JobReading {
  readonly id: string
  readonly status: HardwareJobStatus | null
  /** The service's own word, for the log line. Never stored on the row. */
  readonly rawStatus: string | null
  readonly queuePosition: number | null
  /** Seconds of QPU actually spent, once the service reports any. */
  readonly quantumSeconds: number | null
  /**
   * Seconds of QPU the *service* expects this job to cost, when it quotes one.
   *
   * Present from the first poll, where `quantumSeconds` only appears once the
   * job is DONE — so this is the only number available while there is still
   * time to cancel. It was parsed off the wire and then dropped on the floor,
   * which left the system with nothing at all to say about the price of a run
   * until after it had been paid: the Open Plan grants six hundred seconds per
   * twenty-eight days, and the one job this project has run quoted 4.56 and
   * cost 2.
   */
  readonly estimatedSeconds: number | null
}

export function toJobReading(document: JobDocument): JobReading {
  const raw = document.state?.status ?? document.status ?? null
  return {
    id: document.id,
    status: raw === null ? null : hardwareStatusOf(raw),
    rawStatus: raw,
    queuePosition: document.position ?? document.queue_position ?? null,
    quantumSeconds: document.usage?.quantum_seconds ?? null,
    estimatedSeconds: document.estimated_running_time_seconds ?? null,
  }
}

/** The answer to `POST /jobs`: an id, and whatever else they choose to send. */
export const SubmitJobResponseSchema = z.object({
  id: z.string().min(1),
  backend: z.string().optional(),
})
