/**
 * @qsim/ibm — the protocol between this system and a real quantum computer.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PACKAGE IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It is the wire: how a user's API key becomes a bearer token, which headers
 * every call carries, what `POST /jobs` receives, and what a finished job
 * answers with. It holds no database, no queue, no lifecycle and no policy —
 * `apps/api` decides who may submit and `apps/worker` decides when to ask again,
 * because those are decisions about *this* system rather than about IBM's.
 *
 * It also holds **no conversion of results into counts**. That lives in
 * `@qsim/transpile`, beside the emitter that decided which classical bit each
 * measurement writes into, and `results.ts` here explains at length why
 * duplicating it would be the most dangerous kind of duplication in this
 * project: the mistake it guards against is invisible on a Bell pair, and a
 * real device gives you no ideal answer to compare against.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FIVE THINGS THAT WERE MEASURED RATHER THAN ASSUMED
 *
 * Each one cost a wrong assumption somewhere, and each is written down beside
 * the code that depends on it:
 *
 *   1. `crn.ts`       the region is the CRN's sixth segment, and an instance in
 *                     another region answers **404** on the global host — with
 *                     a perfectly good token and a live instance behind it.
 *   2. `backends.ts`  `IBM-API-Version` decides the response *shape*, and a
 *                     value the service does not understand still answers
 *                     **200** with the pre-2025 shape, which carries no queue
 *                     length at all.
 *   3. `iam.ts`       IAM answers **400**, not 401, for an API key it does not
 *                     recognise.
 *   4. `results.ts`   a results read on a job that has not finished answers
 *                     **400 with code 1234**, not the documented 204.
 *   5. `jobs.ts`      a pub is `[qasm, null, shots]`, and the job records
 *                     `version: 2, support_qiskit: false`. With `support_qiskit`
 *                     true the results come home as a pickled Qiskit object
 *                     this system could not read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE SPENDS QPU TIME EXCEPT `submitJob`
 *
 * Authentication, the device listing, a configuration, a calibration, a job's
 * status and a job's results are all free. Exactly one call in this package
 * costs the Open Plan's ten minutes per twenty-eight days, and it is the one
 * with a name that says so. Every test in this package and in the two apps runs
 * against `recordedTransport`, and what they assert on is the request that
 * would have been sent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BOUNDARIES (§12.3)
 *
 * Consumed by `apps/api` and `apps/worker`. Never by `apps/web`: a browser
 * holding a user's IBM key would be the whole point of §3.7's "the backend acts
 * as a proxy" inverted. Depends on `@qsim/transpile` (for `DeviceTarget` and the
 * translation of a configuration into one) and on `zod`, and on no `node:`
 * builtin — the transport is a parameter, so this package is environment-free
 * in the same sense the engine is.
 */

export {
  InvalidCrnError,
  MAX_CRN_LENGTH,
  baseUrlFor,
  isQuantumCrn,
  parseCrn,
} from './crn.js'
export type { ParsedCrn } from './crn.js'

export {
  IBM_FAILURE_CODES,
  IbmError,
  RESULTS_NOT_READY,
  failureCodeForStatus,
  isRetryable,
  serviceErrorCodes,
  serviceErrorSummary,
} from './errors.js'
export type { IbmFailureCode } from './errors.js'

export { REDACTED, describeRequest, scrub } from './redact.js'

export {
  DEFAULT_TIMEOUT_MS,
  fetchTransport,
  retryAfterSeconds,
} from './transport.js'
export type { HttpRequest, HttpResponse, HttpTransport } from './transport.js'

export {
  IAM_GRANT_TYPE,
  IAM_TOKEN_URL,
  MAX_ENTRIES,
  REFRESH_MARGIN_MS,
  createTokenCache,
  exchangeApiKey,
} from './iam.js'
export type {
  ExchangeOptions,
  IamToken,
  TokenCache,
  TokenCacheOptions,
} from './iam.js'

export {
  BackendListSchema,
  BackendStatusSchema,
  ConfigurationSchema,
  LegacyBackendListSchema,
  PropertiesSchema,
  byAvailability,
  toBackend,
  toStatusReading,
} from './backends.js'
export type { IbmBackend, IbmBackendStatusReading } from './backends.js'

export {
  HARDWARE_JOB_STATUSES,
  IBM_JOB_STATUSES,
  JobDocumentSchema,
  PUB_VERSION,
  SAMPLER_PROGRAM_ID,
  SubmitJobResponseSchema,
  hardwareStatusOf,
  isTerminal,
  submitJobBody,
  toJobReading,
} from './jobs.js'
export type {
  HardwareJobStatus,
  IbmJobStatus,
  JobDocument,
  JobReading,
  SamplerPub,
  SubmitJobBody,
  SubmitJobInput,
} from './jobs.js'

export {
  MAX_SAMPLES,
  ResultsDocumentSchema,
  resultsPending,
  samplesOf,
} from './results.js'
export type { RegisterSamples, ResultsDocument } from './results.js'

export {
  IBM_API_VERSION,
  IBM_PROVIDER,
  USER_AGENT,
  createIbmClient,
} from './client.js'
export type { IbmClient, IbmClientOptions } from './client.js'
