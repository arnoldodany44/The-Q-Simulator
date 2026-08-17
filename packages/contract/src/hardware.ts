/**
 * The hardware routes' wire contract — §3.7, §8's `/hardware/*`, §11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL
 *
 * §11: «El endpoint de lectura devuelve solo metadatos (proveedor, etiqueta,
 * fecha), jamás el token.»
 *
 * `HardwareCredentialResponse` below has four fields and **no field that could
 * hold a secret**, not even a masked or truncated one. That is deliberate and
 * it is the whole of the rule: a schema with a `tokenPreview` would be a schema
 * where somebody eventually puts four real characters, and "the last four" is a
 * convention borrowed from card numbers — where the tail is printed on the
 * receipt anyway. An API key has no such convention. Every character of it is
 * the credential.
 *
 * The response schema is also what the API *serialises through*, so this is not
 * documentation of an intention: a handler that returned the whole row would
 * have the extra fields stripped by the serialiser before they reached a socket.
 * Two independent mechanisms — this schema and `hardwareCredentialMetaSelect` in
 * `@qsim/db`, which cannot even fetch the ciphertext — and the test that matters
 * asserts it from **the owner's own session**, because "only the owner can read
 * it" is the check people write instead of this one.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A BACKEND LISTING CARRIES A QUEUE LENGTH
 *
 * Because it decides whether a result arrives today. Measured on one morning:
 * `ibm_fez` with 24 835 jobs waiting, `ibm_marrakesh` with 15 — four orders of
 * magnitude, on two devices with the same qubit count, the same processor
 * family and near-identical error rates. Choosing a backend is not a cosmetic
 * setting, so the number that decides it travels in the list rather than behind
 * a second request nobody makes.
 *
 * `operational` travels for the same reason and is just as invisible from a
 * qubit count: a device paused for maintenance has a short queue precisely
 * *because* nothing is starting on it, which makes it look like the best choice
 * on every axis except the one that matters.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE JOB RESPONSE CARRIES THE SUBMITTED PROGRAM
 *
 * §3.7's comparison view is "ideal | con ruido | hardware real", and the third
 * column is only worth anything if a reader can see *what actually ran*. A
 * transpiled circuit over physical qubits is not the circuit that was drawn —
 * it has no H and no CNOT, and it names `$154` — and hiding that would make the
 * comparison a claim rather than an observation. It is the user's own circuit
 * and it names no account, so there is nothing here to withhold.
 */

import { z } from 'zod'
import { serverTimestamp, wireTimestamp } from './circuits.js'

/* ─────────────────────────────── vocabulary ─────────────────────────── */

/**
 * Mirrors `JobStatus` in the Prisma schema and `HardwareStatus` in @qsim/jobs.
 *
 * Re-declared here for the reason `RunStatus` is: those are server-side
 * packages the browser may not import (§12.3), and `apps/api` — the one
 * workspace that sees all three — is where a test asserts they agree.
 */
export const HardwareJobStatus = {
  /** The row exists; nothing has been sent to the provider yet. */
  SUBMITTED: 'SUBMITTED',
  /** Accepted by the provider and waiting behind other people's work. */
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  /** The person asked for it to stop. Not a failure — see the socket frame. */
  CANCELLED: 'CANCELLED',
} as const

export type HardwareJobStatus =
  (typeof HardwareJobStatus)[keyof typeof HardwareJobStatus]

export const HARDWARE_JOB_STATUS_VALUES = [
  HardwareJobStatus.SUBMITTED,
  HardwareJobStatus.QUEUED,
  HardwareJobStatus.RUNNING,
  HardwareJobStatus.DONE,
  HardwareJobStatus.FAILED,
  HardwareJobStatus.CANCELLED,
] as const

export const HardwareJobStatusSchema = z.enum(HardwareJobStatus)

/** The one provider this milestone speaks to. A string, so a second can exist. */
export const HARDWARE_PROVIDERS = ['ibm_quantum'] as const

export const HardwareProviderSchema = z.enum(HARDWARE_PROVIDERS)

export type HardwareProvider = (typeof HARDWARE_PROVIDERS)[number]

/* ───────────────────────────── credentials ──────────────────────────── */

/** How long a label may be. It is the user's own note, shown back to them. */
export const MAX_CREDENTIAL_LABEL = 60

/**
 * Registering a credential.
 *
 * Two secrets, because an IBM Cloud credential *is* two: the API key and the
 * instance CRN. Both are bounded here so an oversized value is refused by the
 * parser rather than reaching a cipher or a database column, and neither is
 * ever echoed back — not by this route's own response, and not in a validation
 * error, whose `details` carry a path and a code and never a value.
 */
export const CreateHardwareCredentialBody = z.object({
  provider: HardwareProviderSchema,
  /** The IBM Cloud API key. Exchanged for a bearer token; never stored plain. */
  apiKey: z.string().min(8).max(512),
  /** The instance CRN. Its sixth segment decides which host answers. */
  instance: z.string().min(8).max(512),
  /** A note so a person can tell two keys apart. Optional, and theirs. */
  label: z.string().trim().min(1).max(MAX_CREDENTIAL_LABEL).nullish(),
})

export type CreateHardwareCredentialBody = z.infer<
  typeof CreateHardwareCredentialBody
>

/* ─────────────────────────────── backends ───────────────────────────── */

/**
 * One device.
 *
 * Every field past `name` is nullable, and that is the same rule
 * `deviceTargetFromIbm` follows: a missing number stays missing. A
 * `queueLength` defaulted to zero would rank a device this system knows nothing
 * about above one it has measured — the exact inversion the field exists to
 * prevent.
 */
export const HardwareBackendResponse = z.object({
  name: z.string(),
  /** The provider's own word: `online`, `paused`, `offline`. */
  status: z.string().nullable(),
  /** Whether a job sent now would be expected to start. Derived, not reported. */
  operational: z.boolean(),
  qubits: z.number().int().nullable(),
  /** Jobs waiting. The number that decides whether an answer arrives today. */
  queueLength: z.number().int().nullable(),
  /** `Heron r2`, when the provider says. */
  processor: z.string().nullable(),
})

export type HardwareBackendResponse = z.infer<typeof HardwareBackendResponse>

export const HardwareBackendListEnvelope = z.object({
  backends: z.array(HardwareBackendResponse),
  /** Which credential these were read with, so a client can label the list. */
  credentialId: z.string(),
})

/* ──────────────────────────────── jobs ──────────────────────────────── */

export const MIN_HARDWARE_JOB_SHOTS = 1
export const MAX_HARDWARE_JOB_SHOTS = 4_096
export const DEFAULT_HARDWARE_JOB_SHOTS = 1_024

/**
 * Submitting a circuit to a device.
 *
 * `circuit` is a *handle* and not a document, unlike `POST /simulate`, and the
 * difference is not an oversight. A hardware job is attributed to a stored
 * circuit by §7 (`HardwareJob.circuitId` is not nullable), because the run is
 * expensive, takes hours, and is the kind of thing somebody comes back to —
 * which is only possible if there is a saved circuit to come back to. A
 * throwaway document with no row would produce a result nothing could ever
 * show beside its source.
 */
export const CreateHardwareJobBody = z.object({
  /** The stored circuit's slug or id. It must be one this caller may read. */
  circuit: z.string().min(1).max(64),
  /** Which credential pays. §3.7: the allowance is the user's, per key. */
  credentialId: z.string().min(1).max(64),
  backend: z.string().min(1).max(128),
  shots: z.coerce
    .number()
    .int()
    .min(MIN_HARDWARE_JOB_SHOTS)
    .max(MAX_HARDWARE_JOB_SHOTS)
    .optional(),
})

export type CreateHardwareJobBody = z.infer<typeof CreateHardwareJobBody>

/**
 * The transpiled program, as it was submitted. See the header.
 *
 * The last three fields are what make the run page's three columns provably
 * about one circuit. A device queue is hours deep, so the document will have
 * moved on by the time the answer arrives; these say what it looked like when
 * it left. They are optional because a row written before they existed is still
 * a real record of a real run, and a reader that finds them absent must say
 * "cannot be checked" rather than "checked and fine".
 */
export const HardwareProgramResponse = z.object({
  /** OpenQASM 3 over physical qubits. What the device actually received. */
  qasm: z.string(),
  /** Logical qubit → physical qubit. */
  layout: z.array(z.number().int()),
  /** The classical register the samples come back under. */
  register: z.string(),
  clbits: z.number().int(),
  /** The `CircuitVersion` that was transpiled. */
  versionId: z.string().optional(),
  /** `qubitOfClbit[c]` is the qubit classical bit `c` held at the end (D1). */
  qubitOfClbit: z.array(z.number().int()).optional(),
  /** When the calibration the placement was chosen from was measured. */
  calibratedAt: z.string().nullable().optional(),
})

/**
 * The counts a finished job produced.
 *
 * Keyed exactly as the simulator keys its own — highest classical bit first,
 * qubit 0 last (D1) — so §3.7's three-column view is a join on the key rather
 * than a translation step. Two spellings of a bitstring would make that view
 * silently empty, which is worse than making it wrong.
 */
export const HardwareResultResponse = z.object({
  backend: z.string(),
  shots: z.number().int(),
  counts: z.record(z.string(), z.number().int()),
  layout: z.array(z.number().int()),
  calibratedAt: z.string().nullable(),
  /** Seconds of QPU spent. What the plan's ten minutes were paid out of. */
  quantumSeconds: z.number().nullable(),
})

export type HardwareResultResponse = z.infer<typeof HardwareResultResponse>

function buildHardwareResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  /**
   * A credential, as every read of it comes back.
   *
   * Four fields. There is no fifth, and adding one is the change this file's
   * header is about.
   */
  const HardwareCredentialResponse = z.object({
    id: z.string(),
    provider: z.string(),
    label: z.string().nullable(),
    createdAt: timestamp,
  })

  const HardwareJobResponse = z.object({
    id: z.string(),
    circuitId: z.string(),
    provider: z.string(),
    backend: z.string(),
    /**
     * The provider's own id for this job, once there is one.
     *
     * Returned deliberately: it is how a person finds their job in the
     * provider's own console, which is the only place that can answer "what is
     * actually happening" when this system's poll has given up. It identifies a
     * job and not an account.
     */
    providerJobId: z.string().nullable(),
    shots: z.number().int(),
    status: HardwareJobStatusSchema,
    /**
     * Where this job sits in the device's queue, when the provider says.
     *
     * Usually null, and honestly so: the current Quantum API's job document
     * carries no per-job position at all. What answers "how long" is the
     * device's `queueLength` from `GET /hardware/backends`.
     */
    queuePosition: z.number().int().nullable(),
    program: HardwareProgramResponse.nullable(),
    result: HardwareResultResponse.nullable(),
    /** A failure code, never a sentence. The client renders it (D2). */
    error: z.string().nullable(),
    submittedAt: timestamp,
    completedAt: timestamp.nullable(),
  })

  return {
    HardwareCredentialResponse,
    HardwareCredentialEnvelope: z.object({
      credential: HardwareCredentialResponse,
    }),
    HardwareCredentialListEnvelope: z.object({
      credentials: z.array(HardwareCredentialResponse),
    }),
    HardwareJobResponse,
    HardwareJobEnvelope: z.object({ job: HardwareJobResponse }),
    HardwareJobListEnvelope: z.object({ jobs: z.array(HardwareJobResponse) }),
  }
}

/**
 * Two spellings of one contract, for the reason `circuits.ts` has two.
 *
 * Fastify serialises through the *server* one, whose timestamp is the `Date` a
 * handler is holding; the browser parses through the *wire* one, whose
 * timestamp is the ISO-8601 string that arrives. One shared builder means the
 * two can never grow a field apart — which, on a response that must never grow
 * a field at all, is the property that matters most.
 */
export const serverHardwareResponses = buildHardwareResponses(serverTimestamp)
export const wireHardwareResponses = buildHardwareResponses(wireTimestamp)

export type HardwareCredential = z.infer<
  typeof wireHardwareResponses.HardwareCredentialResponse
>
export type HardwareJob = z.infer<
  typeof wireHardwareResponses.HardwareJobResponse
>

/** How many jobs one listing answers with. */
export const MAX_HARDWARE_JOB_PAGE = 50
