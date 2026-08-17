/**
 * The hardware surface, driven with no IBM and no Postgres.
 *
 * ── Why every one of these is a double, and why that is not a compromise ──
 *
 * The Open Plan grants **ten minutes of QPU time per twenty-eight days**, it is
 * shared with whatever demonstration the owner is giving that week, and it does
 * not refill on request. A suite that reached the real service would spend that
 * allowance on every push, for ever — so the whole hardware surface is
 * exercised against `recordedTransport` from `@qsim/ibm`, whose answers were
 * copied from the live service through read-only calls that cost nothing.
 *
 * What is asserted is **the request that would have been sent**. That is a
 * stronger test than a live one rather than a weaker one: it can assert on the
 * `Service-CRN` header, on the exact JSON of a pub, and on what happens when a
 * device answers 429 — none of which a live run gives you on demand.
 *
 * The one thing that is *not* a double is the cipher. `createCredentialCipher`
 * here is the real AES-256-GCM implementation over a real random key, because
 * the property under test — that the token never comes back out — is worthless
 * if the thing hiding it is a stub.
 */

import { randomBytes } from 'node:crypto'
import { KEY_BYTES, createCredentialCipher } from '@qsim/db'
import type {
  CreateCredentialInput,
  CreateHardwareJobInput,
  CredentialCipher,
  HardwareCredentialMeta,
  HardwareRepository,
  PollableHardwareJob,
  StoredHardwareJob,
} from '@qsim/db'
import { createTokenCache } from '@qsim/ibm'
import {
  RECORDED,
  TEST_CRN,
  recordedTransport,
  scriptOf,
} from '@qsim/ibm/testing'
import type { Script } from '@qsim/ibm/testing'
import type { HardwareJobPayload } from '@qsim/jobs'
import { buildHardwarePort } from '../plugins/hardware.js'
import type { HardwarePort } from '../plugins/hardware.js'
import type { HardwareQueue } from '../plugins/hardware-queue.js'
import { QueueUnavailableError } from '../plugins/queue.js'

export const TEST_API_KEY = 'an-ibm-cloud-api-key-that-is-44-characters-x'
export { TEST_CRN }

/**
 * The script every hardware suite starts from: a working account.
 *
 * One device listing with the real queue lengths as measured — 24 835 against
 * 15 against 121 — because the four-orders-of-magnitude spread is the fact the
 * listing exists to convey, and a fixture that flattened it would let a
 * regression through.
 */
export const WORKING_ACCOUNT = scriptOf({
  'POST /identity/token': { status: 200, body: RECORDED.iamToken },
  'GET /backends': { status: 200, body: RECORDED.backends },
  'GET /configuration': { status: 200, body: RECORDED.configuration },
  'GET /properties': { status: 200, body: RECORDED.properties },
  'GET /status': { status: 200, body: RECORDED.backendStatus },
  'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-job-1' }) },
})

/** An account whose key IAM refuses. Measured: IAM answers 400, not 401. */
export const REFUSED_KEY = scriptOf({
  'POST /identity/token': { status: 400, body: RECORDED.iamBadKey },
})

interface JobRow extends StoredHardwareJob {
  userId: string
  credentialId: string | null
  pollCount: number
  lastPolledAt: Date | null
}

export interface MemoryHardware {
  readonly port: HardwarePort
  readonly repository: HardwareRepository
  readonly cipher: CredentialCipher
  /** Every request the transport saw. The assertion surface. */
  readonly requests: ReturnType<typeof recordedTransport>['requests']
  /** The raw rows, so a test can look at what was actually stored. */
  readonly rows: Map<string, { encryptedToken: Uint8Array; iv: Uint8Array }>
  readonly jobs: Map<string, JobRow>
}

/**
 * A repository in a `Map`, with the real cipher.
 *
 * The ciphertext is genuinely produced and genuinely stored, so a test can look
 * at `rows` and assert that the plaintext is not in there — which is the
 * property §11 is about and the one an in-memory `{ token }` would quietly make
 * untestable.
 */
export function memoryHardware(
  script: Script = WORKING_ACCOUNT
): MemoryHardware {
  const recorder = recordedTransport(script)

  const cipher = createCredentialCipher(randomBytes(KEY_BYTES))
  const rows = new Map<
    string,
    {
      id: string
      userId: string
      provider: string
      label: string | null
      createdAt: Date
      encryptedToken: Uint8Array
      iv: Uint8Array
    }
  >()
  const jobs = new Map<string, JobRow>()
  let nextId = 0

  function meta(row: {
    id: string
    provider: string
    label: string | null
    createdAt: Date
  }): HardwareCredentialMeta {
    // The metadata projection, restated: four fields, and there is no fifth.
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      createdAt: row.createdAt,
    }
  }

  function view(row: JobRow): StoredHardwareJob {
    const {
      userId: _userId,
      credentialId: _c,
      pollCount: _p,
      lastPolledAt: _l,
      ...rest
    } = row
    return rest
  }

  const repository: HardwareRepository = {
    createCredential(input: CreateCredentialInput, withCipher) {
      const id = `cred-${String(++nextId)}`
      const sealed = withCipher.seal(
        JSON.stringify({
          v: 1,
          apiKey: input.document.apiKey,
          instance: input.document.instance,
        }),
        input.userId
      )
      const row = {
        id,
        userId: input.userId,
        provider: input.provider,
        label: input.label,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
        encryptedToken: sealed.encryptedToken,
        iv: sealed.iv,
      }
      rows.set(id, row)
      return Promise.resolve(meta(row))
    },

    listCredentials(userId) {
      return Promise.resolve(
        [...rows.values()].filter((row) => row.userId === userId).map(meta)
      )
    },

    findCredential(id, userId) {
      const row = rows.get(id)
      return Promise.resolve(
        row === undefined || row.userId !== userId ? null : meta(row)
      )
    },

    openCredential(id, userId, withCipher) {
      const row = rows.get(id)
      // Owner in the lookup, never in an `if` afterwards.
      if (row === undefined || row.userId !== userId)
        return Promise.resolve(null)
      const plaintext: unknown = JSON.parse(
        withCipher.open(
          { encryptedToken: row.encryptedToken, iv: row.iv },
          userId
        )
      )
      const document = plaintext as { apiKey: string; instance: string }
      return Promise.resolve({
        apiKey: document.apiKey,
        instance: document.instance,
      })
    },

    deleteCredential(id, userId) {
      const row = rows.get(id)
      if (row === undefined || row.userId !== userId)
        return Promise.resolve(false)
      rows.delete(id)
      return Promise.resolve(true)
    },

    createJob(input: CreateHardwareJobInput) {
      const id = `job-${String(++nextId)}`
      const row: JobRow = {
        id,
        userId: input.userId,
        circuitId: input.circuitId,
        credentialId: input.credentialId,
        provider: input.provider,
        backendName: input.backendName,
        providerJobId: null,
        shots: input.shots,
        status: 'SUBMITTED',
        queuePosition: null,
        /*
         * Round-tripped through JSON, exactly as the real column does it: an
         * optional field left `undefined` disappears rather than becoming
         * `null`, which is what the reader distinguishes. Doing it by spread
         * kept `undefined` values a `JsonValue` cannot hold.
         */
        program: JSON.parse(
          JSON.stringify(input.program)
        ) as StoredHardwareJob['program'],
        result: null,
        errorMessage: null,
        submittedAt: new Date('2026-08-16T00:00:00.000Z'),
        completedAt: null,
        pollCount: 0,
        lastPolledAt: null,
      }
      jobs.set(id, row)
      return Promise.resolve(view(row))
    },

    listJobs({ userId, circuitId }) {
      return Promise.resolve(
        [...jobs.values()]
          .filter(
            (row) =>
              row.userId === userId &&
              (circuitId === undefined || row.circuitId === circuitId)
          )
          .map(view)
      )
    },

    findJob(id, userId) {
      const row = jobs.get(id)
      return Promise.resolve(
        row === undefined || row.userId !== userId ? null : view(row)
      )
    },

    findPollable(id) {
      const row = jobs.get(id)
      if (row === undefined) return Promise.resolve(null)
      const pollable: PollableHardwareJob = {
        id: row.id,
        userId: row.userId,
        credentialId: row.credentialId,
        provider: row.provider,
        backendName: row.backendName,
        providerJobId: row.providerJobId,
        shots: row.shots,
        status: row.status,
        program: row.program,
        pollCount: row.pollCount,
        submittedAt: row.submittedAt,
      }
      return Promise.resolve(pollable)
    },

    claimSubmission({ id, at, notClaimedSince }) {
      const row = jobs.get(id)
      // The lease that stops two ticks submitting one job, restated the way
      // the real UPDATE is written rather than stubbed to `true`.
      if (row === undefined) return Promise.resolve(false)
      if (row.status !== 'SUBMITTED' || row.providerJobId !== null) {
        return Promise.resolve(false)
      }
      if (row.lastPolledAt !== null && row.lastPolledAt >= notClaimedSince) {
        return Promise.resolve(false)
      }
      jobs.set(id, { ...row, lastPolledAt: at, pollCount: row.pollCount + 1 })
      return Promise.resolve(true)
    },

    recordSubmission({ id, providerJobId }) {
      const row = jobs.get(id)
      // Compare-and-set on SUBMITTED, exactly as the real one: a job cancelled
      // before it was sent must never afterwards be sent.
      if (row === undefined || row.status !== 'SUBMITTED') {
        return Promise.resolve(false)
      }
      jobs.set(id, { ...row, providerJobId, status: 'QUEUED' })
      return Promise.resolve(true)
    },

    recordObservation({ id, status, queuePosition, at }) {
      const row = jobs.get(id)
      if (row === undefined || isTerminal(row.status))
        return Promise.resolve(false)
      jobs.set(id, {
        ...row,
        status,
        queuePosition,
        lastPolledAt: at,
        pollCount: row.pollCount + 1,
      })
      return Promise.resolve(true)
    },

    completeJob({ id, result, at }) {
      const row = jobs.get(id)
      if (row === undefined || isTerminal(row.status))
        return Promise.resolve(false)
      jobs.set(id, {
        ...row,
        status: 'DONE',
        result: result as JobRow['result'],
        errorMessage: null,
        completedAt: at,
      })
      return Promise.resolve(true)
    },

    failJob({ id, code, at }) {
      const row = jobs.get(id)
      if (row === undefined || isTerminal(row.status))
        return Promise.resolve(false)
      jobs.set(id, {
        ...row,
        status: 'FAILED',
        errorMessage: code,
        result: null,
        completedAt: at,
      })
      return Promise.resolve(true)
    },

    cancelJob({ id, userId, at }) {
      const row = jobs.get(id)
      if (
        row === undefined ||
        row.userId !== userId ||
        isTerminal(row.status)
      ) {
        return Promise.resolve(false)
      }
      jobs.set(id, { ...row, status: 'CANCELLED', completedAt: at })
      return Promise.resolve(true)
    },

    findResumable({ idleSince, limit }) {
      const resumable = [...jobs.values()]
        .filter(
          (row) =>
            !isTerminal(row.status) &&
            (row.lastPolledAt === null || row.lastPolledAt < idleSince)
        )
        .slice(0, limit)
      return Promise.resolve(
        resumable.map((row) => ({
          id: row.id,
          userId: row.userId,
          credentialId: row.credentialId,
          provider: row.provider,
          backendName: row.backendName,
          providerJobId: row.providerJobId,
          shots: row.shots,
          status: row.status,
          program: row.program,
          pollCount: row.pollCount,
          submittedAt: row.submittedAt,
        }))
      )
    },

    failStaleJobs({ before, code, limit }) {
      let moved = 0
      for (const row of [...jobs.values()].slice(0, limit)) {
        if (isTerminal(row.status) || row.submittedAt >= before) continue
        jobs.set(row.id, { ...row, status: 'FAILED', errorMessage: code })
        moved += 1
      }
      return Promise.resolve(moved)
    },
  }

  const port = buildHardwarePort({
    repository,
    cipher,
    tokens: createTokenCache({ transport: recorder.transport }),
    transport: recorder.transport,
    timeoutMs: 5_000,
  })

  return {
    port,
    repository,
    cipher,
    requests: recorder.requests,
    rows: rows,
    jobs,
  }
}

function isTerminal(status: string): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED'
}

/** A poll queue that records rather than schedules. */
export interface MemoryHardwareQueue extends HardwareQueue {
  readonly ticks: { payload: HardwareJobPayload; delayMs: number | undefined }[]
  fails: boolean
}

export function memoryHardwareQueue(): MemoryHardwareQueue {
  const ticks: MemoryHardwareQueue['ticks'] = []
  const queue: MemoryHardwareQueue = {
    ticks,
    fails: false,
    enqueueTick(payload, delayMs) {
      /*
       * The domain error the real queue raises, not a bare `Error`: what is
       * under test is that a scheduling failure becomes a 503 and a FAILED row,
       * and a double that threw something else would exercise the 500 path
       * instead and prove nothing.
       */
      if (queue.fails) {
        return Promise.reject(new QueueUnavailableError('redis is down'))
      }
      ticks.push({ payload, delayMs })
      return Promise.resolve()
    },
    close() {
      return Promise.resolve()
    },
  }
  return queue
}
