/**
 * Which chip, which queue, which hour, which calibration — §3.7.
 *
 * ════════════════════════════════════════════════════════════════════════
 * A BARE BAR CHART IS THE WRONG RENDERING OF A DEVICE
 *
 * A simulated distribution is reproducible: run it again and it is identical,
 * on any machine, for ever. A device's distribution is none of those things. It
 * came off one named chip, out of one queue, at one hour, under one
 * calibration — and the same job submitted tomorrow answers differently,
 * because the qubits are re-tuned overnight. Presenting the counts without
 * those facts presents a measurement as if it were a computation, which is
 * exactly the misunderstanding §3.7 exists to correct.
 *
 * `provenance.ts` holds the arithmetic and argues two of the entries at length:
 * why the wait is a *duration measured from this job's own timestamps* rather
 * than a queue depth fetched now, and why the calibration's age at submission
 * is worth a row of its own.
 *
 * Every value has an explicit absence. `not reported` is a fact — the current
 * Quantum API's job document genuinely carries no per-job queue position — and
 * a blank cell would read as a value that failed to render.
 */

import { useTranslation } from 'react-i18next'

import { formatCount } from '../analysis/format'
import { formatDuration, formatQpuSeconds } from './duration'
import type { JobProvenance } from './provenance'

export interface DeviceProvenanceProps {
  readonly provenance: JobProvenance
}

export function DeviceProvenance({ provenance }: DeviceProvenanceProps) {
  const { t, i18n } = useTranslation('hardware')
  const language = i18n.language

  const when = new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const absent = t('device.unknown')

  return (
    <section className="device-provenance">
      <h3 className="device-provenance__heading">{t('device.heading')}</h3>
      <p className="device-provenance__lead">{t('device.lead')}</p>

      <dl className="device-provenance__facts">
        {/* The chip's name is an identifier, not a word: `ibm_marrakesh` must
            survive a page translator intact. */}
        <Fact
          term={t('device.backend')}
          value={provenance.backend}
          identifier
        />
        <Fact
          term={t('device.jobId')}
          value={provenance.providerJobId ?? absent}
          identifier={provenance.providerJobId !== null}
        />
        <Fact
          term={t('device.shots')}
          value={formatCount(provenance.shots, language)}
        />
        <Fact
          term={t('device.submitted')}
          value={when.format(provenance.submittedAt)}
          /* Machine-readable beside the human one, the same pairing every other
             timestamp in this app uses. */
          dateTime={provenance.submittedAt.toISOString()}
        />
        <Fact
          term={t('device.completed')}
          value={
            provenance.completedAt === null
              ? t('device.waiting')
              : when.format(provenance.completedAt)
          }
          dateTime={provenance.completedAt?.toISOString()}
        />
        <Fact
          term={t('device.wait')}
          value={
            provenance.waitMs === null
              ? t('device.waiting')
              : formatDuration(provenance.waitMs, language)
          }
        />
        <Fact
          term={t('device.calibration')}
          value={
            provenance.calibratedAt === null
              ? absent
              : when.format(provenance.calibratedAt)
          }
          dateTime={provenance.calibratedAt?.toISOString()}
        />
        <Fact
          term={t('device.calibrationAge')}
          value={
            provenance.calibrationAgeMs === null
              ? absent
              : formatDuration(provenance.calibrationAgeMs, language)
          }
        />
        <Fact
          term={t('device.quantumSeconds')}
          value={
            provenance.quantumSeconds === null
              ? absent
              : formatQpuSeconds(provenance.quantumSeconds, language)
          }
        />
        <Fact
          term={t('device.queuePosition')}
          value={
            provenance.queuePosition === null
              ? absent
              : formatCount(provenance.queuePosition, language)
          }
        />
        <Fact
          term={t('device.layout')}
          value={
            provenance.layout.length === 0
              ? absent
              : provenance.layout
                  .map((physical) => `$${formatCount(physical, language)}`)
                  .join(', ')
          }
          identifier={provenance.layout.length > 0}
        />
      </dl>

      <p className="device-provenance__note">{t('device.queueNote')}</p>
      <p className="device-provenance__note">{t('device.calibrationNote')}</p>
    </section>
  )
}

function Fact({
  term,
  value,
  identifier = false,
  dateTime,
}: {
  readonly term: string
  readonly value: string
  /** Machine vocabulary — a chip name, a job id, a qubit number. */
  readonly identifier?: boolean
  /** The ISO-8601 form, when the value is a timestamp. */
  readonly dateTime?: string
}) {
  return (
    <div className="device-provenance__fact">
      <dt>{term}</dt>
      <dd className="tabular-numbers">
        {dateTime === undefined ? (
          <span translate={identifier ? 'no' : undefined}>{value}</span>
        ) : (
          <time dateTime={dateTime}>{value}</time>
        )}
      </dd>
    </div>
  )
}
