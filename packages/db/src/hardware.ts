/**
 * Hardware credentials and hardware jobs — §7, §8's `/hardware/*`, §11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TWO TABLES, TWO COMPLETELY DIFFERENT RULES
 *
 * `HardwareCredential` is the strictest read in this package: the plaintext
 * leaves through exactly one method, `openCredential`, which exists for the
 * worker and for the submission path and for nothing else. Every other read
 * goes through `hardwareCredentialMetaSelect`, which cannot name
 * `encryptedToken` because the constant does not contain it. §11's sentence is
 * that the read endpoint answers provider, label and date — and the way to make
 * that true rather than intended is for the query that serves it to be
 * incapable of fetching anything else.
 *
 * `HardwareJob` is the second table in this system written by two processes,
 * and it repeats `runs.ts`'s discipline for the same reason: **every status
 * write is a compare-and-set**, taking its legal predecessors from a transition
 * table, and answering whether a row actually moved. What is new is that the
 * job can be moved by a *third* thing — the user cancelling it — while a worker
 * is mid-poll, so "did my write land" is a question with a real answer here
 * rather than a defensive one.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PLAINTEXT NEVER PASSES THROUGH THIS FILE
 *
 * `openCredential` takes a `CredentialCipher` and hands back the opened
 * document; this module holds no key and can hold none. That split is what
 * keeps the master key in one place (`apps/api`'s and `apps/worker`'s
 * environment) and out of a package that is imported for its query builders.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE POLL BOOKKEEPING IS HERE RATHER THAN IN THE WORKER
 *
 * Because `apps/api` needs it too: cancelling a job and reading one both have
 * to agree with the poll about what a status means. §12.3 rule 4 — if `api` and
 * `worker` share logic, the logic moves down into a package — and this is that
 * logic, in the package that owns the row.
 */

import type { CredentialCipher } from './secrets.js'
import { Prisma } from './generated/prisma/client.js'
import type { PrismaClient } from './generated/prisma/client.js'
import { JobStatus } from './generated/prisma/enums.js'
import { hardwareCredentialMetaSelect } from './projections.js'
import type { HardwareCredentialMeta } from './projections.js'

/* ─────────────────────────── the sealed document ───────────────────────── */

/**
 * What `HardwareCredential.encryptedToken` seals.
 *
 * A versioned document rather than a bare token, because an IBM Cloud
 * credential is two values — the API key and the instance CRN — and **both are
 * the user's**. Storing the CRN in a plaintext column beside the ciphertext
 * would publish which account and which instance a person holds to anybody who
 * can read the table, which is most of the ways this data escapes.
 *
 * `v` is inside the plaintext rather than in a column, so a provider whose
 * credential grows a third field is a version bump in this file and not a
 * migration. A document whose version this build does not know is refused: a
 * credential half-read is a credential used wrongly.
 */
export const CREDENTIAL_DOCUMENT_VERSION = 1

export interface CredentialDocument {
  /** The provider's own secret. For IBM, the IBM Cloud API key. */
  readonly apiKey: string
  /** The instance this credential addresses. For IBM, the CRN. */
  readonly instance: string
}

/** A stored credential that could not be read back as one. */
export class CredentialUnreadableError extends Error {
  readonly code = 'CREDENTIAL_UNREADABLE'

  constructor(detail: string, options: { cause?: unknown } = {}) {
    super(detail, options)
    this.name = 'CredentialUnreadableError'
  }
}

/** The plaintext a cipher seals. Not exported: only `seal`/`open` build one. */
function encodeDocument(document: CredentialDocument): string {
  return JSON.stringify({
    v: CREDENTIAL_DOCUMENT_VERSION,
    apiKey: document.apiKey,
    instance: document.instance,
  })
}

function decodeDocument(plaintext: string): CredentialDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch (error) {
    throw new CredentialUnreadableError(
      'the sealed credential is not a document this build wrote',
      { cause: error }
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CredentialUnreadableError(
      'the sealed credential is not an object'
    )
  }
  const record = parsed as Record<string, unknown>
  if (record['v'] !== CREDENTIAL_DOCUMENT_VERSION) {
    throw new CredentialUnreadableError(
      'the sealed credential was written by a different version of this ' +
        'schema; refusing to read half of it'
    )
  }
  const apiKey = record['apiKey']
  const instance = record['instance']
  if (typeof apiKey !== 'string' || typeof instance !== 'string') {
    throw new CredentialUnreadableError(
      'the sealed credential is missing a field'
    )
  }
  return { apiKey, instance }
}

/* ─────────────────────────── the job's program ─────────────────────────── */

/**
 * What was actually sent to the device, kept so the answer can be read.
 *
 * See the migration's header: re-deriving this at result time would place the
 * circuit against today's calibration while the samples came back from the
 * qubits chosen when the job was submitted.
 *
 * `layout` is logical → physical, the same array `TranspiledCircuit` carries.
 * It is stored for the *comparison view* and for diagnosis, not for the result
 * conversion — the conversion deliberately does not take a layout, because the
 * transpiler permutes qubits and not classical bits (see `@qsim/transpile`'s
 * `results.ts`, which is the one place that argument belongs).
 */
export interface HardwareProgram {
  readonly qasm: string
  readonly register: string
  readonly clbits: number
  readonly layout: readonly number[]
  /**
   * The `CircuitVersion` this program was transpiled from.
   *
   * ── WHY A JOB HAS TO NAME A VERSION AND NOT ONLY A CIRCUIT ──────────────
   *
   * `circuitId` points at a row whose *current* version is whatever the author
   * last saved. A device queue is hours deep — 24 862 jobs on `ibm_fez` on one
   * morning — so editing the circuit while its job waits is the ordinary case,
   * not an edge case. Without this field the run page draws its ideal and
   * modelled columns from a document the device never saw, and prints the
   * difference as though it were hardware error.
   *
   * Optional because rows written before this field existed do not have one.
   * A reader that finds it absent knows only that it *cannot* prove the
   * columns agree, which is a different sentence from "they do".
   */
  readonly versionId?: string
  /**
   * `qubitOfClbit[c]` is the qubit classical bit `c` holds when the submitted
   * program ends — `@qsim/qasm`'s `finalClassicalRegister` of the document that
   * was transpiled.
   *
   * Frozen here for the same reason `qasm` and `layout` are: the device's keys
   * are its classical register, and turning one into a basis state of the chart
   * needs the mapping the *submitted* circuit wrote. Re-deriving it from
   * today's document is how a later edit silently moves every bar to a
   * different basis state — a wrong answer with no oracle to catch it, which is
   * the failure this whole milestone is arranged around.
   */
  readonly qubitOfClbit?: readonly number[]
  /**
   * When the calibration the placement was chosen from was measured, ISO-8601.
   *
   * Available at submission — `transpile()` returns it, from the backend's
   * `last_update_date` — and thrown away until now, which left the provenance
   * panel reading "not reported" on every run beneath a paragraph explaining
   * what the number means. A device is re-tuned about daily, so the age of this
   * timestamp is what says how much to trust the qubits that were chosen.
   */
  readonly calibratedAt?: string | null
}

/** Reads a stored program, or `null`. A malformed one is never half-read. */
export function parseStoredProgram(value: unknown): HardwareProgram | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const qasm = record['qasm']
  const register = record['register']
  const clbits = record['clbits']
  const layout = record['layout']
  if (typeof qasm !== 'string' || qasm.length === 0) return null
  if (typeof register !== 'string' || register.length === 0) return null
  if (typeof clbits !== 'number' || !Number.isInteger(clbits)) return null
  if (!Array.isArray(layout)) return null
  // The predicate narrows the array element type, so `layout` is already
  // `number[]` here — hence no assertion. Copied rather than aliased: a stored
  // layout is a `JsonValue` the caller must not be able to write back through.
  if (!layout.every((wire) => typeof wire === 'number')) return null

  /*
   * The three fields below are read leniently and the four above strictly, and
   * the asymmetry is deliberate: a row written before they existed is a
   * perfectly good record of a run, and refusing it would turn every job
   * submitted by an earlier build into `RESULT_UNREADABLE` — a poll that
   * refuses to collect an answer the device has already been paid for. A
   * malformed value is dropped rather than half-read, so a reader sees "absent"
   * and says so, which is what the run page does.
   */
  const versionId = record['versionId']
  const qubitOfClbit = record['qubitOfClbit']
  const calibratedAt = record['calibratedAt']

  return {
    qasm,
    register,
    clbits,
    layout: [...layout],
    ...(typeof versionId === 'string' && versionId.length > 0
      ? { versionId }
      : {}),
    ...(Array.isArray(qubitOfClbit) &&
    qubitOfClbit.length === clbits &&
    qubitOfClbit.every(
      (qubit) => typeof qubit === 'number' && Number.isInteger(qubit)
    )
      ? { qubitOfClbit: [...(qubitOfClbit as number[])] }
      : {}),
    ...(typeof calibratedAt === 'string' ? { calibratedAt } : {}),
  }
}

/* ────────────────────────── the transition table ───────────────────────── */

/**
 * Every legal move, as the set of statuses a job may be in *before* it.
 *
 * Written "who may precede me" for the reason `runs.ts` gives: that is the
 * direction the writes are made in, as `updateMany({ where: { id, status: { in:
 * … } } })`, so a row that moved since the read matches nothing and is left
 * alone.
 *
 * Two edges here that `RunStatus` has no counterpart for:
 *
 *   - **SUBMITTED → QUEUED** is the successful `POST /jobs`. Before it, the row
 *     describes an intention; after it, a thing exists on somebody else's
 *     machine with an id.
 *   - **anything non-terminal → CANCELLED** is the user asking. It is allowed
 *     from SUBMITTED as well as from QUEUED and RUNNING, and that is the
 *     interesting case: a job cancelled before it was ever sent must never
 *     afterwards be sent, and the poll's own compare-and-set on SUBMITTED is
 *     what enforces it — the cancel wins the row, and the submit finds nothing
 *     to move.
 */
const HARDWARE_PREDECESSORS: Record<JobStatus, readonly JobStatus[]> = {
  SUBMITTED: [],
  QUEUED: [JobStatus.SUBMITTED, JobStatus.QUEUED],
  RUNNING: [JobStatus.SUBMITTED, JobStatus.QUEUED, JobStatus.RUNNING],
  DONE: [JobStatus.SUBMITTED, JobStatus.QUEUED, JobStatus.RUNNING],
  FAILED: [JobStatus.SUBMITTED, JobStatus.QUEUED, JobStatus.RUNNING],
  CANCELLED: [JobStatus.SUBMITTED, JobStatus.QUEUED, JobStatus.RUNNING],
}

/**
 * QUEUED and RUNNING accept themselves, and that is deliberate.
 *
 * A poll re-states the status it read; a job that has been RUNNING for an hour
 * is written as RUNNING on every tick, because the write is also what refreshes
 * `lastPolledAt` and `pollCount`. Refusing a self-transition would make the
 * common case of a long job the case that never updates its bookkeeping — and
 * the sweep would then resume a job that is being polled perfectly well.
 */
export function hardwarePredecessorsOf(next: JobStatus): readonly JobStatus[] {
  return HARDWARE_PREDECESSORS[next]
}

/** DONE, FAILED and CANCELLED. Nothing leaves any of the three. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.DONE,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
]

export const NON_TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.SUBMITTED,
  JobStatus.QUEUED,
  JobStatus.RUNNING,
]

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status)
}

/* ──────────────────────────── the projections ──────────────────────────── */

/**
 * A job as every read of it comes back.
 *
 * `program` is here because the poll needs it and `GET /hardware/jobs/:id`
 * shows the submitted OpenQASM — which is a genuine feature (§3.7's comparison
 * view is about trusting what ran) and not a leak: it is the user's own circuit,
 * transpiled, and it names physical qubits rather than anything about the
 * account.
 *
 * `credentialId` is *not* selected. A response has no use for it, and an
 * identifier in a response is an identifier loose in the world; the poll reads
 * it through its own narrow projection below.
 */
export const hardwareJobSelect = {
  id: true,
  circuitId: true,
  provider: true,
  backendName: true,
  providerJobId: true,
  shots: true,
  status: true,
  queuePosition: true,
  program: true,
  result: true,
  errorMessage: true,
  submittedAt: true,
  completedAt: true,
} satisfies Prisma.HardwareJobSelect

export type StoredHardwareJob = Prisma.HardwareJobGetPayload<{
  select: typeof hardwareJobSelect
}>

/**
 * What a poll needs, and nothing a response would want.
 *
 * A separate projection from the one above precisely because it contains
 * `credentialId` and `pollCount`: the two fields that must reach a worker and
 * must not reach a client.
 */
export const hardwarePollSelect = {
  id: true,
  userId: true,
  credentialId: true,
  provider: true,
  backendName: true,
  providerJobId: true,
  shots: true,
  status: true,
  program: true,
  pollCount: true,
  submittedAt: true,
} satisfies Prisma.HardwareJobSelect

export type PollableHardwareJob = Prisma.HardwareJobGetPayload<{
  select: typeof hardwarePollSelect
}>

/* ──────────────────────────── the repository ───────────────────────────── */

export interface CreateCredentialInput {
  readonly userId: string
  readonly provider: string
  readonly label: string | null
  readonly document: CredentialDocument
}

export interface CreateHardwareJobInput {
  readonly userId: string
  readonly circuitId: string
  readonly credentialId: string
  readonly provider: string
  readonly backendName: string
  readonly shots: number
  readonly program: HardwareProgram
}

export interface RecordProviderJobInput {
  readonly id: string
  readonly providerJobId: string
}

export interface PollObservationInput {
  readonly id: string
  readonly status: JobStatus
  /** Null when the provider does not report one, which is the usual case. */
  readonly queuePosition: number | null
  readonly at: Date
}

export interface CompleteHardwareJobInput {
  readonly id: string
  /** Counts and metadata. Shape owned and validated by @qsim/jobs. */
  readonly result: unknown
  readonly at: Date
}

export interface FailHardwareJobInput {
  readonly id: string
  /** A failure code, never a sentence — the client renders it (D2). */
  readonly code: string
  readonly at: Date
}

export interface HardwareRepository {
  /* ── credentials ── */

  /** Stores a sealed credential. Answers metadata; never the ciphertext. */
  createCredential(
    input: CreateCredentialInput,
    cipher: CredentialCipher
  ): Promise<HardwareCredentialMeta>

  /** This user's credentials, as metadata. §11: never the token. */
  listCredentials(userId: string): Promise<HardwareCredentialMeta[]>

  /** One credential's metadata, if it is this user's. §11: never the token. */
  findCredential(
    id: string,
    userId: string
  ): Promise<HardwareCredentialMeta | null>

  /**
   * The plaintext behind a credential.
   *
   * THE ONLY METHOD IN THIS PACKAGE THAT CAN PRODUCE IT. Scoped by owner in
   * the query, so a job that names somebody else's credential id reads
   * nothing — the check is in the `where` and not in a caller's `if`.
   */
  openCredential(
    id: string,
    userId: string,
    cipher: CredentialCipher
  ): Promise<CredentialDocument | null>

  /** Deletes a credential this user owns. Answers whether one was deleted. */
  deleteCredential(id: string, userId: string): Promise<boolean>

  /* ── jobs ── */

  /** Creates the row SUBMITTED. The only way a hardware job comes to exist. */
  createJob(input: CreateHardwareJobInput): Promise<StoredHardwareJob>

  /** This user's jobs for a circuit, newest first. */
  listJobs(input: {
    userId: string
    circuitId?: string
    limit: number
  }): Promise<StoredHardwareJob[]>

  /** The job this id names, if it is this user's. `null` for both refusals. */
  findJob(id: string, userId: string): Promise<StoredHardwareJob | null>

  /**
   * What a poll needs, with no viewer.
   *
   * The same exception `runStatus` is in `runs.ts`: this answers "what is the
   * job I am holding", which is not a request and has no viewer. The
   * authorisation happened when the row was created.
   */
  findPollable(id: string): Promise<PollableHardwareJob | null>

  /**
   * Records the provider's id and moves SUBMITTED → QUEUED.
   *
   * Compare-and-set on SUBMITTED, and that is the whole of "a job cancelled
   * before it was sent is never sent": a cancel that won the row leaves this
   * matching zero rows, and the caller then knows to cancel at the provider
   * instead of pretending the submission never happened.
   */
  recordSubmission(input: RecordProviderJobInput): Promise<boolean>

  /**
   * Claims the right to submit this job to the provider. `false` means another
   * tick holds the claim, or the row has moved.
   *
   * ══════════════════════════════════════════════════════════════════════
   * THE ONLY MUTUAL EXCLUSION IN THIS SYSTEM, AND IT GUARDS THE ONE CALL
   * THAT SPENDS MONEY
   *
   * `recordSubmission` is a compare-and-set *after* the provider has been
   * handed the work, so it can report a duplicate and cannot prevent one.
   * The provider offers no idempotency key: two `POST /jobs` with the same
   * body are two jobs on a real machine, charged to a ten-minute allowance
   * that does not refill on request.
   *
   * This is the guard that runs *before*. It is `UPDATE … WHERE id = $1 AND
   * status = 'SUBMITTED' AND "providerJobId" IS NULL AND ("lastPolledAt" IS
   * NULL OR "lastPolledAt" < $2)`, which is atomic in Postgres, so of two
   * ticks that read the same row exactly one matches. The loser stops without
   * spending anything.
   *
   * `notClaimedSince` is what makes the claim a *lease* rather than a lock: a
   * container killed between the claim and the submission must not strand its
   * job for ever, so the claim expires (`SUBMIT_CLAIM_MS`) and the next tick
   * may take it.
   *
   * It also stamps `lastPolledAt` and increments `pollCount`, which is what
   * records that an attempt happened at all — a submission whose answer was
   * lost used to leave the row indistinguishable from one nothing had ever
   * touched, so every ceiling that counts attempts was unreachable.
   */
  claimSubmission(input: {
    id: string
    at: Date
    notClaimedSince: Date
  }): Promise<boolean>

  /** Writes what a poll saw, and refreshes the poll bookkeeping. */
  recordObservation(input: PollObservationInput): Promise<boolean>

  /** Compare-and-set to DONE. `false` if the job was already terminal. */
  completeJob(input: CompleteHardwareJobInput): Promise<boolean>

  /** Compare-and-set to FAILED. `false` if the job was already terminal. */
  failJob(input: FailHardwareJobInput): Promise<boolean>

  /**
   * Compare-and-set to CANCELLED, scoped to the owner.
   *
   * Scoped by `userId` because this one is reached from a request: every other
   * write here is a worker's, and a worker has no viewer.
   */
  cancelJob(input: { id: string; userId: string; at: Date }): Promise<boolean>

  /**
   * Non-terminal jobs that nothing has asked about recently.
   *
   * The resume sweep — "a worker restart must resume polling a job it did not
   * submit". Ordered by `lastPolledAt` ascending with NULLs first, so a job
   * that was submitted and then lost outranks one that is merely slow.
   */
  findResumable(input: {
    idleSince: Date
    limit: number
  }): Promise<PollableHardwareJob[]>

  /**
   * Fails every job that has been non-terminal since before `before`.
   *
   * The same last line of defence `failStaleRuns` is, with a much longer
   * horizon: a hardware job legitimately takes hours, so "stale" here is days
   * rather than minutes. What it catches is a job whose provider forgot it, or
   * whose credential was deleted, leaving a row nothing can ever move.
   */
  failStaleJobs(input: {
    before: Date
    code: string
    limit: number
  }): Promise<number>
}

export function prismaHardwareRepository(
  prisma: PrismaClient
): HardwareRepository {
  return {
    async createCredential(input, cipher) {
      const sealed = cipher.seal(encodeDocument(input.document), input.userId)
      return prisma.hardwareCredential.create({
        data: {
          userId: input.userId,
          provider: input.provider,
          label: input.label,
          /*
           * Copied into plain `Uint8Array`s rather than passed as the
           * `Buffer`s the cipher produced. Prisma types a `Bytes` column as
           * `Uint8Array<ArrayBuffer>`, and a `Buffer` is
           * `Uint8Array<ArrayBufferLike>` — which admits `SharedArrayBuffer`
           * and therefore does not satisfy it. The copy is a few dozen bytes.
           */
          encryptedToken: new Uint8Array(sealed.encryptedToken),
          iv: new Uint8Array(sealed.iv),
        },
        // The metadata projection, on the *write* as well as on the read. A
        // create that returned the whole row would put the ciphertext in a
        // response body's reach on the one path where nobody thinks to check.
        select: hardwareCredentialMetaSelect,
      })
    },

    listCredentials(userId) {
      return prisma.hardwareCredential.findMany({
        where: { userId },
        select: hardwareCredentialMetaSelect,
        orderBy: { createdAt: 'desc' },
      })
    },

    findCredential(id, userId) {
      return prisma.hardwareCredential.findFirst({
        where: { id, userId },
        select: hardwareCredentialMetaSelect,
      })
    },

    async openCredential(id, userId, cipher) {
      const row = await prisma.hardwareCredential.findFirst({
        // Owner in the `where`, never in an `if` afterwards.
        where: { id, userId },
        select: { encryptedToken: true, iv: true },
      })
      if (row === null) return null
      /*
       * The owner is the additional authenticated data, so a row copied from
       * one user to another does not decrypt — the ciphertext is not merely
       * secret, it is *about* this owner. See `secrets.ts`.
       */
      return decodeDocument(cipher.open(row, userId))
    },

    async deleteCredential(id, userId) {
      const { count } = await prisma.hardwareCredential.deleteMany({
        where: { id, userId },
      })
      return count === 1
    },

    createJob(input) {
      return prisma.hardwareJob.create({
        data: {
          userId: input.userId,
          circuitId: input.circuitId,
          credentialId: input.credentialId,
          provider: input.provider,
          backendName: input.backendName,
          shots: input.shots,
          status: JobStatus.SUBMITTED,
          /*
           * Built field by field rather than spread. `undefined` is not JSON,
           * and an optional half of a program that is absent must be absent
           * from the column rather than present and null — the reader
           * distinguishes the two.
           */
          program: {
            qasm: input.program.qasm,
            register: input.program.register,
            clbits: input.program.clbits,
            layout: [...input.program.layout],
            ...(input.program.versionId === undefined
              ? {}
              : { versionId: input.program.versionId }),
            ...(input.program.qubitOfClbit === undefined
              ? {}
              : { qubitOfClbit: [...input.program.qubitOfClbit] }),
            ...(input.program.calibratedAt === undefined ||
            input.program.calibratedAt === null
              ? {}
              : { calibratedAt: input.program.calibratedAt }),
          },
        },
        select: hardwareJobSelect,
      })
    },

    listJobs({ userId, circuitId, limit }) {
      return prisma.hardwareJob.findMany({
        where: {
          userId,
          ...(circuitId === undefined ? {} : { circuitId }),
        },
        select: hardwareJobSelect,
        orderBy: { submittedAt: 'desc' },
        take: limit,
      })
    },

    findJob(id, userId) {
      return prisma.hardwareJob.findFirst({
        where: { id, userId },
        select: hardwareJobSelect,
      })
    },

    findPollable(id) {
      return prisma.hardwareJob.findUnique({
        where: { id },
        select: hardwarePollSelect,
      })
    },

    async recordSubmission({ id, providerJobId }) {
      const { count } = await prisma.hardwareJob.updateMany({
        where: { id, status: JobStatus.SUBMITTED },
        data: {
          providerJobId,
          status: JobStatus.QUEUED,
        },
      })
      return count === 1
    },

    async claimSubmission({ id, at, notClaimedSince }) {
      const { count } = await prisma.hardwareJob.updateMany({
        where: {
          id,
          status: JobStatus.SUBMITTED,
          // A row that already has a provider id has been submitted; there is
          // nothing left to claim and a second POST would be a second job.
          providerJobId: null,
          OR: [
            { lastPolledAt: null },
            { lastPolledAt: { lt: notClaimedSince } },
          ],
        },
        data: { lastPolledAt: at, pollCount: { increment: 1 } },
      })
      return count === 1
    },

    async recordObservation({ id, status, queuePosition, at }) {
      const { count } = await prisma.hardwareJob.updateMany({
        where: { id, status: { in: [...hardwarePredecessorsOf(status)] } },
        data: {
          status,
          queuePosition,
          lastPolledAt: at,
          pollCount: { increment: 1 },
        },
      })
      return count === 1
    },

    async completeJob({ id, result, at }) {
      const { count } = await prisma.hardwareJob.updateMany({
        // The status predicate is the guard: a second poll that raced the
        // first must not overwrite an answer somebody has already read, and a
        // job the user cancelled must not come back to life as DONE.
        where: { id, status: { in: [...NON_TERMINAL_JOB_STATUSES] } },
        data: {
          status: JobStatus.DONE,
          result:
            result === null || result === undefined ? Prisma.DbNull : result,
          errorMessage: null,
          completedAt: at,
          lastPolledAt: at,
        },
      })
      return count === 1
    },

    async failJob({ id, code, at }) {
      const { count } = await prisma.hardwareJob.updateMany({
        where: { id, status: { in: [...NON_TERMINAL_JOB_STATUSES] } },
        data: {
          status: JobStatus.FAILED,
          errorMessage: code,
          result: Prisma.DbNull,
          completedAt: at,
          lastPolledAt: at,
        },
      })
      return count === 1
    },

    async cancelJob({ id, userId, at }) {
      const { count } = await prisma.hardwareJob.updateMany({
        where: { id, userId, status: { in: [...NON_TERMINAL_JOB_STATUSES] } },
        data: { status: JobStatus.CANCELLED, completedAt: at },
      })
      return count === 1
    },

    findResumable({ idleSince, limit }) {
      return prisma.hardwareJob.findMany({
        where: {
          status: { in: [...NON_TERMINAL_JOB_STATUSES] },
          /*
           * "IDLE" HAS TO MEAN IDLE ON BOTH BRANCHES.
           *
           * The NULL branch used to ignore `idleSince` entirely, which made
           * every never-polled row eligible the instant it was created — so a
           * job whose first tick the API had just booked with a two-second
           * delay was resumed by the very next sweep, and both ticks submitted
           * it. `RESUME_IDLE_MS`'s stated guarantee ("a job that is being
           * polled normally is never resumed") was false for exactly the rows
           * that had not been polled yet, which is every row for its first few
           * seconds.
           *
           * A row nothing has polled is idle when it was *submitted* long
           * enough ago, so the NULL branch reads `submittedAt` — the only
           * timestamp such a row has.
           */
          OR: [
            { lastPolledAt: null, submittedAt: { lt: idleSince } },
            { lastPolledAt: { lt: idleSince } },
          ],
        },
        select: hardwarePollSelect,
        // NULLs first: never polled is more urgent than polled a while ago.
        orderBy: { lastPolledAt: { sort: 'asc', nulls: 'first' } },
        take: limit,
      })
    },

    async failStaleJobs({ before, code, limit }) {
      /*
       * Two statements, for the reason `failStaleRuns` gives: Postgres has no
       * LIMIT on UPDATE, and a sweep that touched ten thousand rows in one
       * transaction would hold locks on a pooler whose budget is one.
       */
      const stale = await prisma.hardwareJob.findMany({
        where: {
          status: { in: [...NON_TERMINAL_JOB_STATUSES] },
          submittedAt: { lt: before },
        },
        select: { id: true },
        orderBy: { submittedAt: 'asc' },
        take: limit,
      })
      if (stale.length === 0) return 0
      const { count } = await prisma.hardwareJob.updateMany({
        where: {
          id: { in: stale.map((row) => row.id) },
          // The predicate again: a poll may have finished one of these between
          // the read and the write, and overwriting a result with a failure is
          // the exact bug this sweep exists to prevent.
          status: { in: [...NON_TERMINAL_JOB_STATUSES] },
        },
        data: {
          status: JobStatus.FAILED,
          errorMessage: code,
          completedAt: new Date(),
        },
      })
      return count
    },
  }
}
