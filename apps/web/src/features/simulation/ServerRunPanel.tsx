/**
 * The one place §4's two-level split is visible to a reader.
 *
 * Everything else in this feature works hard to make the split *invisible* —
 * one scheduler, one staleness rule, one snapshot — and that is right for the
 * code and wrong for the person looking at the screen. A run that took eleven
 * seconds when the last one took eight milliseconds is not a slow app; it is a
 * different machine doing the work, for a reason, and a reader who cannot tell
 * has no way to understand what they are seeing.
 *
 * So this component answers exactly the three questions somebody in front of a
 * queued run has:
 *
 *   **Where did this go?** A line that names the register and the browser's
 *   ceiling, because that is the whole reason it left the tab. Not a badge
 *   saying "server" — a badge is a label, and the interesting part is the
 *   threshold it crossed.
 *
 *   **How long?** The API's own estimate when it gave one, beside the time that
 *   has actually elapsed. The estimate is engine time and excludes the queue
 *   wait, which the copy says rather than hides: a run that has been waiting
 *   twelve seconds for a worker has not overrun a four-second estimate, and a
 *   panel that implied it had would be teaching the reader to distrust it.
 *   Where there is no estimate, none is invented — the same rule
 *   `progressFraction` follows for a phase that does not divide.
 *
 *   **Can I stop?** Yes, and the button says what it really does. §8 gives
 *   `/simulate` no delete and a job already inside a killable child is going to
 *   finish; what this stops is *waiting*. A control labelled "cancel" that
 *   silently does not cancel is worse than no control, so the label is "stop
 *   waiting" and the note underneath says the run keeps its id.
 *
 * ── AND THE IDENTIFIER HAS TO SURVIVE THE CLICK ──────────────────────────
 *
 * "The run keeps going on the server and keeps its identifier" is the one
 * sentence this app offers about what cancellation does, and it was true of the
 * system and false of the interface: `disown()` clears `serverRun`, which took
 * the id, the counter, the button and the note off the screen in the same
 * frame. The run really did keep its identity — and there is no run history, no
 * listing, and `GET /simulate/:runId` is addressable only by an id the reader
 * no longer had.
 *
 * So the panel remembers the id it was showing and keeps it, in a live region
 * that says the wait was stopped. That line is also the *announcement* of the
 * command: the status line it replaces was unmounted along with the button, and
 * removing a live region announces nothing. Focus goes to the heading, which is
 * the nearest thing that still exists — a keyboard reader who presses a button
 * that deletes itself is otherwise left on `document.body`.
 *
 * ── The result is rendered as a table, not as the histogram ──────────────
 *
 * A server run answers with the bounded reading `@qsim/jobs`' `result.ts`
 * defines: the largest outcomes, plus a count and a weight for everything left
 * out. It is not a statevector and at these register sizes it never can be —
 * 2²⁴ amplitudes is 256 MB. Drawing it with the same chart as an exact state
 * would claim more than the data knows, so it gets a table that says what was
 * withheld, in the same spirit as `MeasurementCounts`.
 *
 * LIVE REGION DISCIPLINE. The status line is a live region and the progress
 * numbers are not. A run leaving the queue, finishing, or losing its feed is
 * news that arrives without the reader doing anything; a percentage that ticks
 * four times a second would drown every other announcement on the page.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { SimulationRun } from '@qsim/contract'

import { formatProbability } from '../analysis/format'
import type { ServerRunView } from './protocol'

export interface ServerRunPanelProps {
  /** The run in flight, or null when nothing is out there. */
  readonly serverRun: ServerRunView | null
  /** The finished run, when the answer on screen came from the server. */
  readonly run?: SimulationRun | null
  /** Register size, for the sentence that explains why this left the tab. */
  readonly qubits: number
  readonly clientLimit: number
  readonly onCancel: () => void
  /** Injected by tests so the elapsed counter does not need a real clock. */
  readonly now?: () => number
}

/**
 * How often the elapsed counter is redrawn, in milliseconds.
 *
 * One second, because the number is displayed in seconds. A faster interval
 * would re-render the panel for a value that did not change, and a slower one
 * would make the counter visibly skip.
 */
const TICK_MS = 1_000

export function ServerRunPanel({
  serverRun,
  run = null,
  qubits,
  clientLimit,
  onCancel,
  now = Date.now,
}: ServerRunPanelProps) {
  const { t, i18n } = useTranslation('simulation')
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [tick, setTick] = useState(() => now())
  /**
   * The run this page stopped waiting for, once it has.
   *
   * Held here rather than in the scheduler because it is a fact about *this
   * panel* — the reader pressed this button — and because the scheduler's
   * `serverRun` is deliberately "what is in flight", which after a cancel is
   * nothing. See the header for why the id has to outlive the click.
   */
  const [stopped, setStopped] = useState<{
    runId: string | null
    /** `submittedAt` of the run that was stopped — this panel's identity for it. */
    at: number
  } | null>(null)

  const inFlight = serverRun !== null
  /*
   * A *new* run supersedes the sentence about the stopped one, and a new run is
   * one submitted at a different moment — not merely "something is in flight",
   * which is still true for the frame between the click and the scheduler
   * publishing. Adjusted during render rather than in an effect, which is
   * React's own prescription for state that has to follow a prop.
   */
  if (
    serverRun !== null &&
    stopped !== null &&
    serverRun.submittedAt !== stopped.at
  ) {
    setStopped(null)
  }
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => setTick(now()), TICK_MS)
    return () => clearInterval(timer)
  }, [inFlight, now])

  const numbers = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  )
  const seconds = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        maximumFractionDigits: 0,
      }),
    [i18n.language]
  )

  /*
   * WHY THE CEILING ALONE IS ENOUGH TO RENDER THIS.
   *
   * The "why" line is a fact about the *circuit* — this register is past what
   * a tab can hold — and it stays true whatever happens to the run. Tying the
   * whole panel to a run in flight cost the reader exactly the sentence they
   * needed on the one path where they needed it most: a submission that
   * failed left `serverRun` null and `run` null, so the only thing on screen
   * was "the server did not accept this run", with nothing to say why a server
   * was involved in a circuit the reader had just been editing locally.
   *
   * So the explanation appears as soon as the register crosses the ceiling and
   * stays for as long as it is over it, and the run's own state — queued,
   * running, finished, failed — is layered underneath.
   */
  const beyondBrowser = qubits > clientLimit
  if (
    !beyondBrowser &&
    serverRun === null &&
    run === null &&
    stopped === null
  ) {
    return null
  }

  const elapsedSeconds =
    serverRun === null
      ? 0
      : Math.max(0, Math.round((tick - serverRun.submittedAt) / 1000))

  /*
   * The register the sentence is about is the register of the run it captions.
   * `qubits` is the circuit on the canvas, and the two disagree for as long as
   * an edit sits between a finished server run and its replacement — long
   * enough to print "this circuit has 20 qubits, the browser simulates up to
   * 20, so it went to a server" directly above a result from a 21-qubit run,
   * and for ever if no worker is available to replace the outcome.
   *
   * The same rule `SimulationPanel` states for the mode: what was asked for and
   * what came back are different things, and a caption describes what came
   * back.
   */
  const explained = run?.result?.qubits ?? qubits

  function stopWaiting(): void {
    setStopped({
      runId: serverRun?.runId ?? null,
      at: serverRun?.submittedAt ?? 0,
    })
    onCancel()
    // The button is about to unmount. Focus has to land somewhere deliberate,
    // and the heading is the nearest thing that survives.
    heading.current?.focus()
  }

  return (
    <section className="server-run" aria-labelledby={headingId}>
      {/*
       * `tabIndex={-1}` so the heading can take focus programmatically without
       * joining the tab order — the standard target for a command whose own
       * control disappears.
       */}
      <h4
        id={headingId}
        className="server-run__heading"
        ref={heading}
        tabIndex={-1}
      >
        {t('server.heading')}
      </h4>

      {/*
       * The reason, not a label. It names the register and the ceiling it
       * crossed, so the split reads as a consequence of the circuit rather than
       * as something the app decided on its own.
       */}
      <p className="server-run__why">
        {t('server.why', {
          qubits: numbers.format(explained),
          limit: numbers.format(clientLimit),
        })}
      </p>

      {stopped === null ? null : (
        <p className="server-run__stopped" role="status">
          {stopped.runId === null
            ? t('server.stopped')
            : t('server.stoppedWithId', { runId: stopped.runId })}
        </p>
      )}

      {serverRun === null ? null : (
        <>
          <p className="server-run__status" role="status">
            {t(stageKey(serverRun), {
              phase: t(`server.phase.${serverRun.phase ?? 'validating'}`),
            })}
          </p>

          <dl className="server-run__facts">
            <div className="server-run__fact">
              <dt>{t('server.elapsed')}</dt>
              <dd>
                {t('server.seconds', {
                  seconds: seconds.format(elapsedSeconds),
                })}
              </dd>
            </div>

            {serverRun.estimatedDurationMs === null ? null : (
              <div className="server-run__fact">
                <dt>{t('server.estimate')}</dt>
                <dd>
                  {t('server.seconds', {
                    seconds: seconds.format(
                      Math.max(1, serverRun.estimatedDurationMs / 1000)
                    ),
                  })}
                </dd>
              </div>
            )}

            {serverRun.completed === null || serverRun.total === null ? null : (
              <div className="server-run__fact">
                <dt>{t('server.done')}</dt>
                <dd>
                  {t('server.fraction', {
                    completed: numbers.format(serverRun.completed),
                    total: numbers.format(serverRun.total),
                  })}
                </dd>
              </div>
            )}

            {serverRun.runId === null ? null : (
              <div className="server-run__fact">
                <dt>{t('server.runId')}</dt>
                <dd className="server-run__id">{serverRun.runId}</dd>
              </div>
            )}
          </dl>

          {/*
           * Only while the feed is down, and only once a run id exists — before
           * that there is nothing to be connected *to*, and saying "reconnecting"
           * during a POST would describe a state that does not exist.
           */}
          {serverRun.live || serverRun.runId === null ? null : (
            <p className="server-run__offline">{t('server.offline')}</p>
          )}

          <button
            type="button"
            className="server-run__stop"
            onClick={stopWaiting}
          >
            {t('server.stop')}
          </button>
          <p className="server-run__stop-note">{t('server.stopNote')}</p>
        </>
      )}

      {run === null ? null : <ServerRunResult run={run} />}
    </section>
  )
}

/** The bounded reading a finished server run carries. */
function ServerRunResult({ run }: { readonly run: SimulationRun }) {
  const { t, i18n } = useTranslation('simulation')
  const captionId = useId()
  const numbers = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  )
  /*
   * `formatProbability` and not an inline percent formatter with two decimal
   * places. This table is the one place in the app where a *genuine* share can
   * be tiny: the remainder of a peaked distribution over 2²⁴ basis states is
   * four millionths, and two decimals print that as "0 %" — the exact falsehood
   * the sentence beneath the table exists to prevent, in the sentence itself.
   * The shared formatter re-formats a positive value that would round away to
   * one significant digit and reports "0,0004 %".
   */
  const share = (value: number): string =>
    formatProbability(value, i18n.language)

  if (run.status === 'FAILED') {
    /*
     * A failed run is an answer, and it is reported as one. The code comes off
     * the row and is translated here (D2) — the API never sends prose, so
     * `run.error` is a `SimulationFailureCode` and never a sentence. A code
     * this bundle has no key for falls back to the generic line rather than
     * rendering an identifier.
     */
    return (
      <p className="server-run__failure" role="status">
        {t(
          [
            `server.failure.${run.error ?? 'UNKNOWN'}`,
            'server.failure.UNKNOWN',
          ],
          { defaultValue: '' }
        )}
      </p>
    )
  }

  const result = run.result
  if (result === null) {
    return <p className="server-run__failure">{t('server.noResult')}</p>
  }

  return (
    <div className="server-run__result">
      <p className="server-run__summary">
        {t('server.summary', {
          qubits: numbers.format(result.qubits),
          seed: numbers.format(result.seed),
          milliseconds: numbers.format(result.durationMs),
        })}
      </p>

      <div className="server-run__viewport">
        <table className="server-run__grid" aria-describedby={captionId}>
          <caption id={captionId} className="visually-hidden">
            {t('server.table.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('server.table.state')}</th>
              <th scope="col">{t('server.table.probability')}</th>
              <th scope="col">{t('server.table.count')}</th>
            </tr>
          </thead>
          <tbody>
            {result.outcomes.map((outcome) => (
              <tr key={outcome.state}>
                <th scope="row" className="server-run__state">
                  {`|${outcome.state}⟩`}
                </th>
                <td>
                  {outcome.probability === null
                    ? '—'
                    : share(outcome.probability)}
                </td>
                <td>
                  {outcome.count === null ? '—' : numbers.format(outcome.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
       * What the cap left out, stated rather than dropped. A truncated list
       * presented as complete is the same silent falsehood as a fabricated
       * progress bar — the reader would conclude the remaining probability is
       * zero, which at these register sizes is exactly the wrong lesson.
       */}
      {result.hiddenOutcomes === 0 ? null : (
        <p className="server-run__hidden">
          {t('server.hidden', {
            /*
             * `states` and not `count`: i18next reserves `count` for plural
             * selection, and handing it a locale-formatted *string* would make
             * the plural rule read a value it cannot classify. The number is
             * already formatted for the reader's locale here, which is the
             * whole reason it is a string.
             */
            states: numbers.format(result.hiddenOutcomes),
            weight: share(result.hiddenWeight),
          })}
        </p>
      )}
    </div>
  )
}

/**
 * The sentence for a stage, as a lookup rather than an interpolated key — the
 * same reason `stateKey` in `SimulationPanel` is one: a key built by
 * concatenation is invisible to every tool that checks catalogs.
 */
function stageKey(view: ServerRunView): string {
  switch (view.stage) {
    case 'submitting':
      return 'server.state.submitting'
    case 'queued':
      return 'server.state.queued'
    default:
      return 'server.state.running'
  }
}
