/**
 * What a credential buys, and for exactly how long.
 *
 * Derived from §11 and from how a correct long-lived write channel behaves:
 *
 *   - a token that does not verify must be refused at the upgrade, not turned
 *     into a silently anonymous socket;
 *   - a socket must not outlive the credential it presented, and enforcement
 *     must not wait for a sweep timer — authority ends at `exp`, which means on
 *     the next frame and on the next delivery;
 *   - a second identity on one socket cannot be reconciled with the
 *     authorisations already granted, so it must not be accepted;
 *   - none of it may be *fixable* by the client: an expired token must not buy
 *     a new attachment either.
 */

import { describe, expect, it } from 'vitest'
import {
  connect,
  editUpdate,
  payload,
  peerDocument,
  startRelay,
  upgradeStatus,
} from './harness.js'
import { OWNER, STRANGER, seed, withGate } from './fixtures.js'

describe('the upgrade', () => {
  it('refuses a token that does not verify rather than degrading to anonymous', async () => {
    const relay = await startRelay()
    try {
      const expired = await relay.token({
        subject: OWNER,
        expiresInSeconds: -60,
      })
      expect(
        await upgradeStatus(relay, { authorization: `Bearer ${expired}` })
      ).toBe(401)
      expect(
        await upgradeStatus(relay, { authorization: 'Bearer not-a-token' })
      ).toBe(401)
      // And an origin the deployment does not allow is refused too, which a
      // browser will not do for a WebSocket handshake.
      expect(
        await upgradeStatus(relay, { origin: 'https://evil.example' })
      ).toBe(403)
      expect(await upgradeStatus(relay, { origin: relay.origin })).toBe(101)
    } finally {
      await relay.close()
    }
  })
})

describe('a credential that dies while the session runs', () => {
  it('refuses the next frame and stops delivering, long before the sweep', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.private.id

      const durable = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const dying = await connect(relay, {
        bearer: await relay.token({ subject: OWNER, expiresInSeconds: 3 }),
      })
      for (const peer of [durable, dying]) {
        peer.send({ type: 'collab:join', circuitId: handle })
        expect(
          await peer.waitFor((frame) => frame.type === 'collab:joined')
        ).toMatchObject({ access: 'write' })
      }
      const document = peerDocument(
        durable.frames.find((frame) => frame.type === 'collab:joined') ?? {
          type: 'x',
        }
      )

      // Past `exp`, and far inside the 15 s sweep interval.
      await dying.quiet(3_300)
      dying.frames.length = 0

      // A delivery to the dead socket must not happen.
      durable.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(document, withGate('op_after_expiry'))),
      })
      expect(await dying.waitClosed()).toBe(4001)
      expect(dying.frames.map((frame) => frame.type)).not.toContain(
        'collab:update'
      )
      // The live socket is unaffected.
      expect(durable.closeCode()).toBeNull()
    } finally {
      await relay.close()
    }
  })

  it('does not let an expired credential buy a new attachment', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay, {
        bearer: await relay.token({ subject: OWNER, expiresInSeconds: 2 }),
      })
      await peer.quiet(2_300)
      peer.send({
        type: 'collab:join',
        circuitId: circuits.private.id,
      })
      expect(await peer.waitClosed()).toBe(4001)
      expect(peer.frames.map((frame) => frame.type)).not.toContain(
        'collab:joined'
      )
      expect(relay.app.collab?.documentCount()).toBe(0)
    } finally {
      await relay.close()
    }
  })

  it('refuses an expired token in `authenticate` and stays anonymous', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay)
      peer.send({
        type: 'authenticate',
        token: await relay.token({ subject: OWNER, expiresInSeconds: -60 }),
      })
      expect(
        await peer.waitFor((frame) => frame.type === 'error')
      ).toMatchObject({ code: 'AUTH_INVALID_TOKEN' })

      peer.send({
        type: 'collab:join',
        circuitId: circuits.private.id,
      })
      expect(
        await peer.waitFor((frame) => frame.type.startsWith('collab:'))
      ).toMatchObject({ type: 'collab:error', code: 'NOT_FOUND' })
      expect(peer.closeCode()).toBeNull()
    } finally {
      await relay.close()
    }
  })

  it('closes a socket that presents a second identity', async () => {
    const relay = await startRelay()
    try {
      const peer = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      peer.send({
        type: 'authenticate',
        token: await relay.token({ subject: STRANGER }),
      })
      expect(await peer.waitClosed()).toBe(4003)
    } finally {
      await relay.close()
    }
  })

  it('lets a refreshed token for the same subject extend the session', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay, {
        bearer: await relay.token({ subject: OWNER, expiresInSeconds: 3 }),
      })
      peer.send({
        type: 'collab:join',
        circuitId: circuits.private.id,
      })
      await peer.waitFor((frame) => frame.type === 'collab:joined')
      peer.send({
        type: 'authenticate',
        token: await relay.token({ subject: OWNER, expiresInSeconds: 3_600 }),
      })
      await peer.waitFor(
        (frame) =>
          frame.type === 'ready' &&
          Number(frame.expiresAt) > Date.now() + 60_000
      )
      await peer.quiet(3_400)
      peer.send({ type: 'ping' })
      await peer.waitFor((frame) => frame.type === 'pong')
      expect(peer.closeCode()).toBeNull()
    } finally {
      await relay.close()
    }
  })
})
