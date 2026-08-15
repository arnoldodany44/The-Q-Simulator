/**
 * The analysis panel: the live answer to the circuit on screen.
 *
 * This is the only component in the app that mounts `useSimulation`, so it
 * is the reason a worker is ever spawned. M0.6 stood it up as a placeholder
 * that could do no more than count basis states; M0.7b replaced its contents
 * with the real thing — the probability histogram and its phasors (§3.2,
 * §10) — and M0.7c added the exact reading beneath it, the amplitude table,
 * and the shots control that compares a sample against it. The pipeline
 * wiring has not moved through any of it.
 *
 * WHAT IS STILL MISSING, and deliberately: the Bloch spheres, the Q-sphere
 * and the entanglement metrics. They are separate slices of §3.2 and they
 * hang off the same `outcome`; nothing here has to move to admit them.
 *
 * THE MODE IS READ OFF THE CIRCUIT (M0.9). A circuit that measures before it
 * ends has no single final state, so analytic mode refuses it (§5.3) — and
 * until the presets arrived, that refusal was all the reader got: an error
 * message where the answer belongs. `executionModeFor` asks the document the
 * same question the engine asks it, and a measuring circuit is run in
 * trajectories mode and reported as a tally of the classical register.
 * Neither the scheduler nor the worker needed a line for this; both modes
 * have been in the protocol since M0.6 and nothing in the app had ever asked
 * for the second one.
 *
 * THE TIMELINE ARRIVES AS ONE NUMBER (M0.8). `throughColumn` says which cut of
 * the circuit to describe, and every chart below simply describes whatever
 * came back — none of them knows or needs to know that it is looking at
 * column 3 rather than at the end. The one thing the panel adds is a caption
 * saying so, because an intermediate state presented as the answer is a lie
 * told in a chart.
 *
 * THE BAR APPLIES IN BOTH MODES (M0.9c). It used to be honoured analytically
 * and silently ignored in trajectories mode, which is the same lie wearing the
 * opposite mask: on the teleportation preset the bar moved, announced a
 * position and painted a playhead on the canvas while the panel below went on
 * tallying the whole circuit. A measuring circuit has no single state at a
 * column, so what a scrub position asks of it is the *register* at that
 * instant — `job.ts` truncates the run and the tally answers for the cut. The
 * mode itself is still chosen from the whole document rather than from the cut:
 * flipping between a statevector and a tally halfway through a scrub would
 * replace the picture the reader is stepping through.
 *
 * THE SHOTS SETTINGS LIVE HERE because the sampling happens on the worker.
 * The control chooses a shot count and a seed, but nothing can act on them
 * until they reach a request — so the panel that owns the simulation owns
 * them, and `ShotSampler` is left as a component that reads state and reports
 * intent. Sampling is off until asked for: an analytic run knows every
 * probability exactly, and shot noise nobody requested is noise (§5.3).
 *
 * THE FACTS ABOVE THE CHART are the pipeline describing itself: the size of
 * the register, how many basis states carry any probability, and how long
 * the last run took. They are what tells a reader whether the picture below
 * is fresh, and the last two cannot be produced unless the circuit really
 * crossed into a worker, ran on the engine and came back.
 *
 * LIVE REGION DISCIPLINE. Only the failure line is a live region. The state
 * line changes on every keystroke — scheduled, running, ready — and a screen
 * reader reciting that during typing would drown the editor's own placement
 * feedback. A refusal is news; a debounce is not. The failure paragraph is
 * always in the DOM, empty when there is nothing to say, because a live
 * region that appears at the same moment as its text is a live region some
 * readers never see. The histogram is not a live region either, for the same
 * reason and more strongly: it changes on every slider tick.
 */

import type { Circuit } from '@qsim/schema'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AmplitudeTable } from '../analysis/AmplitudeTable'
import { MeasurementCounts } from '../analysis/MeasurementCounts'
import { ProbabilityHistogram } from '../analysis/ProbabilityHistogram'
import { ShotSampler, type SamplingSettings } from '../analysis/ShotSampler'
import { occupiedStates } from '../analysis/histogram'
import { DEFAULT_SAMPLE_SHOTS } from '../analysis/sampling'
import { executionModeFor } from './mode'
import { DEFAULT_SEED, type SimulationStatus } from './scheduler'
import { useSimulation, type SimulationWorkerLike } from './useSimulation'

/** Off, at Qiskit's default shot count, with a seed that repeats. */
const INITIAL_SAMPLING: SamplingSettings = {
  enabled: false,
  shots: DEFAULT_SAMPLE_SHOTS,
  seed: DEFAULT_SEED,
}

export interface SimulationPanelProps {
  readonly circuit: Circuit
  /**
   * Where the timeline scrubber is parked (M0.8): show the state after this
   * column instead of the final one, `-1` for the state before column 0, or
   * `null` for the whole circuit.
   */
  readonly throughColumn?: number | null
  /**
   * How to obtain the worker, for the same reason `useSimulation` takes one:
   * jsdom has no `Worker`, so a component test drives a stand-in. Production
   * leaves it alone and gets the bundled worker.
   */
  readonly createWorker?: () => SimulationWorkerLike
}

export function SimulationPanel({
  circuit,
  throughColumn = null,
  createWorker,
}: SimulationPanelProps) {
  const { t, i18n } = useTranslation('simulation')
  const [sampling, setSampling] = useState<SamplingSettings>(INITIAL_SAMPLING)
  // Asked of the document, not of the last failure: a circuit that measures is
  // known to need trajectories before it is ever sent, so the reader never
  // sees the round trip that would have refused it.
  const mode = executionModeFor(circuit)
  const simulation = useSimulation(circuit, {
    mode,
    sample: sampling.enabled,
    shots: sampling.shots,
    seed: sampling.seed,
    throughColumn,
    ...(createWorker === undefined ? {} : { createWorker }),
  })
  const headingId = useId()

  // Per-locale digits (D2/§1.1): French writes 1 048 576, English 1,048,576.
  const numbers = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  )
  /*
   * One decimal for the duration, because most runs at this size finish in
   * under a millisecond and a panel that reports "0 ms" for work that plainly
   * happened reads as a pipeline that did not run. French writes 0,4.
   */
  const milliseconds = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }),
    [i18n.language]
  )

  const { outcome, status, durationMs, error } = simulation
  // Narrowed once: the state, its counts and the fact that there is anything
  // to draw are three readings of one outcome, and taking them separately is
  // how a panel ends up drawing a chart of one run beside counts of another.
  const analytic =
    outcome !== null && outcome.mode === 'analytic' ? outcome : null
  /*
   * The other branch, narrowed the same way and for the same reason. Both are
   * kept rather than one being derived from `mode`: the mode is what was
   * *asked for* and the outcome is what came *back*, and for the frame between
   * an edit that adds a measurement and the answer to it those two disagree.
   * Rendering from the request would draw an empty counts table over a
   * statevector that is still perfectly good.
   */
  const trajectories =
    outcome !== null && outcome.mode === 'trajectories' ? outcome : null
  /**
   * The cut the answer on screen belongs to, or `null` for the end of the
   * circuit. Read off whichever outcome came back, never off the scrubber —
   * see the caption below.
   */
  const moment = outcome === null ? null : outcome.throughColumn
  const state = analytic?.state ?? null
  /*
   * One extra pass over the amplitudes, and the histogram makes another to
   * choose its bars. Neither allocates, and the alternative — threading the
   * chart's model back up here — would put a chart's internals in the
   * panel's props so that a 20-qubit register could save three milliseconds
   * it is not short of.
   */
  const support = useMemo(
    () => (state === null ? null : occupiedStates(state)),
    [state]
  )
  const busy = status === 'scheduled' || status === 'running'

  return (
    <section
      className="simulation-panel"
      aria-labelledby={headingId}
      aria-busy={busy}
    >
      <h3 id={headingId} className="simulation-panel__heading">
        {t('panel.heading')}
      </h3>

      <p className="simulation-panel__state">{t(stateKey(status))}</p>

      <p className="simulation-panel__failure" role="status">
        {error === null ? '' : error.message}
      </p>

      <dl className="simulation-panel__facts">
        <div className="simulation-panel__fact">
          <dt>{t('panel.qubits')}</dt>
          <dd>{numbers.format(circuit.qubits)}</dd>
        </div>

        {support === null ? null : (
          <div className="simulation-panel__fact">
            <dt>{t('panel.support')}</dt>
            <dd>{numbers.format(support)}</dd>
          </div>
        )}

        {durationMs === null ? null : (
          <div className="simulation-panel__fact">
            <dt>{t('panel.duration')}</dt>
            <dd>
              {t('panel.milliseconds', {
                milliseconds: milliseconds.format(durationMs),
              })}
            </dd>
          </div>
        )}
      </dl>

      {moment === null ? null : (
        /*
         * What is drawn below is not the circuit's answer but one of its
         * intermediate instants, and a chart that did not say so would be read
         * as the answer. The column comes from the *outcome* rather than from
         * the scrubber's own state: the bar moves the instant a key is
         * pressed and the worker answers a few milliseconds later, so a
         * caption taken from the control would spend that gap naming a column
         * the picture underneath it does not belong to.
         *
         * Both modes, because the bar applies to both (M0.9c). A measuring
         * circuit has no single state at a column, so what it answers with is
         * the tally of the classical register as it stood there — a different
         * kind of answer to the same question, and one this caption names the
         * same way.
         *
         * Not a live region. It changes on every step, exactly like the
         * histogram it captions, and the position is already announced by the
         * slider that moved it.
         */
        <p className="simulation-panel__moment">
          {moment < 0
            ? t('panel.moment.start')
            : t('panel.moment.column', { column: numbers.format(moment) })}
        </p>
      )}

      {analytic === null ? null : (
        <>
          <ProbabilityHistogram state={analytic.state} />
          <AmplitudeTable state={analytic.state} />
          <ShotSampler
            state={analytic.state}
            settings={sampling}
            onChange={setSampling}
            sampling={analytic.sampling}
          />
        </>
      )}

      {/*
       * The shots control is deliberately absent here. On the analytic side it
       * is a second, optional reading taken from a state that already exists;
       * in trajectories mode the shots *are* the run, so a control that
       * changed them would be re-running the circuit rather than resampling
       * it — a different thing wearing the same label. The count is stated in
       * the tally's own summary instead.
       */}
      {trajectories === null ? null : (
        <MeasurementCounts counts={trajectories.counts} />
      )}
    </section>
  )
}

/**
 * The sentence for a status. The `error` one stays deliberately short — it
 * names the state, and the failure line under it gives the reason, so the
 * two do not say the same thing at different lengths.
 */
function stateKey(status: SimulationStatus): string {
  switch (status) {
    case 'scheduled':
      return 'panel.state.scheduled'
    case 'running':
      return 'panel.state.running'
    case 'ready':
      return 'panel.state.ready'
    case 'error':
      return 'panel.state.error'
    default:
      return 'panel.state.idle'
  }
}
