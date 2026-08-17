/**
 * A real socket against a real app, for the relay-authz verification.
 *
 * Independent of the implementation's own suites on purpose: nothing here is
 * imported from `ws/*.test.ts`. What is reused is only the *harness* the whole
 * package uses — `createTestApp` (so the hooks, the verifier and the compilers
 * are the production ones) and the in-memory circuit repository (so no row of
 * the owner's only database is touched).
 *
 * Unlike the session's own unit tests this listens on a port and speaks
 * WebSocket, because half the questions in this lens are about the transport:
 * what the upgrade refuses, what `maxPayload` refuses, what a close code says,
 * and how much a peer can spend before anything counts it.
 *
 * The client is Node's own global `WebSocket` rather than the `ws` package,
 * which is not a dependency of this app: `ws` arrives only under
 * `@fastify/websocket`, and reaching into another package's tree is not a
 * dependency this verification should invent.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { projectCircuit, writeCircuit } from '@qsim/collab'
import type { Circuit } from '@qsim/schema'
import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import { createTestApp, TEST_WEB_ORIGIN } from '../../testing/app.js'
import {
  createMemoryCircuitRepository,
  type MemoryCircuitRepository,
} from '../../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
  type TestSigningKey,
  type TokenOverrides,
} from '../../testing/tokens.js'

/** Node's `WebSocket` accepts a non-standard header bag; the types do not. */
interface SocketOptions {
  readonly headers?: Record<string, string>
}

const SocketClient = WebSocket as unknown as new (
  url: string,
  options?: SocketOptions
) => WebSocket

export interface Relay {
  readonly app: FastifyInstance
  readonly repository: MemoryCircuitRepository
  readonly url: string
  readonly port: number
  readonly origin: string
  readonly token: (overrides?: TokenOverrides) => Promise<string>
  readonly close: () => Promise<void>
}

export async function startRelay(
  envOverrides: Record<string, string> = {}
): Promise<Relay> {
  const repository = createMemoryCircuitRepository()
  const key: TestSigningKey = await createSigningKey('relay-authz-key')
  const endpoint = stubJwksEndpoint([key])
  const app = await createTestApp({
    circuits: { repository },
    jwks: createTestJwksCache(endpoint),
    envOverrides,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return {
    app,
    repository,
    url: `ws://127.0.0.1:${String(port)}/ws`,
    port,
    origin: TEST_WEB_ORIGIN,
    token: (overrides = {}) => signToken(key, overrides),
    close: async () => {
      await app.close()
    },
  }
}

export interface Frame {
  readonly type: string
  readonly [key: string]: unknown
}

export interface Peer {
  readonly socket: WebSocket
  readonly frames: Frame[]
  readonly send: (frame: unknown) => void
  readonly raw: (text: string) => void
  readonly waitFor: (
    predicate: (frame: Frame) => boolean,
    timeoutMs?: number
  ) => Promise<Frame>
  readonly quiet: (ms: number) => Promise<void>
  readonly closeCode: () => number | null
  readonly waitClosed: (timeoutMs?: number) => Promise<number>
  readonly close: () => void
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function connect(
  relay: Relay,
  options: { readonly bearer?: string; readonly origin?: string | null } = {}
): Promise<Peer> {
  const headers: Record<string, string> = {}
  const origin = options.origin === undefined ? relay.origin : options.origin
  if (origin !== null) headers.origin = origin
  if (options.bearer !== undefined) {
    headers.authorization = `Bearer ${options.bearer}`
  }

  const socket = new SocketClient(relay.url, { headers })
  const frames: Frame[] = []
  let closeCode: number | null = null
  let failed: Error | null = null

  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(JSON.parse(String(event.data)) as Frame)
  })
  socket.addEventListener('close', (event: CloseEvent) => {
    closeCode = event.code
  })
  socket.addEventListener('error', () => {
    failed = new Error('the socket errored')
  })

  const peer: Peer = {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    raw: (text) => socket.send(text),
    waitFor: async (predicate, timeoutMs = 3_000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = frames.find((frame) => predicate(frame))
        if (found !== undefined) return found
        if (Date.now() > deadline) {
          throw new Error(
            `no frame matched in ${String(timeoutMs)}ms; saw ` +
              JSON.stringify(frames.map((frame) => frame.type)) +
              ` closeCode=${String(closeCode)}`
          )
        }
        await pause(10)
      }
    },
    quiet: pause,
    closeCode: () => closeCode,
    waitClosed: async (timeoutMs = 3_000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (closeCode !== null) return closeCode
        if (Date.now() > deadline) throw new Error('the socket did not close')
        await pause(10)
      }
    },
    close: () => {
      socket.close()
    },
  }

  const deadline = Date.now() + 5_000
  while (socket.readyState === socket.CONNECTING) {
    if (Date.now() > deadline) throw new Error('the socket did not open')
    await pause(10)
  }
  if (failed !== null || socket.readyState !== socket.OPEN) {
    throw new Error('the upgrade was refused')
  }
  await peer.waitFor((frame) => frame.type === 'ready')
  return peer
}

/**
 * The raw upgrade, for the questions a WebSocket client hides.
 *
 * A refused upgrade reaches a browser as a close with code 1006 and nothing
 * else, so the status the API answered — 401 for a token that does not verify,
 * 403 for a foreign origin, 429 for too many held connections — is only
 * observable from a plain HTTP request that asks for the upgrade.
 */
export function upgradeStatus(
  relay: Relay,
  headers: Record<string, string> = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      port: relay.port,
      host: '127.0.0.1',
      path: '/ws',
      // A fresh connection per probe: a refused upgrade leaves the socket in a
      // state the agent's pool must not hand to the next request.
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
    })
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve(101)
    })
    request.on('error', reject)
    request.end()
  })
}

/** Base64 of some bytes, as a frame carries a CRDT update. */
export function payload(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function decodePayload(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(String(value), 'base64'))
}

/**
 * The document a joined peer holds, built the way a browser builds it.
 *
 * A delta produced against a document that does not share history with the
 * relay's copy is not applied at all — it waits in Yjs's pending queue for
 * items it will never see — so an update that is meant to be *accepted* has to
 * be written on top of the state the join frame carried. Anything else tests
 * nothing: the relay would accept bytes that change no document.
 */
export function peerDocument(joined: Frame): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, decodePayload(joined.update), 'joined')
  return doc
}

/** One edit on a joined peer's document, as the bytes it would send. */
export function editUpdate(
  doc: Y.Doc,
  mutate: (circuit: Circuit) => Circuit
): Uint8Array {
  const before = Y.encodeStateVector(doc)
  const baseline = projectCircuit(doc)
  writeCircuit(doc, mutate(baseline.circuit), { origin: 'peer', baseline })
  return Y.encodeStateAsUpdate(doc, before)
}
