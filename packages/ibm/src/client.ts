/**
 * One user's credential, as a set of calls.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE CLIENT IS PER-CREDENTIAL, AND THAT IS §3.7 RATHER THAN A STYLE
 *
 * Nobody's key is the project's. §3.7 and risk 4 say each user brings their own
 * token precisely so that the cost of a run falls on the person who asked for
 * it — the Open Plan grants ten minutes per twenty-eight days and it is not
 * refillable, so a shared credential would mean one person's demonstration
 * exhausting everybody's allowance. A client bound to one credential is what
 * makes that structural: there is no ambient token in this package, and no call
 * below can be made without naming whose it is.
 *
 * The API key itself is fetched through a callback, not passed in. That is the
 * shape that keeps the plaintext transient: it lives for the duration of one
 * IAM exchange, inside `iam.ts`, and this object never holds it. What it does
 * hold is a `TokenCache`, and even that is shared with every other client of
 * the same process so that a worker polling six of one user's jobs performs one
 * exchange rather than six.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE THREE HEADERS, AND WHAT EACH ONE BREAKS
 *
 *   `Authorization: Bearer <token>`  the IAM token, not the API key. The key
 *                                    itself is refused with a 401.
 *   `Service-CRN: <crn>`             which instance pays. Absent, the service
 *                                    answers as though the account had no
 *                                    instances at all.
 *   `IBM-API-Version: <YYYY-MM-DD>`  the response *shape*. A wrong value still
 *                                    answers 200, with an older shape — see
 *                                    `backends.ts`, where that trap is argued.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE RETRY, ON EXACTLY ONE FAILURE
 *
 * A 401 mid-poll means the cached token expired despite the refresh margin —
 * a process suspended, a clock that jumped. It is retried once, after
 * invalidating the cache, because the second attempt exchanges a fresh token
 * and is overwhelmingly likely to succeed.
 *
 * Nothing else is retried here. A 429 and a 5xx *are* retryable, but the right
 * place to wait is the poll schedule in `apps/worker`, which already re-queues
 * with a delay and survives a process restart; retrying inside a request
 * handler would hold a database connection and a BullMQ lock while it slept.
 * The failure carries `retryable` so the caller can tell the difference.
 */

import { deviceTargetFromIbm } from '@qsim/transpile'
import type { DeviceTarget } from '@qsim/transpile'
import type { z } from 'zod'
import {
  BackendListSchema,
  BackendStatusSchema,
  ConfigurationSchema,
  LegacyBackendListSchema,
  PropertiesSchema,
  byAvailability,
  toBackend,
  toStatusReading,
} from './backends.js'
import type { IbmBackend, IbmBackendStatusReading } from './backends.js'
import { parseCrn } from './crn.js'
import {
  IbmError,
  RESULTS_NOT_READY,
  failureCodeForStatus,
  serviceErrorCodes,
  serviceErrorSummary,
} from './errors.js'
import type { TokenCache } from './iam.js'
import {
  JobDocumentSchema,
  SubmitJobResponseSchema,
  submitJobBody,
  toJobReading,
} from './jobs.js'
import type { JobReading, SubmitJobInput } from './jobs.js'
import { describeRequest } from './redact.js'
import { ResultsDocumentSchema, resultsPending, samplesOf } from './results.js'
import type { RegisterSamples } from './results.js'
import { DEFAULT_TIMEOUT_MS, retryAfterSeconds } from './transport.js'
import type { HttpRequest, HttpTransport } from './transport.js'

/**
 * The API version this build is written against.
 *
 * Pinned, and a constant rather than configuration. The header decides the
 * response *shape* (see `backends.ts`), so an operator who changed it through
 * an environment variable would be changing a contract this package's parsers
 * encode — and would find out through a listing that silently lost its queue
 * numbers rather than through a boot failure. It moves when a person reads the
 * changelog and updates the schemas in the same commit.
 */
export const IBM_API_VERSION = '2025-05-01'

/** How this system identifies itself. Read by nobody, useful in their logs. */
export const USER_AGENT = 'the-q-simulator/1.0'

/** The provider string stored in `HardwareCredential.provider` (§7). */
export const IBM_PROVIDER = 'ibm_quantum'

export interface IbmClientOptions {
  /** The instance CRN. Decides the region, and therefore the host. */
  readonly crn: string
  /**
   * The credential's identity — a `HardwareCredential.id`, never the key.
   *
   * It is the token cache's key, so it must be stable for one credential and
   * distinct between two. See `TokenCache` for why keying by the secret itself
   * would be a map with a secret in its keys.
   */
  readonly credentialId: string
  /** Reads and decrypts the API key. Called only when a token is exchanged. */
  readonly apiKey: () => Promise<string>
  readonly transport: HttpTransport
  readonly tokens: TokenCache
  readonly timeoutMs?: number
}

export interface IbmClient {
  /** Every device this instance can see, best first. */
  backends(): Promise<readonly IbmBackend[]>
  /** One device's live status. Fresher than the listing. */
  backendStatus(name: string): Promise<IbmBackendStatusReading>
  /**
   * One device as `@qsim/transpile` needs it: topology plus calibration.
   *
   * Two requests, composed here rather than by the caller, because the pairing
   * is the interesting part: a target built from the configuration alone has no
   * error rates, and the placement search then has nothing to prefer with. It
   * says so through `DeviceGraph.calibrated` rather than inventing numbers, so
   * a properties read that fails degrades to a usable target instead of failing
   * the request.
   */
  deviceTarget(name: string): Promise<DeviceTarget>
  /** Submits a job. Answers the provider's id for it. Spends QPU time. */
  submitJob(input: SubmitJobInput): Promise<string>
  /** One job's status, as this system's vocabulary. */
  readJob(providerJobId: string): Promise<JobReading>
  /**
   * A finished job's samples, or `null` while it is still running.
   *
   * `null` rather than a throw for "not ready", because that is the ordinary
   * answer to a poll and an exception would make the common path the
   * exceptional one — see `results.ts`.
   */
  readResults(
    providerJobId: string,
    register: string
  ): Promise<RegisterSamples | null>
  /** Asks the service to cancel. Idempotent as far as this system is concerned. */
  cancelJob(providerJobId: string): Promise<void>
}

export function createIbmClient(options: IbmClientOptions): IbmClient {
  // Throws `InvalidCrnError` here rather than on the first call, so a credential
  // that cannot address any host is refused where it is created.
  const { baseUrl } = parseCrn(options.crn)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function headers(): Promise<Record<string, string>> {
    const token = await options.tokens.tokenFor(
      options.credentialId,
      options.apiKey
    )
    return {
      authorization: `Bearer ${token}`,
      'service-crn': options.crn,
      'ibm-api-version': IBM_API_VERSION,
      accept: 'application/json',
      'user-agent': USER_AGENT,
    }
  }

  /**
   * One call, with the single 401 retry described in the header.
   *
   * Returns the raw response rather than a parsed body, because two callers
   * need to look at a non-2xx before it becomes an error: the results read,
   * where a 400 can mean "not yet", and the cancel, where a 404 can mean
   * "already gone".
   */
  async function call(
    method: HttpRequest['method'],
    path: string,
    body: unknown = undefined
  ) {
    const url = `${baseUrl}${path}`
    const encoded = body === undefined ? null : JSON.stringify(body)

    async function once() {
      const base = await headers()
      return options.transport({
        method,
        url,
        headers:
          encoded === null
            ? base
            : { ...base, 'content-type': 'application/json' },
        body: encoded,
        timeoutMs,
      })
    }

    const first = await once()
    if (first.status !== 401) return { response: first, url }
    /*
     * The cached token was refused. Forget it and try once more — the second
     * attempt exchanges a fresh one. If that is refused too, the credential
     * itself is wrong and `expect2xx` reports IBM_CREDENTIAL_INVALID, which is
     * the one failure the person who typed the key can act on.
     */
    options.tokens.invalidate(options.credentialId)
    return { response: await once(), url }
  }

  /** A response that is not 2xx, as a classified error. */
  function refuse(
    method: HttpRequest['method'],
    url: string,
    response: { status: number; headers: Readonly<Record<string, string>> },
    parsed: unknown
  ): IbmError {
    const summary = serviceErrorSummary(parsed)
    return new IbmError(
      failureCodeForStatus(response.status),
      `${describeRequest(method, url)} answered ${String(response.status)}` +
        (summary === '' ? '' : `: ${summary}`),
      {
        status: response.status,
        retryAfterSeconds: retryAfterSeconds(response.headers),
      }
    )
  }

  /** The body of a 2xx, parsed as JSON, or a named malformed-response error. */
  function decode(
    method: HttpRequest['method'],
    url: string,
    body: string
  ): unknown {
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new IbmError(
        'IBM_MALFORMED_RESPONSE',
        `${describeRequest(method, url)} answered 2xx with a body that is ` +
          'not JSON',
        { cause: error }
      )
    }
  }

  /**
   * A 2xx body, parsed and validated, or a classified failure.
   *
   * The schema failure is `IBM_MALFORMED_RESPONSE` and never a validation error
   * shown to a user: a 200 whose shape this build does not recognise is a
   * version drift or a bug here, and telling somebody their request was invalid
   * would send them to fix a thing that is not broken.
   */
  async function json<Schema extends z.ZodType>(
    method: HttpRequest['method'],
    path: string,
    schema: Schema,
    body?: unknown
  ): Promise<z.infer<Schema>> {
    const { response, url } = await call(method, path, body)
    const parsed =
      response.body === '' ? {} : decode(method, url, response.body)
    if (response.status < 200 || response.status >= 300) {
      throw refuse(method, url, response, parsed)
    }
    const result = schema.safeParse(parsed)
    if (!result.success) {
      throw new IbmError(
        'IBM_MALFORMED_RESPONSE',
        `${describeRequest(method, url)} answered a shape this build does ` +
          `not recognise (IBM-API-Version ${IBM_API_VERSION})`
      )
    }
    return result.data
  }

  /**
   * A device's live status.
   *
   * A named function rather than a method reached through `this`, because
   * `deviceTarget` calls it: an object literal that calls its own sibling
   * through `this` is one destructuring away from a runtime `undefined`, and
   * this object is deliberately the kind of thing a caller destructures.
   */
  async function readBackendStatus(
    name: string
  ): Promise<IbmBackendStatusReading> {
    const document = await json(
      'GET',
      `/backends/${encodeURIComponent(name)}/status`,
      BackendStatusSchema
    )
    return toStatusReading(document)
  }

  return {
    async backends() {
      const { response, url } = await call('GET', '/backends')
      const parsed =
        response.body === '' ? {} : decode('GET', url, response.body)
      if (response.status < 200 || response.status >= 300) {
        throw refuse('GET', url, response, parsed)
      }

      const listing = BackendListSchema.safeParse(parsed)
      if (listing.success) {
        return listing.data.devices.map(toBackend).sort(byAvailability)
      }

      /*
       * A legacy-shaped answer, refused by name. See `backends.ts`: an
       * `IBM-API-Version` this service does not recognise still answers 200,
       * with a list of *strings*, and a lenient parser would report every
       * device as having no queue at all. Choosing between a device with fifteen
       * jobs waiting and one with twenty-four thousand is the whole point of
       * this call, so an answer that cannot say is a failure and not a listing.
       */
      if (LegacyBackendListSchema.safeParse(parsed).success) {
        throw new IbmError(
          'IBM_MALFORMED_RESPONSE',
          'the backend listing came back in the pre-2025 shape, which ' +
            'carries no queue length. The IBM-API-Version header was not ' +
            'understood.',
          { status: response.status }
        )
      }
      throw new IbmError(
        'IBM_MALFORMED_RESPONSE',
        'the backend listing is not a shape this build recognises',
        { status: response.status }
      )
    },

    backendStatus: readBackendStatus,

    async deviceTarget(name) {
      const encoded = encodeURIComponent(name)
      const configuration = await json(
        'GET',
        `/backends/${encoded}/configuration`,
        ConfigurationSchema
      )

      /*
       * The calibration is optional and its failure is swallowed. A target
       * without error rates still places a circuit — the search falls back to
       * topology alone and reports `calibrated: false` — whereas a failed
       * request here would refuse to show somebody a device that is working.
       * The one thing that must never happen is a *fabricated* zero, and that
       * is `deviceTargetFromIbm`'s rule rather than this one's.
       */
      let properties: z.infer<typeof PropertiesSchema> | undefined
      try {
        properties = await json(
          'GET',
          `/backends/${encoded}/properties`,
          PropertiesSchema
        )
      } catch {
        properties = undefined
      }

      /*
       * Same reasoning as the calibration above: a device whose status cannot
       * be read is still a device, and a queue length nobody could fetch is
       * `undefined` rather than zero — the difference between "we do not know"
       * and "nothing is waiting", which is the one thing a person choosing a
       * backend must not be lied to about.
       */
      const status = await readBackendStatus(name).catch(() => null)
      const queueLength = status?.queueLength ?? null

      return deviceTargetFromIbm(
        { ...configuration, backend_name: configuration.backend_name ?? name },
        properties,
        queueLength === null ? undefined : { queueLength }
      )
    },

    async submitJob(input) {
      const answer = await json(
        'POST',
        '/jobs',
        SubmitJobResponseSchema,
        submitJobBody(input)
      )
      return answer.id
    },

    async readJob(providerJobId) {
      const document = await json(
        'GET',
        `/jobs/${encodeURIComponent(providerJobId)}`,
        JobDocumentSchema
      )
      return toJobReading(document)
    },

    async readResults(providerJobId, register) {
      const path = `/jobs/${encodeURIComponent(providerJobId)}/results`
      const { response, url } = await call('GET', path)
      const parsed =
        response.body === '' ? {} : decode('GET', url, response.body)

      if (
        resultsPending(
          response.status,
          serviceErrorCodes(parsed),
          RESULTS_NOT_READY
        )
      ) {
        return null
      }
      if (response.status < 200 || response.status >= 300) {
        throw refuse('GET', url, response, parsed)
      }

      const document = ResultsDocumentSchema.safeParse(parsed)
      if (!document.success) {
        throw new IbmError(
          'IBM_MALFORMED_RESPONSE',
          'the results document is not a shape this build recognises'
        )
      }
      return samplesOf(document.data, register)
    },

    async cancelJob(providerJobId) {
      const path = `/jobs/${encodeURIComponent(providerJobId)}/cancel`
      const { response, url } = await call('POST', path)
      /*
       * 404 is success here. A job the service has never heard of, or has
       * already reaped, is a job that is not going to run — which is exactly
       * what the caller asked for. Reporting it as a failure would leave a row
       * the user cancelled sitting in RUNNING because the cancellation "failed".
       */
      if (response.status === 404) return
      if (response.status < 200 || response.status >= 300) {
        const parsed =
          response.body === '' ? {} : decode('POST', url, response.body)
        throw refuse('POST', url, response, parsed)
      }
    },
  }
}
