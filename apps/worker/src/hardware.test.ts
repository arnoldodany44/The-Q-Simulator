/**
 * The hardware poll, driven with no IBM, no Redis and no Postgres.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY NONE OF THESE RUNS A CIRCUIT
 *
 * The Open Plan grants ten minutes of QPU time per twenty-eight days, it is the
 * *owner's*, and it does not refill on request. Every call below goes to
 * `recordedTransport` from `@qsim/ibm`, whose answers were copied from the live
 * service through reads that cost nothing — and what is asserted is the request
 * that would have been sent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE THREE PROPERTIES THAT MATTER
 *
 *   1. **A job cancelled before it was sent is never sent.** Both orderings are
 *      exercised: the cancel landing first (nothing is submitted) and the
 *      cancel landing during the submission (the provider is told to cancel).
 *   2. **A worker restart resumes a job it did not submit.** Every tick reads
 *      everything from the row, so the test is literally a fresh set of ports
 *      over the same repository — there is no state to carry.
 *   3. **The samples come home in the project's convention.** Asserted on an
 *      ASYMMETRIC distribution, because a Bell pair is symmetric under exactly
 *      the mistake being tested and a real device offers no ideal answer to
 *      compare against.
 */

import type {
  CompleteHardwareJobInput,
  FailHardwareJobInput,
  HardwareRepository,
  PollObservationInput,
  PollableHardwareJob,
  RecordProviderJobInput,
} from '@qsim/db'
import { createIbmClient, createTokenCache } from '@qsim/ibm'
import type { IbmClient } from '@qsim/ibm'
import {
  RECORDED,
  TEST_CRN,
  recordedTransport,
  resultsOf,
  scriptOf,
} from '@qsim/ibm/testing'
import type { Script } from '@qsim/ibm/testing'
import { MAX_POLL_ATTEMPTS } from '@qsim/jobs'
import type { HardwareJobPayload, HardwareResult } from '@qsim/jobs'
import { describe, expect, it } from 'vitest'
import { failureCodeOf, pollHardwareJob } from './hardware.js'
import type { HardwarePollPorts, HardwarePublication } from './hardware.js'

const USER = '11111111-1111-4111-8111-111111111111'

/** A two-bit register measured into by two qubits placed at 154 and 155. */
const PROGRAM = {
  qasm: 'OPENQASM 3.0;\nbit[2] c;\nx $154;\nc[0] = measure $154;\n',
  register: 'c',
  clbits: 2,
  layout: [154, 155],
}

interface Row extends PollableHardwareJob {
  result: unknown
  errorMessage: string | null
  completedAt: Date | null
  lastPolledAt: Date | null
  queuePosition: number | null
}

interface Harness {
  readonly ports: HardwarePollPorts
  readonly rows: Map<string, Row>
  readonly ticks: { payload: HardwareJobPayload; delayMs: number }[]
  readonly published: HardwarePublication[]
  readonly requests: ReturnType<typeof recordedTransport>['requests']
  /** A second set of ports over the same rows: a worker that restarted. */
  restart(): HardwarePollPorts
}

function harness(
  script: Script,
  seed: Partial<Row> & Pick<Row, 'status'> = { status: 'SUBMITTED' }
): Harness {
  const recorder = recordedTransport(script)
  const ticks: Harness['ticks'] = []
  const published: HardwarePublication[] = []
  const rows = new Map<string, Row>()

  rows.set('job-1', {
    id: 'job-1',
    userId: USER,
    credentialId: 'cred-1',
    provider: 'ibm_quantum',
    backendName: 'ibm_marrakesh',
    providerJobId: null,
    shots: 100,
    program: PROGRAM,
    pollCount: 0,
    submittedAt: new Date('2026-08-16T00:00:00.000Z'),
    result: null,
    errorMessage: null,
    completedAt: null,
    lastPolledAt: null,
    queuePosition: null,
    ...seed,
  })

  /*
   * The four writes the poll makes, each restating the *compare-and-set* the
   * real repository performs rather than stubbing it away. That is the whole
   * value of this double: what is under test is a race, and a double that
   * always said "yes" would test nothing.
   */
  const jobs = {
    findPollable: (id: string) => Promise.resolve(rows.get(id) ?? null),
    /*
     * The guard that runs *before* a submission, restated the way the real one
     * is written: SUBMITTED, no provider id yet, and no claim inside the lease.
     * Stubbing this to `true` would be stubbing away the one piece of mutual
     * exclusion in front of the call that spends somebody's month.
     */
    claimSubmission: ({
      id,
      at,
      notClaimedSince,
    }: {
      id: string
      at: Date
      notClaimedSince: Date
    }) => {
      const row = rows.get(id)
      if (row === undefined) return Promise.resolve(false)
      if (row.status !== 'SUBMITTED' || row.providerJobId !== null) {
        return Promise.resolve(false)
      }
      if (row.lastPolledAt !== null && row.lastPolledAt >= notClaimedSince) {
        return Promise.resolve(false)
      }
      rows.set(id, { ...row, lastPolledAt: at, pollCount: row.pollCount + 1 })
      return Promise.resolve(true)
    },
    recordSubmission: ({ id, providerJobId }: RecordProviderJobInput) => {
      const row = rows.get(id)
      // The compare-and-set that makes "cancelled before it was sent is never
      // sent" true, restated here rather than stubbed away.
      if (row === undefined || row.status !== 'SUBMITTED') {
        return Promise.resolve(false)
      }
      rows.set(id, { ...row, providerJobId, status: 'QUEUED' })
      return Promise.resolve(true)
    },
    recordObservation: ({
      id,
      status,
      queuePosition,
      at,
    }: PollObservationInput) => {
      const row = rows.get(id)
      if (row === undefined || terminal(row.status))
        return Promise.resolve(false)
      rows.set(id, {
        ...row,
        status,
        queuePosition,
        lastPolledAt: at,
        pollCount: row.pollCount + 1,
      })
      return Promise.resolve(true)
    },
    completeJob: ({ id, result, at }: CompleteHardwareJobInput) => {
      const row = rows.get(id)
      if (row === undefined || terminal(row.status))
        return Promise.resolve(false)
      rows.set(id, { ...row, status: 'DONE', result, completedAt: at })
      return Promise.resolve(true)
    },
    failJob: ({ id, code, at }: FailHardwareJobInput) => {
      const row = rows.get(id)
      if (row === undefined || terminal(row.status))
        return Promise.resolve(false)
      rows.set(id, {
        ...row,
        status: 'FAILED',
        errorMessage: code,
        completedAt: at,
      })
      return Promise.resolve(true)
    },
  } as unknown as HardwareRepository

  function clientFor(): Promise<IbmClient | null> {
    return Promise.resolve(
      createIbmClient({
        crn: TEST_CRN,
        credentialId: 'cred-1',
        apiKey: () => Promise.resolve('a-key'),
        transport: recorder.transport,
        tokens: createTokenCache({ transport: recorder.transport }),
      })
    )
  }

  function build(): HardwarePollPorts {
    return {
      jobs,
      clientFor,
      schedule: (payload, delayMs) => {
        ticks.push({ payload, delayMs })
        return Promise.resolve()
      },
      publish: (event) => published.push(event),
      log: () => undefined,
    }
  }

  return {
    ports: build(),
    rows,
    ticks,
    published,
    requests: recorder.requests,
    restart: build,
  }
}

function terminal(status: string): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED'
}

const AUTH = {
  'POST /identity/token': { status: 200, body: RECORDED.iamToken },
}

function tick(n = 0): HardwareJobPayload {
  return { jobId: 'job-1', userId: USER, tick: n }
}

/* ══════════════════════════════════════════════════════════════════════ */

describe('submitting', () => {
  it('sends the program and records the provider s id', async () => {
    const h = harness(
      scriptOf({
        ...AUTH,
        'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-1' }) },
      })
    )

    const outcome = await pollHardwareJob(tick(), h.ports)

    expect(outcome).toEqual({ kind: 'polled', status: 'QUEUED' })
    expect(h.rows.get('job-1')?.providerJobId).toBe('ibm-1')
    expect(h.rows.get('job-1')?.status).toBe('QUEUED')

    const submission = h.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/jobs')
    )
    const body: unknown = JSON.parse(submission?.body ?? '')
    expect(body).toEqual({
      program_id: 'sampler',
      backend: 'ibm_marrakesh',
      params: {
        // The shot count is spelled out. A two-element pub would mean "use the
        // default", and the default is what the ten minutes are spent on.
        pubs: [[PROGRAM.qasm, null, 100]],
        version: 2,
        support_qiskit: false,
      },
    })
  })

  it('books the next tick and never holds anything open', async () => {
    const h = harness(
      scriptOf({
        ...AUTH,
        'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-1' }) },
      })
    )
    await pollHardwareJob(tick(), h.ports)
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0]?.payload.tick).toBe(1)
    expect(h.ticks[0]?.delayMs).toBeGreaterThan(0)
  })

  /* THE PROPERTY. A cancel that landed first must cost nothing at all. */
  it('sends nothing for a job that was cancelled before this tick', async () => {
    const h = harness(
      scriptOf({
        ...AUTH,
        'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-1' }) },
      }),
      { status: 'CANCELLED' }
    )

    const outcome = await pollHardwareJob(tick(), h.ports)

    expect(outcome).toEqual({ kind: 'skipped', reason: 'already-terminal' })
    expect(h.requests).toHaveLength(0)
    expect(h.ticks).toHaveLength(0)
  })

  /*
   * And the harder half: the cancel landing *during* the submission. The job
   * now exists at the provider and this system has no record of its id, so it
   * is cancelled there rather than left running against an allowance nobody
   * wants spent.
   */
  it('cancels at the provider when the row moves mid-submission', async () => {
    const h = harness(
      scriptOf({
        ...AUTH,
        'POST /cancel': { status: 204 },
        'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-1' }) },
      })
    )
    // Reaches in and cancels between `findPollable` and `recordSubmission`.
    const original = h.ports.jobs.recordSubmission.bind(h.ports.jobs)
    h.ports.jobs.recordSubmission = (input) => {
      const row = h.rows.get(input.id)
      if (row !== undefined)
        h.rows.set(input.id, { ...row, status: 'CANCELLED' })
      return original(input)
    }

    const outcome = await pollHardwareJob(tick(), h.ports)

    expect(outcome.kind).toBe('skipped')
    expect(h.requests.some((request) => request.url.endsWith('/cancel'))).toBe(
      true
    )
    expect(h.rows.get('job-1')?.status).toBe('CANCELLED')
  })
})

describe('observing', () => {
  function queued(script: Script) {
    return harness(script, { status: 'QUEUED', providerJobId: 'ibm-1' })
  }

  it('records a run that has started, and keeps polling', async () => {
    const h = queued(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobRunning },
      })
    )
    const outcome = await pollHardwareJob(tick(3), h.ports)
    expect(outcome).toEqual({ kind: 'polled', status: 'RUNNING' })
    expect(h.rows.get('job-1')?.status).toBe('RUNNING')
    expect(h.ticks[0]?.payload.tick).toBe(4)
    expect(h.published).toContainEqual({
      kind: 'status',
      jobId: 'job-1',
      status: 'RUNNING',
      queuePosition: null,
    })
  })

  /*
   * A status word this build has never seen must not move the row. Guessing
   * FAILED for a provider that added `Validating` would mark a wave of
   * perfectly healthy jobs as failed.
   */
  it('keeps asking when the provider reports a status it does not know', async () => {
    const h = queued(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1': {
          status: 200,
          body: JSON.stringify({ id: 'ibm-1', status: 'Validating' }),
        },
      })
    )
    await pollHardwareJob(tick(), h.ports)
    expect(h.rows.get('job-1')?.status).toBe('QUEUED')
    expect(h.ticks).toHaveLength(1)
  })

  it('records a device failure as a failure and stops', async () => {
    const h = queued(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobFailed },
      })
    )
    const outcome = await pollHardwareJob(tick(), h.ports)
    expect(outcome).toEqual({ kind: 'finished', status: 'FAILED' })
    expect(h.rows.get('job-1')?.errorMessage).toBe('PROVIDER_FAILED')
    expect(h.ticks).toHaveLength(0)
  })

  /*
   * A cancellation at the provider's own console is a third outcome and not a
   * failure. Telling somebody their circuit failed when they stopped it
   * themselves is a lie about their work.
   */
  it('records a provider-side cancellation as a cancellation', async () => {
    const h = queued(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1': {
          status: 200,
          body: JSON.stringify({ id: 'ibm-1', status: 'Cancelled' }),
        },
      })
    )
    const outcome = await pollHardwareJob(tick(), h.ports)
    expect(outcome).toEqual({ kind: 'finished', status: 'CANCELLED' })
    expect(h.rows.get('job-1')?.status).toBe('CANCELLED')
    expect(h.published).toContainEqual({
      kind: 'complete',
      jobId: 'job-1',
      status: 'CANCELLED',
      error: null,
    })
  })

  /* A network blip must never fail a job somebody has already paid for. */
  it('leaves a job alone when the provider is merely unavailable', async () => {
    const h = queued(
      scriptOf({ ...AUTH, 'GET /jobs/ibm-1': { status: 503, body: '{}' } })
    )
    const outcome = await pollHardwareJob(tick(), h.ports)
    expect(outcome.kind).toBe('polled')
    expect(h.rows.get('job-1')?.status).toBe('QUEUED')
    expect(h.rows.get('job-1')?.errorMessage).toBeNull()
  })

  it('fails a job whose credential was refused', async () => {
    const h = queued(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1': { status: 401, body: RECORDED.badToken },
      })
    )
    await pollHardwareJob(tick(), h.ports)
    expect(h.rows.get('job-1')?.errorMessage).toBe('CREDENTIAL_INVALID')
  })

  it('stops asking past the ceiling rather than polling for ever', async () => {
    const h = queued(scriptOf(AUTH))
    const outcome = await pollHardwareJob(tick(MAX_POLL_ATTEMPTS), h.ports)
    expect(outcome).toEqual({ kind: 'finished', status: 'FAILED' })
    expect(h.rows.get('job-1')?.errorMessage).toBe('POLL_ABANDONED')
    // Nothing was even asked: the ceiling is checked before the provider.
    expect(h.requests).toHaveLength(0)
  })

  it('fails a job whose credential was deleted underneath it', async () => {
    const h = harness(scriptOf(AUTH), {
      status: 'QUEUED',
      providerJobId: 'ibm-1',
      credentialId: null,
    })
    const outcome = await pollHardwareJob(tick(), h.ports)
    expect(outcome.kind).toBe('finished')
    expect(h.rows.get('job-1')?.errorMessage).toBe('CREDENTIAL_MISSING')
  })
})

describe('collecting the result', () => {
  function finished(script: Script) {
    return harness(script, { status: 'RUNNING', providerJobId: 'ibm-1' })
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * THE ENDIANNESS TEST, ON AN ASYMMETRIC DISTRIBUTION.
   *
   * `0x1` is c[0]=1, c[1]=0 — printed highest bit first, that is "01". A
   * conversion that reversed the register would answer "10", and a Bell pair's
   * {00, 11} is symmetric under exactly that mistake. A real device gives no
   * ideal distribution to compare against, so this is the only kind of input
   * that can tell the two apart.
   */
  it('brings hexadecimal samples home in the project s convention', async () => {
    const h = finished(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1/results': {
          status: 200,
          body: resultsOf(['0x1', '0x1', '0x1', '0x2']),
        },
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobCompleted },
      })
    )

    const outcome = await pollHardwareJob(tick(), h.ports)

    expect(outcome).toEqual({ kind: 'finished', status: 'DONE' })
    const result = h.rows.get('job-1')?.result as HardwareResult
    expect(result.counts).toEqual({ '01': 3, '10': 1 })
    // The two buckets are not interchangeable: swapping them changes the
    // answer, which is the whole point of choosing this distribution.
    expect(result.counts['01']).not.toBe(result.counts['10'])
  })

  it('stores the layout beside the counts, without applying it', async () => {
    const h = finished(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1/results': { status: 200, body: resultsOf(['0x1']) },
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobCompleted },
      })
    )
    await pollHardwareJob(tick(), h.ports)
    const result = h.rows.get('job-1')?.result as HardwareResult
    // Kept for the reader and for diagnosis. The conversion above takes no
    // layout, because the transpiler permutes qubits and not classical bits.
    expect(result.layout).toEqual([154, 155])
    expect(result.backend).toBe('ibm_marrakesh')
    /*
     * THE SHOTS THE DEVICE RETURNED, NOT THE SHOTS THAT WERE ASKED FOR. The
     * row requested 100 and this response carries one sample, so the two
     * disagree — which is the whole reason `HardwareResult` has a shot count of
     * its own. `provenance.ts` labels a row "Shots returned" and derives it
     * from this field; writing the request here made that label unconditionally
     * wrong, and made it impossible for the panel's sampling error (computed
     * from the counts) and its header to ever agree.
     */
    expect(h.rows.get('job-1')?.shots).toBe(100)
    expect(result.shots).toBe(1)
    expect(result.quantumSeconds).toBe(4.1)
  })

  /*
   * The most expensive failure in this milestone: the device spent the
   * allowance and the answer could not be collected. Its own code, so it never
   * hides inside a generic failure.
   */
  it('names a result that was produced and could not be read', async () => {
    const h = finished(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1/results': {
          status: 200,
          body: resultsOf(['0xff'], 'c', 2),
        },
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobCompleted },
      })
    )
    await pollHardwareJob(tick(), h.ports)
    expect(h.rows.get('job-1')?.errorMessage).toBe('RESULT_UNREADABLE')
  })

  /* Two separate stores: "done" and "results readable" are not the same. */
  it('asks again when a completed job s results are not ready yet', async () => {
    const h = finished(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1/results': {
          status: 400,
          body: RECORDED.resultsNotReady,
        },
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobCompleted },
      })
    )
    const outcome = await pollHardwareJob(tick(), h.ports)
    expect(outcome.kind).toBe('polled')
    expect(h.rows.get('job-1')?.status).toBe('RUNNING')
    expect(h.rows.get('job-1')?.errorMessage).toBeNull()
  })

  it('discards a result for a job somebody already cancelled', async () => {
    const h = finished(
      scriptOf({
        ...AUTH,
        'GET /jobs/ibm-1/results': { status: 200, body: resultsOf(['0x1']) },
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobCompleted },
      })
    )
    const original = h.ports.jobs.completeJob.bind(h.ports.jobs)
    h.ports.jobs.completeJob = (input) => {
      const row = h.rows.get(input.id)
      if (row !== undefined)
        h.rows.set(input.id, { ...row, status: 'CANCELLED' })
      return original(input)
    }

    const outcome = await pollHardwareJob(tick(), h.ports)

    expect(outcome).toEqual({ kind: 'skipped', reason: 'already-terminal' })
    // Writing it would resurrect a job somebody deliberately stopped.
    expect(h.rows.get('job-1')?.status).toBe('CANCELLED')
    expect(h.rows.get('job-1')?.result).toBeNull()
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════
 * "A WORKER RESTART MUST RESUME POLLING A JOB IT DID NOT SUBMIT"
 *
 * There is no recovery path to test, and that is the point: every tick reads
 * everything from the row, so a *fresh set of ports* over the same repository is
 * exactly what a restarted process is. Nothing is carried between the two.
 */
describe('resuming a job this worker did not submit', () => {
  it('continues from the row alone, with no state from the first tick', async () => {
    const h = harness(
      scriptOf({
        ...AUTH,
        'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-1' }) },
        'GET /jobs/ibm-1': { status: 200, body: RECORDED.jobCompleted },
        'GET /jobs/ibm-1/results': {
          status: 200,
          body: resultsOf(['0x1', '0x2']),
        },
      })
    )

    // Process A submits.
    await pollHardwareJob(tick(0), h.ports)
    expect(h.rows.get('job-1')?.providerJobId).toBe('ibm-1')

    // Process A is killed. Process B, with nothing in common but the database,
    // picks the job up at whatever tick the sweep computed.
    const resumed = h.restart()
    const outcome = await pollHardwareJob(tick(7), resumed)

    expect(outcome).toEqual({ kind: 'finished', status: 'DONE' })
    const result = h.rows.get('job-1')?.result as HardwareResult
    expect(result.counts).toEqual({ '01': 1, '10': 1 })
  })
})

describe('failureCodeOf', () => {
  it('classifies by shape and never by message text', () => {
    // The same discipline as the API's `toApiError`: a provider that reworded
    // its errors must not be able to reclassify every failure in this system.
    expect(failureCodeOf(new Error('Error authenticating user.'))).toBe(
      'PROVIDER_REFUSED'
    )
  })
})
