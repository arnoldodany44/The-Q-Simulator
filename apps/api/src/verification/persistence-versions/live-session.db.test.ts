/**
 * What a shared session leaves behind — verified against the real thing.
 *
 * Independent verification of Fase 5 through the lens of persistence and
 * versions. Nothing here is a unit test: two `buildApp` instances listen on
 * loopback ports, they talk to the project's real Postgres and the real Redis,
 * and the peers are real `WebSocket` clients holding real `Y.Doc`s. The
 * questions it answers are the ones only a running system can:
 *
 *   1. Does a document survive everybody leaving? Close every socket, read the
 *      row back, rebuild it, and check the circuit is the merge of what both
 *      peers did.
 *   2. Does an edit on replica A reach a peer on replica B? Two apps, one Redis,
 *      one circuit.
 *   3. When a session becomes a version, do the two stores agree afterwards —
 *      the row gone, the counters recomputed, the version immutable?
 *   4. Does a *restore* survive a live session? This is the one the design
 *      document makes a claim about ("`appendVersion` deletes the row in the
 *      same transaction, which is what makes restoring version 3 not undo
 *      itself"), and the claim is about the row rather than about the document
 *      the relay is still holding in memory.
 *   5. Does a redeploy keep the last few seconds? SIGTERM is `app.close()`, and
 *      the debounce means the row may be up to fifteen seconds behind.
 *
 * ── Run it deliberately ───────────────────────────────────────────────────
 *
 *   QSIM_PV_E2E=1 pnpm --filter api test src/verification/persistence-versions
 *
 * It is gated for the reason the `@qsim/db` integration suite is: it writes to
 * the project's only database, opens Redis connections against a metered
 * instance, and binds ports. A pull request must not do any of that.
 *
 * ── The hygiene rules, which are not negotiable ───────────────────────────
 *
 * 1. Everything created belongs to one reserved identity whose UUID and e-mail
 *    are recognisably this file's (`.invalid` is reserved by RFC 2606), and
 *    which is distinct from the ids the `@qsim/db` suite reserves so the two
 *    can run at once.
 * 2. Cleanup deletes that one `User` row and nothing else. The circuit cascades
 *    from the user, the versions and the session row cascade from the circuit.
 * 3. Nothing here reads or asserts over a row it did not create.
 * 4. Redis is used only as pub/sub under a probe-specific `QUEUE_PREFIX`, so no
 *    key is written and no production channel is touched.
 * 5. No identity provider is contacted: the API is pointed at a loopback JWKS
 *    document this file mints, so the tokens are this file's own.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyCircuitUpdate,
  projectCircuit,
  writeCircuit,
  type CircuitProjection,
} from '@qsim/collab'
import {
  MAX_COLLAB_STATE_BYTES,
  decodeBinaryPayload,
  encodeBinaryPayload,
  type ClientFrame,
  type ServerFrame,
} from '@qsim/contract'
import {
  CIRCUIT_SCHEMA_VERSION,
  validateCircuit,
  type Circuit,
} from '@qsim/schema'
import {
  Visibility,
  disconnectPrismaClient,
  getPrismaClient,
  metricsOf,
  prismaCircuitRepository,
  type CircuitRepository,
} from '@qsim/db'
import type { PrismaClient } from '@qsim/db'
import { buildApp } from '../../app.js'
import { loadEnv } from '../../env.js'
/*
 * The token minting lives in `src/testing/` and is imported rather than
 * repeated here: that directory is the one place `apps/api` may reach for
 * `jose`, precisely because its job is to sign tokens with a key pair it
 * generated itself so the real verifier can be exercised instead of mocked.
 */
import { createSigningKey, signToken } from '../../testing/tokens.js'

/*
 * A suite that must not run in CI needs its own gate, and a gate read through
 * `loadEnv` would be a configuration key the service does not have.
 */
// eslint-disable-next-line no-restricted-globals
const enabled = process.env.QSIM_PV_E2E === '1'

/**
 * Reserved for this file alone. See hygiene rule 1.
 *
 * Distinct from the two UUIDs `@qsim/db`'s integration suite reserves, so the
 * two can run against the same database at the same time.
 */
const OWNER = {
  id: '00000000-0000-4000-8000-0000000dfa01',
  email: 'qsim-verify-pv-owner@example.invalid',
  displayName: 'Persistence Verifier',
  avatarUrl: null,
}

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/* ── the environment, read by hand ──────────────────────────────────────── */

/**
 * The repo-root `.env`, parsed here rather than loaded into `process.env`.
 *
 * `vitest.config.ts` deliberately blanks `DATABASE_URL` and friends for this
 * package, and `process.loadEnvFile` does not override a value that is already
 * set — so a suite that needs the real connection string has to read the file
 * itself. Only the four keys below are ever looked up, and none is logged.
 */
function readDotEnv(): Record<string, string> {
  const file = resolve(import.meta.dirname, '../../../../../.env')
  if (!existsSync(file)) return {}
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match === null) continue
    const [, key, raw] = match as unknown as [string, string, string]
    values[key] = raw.replace(/^['"]|['"]$/g, '')
  }
  return values
}

const dotEnv = readDotEnv()
const databaseUrl = dotEnv.DATABASE_URL ?? ''
const runnable = enabled && databaseUrl !== ''

/* ── a loopback identity provider ───────────────────────────────────────── */

interface Identity {
  readonly issuer: string
  readonly jwksUrl: string
  readonly server: Server
  readonly token: (subject: string) => Promise<string>
}

/**
 * An ES256 key pair, published as a JWKS on a loopback port.
 *
 * The API's trust anchor is `SUPABASE_JWKS_URL`, and `env.ts` accepts `http`
 * on loopback precisely so a local Supabase stack works — so a verifier can be
 * its own Supabase without weakening anything: the key is generated in this
 * process, lives for the length of the suite, and signs tokens for one
 * reserved subject.
 */
async function startIdentity(): Promise<Identity> {
  const key = await createSigningKey('pv-verify')
  const body = JSON.stringify({ keys: [key.publicJwk] })

  const server = createServer((request, response) => {
    if (request.url === '/keys') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the identity server did not bind')
  }
  const origin = `http://127.0.0.1:${String(address.port)}`

  return {
    issuer: `${origin}/auth/v1`,
    jwksUrl: `${origin}/keys`,
    server,
    token: (subject) =>
      signToken(key, {
        subject,
        email: OWNER.email,
        issuer: `${origin}/auth/v1`,
      }),
  }
}

/* ── a replica ──────────────────────────────────────────────────────────── */

type App = Awaited<ReturnType<typeof buildApp>>

interface Replica {
  readonly app: App
  readonly port: number
}

async function startReplica(
  identity: Identity,
  client: PrismaClient
): Promise<Replica> {
  const env = loadEnv({
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    // Not the port it binds — `listen({ port: 0 })` below asks the operating
    // system for a free one. `loadEnv` will not accept 0, and the value it
    // holds is never read by anything this suite drives.
    PORT: '8080',
    HOST: '127.0.0.1',
    WEB_URL: 'http://127.0.0.1:5173',
    DATABASE_URL: databaseUrl,
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_JWKS_URL: identity.jwksUrl,
    SUPABASE_JWT_ISSUER: identity.issuer,
    // Namespaced away from anything real. See hygiene rule 4.
    QUEUE_PREFIX: 'qsim-verify-pv',
    ...(dotEnv.REDIS_URL === undefined ? {} : { REDIS_URL: dotEnv.REDIS_URL }),
  })
  /*
   * The client is injected so that closing one replica does not disconnect the
   * singleton the other replica and this suite are still using — the database
   * plugin's `onClose` returns early for a client it was handed.
   */
  const app = await buildApp({ env, database: { client } })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('a replica did not bind')
  }
  return { app, port: address.port }
}

/* ── a peer ─────────────────────────────────────────────────────────────── */

/**
 * One browser, as far as the relay can tell: a socket, a token and a Y.Doc.
 *
 * The client half of the bridge is deliberately re-implemented here in twenty
 * lines rather than imported from `apps/web`, because `apps/web` has no
 * transport for this channel at all (see the finding) and because a verifier
 * that shares the implementation's plumbing shares its blind spots.
 */
class Peer {
  readonly doc = new Y.Doc()
  readonly frames: ServerFrame[] = []
  /** The bytes of every `collab:joined`/`collab:update` frame, as they arrived. */
  readonly received: Uint8Array[] = []
  private socket!: WebSocket
  private baseline: CircuitProjection = projectCircuit(this.doc)
  private readonly origin = { qsim: 'verify-peer' }

  constructor(
    readonly name: string,
    readonly circuitId: string,
    private readonly port: number,
    private readonly token: string
  ) {}

  async open(): Promise<void> {
    this.socket = new WebSocket(`ws://127.0.0.1:${String(this.port)}/ws`)
    await new Promise<void>((ready, fail) => {
      this.socket.addEventListener('open', () => ready(), { once: true })
      this.socket.addEventListener('error', () => fail(new Error('ws error')), {
        once: true,
      })
    })
    this.socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame
      this.frames.push(frame)
      if (frame.type === 'collab:joined' || frame.type === 'collab:update') {
        const bytes = decodeBinaryPayload(frame.update)
        if (bytes !== null && bytes.byteLength > 0) {
          this.received.push(bytes)
          /*
           * `maxBytes` is passed deliberately: the default ceiling in
           * `applyCircuitUpdate` is 256 KiB while the relay will send up to
           * `MAX_COLLAB_STATE_BYTES` (512 KiB), and a peer that took the
           * default would silently hold an empty document after a successful
           * join. See the large-circuit test, which measures exactly that.
           */
          applyCircuitUpdate(this.doc, bytes, {
            origin: 'remote',
            maxBytes: MAX_COLLAB_STATE_BYTES,
          })
          this.baseline = projectCircuit(this.doc)
        }
      }
    })
    await this.awaitFrame((frame) => frame.type === 'ready')
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame))
  }

  async authenticate(): Promise<void> {
    const before = this.frames.length
    this.send({ type: 'authenticate', token: this.token })
    const ready = await this.awaitFrame(
      (frame) => frame.type === 'ready',
      before
    )
    if (ready.type !== 'ready' || ready.viewer === null) {
      throw new Error(`${this.name} was not authenticated`)
    }
  }

  async join(): Promise<ServerFrame> {
    const before = this.frames.length
    this.send({ type: 'collab:join', circuitId: this.circuitId })
    return this.awaitFrame(
      (frame) =>
        frame.type === 'collab:joined' || frame.type === 'collab:error',
      before
    )
  }

  /** Edits the local document and sends the difference, as a bridge would. */
  edit(mutate: (circuit: Circuit) => Circuit): void {
    const next = mutate(this.baseline.circuit)
    const before = Y.encodeStateVector(this.doc)
    this.baseline = writeCircuit(this.doc, next, {
      origin: this.origin,
      baseline: this.baseline,
    })
    const update = Y.encodeStateAsUpdate(this.doc, before)
    this.send({
      type: 'collab:update',
      circuitId: this.circuitId,
      update: encodeBinaryPayload(update),
    })
  }

  circuit(): Circuit {
    return projectCircuit(this.doc).circuit
  }

  async awaitFrame(
    predicate: (frame: ServerFrame) => boolean,
    from = 0,
    timeoutMs = 10_000
  ): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.slice(from).find(predicate)
      if (found !== undefined) return found
      if (Date.now() > deadline) {
        throw new Error(
          `${this.name} waited for a frame that never came; saw ${this.frames
            .slice(from)
            .map((frame) => frame.type)
            .join(', ')}`
        )
      }
      await delay(50)
    }
  }

  close(): void {
    this.socket.close()
  }
}

/* ── helpers over the row this milestone introduced ─────────────────────── */

async function sessionRow(
  prisma: PrismaClient,
  circuitId: string
): Promise<{ state: Uint8Array; updatedAt: Date } | null> {
  const row = await prisma.circuitSession.findUnique({
    where: { circuitId },
    select: { state: true, updatedAt: true },
  })
  return row === null
    ? null
    : { state: Uint8Array.from(row.state), updatedAt: row.updatedAt }
}

/** The circuit a stored session projects to, exactly as the relay would. */
function storedCircuit(state: Uint8Array): CircuitProjection {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return projectCircuit(doc)
}

async function waitForRow(
  prisma: PrismaClient,
  circuitId: string,
  predicate: (row: { state: Uint8Array } | null) => boolean,
  what: string
): Promise<{ state: Uint8Array } | null> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const row = await sessionRow(prisma, circuitId)
    if (predicate(row)) return row
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(250)
  }
}

const gateIds = (circuit: Circuit): string[] =>
  circuit.operations.map((operation) => operation.id).sort()

describe.skipIf(!runnable)(
  'a collaborative session and the rows it leaves',
  () => {
    let prisma: PrismaClient
    let repository: CircuitRepository
    let identity: Identity
    let alpha: Replica
    let beta: Replica
    let token: string

    async function cleanup(): Promise<void> {
      await prisma.user.deleteMany({ where: { id: OWNER.id } })
    }

    beforeAll(async () => {
      /*
       * `getPrismaClient` reads the connection string from the environment, and
       * `vitest.config.ts` blanks it for this package on purpose. Handing it the
       * real value is the one thing this suite cannot do through `loadEnv`.
       */
      // eslint-disable-next-line no-restricted-globals
      process.env.DATABASE_URL = databaseUrl
      prisma = getPrismaClient()
      repository = prismaCircuitRepository(prisma)
      await cleanup()
      identity = await startIdentity()
      token = await identity.token(OWNER.id)
      alpha = await startReplica(identity, prisma)
      beta = await startReplica(identity, prisma)
    }, 120_000)

    afterAll(async () => {
      await alpha?.app.close()
      await beta?.app.close()
      identity?.server.close()
      await cleanup()
      await disconnectPrismaClient()
    }, 120_000)

    async function circuit(): Promise<string> {
      await repository.ensureOwner(OWNER)
      const created = await repository.create({
        ownerId: OWNER.id,
        title: 'Persistence verification',
        description: null,
        visibility: Visibility.PRIVATE,
        data: bell,
        message: 'version 1',
        forkedFromId: null,
      })
      return created.circuit.id
    }

    async function peer(replica: Replica, id: string, name: string) {
      const client = new Peer(name, id, replica.port, token)
      await client.open()
      await client.authenticate()
      const joined = await client.join()
      expect(joined.type).toBe('collab:joined')
      return client
    }

    it('keeps both peers’ work when everybody leaves, across two replicas', async () => {
      const id = await circuit()
      const ana = await peer(alpha, id, 'ana')
      const beto = await peer(beta, id, 'beto')

      // Each peer adds a gate the other has never seen. Nothing collides, so a
      // correct merge holds all four operations.
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'ana-1', gate: 'x', targets: [0], column: 2 },
        ],
      }))
      beto.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'beto-1', gate: 'z', targets: [1], column: 3 },
        ],
      }))

      // Cross-replica fan-out, in both directions: each peer must see the
      // other's gate, and the only path between them is Redis.
      await ana.awaitFrame(
        (frame) =>
          frame.type === 'collab:update' &&
          gateIds(ana.circuit()).includes('beto-1')
      )
      await beto.awaitFrame(
        (frame) =>
          frame.type === 'collab:update' &&
          gateIds(beto.circuit()).includes('ana-1')
      )
      expect(gateIds(ana.circuit())).toStrictEqual(gateIds(beto.circuit()))

      ana.close()
      beto.close()

      const row = await waitForRow(
        prisma,
        id,
        (current) =>
          current !== null &&
          gateIds(storedCircuit(current.state).circuit).includes('beto-1') &&
          gateIds(storedCircuit(current.state).circuit).includes('ana-1'),
        'the row written when the last peer left'
      )
      const stored = storedCircuit(row!.state)

      // A restored document is a legal circuit …
      expect(validateCircuit(stored.circuit)).toStrictEqual([])
      expect(stored.deferred).toStrictEqual([])
      expect(stored.overflow).toBe(0)
      // … it is the merge of everything …
      expect(gateIds(stored.circuit)).toStrictEqual([
        'ana-1',
        'beto-1',
        'op-0',
        'op-1',
      ])
      // … and a peer that reconnects is given it back.
      const returning = await peer(alpha, id, 'returning')
      expect(gateIds(returning.circuit())).toStrictEqual(
        gateIds(stored.circuit)
      )
      returning.close()
    }, 120_000)

    it('turns a session into a version, and the counters follow the version', async () => {
      const id = await circuit()
      const ana = await peer(alpha, id, 'saver')
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'saved-1', gate: 'h', targets: [1], column: 2 },
        ],
      }))
      await waitForRow(prisma, id, (row) => row !== null, 'the session row')

      const saved = ana.circuit()
      const response = await alpha.app.inject({
        method: 'POST',
        url: `/api/v1/circuits/${id}/versions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { circuit: saved, message: 'the session, saved' },
      })
      expect(response.statusCode).toBe(201)

      // The row is gone in the same transaction that wrote the version.
      expect(await sessionRow(prisma, id)).toBeNull()

      // The counters are what the schema computes for what was saved.
      const row = await prisma.circuit.findUniqueOrThrow({
        where: { id },
        select: { qubitCount: true, gateCount: true, depth: true },
      })
      expect(row).toStrictEqual(metricsOf(saved))

      // And the version is immutable: the surface has no way to change one.
      const versions = await repository.listVersions({
        circuitId: id,
        skip: 0,
        take: 10,
      })
      expect(versions.total).toBe(2)
      ana.close()
    }, 120_000)

    it('a restore does not survive the live session it was made from', async () => {
      const id = await circuit()
      const ana = await peer(alpha, id, 'restorer')
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'after-v1', gate: 'x', targets: [0], column: 2 },
        ],
      }))
      await waitForRow(prisma, id, (row) => row !== null, 'the session row')

      // A restore, exactly as `VersionPreview` performs one: the old version's
      // circuit appended as a new version.
      const restore = await alpha.app.inject({
        method: 'POST',
        url: `/api/v1/circuits/${id}/versions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { circuit: bell, message: 'restore of version 1' },
      })
      expect(restore.statusCode).toBe(201)
      expect(await sessionRow(prisma, id)).toBeNull()

      // The session is still open in a tab nobody told about the restore, and
      // the next thing that tab does re-creates the row from the document the
      // relay never stopped holding.
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'after-restore', gate: 'z', targets: [1], column: 4 },
        ],
      }))
      const resurrected = await waitForRow(
        prisma,
        id,
        (row) => row !== null,
        'the row a live session re-creates after a restore'
      )
      const stored = storedCircuit(resurrected!.state).circuit

      // What the head version says, and what the next joiner will be shown.
      const head = await repository.latestVersion(id)
      expect(gateIds(head!.data)).toStrictEqual(['op-0', 'op-1'])
      ana.close()

      const next = await peer(beta, id, 'after-restore-joiner')
      const seen = gateIds(next.circuit())
      next.close()

      // The restore is undone for everybody who opens the circuit next: the
      // pre-restore gate is back, and the version history says it should not be.
      expect(gateIds(stored)).toContain('after-v1')
      expect(seen).toContain('after-v1')
    }, 120_000)

    it('undoes a restore with no further edit, from the debounce alone', async () => {
      const id = await circuit()
      const ana = await peer(alpha, id, 'quiet-restorer')
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'before-restore', gate: 'x', targets: [0], column: 2 },
        ],
      }))

      /*
       * Inside PERSIST_QUIET_MS, so the relay is holding `pending` bytes and an
       * armed timer. Nobody edits anything after this point: the restore is the
       * last action any human takes.
       */
      const restore = await alpha.app.inject({
        method: 'POST',
        url: `/api/v1/circuits/${id}/versions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { circuit: bell, message: 'restore of version 1' },
      })
      expect(restore.statusCode).toBe(201)

      const resurrected = await waitForRow(
        prisma,
        id,
        (row) => row !== null,
        'the row the pending debounce re-creates after a restore'
      )
      ana.close()
      expect(gateIds(storedCircuit(resurrected!.state).circuit)).toContain(
        'before-restore'
      )
    }, 120_000)

    it('hands a peer on another replica a document that was never persisted', async () => {
      const id = await circuit()
      const ana = await peer(alpha, id, 'unpersisted')
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'only-in-memory', gate: 'h', targets: [1], column: 2 },
        ],
      }))
      // No row yet: this edit exists only in replica A's memory, which is the
      // gap `sync-request` is documented to close.
      expect(await sessionRow(prisma, id)).toBeNull()

      const beto = await peer(beta, id, 'catching-up')
      await beto.awaitFrame(() =>
        gateIds(beto.circuit()).includes('only-in-memory')
      )
      expect(gateIds(beto.circuit())).toStrictEqual([
        'only-in-memory',
        'op-0',
        'op-1',
      ])
      ana.close()
      beto.close()
    }, 120_000)

    it('flushes the debounced tail when the process is asked to stop', async () => {
      const id = await circuit()
      const replica = await startReplica(identity, prisma)
      const ana = await peer(replica, id, 'shutdown')
      ana.edit((current) => ({
        ...current,
        operations: [
          ...current.operations,
          { id: 'tail', gate: 'y', targets: [0], column: 2 },
        ],
      }))
      // Deliberately inside PERSIST_QUIET_MS: the row does not exist yet.
      await delay(200)
      expect(await sessionRow(prisma, id)).toBeNull()

      await replica.app.close()

      const row = await sessionRow(prisma, id)
      expect(row).not.toBeNull()
      expect(gateIds(storedCircuit(row!.state).circuit)).toContain('tail')
      ana.close()
    }, 120_000)

    it('shortens a saved circuit that has more operations than a document projects', async () => {
      /*
       * A circuit with more than `MAX_DOCUMENT_OPERATIONS` operations, still
       * inside the 256 KiB a version may occupy and inside the session
       * ceiling — see `ceilings.test.ts` for the measurement that says such a
       * circuit exists. Joining a session for it hands the peer a *shorter*
       * circuit, and saving that is an ordinary version.
       */
      const qubits = 16
      const operations = Array.from({ length: 4150 }, (_, index) => ({
        id: `op-${String(index)}`,
        gate: 'h' as const,
        targets: [index % qubits],
        column: Math.floor(index / qubits),
      }))
      const large: Circuit = {
        schemaVersion: CIRCUIT_SCHEMA_VERSION,
        qubits,
        clbits: 0,
        operations,
      }
      await repository.ensureOwner(OWNER)
      const created = await repository.create({
        ownerId: OWNER.id,
        title: 'Persistence verification — large',
        description: null,
        visibility: Visibility.PRIVATE,
        data: large,
        message: 'version 1',
        forkedFromId: null,
      })
      const id = created.circuit.id

      const ana = await peer(alpha, id, 'large')
      const joined = ana.frames.find((frame) => frame.type === 'collab:joined')
      expect(joined?.type).toBe('collab:joined')
      if (joined?.type === 'collab:joined') {
        expect(joined.overflow).toBe(4150 - 4096)
      }

      /*
       * The state the relay just sent is past the ceiling `applyCircuitUpdate`
       * uses when a caller does not name one — which is what
       * `bridgeCircuitDocument`'s `receive` does. A peer built on the bridge
       * therefore refuses this join and, by the bridge's own contract, drops the
       * connection: the two halves of one channel do not agree on how large a
       * document may be.
       */
      const sent = ana.received[0]
      expect(sent).toBeDefined()
      expect(sent!.byteLength).toBeGreaterThan(256 * 1024)
      expect(sent!.byteLength).toBeLessThanOrEqual(MAX_COLLAB_STATE_BYTES)
      const asTheBridgeWould = applyCircuitUpdate(new Y.Doc(), sent!, {
        origin: 'bridge',
      })
      expect(asTheBridgeWould).toStrictEqual({
        ok: false,
        reason: 'too-large',
      })

      const held = ana.circuit()
      expect(held.operations).toHaveLength(4096)

      const response = await alpha.app.inject({
        method: 'POST',
        url: `/api/v1/circuits/${id}/versions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { circuit: held, message: 'saved from the session' },
      })
      expect(response.statusCode).toBe(201)
      ana.close()

      // The head version is now 54 operations shorter than the one it replaced,
      // and the counters on the card follow it.
      const head = await repository.latestVersion(id)
      expect(head!.data.operations).toHaveLength(4096)
      const row = await prisma.circuit.findUniqueOrThrow({
        where: { id },
        select: { gateCount: true },
      })
      expect(row.gateCount).toBe(4096)
    }, 180_000)

    /** Hygiene rule 2, asserted rather than assumed. Keep this last. */
    it('leaves nothing behind', async () => {
      await alpha.app.close()
      await beta.app.close()
      await cleanup()
      expect(await prisma.user.count({ where: { id: OWNER.id } })).toBe(0)
      expect(await prisma.circuit.count({ where: { ownerId: OWNER.id } })).toBe(
        0
      )
      expect(
        await prisma.circuitSession.count({
          where: { circuit: { ownerId: OWNER.id } },
        })
      ).toBe(0)
    }, 120_000)
  }
)
