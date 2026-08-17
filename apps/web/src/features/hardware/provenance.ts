/**
 * A result from real hardware is a measurement of a physical object at a moment
 * in time, and this module is what keeps that from being thrown away.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY A BARE BAR CHART IS THE WRONG RENDERING OF A DEVICE
 *
 * A simulated distribution is reproducible: run it again and it is the same,
 * on any machine, for ever. A device's distribution is none of those things. It
 * came off *one named chip*, out of *one queue*, at *one hour*, under *one
 * calibration* — and the same job submitted tomorrow would answer differently,
 * because the qubits were re-tuned overnight. Presenting the counts without
 * those four facts presents a measurement as if it were a computation.
 *
 * So the panel names all four, and this module is the arithmetic behind them.
 * No formatting happens here — the panel owns the language (D2) — and no
 * fetching: everything below is derived from a stored `HardwareJob`, which is
 * the whole point of §3.7's "resultados guardados junto al circuito".
 *
 * ════════════════════════════════════════════════════════════════════════
 * "THE QUEUE IT WAITED IN" IS A DURATION HERE, NOT A DEPTH, AND THAT IS
 * DELIBERATE
 *
 * The device listing reports a queue length, and it decides everything about
 * whether to submit: `ibm_fez` at 24 862 jobs and `ibm_marrakesh` at 1 are the
 * same hardware with four orders of magnitude between their answers arriving.
 * That number belongs beside a device somebody is *choosing*.
 *
 * It does not belong on a finished job, because the number a client can fetch
 * now is **today's** depth on that device, which is not the queue this job
 * waited in and would be read as though it were. What this job can honestly
 * report is how long it actually waited — `completedAt − submittedAt`, both
 * stored, both about this job — and that is a better answer anyway: it is the
 * measurement rather than a proxy for it.
 *
 * `queuePosition` is reported when the provider gave one, which is rarely: the
 * current Quantum API's job document carries no per-job position at all. Null
 * here means "not reported", never "first in line", which is why it is
 * nullable all the way down from the schema rather than defaulted to a number.
 */

/** What a stored job says about the run that produced it. */
export interface JobProvenance {
  /** The chip. Not a class of chip — this one. */
  readonly backend: string
  /**
   * The provider's own id, which is how a person finds this job in IBM's
   * console — the only place that can answer "what actually happened" when this
   * system's poll gave up.
   */
  readonly providerJobId: string | null
  readonly shots: number
  readonly submittedAt: Date
  readonly completedAt: Date | null
  /**
   * How long the job took from submission to result, in milliseconds — the
   * queue it waited in, measured rather than inferred. Null while it is still
   * waiting, because a duration that ends "now" would change on every render
   * and would describe the reader's patience rather than the device's queue.
   */
  readonly waitMs: number | null
  /** When the calibration the placement was chosen from was taken. */
  readonly calibratedAt: Date | null
  /**
   * How old that calibration already was when the job was submitted.
   *
   * The number that says how much to trust the placement. A device recalibrates
   * daily; qubits chosen from a reading twelve hours old were chosen from a
   * device that no longer quite existed, and that is a real contribution to the
   * third column which nothing else on the page would reveal.
   *
   * Negative values are possible in principle — a calibration published after
   * submission — and are kept rather than clamped, because a negative age is
   * evidence that one of the two timestamps is not what it claims and silently
   * flooring it to zero would hide exactly that.
   */
  readonly calibrationAgeMs: number | null
  /** Seconds of QPU actually spent. What the plan's ten minutes were paid from. */
  readonly quantumSeconds: number | null
  /** Which physical qubits ran it: `layout[logical]` is the wire on the chip. */
  readonly layout: readonly number[]
  /** Where it sat in the queue, when the provider said. Usually null. */
  readonly queuePosition: number | null
}

/** The fields of a stored job this module reads. A structural subset, so the
 * wire type and the test fixtures can both satisfy it without either importing
 * the other's shape. */
export interface ProvenanceSource {
  readonly backend: string
  readonly providerJobId: string | null
  readonly shots: number
  readonly submittedAt: string | Date
  readonly completedAt: string | Date | null
  readonly queuePosition: number | null
  readonly result: {
    readonly calibratedAt: string | null
    readonly quantumSeconds: number | null
    readonly layout: readonly number[]
    readonly shots: number
  } | null
}

export function provenanceOf(job: ProvenanceSource): JobProvenance {
  const submittedAt = asDate(job.submittedAt) ?? new Date(0)
  const completedAt = asDate(job.completedAt)
  const calibratedAt = asDate(job.result?.calibratedAt ?? null)

  return {
    backend: job.backend,
    providerJobId: job.providerJobId,
    /*
     * The result's own shot count when there is one, and the request's
     * otherwise. They differ when a device returns fewer shots than were asked
     * for, and the third column is drawn from what came back — so a header
     * quoting the request would label a histogram with a number that is not its
     * denominator.
     */
    shots: job.result?.shots ?? job.shots,
    submittedAt,
    completedAt,
    waitMs:
      completedAt === null
        ? null
        : completedAt.getTime() - submittedAt.getTime(),
    calibratedAt,
    calibrationAgeMs:
      calibratedAt === null
        ? null
        : submittedAt.getTime() - calibratedAt.getTime(),
    quantumSeconds: job.result?.quantumSeconds ?? null,
    layout: job.result?.layout ?? [],
    queuePosition: job.queuePosition,
  }
}

/**
 * A timestamp as a `Date`, or null.
 *
 * Both spellings are accepted because the same job arrives as ISO-8601 strings
 * over the wire and as `Date`s from anything holding the server's own row, and
 * a panel that worked in one place and produced `Invalid Date` in the other is
 * the kind of defect that only shows up in the deployed build. An unparseable
 * string is null rather than an `Invalid Date`, so every consumer below has one
 * absence to handle instead of two.
 */
function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
