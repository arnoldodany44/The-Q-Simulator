/**
 * Two ways one `POST /hardware/jobs` became more than one job on a real device
 * — §3.7, risk 4 — and the guard that now stops both.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE ONE PROPERTY WORTH ITS OWN FILE
 *
 * The Open Plan grants ten minutes of QPU time per twenty-eight days, it does
 * not refill on request, and a measured job on `ibm_marrakesh` costs about two
 * of those six hundred seconds. So the unit of damage here is not a wasted
 * request: it is a percent of somebody's month, per duplicate, permanently.
 *
 * `submit` in `../../hardware.ts` calls `client.submitJob` and *then*
 * compare-and-sets the row. That order is right — the row must not claim a
 * provider id it does not have — but on its own it leaves the submission
 * unguarded: the compare-and-set can only notice a duplicate *after* the device
 * has been handed the work, and the provider offers no idempotency key, so two
 * identical `POST /jobs` are two jobs.
 *
 * What guards it is `claimSubmission`: one atomic `UPDATE … WHERE id = $1 AND
 * status = 'SUBMITTED' AND "providerJobId" IS NULL AND ("lastPolledAt" IS NULL
 * OR "lastPolledAt" < $2)`, taken *before* the submission. Of two ticks that
 * read the same row, exactly one matches. It is also what records that an
 * attempt happened, which is what makes `MAX_SUBMIT_ATTEMPTS` reachable.
 *
 * Every test below runs entirely against a scripted transport. Nothing here
 * reaches IBM and nothing here spends a second of anybody's allowance.
 */

import type {
  HardwareRepository,
  PollableHardwareJob,
  RecordProviderJobInput,
} from '@qsim/db'
import { IbmError, createIbmClient, createTokenCache } from '@qsim/ibm'
import type { HttpRequest, HttpResponse, HttpTransport } from '@qsim/ibm'
import { RECORDED, TEST_CRN } from '@qsim/ibm/testing'
import { MAX_SUBMIT_ATTEMPTS, RESUME_IDLE_MS } from '@qsim/jobs'
import type { HardwareJobPayload } from '@qsim/jobs'
import { describe, expect, it } from 'vitest'

import { pollHardwareJob } from '../../hardware.js'
import type { HardwarePollPorts } from '../../hardware.js'

const USER = '11111111-1111-4111-8111-111111111111'
const JOB = 'job-1'

const PROGRAM = {
  qasm: 'OPENQASM 3.0;\nbit[2] c;\nx $154;\nc[0] = measure $154;\n',
  register: 'c',
  clbits: 2,
  layout: [154, 155],
}

interface Row extends PollableHardwareJob {
  lastPolledAt: Date | null
  errorMessage: string | null
  completedAt: Date | null
}

function seedRow(overrides: Partial<Row> = {}): Row {
  return {
    id: JOB,
    userId: USER,
    credentialId: 'cred-1',
    provider: 'ibm_quantum',
    backendName: 'ibm_marrakesh',
    providerJobId: null,
    shots: 1024,
    status: 'SUBMITTED',
    program: PROGRAM,
    pollCount: 0,
    submittedAt: new Date('2026-08-17T01:00:00.000Z'),
    lastPolledAt: null,
    errorMessage: null,
    completedAt: null,
    ...overrides,
  }
}

/**
 * The repository, with the writes this file is about implemented exactly as
 * `packages/db/src/hardware.ts` implements them.
 *
 * `claimSubmission` is the real compare-and-set, including the lease: `status =
 * SUBMITTED AND providerJobId IS NULL AND (lastPolledAt IS NULL OR
 * lastPolledAt < notClaimedSince)`. `findResumable` is the real predicate,
 * including the fix the second test turns on — the NULL branch reads
 * `submittedAt`, so a row nothing has polled is idle only when it is genuinely
 * old.
 */
function repositoryOver(row: Row): HardwareRepository {
  const unused = (): never => {
    throw new Error('not part of this verification')
  }

  return {
    createCredential: unused,
    listCredentials: unused,
    findCredential: unused,
    openCredential: unused,
    deleteCredential: unused,
    createJob: unused,
    listJobs: unused,
    findJob: unused,
    cancelJob: unused,
    completeJob: unused,

    findPollable(id: string) {
      return Promise.resolve(id === row.id ? { ...row } : null)
    },

    claimSubmission({ id, at, notClaimedSince }) {
      if (id !== row.id) return Promise.resolve(false)
      if (row.status !== 'SUBMITTED') return Promise.resolve(false)
      if (row.providerJobId !== null) return Promise.resolve(false)
      if (row.lastPolledAt !== null && row.lastPolledAt >= notClaimedSince) {
        return Promise.resolve(false)
      }
      row.lastPolledAt = at
      row.pollCount += 1
      return Promise.resolve(true)
    },

    recordSubmission({ id, providerJobId }: RecordProviderJobInput) {
      if (id !== row.id || row.status !== 'SUBMITTED') {
        return Promise.resolve(false)
      }
      row.providerJobId = providerJobId
      row.status = 'QUEUED'
      return Promise.resolve(true)
    },

    recordObservation({ id, status, at }) {
      if (id !== row.id) return Promise.resolve(false)
      row.status = status
      row.lastPolledAt = at
      row.pollCount += 1
      return Promise.resolve(true)
    },

    failJob({ id, code, at }) {
      if (id !== row.id) return Promise.resolve(false)
      row.status = 'FAILED'
      row.errorMessage = code
      row.completedAt = at
      row.lastPolledAt = at
      return Promise.resolve(true)
    },

    findResumable({ idleSince, limit }) {
      const terminal =
        row.status === 'DONE' ||
        row.status === 'FAILED' ||
        row.status === 'CANCELLED'
      const idle =
        row.lastPolledAt === null
          ? row.submittedAt < idleSince
          : row.lastPolledAt < idleSince
      return Promise.resolve(terminal || !idle || limit < 1 ? [] : [{ ...row }])
    },

    failStaleJobs: unused,
  }
}

interface Transport {
  readonly transport: HttpTransport
  readonly requests: HttpRequest[]
  /** Answers every `POST /jobs` currently parked, with a distinct id each. */
  release(): void
  countOf(method: string, suffix: string): number
}

/**
 * A transport whose `POST /jobs` can be held open.
 *
 * Holding it is the whole apparatus: a duplicate submission is two calls that
 * overlap, and a transport that answers synchronously cannot express one.
 */
function gatedTransport(options: { failSubmissions: number }): Transport {
  const requests: HttpRequest[] = []
  const parked: ((answer: HttpResponse) => void)[] = []
  let submissions = 0

  const transport: HttpTransport = (request) => {
    requests.push(request)
    const path = new URL(request.url).pathname

    if (path.endsWith('/identity/token')) {
      return Promise.resolve({
        status: 200,
        headers: {},
        body: RECORDED.iamToken,
      })
    }

    if (request.method === 'POST' && path.endsWith('/jobs')) {
      submissions += 1
      if (submissions <= options.failSubmissions) {
        /*
         * What the ten-second abort in `fetchTransport` produces. The device
         * may well have accepted the job — an abort says nothing about what the
         * far end did with the bytes it already received.
         */
        return Promise.reject(
          new IbmError('IBM_UNAVAILABLE', 'POST /jobs did not complete')
        )
      }
      const id = `ibm-job-${String(submissions)}`
      return new Promise<HttpResponse>((resolve) => {
        parked.push(resolve)
      }).then(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ id }),
      }))
    }

    // Cancels, and anything else a tick reaches for.
    return Promise.resolve({ status: 200, headers: {}, body: '{}' })
  }

  return {
    transport,
    requests,
    release() {
      const waiting = parked.splice(0)
      for (const resolve of waiting) {
        resolve({ status: 200, headers: {}, body: '{}' })
      }
    },
    countOf(method, suffix) {
      return requests.filter(
        (request) =>
          request.method === method &&
          new URL(request.url).pathname.endsWith(suffix)
      ).length
    },
  }
}

function portsOver(
  jobs: HardwareRepository,
  transport: HttpTransport,
  ticks: { payload: HardwareJobPayload; delayMs: number }[],
  now?: () => Date
): HardwarePollPorts {
  const tokens = createTokenCache({ transport, timeoutMs: 1_000 })
  return {
    jobs,
    clientFor: (credentialId) =>
      Promise.resolve(
        createIbmClient({
          crn: TEST_CRN,
          credentialId,
          apiKey: () => Promise.resolve('a-key-this-test-never-prints'),
          transport,
          tokens,
          timeoutMs: 1_000,
        })
      ),
    schedule: (payload, delayMs) => {
      ticks.push({ payload, delayMs })
      return Promise.resolve()
    },
    log: () => undefined,
    ...(now === undefined ? {} : { now }),
  }
}

describe('one request, one job on the device', () => {
  it('submits once when two ticks for one job overlap', async () => {
    /*
     * The two ticks are not hypothetical. `POST /hardware/jobs` books tick 0
     * with a two-second delay; a resume sweep that fired inside that window
     * used to book `pollCount + 1` with no delay, so the queue held
     * `hw-job-1-0` and `hw-job-1-1` and nothing held a lock on the row.
     *
     * The claim is what collapses them. Both ticks are still delivered — the
     * sweep's predicate is a separate fix, tested below — and exactly one of
     * them reaches the device.
     */
    const row = seedRow()
    const jobs = repositoryOver(row)
    const wire = gatedTransport({ failSubmissions: 0 })
    const ticks: { payload: HardwareJobPayload; delayMs: number }[] = []
    const ports = portsOver(jobs, wire.transport, ticks)

    const both = Promise.all([
      pollHardwareJob({ jobId: JOB, userId: USER, tick: 0 }, ports),
      pollHardwareJob({ jobId: JOB, userId: USER, tick: 1 }, ports),
    ])

    await waitFor(() => wire.countOf('POST', '/jobs') >= 1)
    wire.release()
    const outcomes = await both

    // ONE real job on a real device, for one thing the user asked for once.
    expect(wire.countOf('POST', '/jobs')).toBe(1)
    expect(row.providerJobId).toBe('ibm-job-1')
    expect(row.status).toBe('QUEUED')
    // The loser says so rather than pretending it did the work.
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.kind === 'skipped' &&
          outcome.reason === 'submission-claimed-elsewhere'
      )
    ).toHaveLength(1)
    // And no cancel was needed, because nothing extra was ever created.
    expect(wire.countOf('POST', '/cancel')).toBe(0)
  })

  it('stops after MAX_SUBMIT_ATTEMPTS when the answer keeps being lost', async () => {
    const row = seedRow()
    const jobs = repositoryOver(row)
    /*
     * Every submission's *answer* is lost. The device's side of it is
     * unknowable from here — an abort at ten seconds is a request that may have
     * been accepted — which is why a further attempt would be a further real
     * job rather than a retry of a thing that did not happen.
     */
    const wire = gatedTransport({ failSubmissions: 100 })
    const ticks: { payload: HardwareJobPayload; delayMs: number }[] = []
    let clock = new Date('2026-08-17T01:00:00.000Z').getTime()
    const ports = portsOver(jobs, wire.transport, ticks, () => new Date(clock))

    const first = await pollHardwareJob(
      { jobId: JOB, userId: USER, tick: 0 },
      ports
    )

    // Not terminal, and deliberately so: the job may be queued at the provider.
    expect(first).toEqual({ kind: 'polled', status: 'SUBMITTED' })
    expect(row.status).toBe('SUBMITTED')
    expect(row.providerJobId).toBeNull()

    /*
     * A tick IS scheduled now. `failFromProvider` books it here, rather than
     * claiming — as its comment used to — that "the queue wrapper schedules the
     * retry" while `attempts: 1` and a discarded outcome meant nothing did.
     */
    expect(ticks).toHaveLength(1)
    expect(ticks[0]?.payload.tick).toBe(1)

    /*
     * And the attempt was *recorded*. A row whose submission was lost used to
     * be indistinguishable from one nothing had ever touched, which is what
     * made every ceiling unreachable.
     */
    expect(row.pollCount).toBe(1)
    expect(row.lastPolledAt).not.toBeNull()

    /*
     * The resume sweep does not take it either, because it was just touched.
     * `RESUME_IDLE_MS` now applies to a never-polled row as well.
     */
    const resumable = await jobs.findResumable({
      idleSince: new Date(clock - RESUME_IDLE_MS),
      limit: 20,
    })
    expect(resumable).toEqual([])

    /*
     * Drive the remaining attempts. Each one advances the clock past the claim
     * lease, which is what a later tick genuinely does.
     */
    for (let tick = 1; tick < MAX_SUBMIT_ATTEMPTS; tick += 1) {
      clock += RESUME_IDLE_MS
      await pollHardwareJob({ jobId: JOB, userId: USER, tick }, ports)
    }
    expect(row.pollCount).toBe(MAX_SUBMIT_ATTEMPTS)
    expect(wire.countOf('POST', '/jobs')).toBe(MAX_SUBMIT_ATTEMPTS)

    // The next one refuses to buy another job and says exactly why.
    clock += RESUME_IDLE_MS
    const last = await pollHardwareJob(
      { jobId: JOB, userId: USER, tick: MAX_SUBMIT_ATTEMPTS },
      ports
    )
    expect(last).toEqual({ kind: 'finished', status: 'FAILED' })
    expect(row.status).toBe('FAILED')
    expect(row.errorMessage).toBe('SUBMIT_ABANDONED')
    expect(wire.countOf('POST', '/jobs')).toBe(MAX_SUBMIT_ATTEMPTS)

    // Terminal, so the sweep will never look at it again however long it sits.
    const afterwards = await jobs.findResumable({
      idleSince: new Date(clock + RESUME_IDLE_MS),
      limit: 20,
    })
    expect(afterwards).toEqual([])
  })

  it('does not resume a job the API has only just created', async () => {
    /*
     * The other half of the duplicate. A fresh row has `lastPolledAt` NULL, and
     * the predicate's NULL branch used to ignore `idleSince` entirely — so the
     * sweep booked a second tick for a job whose first one was still two
     * seconds away. Now the NULL branch reads `submittedAt`, which is the only
     * timestamp such a row has.
     */
    const now = new Date('2026-08-17T01:00:00.000Z').getTime()
    const fresh = repositoryOver(seedRow({ submittedAt: new Date(now - 1000) }))
    expect(
      await fresh.findResumable({
        idleSince: new Date(now - RESUME_IDLE_MS),
        limit: 20,
      })
    ).toEqual([])

    // A genuinely stranded one — submitted before the window — is still taken.
    const stranded = repositoryOver(
      seedRow({ submittedAt: new Date(now - RESUME_IDLE_MS - 1000) })
    )
    const found = await stranded.findResumable({
      idleSince: new Date(now - RESUME_IDLE_MS),
      limit: 20,
    })
    expect(found.map((job) => job.id)).toEqual([JOB])
  })
})

/** Spins the microtask queue until `predicate` holds, or gives up. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the condition never held')
}
