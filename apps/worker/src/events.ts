/**
 * Publishing a run's progress, so the API can push it to a browser.
 *
 * The argument for pub/sub over BullMQ's own event stream is in `@qsim/jobs`'
 * `events.ts` and is not repeated here. What this file adds is the two
 * properties the *publisher* has to have, both of which are about the worker
 * rather than about the transport.
 *
 * ── Publishing must never be able to affect a run ─────────────────────────
 *
 * A run that failed because a progress notification could not be delivered
 * would be an absurd trade: the simulation is the expensive, irreplaceable
 * part, and the notification is a convenience over a REST endpoint that still
 * answers. So every publish is fire-and-forget, every failure is swallowed
 * after one log line, and nothing here is ever awaited on a path that leads to
 * a row. It is the same discipline `processor.ts` already applies to
 * `reportProgress` and `signalCompletion`, for the same reason.
 *
 * ── It is deliberately not throttled here ────────────────────────────────
 *
 * `shouldReport` in `@qsim/jobs` already collapses a hundred-thousand-shot
 * run's 780 reporting opportunities into roughly four a second, and the
 * processor applies it once, upstream of both sinks. Throttling again in this
 * file would be a second policy to keep in step with the first, and the two
 * would drift the moment one of them was tuned.
 */

import { encodeRunEvent, runEventChannel } from '@qsim/jobs'
import type { RunEvent } from '@qsim/jobs'

/** The one command this needs off a Redis client. */
export interface EventPublisherConnection {
  publish(channel: string, message: string): Promise<number>
}

/** Publishes one event. Never throws, never rejects. */
export type PublishRunEvent = (event: RunEvent) => void

export interface PublisherOptions {
  readonly connection: EventPublisherConnection
  readonly prefix: string
  readonly log: (
    level: 'info' | 'warn' | 'error',
    fields: Record<string, unknown>,
    message: string
  ) => void
}

export function createRunEventPublisher(
  options: PublisherOptions
): PublishRunEvent {
  const { connection, prefix, log } = options
  return (event) => {
    const channel = runEventChannel(prefix, event.runId)
    void connection
      .publish(channel, encodeRunEvent(event))
      .then(() => undefined)
      .catch((error: unknown) => {
        /*
         * Warn and not error. Nobody subscribed is not a failure — `PUBLISH`
         * answers zero and resolves — so reaching here means the connection
         * itself refused, which is worth a line beside the run and is worth
         * nothing more: the client falls back to `GET /simulate/:runId`, which
         * is what it does across a reconnect anyway.
         */
        log(
          'warn',
          { runId: event.runId, type: event.type, err: error },
          'could not publish a run event; the client will poll instead'
        )
      })
  }
}

/** A publisher that does nothing, for a worker with nowhere to publish. */
export const NO_PUBLISHER: PublishRunEvent = () => undefined
