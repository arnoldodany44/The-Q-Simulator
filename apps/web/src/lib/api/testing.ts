/**
 * A `fetch` that never touches a network, and the fixtures the suites share.
 *
 * The client is built over a real function rather than a mocking library on
 * purpose: what is under test is how one request turns into one `fetch` call
 * and one parsed result, and a stub that records its arguments proves that
 * more directly — and more readably — than an assertion about a mock.
 *
 * Imported only from `*.test.ts` files, so it never enters a bundle — Vite
 * builds from `main.tsx` and nothing on that graph reaches here. A boundary
 * rule (`web-testing-helpers-stay-in-tests`) makes that a property rather
 * than a coincidence, the same way `apps/api/src/testing` is guarded.
 */

import { emptyCircuit } from '@qsim/schema'
import type {
  CircuitDetail,
  CircuitVersion,
  CircuitView,
  CircuitWithVersion,
} from '@qsim/contract'

import type { FetchLike } from './client.js'

export interface RecordedCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

export interface StubFetch {
  readonly fetch: FetchLike
  /** Every call, in order. */
  readonly calls: RecordedCall[]
  /** The most recent call, for the common single-request case. */
  readonly last: () => RecordedCall
  /** Headers of the most recent call, normalised to lowercase names. */
  readonly lastHeaders: () => Record<string, string>
  /** Body of the most recent call, parsed back from JSON. */
  readonly lastBody: () => unknown
}

/** Builds a `Response` without needing one from a server. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The shape the API's error handler produces, for the failure paths. */
export function errorResponse(
  code: string,
  status: number,
  extras: { requestId?: string; details?: unknown } = {}
): Response {
  return jsonResponse(
    {
      error: {
        code,
        // Fixed developer-facing English, exactly as the API sends it. No
        // test asserts it reaches a user, because it must not.
        message: 'Developer-facing text the client must never display.',
        requestId: extras.requestId ?? 'req-test',
        ...(extras.details === undefined ? {} : { details: extras.details }),
      },
    },
    status
  )
}

/**
 * A stub whose queue is consumed one entry per call. A `Response` resolves;
 * anything else rejects with itself.
 *
 * The discrimination is `instanceof Response` rather than `instanceof Error`,
 * and that is not a style choice: a `DOMException` — which is what an aborted
 * `fetch` throws — does not extend `Error` in every runtime, so testing for
 * `Error` silently resolved the abort case as if it were a response.
 */
export function stubFetch(responses: readonly unknown[]): StubFetch {
  const calls: RecordedCall[] = []
  let index = 0

  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init })
    if (index >= responses.length) {
      return Promise.reject(
        new Error(`stubFetch: no response queued for ${url}`)
      )
    }
    const next = responses[index++]
    if (next instanceof Response) return Promise.resolve(next)
    /*
     * `fetch` rejects with whatever the platform threw, and one of the cases
     * under test is a `DOMException`, which is not an `Error` subclass
     * everywhere. So this deliberately rejects with the queued value as-is
     * rather than wrapping it — wrapping would test a failure mode the
     * browser never produces.
     */
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(next)
  }

  function last(): RecordedCall {
    const call = calls.at(-1)
    if (call === undefined) throw new Error('stubFetch: no call was made')
    return call
  }

  return {
    fetch: fetchImpl,
    calls,
    last,
    lastHeaders: () => {
      const headers = last().init?.headers ?? {}
      return Object.fromEntries(
        Object.entries(headers as Record<string, string>).map(
          ([key, value]) => [key.toLowerCase(), value]
        )
      )
    },
    lastBody: (): unknown => {
      const body = last().init?.body
      return typeof body === 'string' ? (JSON.parse(body) as unknown) : body
    },
  }
}

export const TEST_BASE_URL = 'https://api.example.test'

const CREATED_AT = '2024-05-01T10:00:00.000Z'

/** A circuit exactly as the API serialises it: timestamps as ISO strings. */
export const circuitDetailPayload = {
  id: 'cir_1',
  slug: 'V1StGXR8Z5jdHi6BmyT8a',
  title: 'Bell pair',
  visibility: 'PUBLIC',
  qubitCount: 2,
  gateCount: 2,
  depth: 2,
  starCount: 0,
  viewCount: 3,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  owner: { id: 'usr_1', username: 'ada', avatarUrl: null },
  description: null,
  // Canonical spellings, sorted, exactly as the API sends them (M1.5).
  tags: [],
  // The card's thumbnail (M1.5b), as `previewOf` derives it from the Bell
  // pair this fixture describes. Written out rather than computed so that a
  // change to the derivation shows up here as a decision rather than as a
  // fixture that quietly followed it.
  preview: {
    qubits: 2,
    columns: 2,
    truncated: false,
    operations: [
      { gate: 'h', column: 0, targets: [0], controls: [] },
      { gate: 'cx', column: 1, targets: [1], controls: [0] },
    ],
  },
}

export const versionPayload = {
  id: 'ver_1',
  versionNum: 1,
  message: null,
  createdAt: CREATED_AT,
  circuit: emptyCircuit(2),
}

export const circuitWithVersionPayload = {
  circuit: circuitDetailPayload,
  version: versionPayload,
}

/**
 * What `GET /circuits/:id` answers from M1.5b: the same pair plus this
 * viewer's own star, which rides in the envelope rather than on the circuit.
 */
export const circuitViewPayload = {
  ...circuitWithVersionPayload,
  starred: false,
}

/** The same values as this app's types see them, after parsing. */
export type ParsedDetail = CircuitDetail
export type ParsedVersion = CircuitVersion
export type ParsedCircuitWithVersion = CircuitWithVersion
export type ParsedCircuitView = CircuitView
