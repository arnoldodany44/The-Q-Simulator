/**
 * What M0.6 has to show for itself — the smallest honest window on the live
 * simulation, and the only thing in the app that mounts `useSimulation`.
 *
 * The orchestration of M0.6 (worker, debounce, cancellation, checkpoint
 * invalidation) was complete and tested before anything rendered it, which
 * meant a user could build a circuit and the app would never spawn a worker
 * at all: no simulation, and no way for the >20 qubit refusal §3.1 requires
 * to reach anybody. This panel closes that gap without pre-empting M0.7.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not the analysis panel. No histogram, no
 * amplitude table, no phasors — those are M0.7's, they need the design system
 * and three.js, and building a sketch of them here would only have to be
 * deleted. What it shows instead is the pipeline's own state (idle, waiting,
 * running, ready, or a translated failure), the size of the register, and one
 * fact computed from the returned statevector — how many basis states carry
 * any probability at all. That last number is the point: it can only be right
 * if the circuit really crossed into a worker, ran on the engine, and came
 * back. A Bell pair says two; an empty register says one.
 *
 * LIVE REGION DISCIPLINE. Only the failure line is a live region. The state
 * line changes on every keystroke — scheduled, running, ready — and a screen
 * reader reciting that during typing would drown the editor's own placement
 * feedback. A refusal is news; a debounce is not. The failure paragraph is
 * always in the DOM, empty when there is nothing to say, because a live
 * region that appears at the same moment as its text is a live region some
 * readers never see.
 */

import type { Statevector } from '@qsim/core'
import type { Circuit } from '@qsim/schema'
import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { SimulationOutcome } from './protocol'
import type { SimulationStatus } from './scheduler'
import { useSimulation, type SimulationWorkerLike } from './useSimulation'

export interface SimulationPanelProps {
  readonly circuit: Circuit
  /**
   * How to obtain the worker, for the same reason `useSimulation` takes one:
   * jsdom has no `Worker`, so a component test drives a stand-in. Production
   * leaves it alone and gets the bundled worker.
   */
  readonly createWorker?: () => SimulationWorkerLike
}

/**
 * Below this a probability is Float64 noise rather than a state the circuit
 * can reach — D6's tolerance, applied to |amplitude|².
 */
const PROBABILITY_FLOOR = 1e-12

export function SimulationPanel({
  circuit,
  createWorker,
}: SimulationPanelProps) {
  const { t, i18n } = useTranslation('simulation')
  const simulation = useSimulation(
    circuit,
    createWorker === undefined ? {} : { createWorker }
  )
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
  const support = useMemo(() => supportOf(outcome), [outcome])
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

      <p className="simulation-panel__note">{t('panel.note')}</p>
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

/** Basis states carrying any probability, or `null` when there is no state. */
function supportOf(outcome: SimulationOutcome | null): number | null {
  if (outcome === null || outcome.mode !== 'analytic') return null
  return countAbove(outcome.state, PROBABILITY_FLOOR)
}

/**
 * Counted in one pass rather than through the engine's `probabilities()`,
 * which allocates an array of 2ⁿ doubles — 8 MB at the 20-qubit ceiling, on
 * every result, to produce a single integer.
 */
function countAbove(state: Statevector, floor: number): number {
  let count = 0
  for (let index = 0; index < state.size; index++) {
    const re = state.re[index] ?? 0
    const im = state.im[index] ?? 0
    if (re * re + im * im > floor) count += 1
  }
  return count
}
