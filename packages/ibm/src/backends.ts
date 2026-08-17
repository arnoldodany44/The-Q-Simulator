/**
 * What `/backends` answers, and the version trap underneath it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE VERSION HEADER CHANGES THE SHAPE, AND A WRONG ONE STILL ANSWERS 200
 *
 * Measured against the live service on this account:
 *
 *     IBM-API-Version: 2024-01-01   →  {"devices":["ibm_fez","ibm_marrakesh",…]}
 *     IBM-API-Version: 2025-01-01   →  {"devices":[{"name":…,"queue_length":…}]}
 *     IBM-API-Version: not-a-date   →  the 2024 shape, with a 200
 *
 * That last line is the whole reason this file parses strictly. A header this
 * package got wrong — a typo, a constant somebody "tidied" — does not produce
 * an error. It produces a **success** carrying a list of strings, and a lenient
 * parser reading `device.queue_length` off a string finds `undefined`, reports
 * every device as having no queue, and the person choosing one is choosing
 * blind between a backend with fifteen jobs waiting and one with twenty-four
 * thousand.
 *
 * So a legacy-shaped answer is `IBM_MALFORMED_RESPONSE` by name. It is not the
 * caller's fault and it is not a device problem: it is this build asking with
 * the wrong version, and the honest thing is to say so rather than to degrade
 * into a listing that is quietly missing the one number that matters.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE QUEUE IS PART OF THE LISTING RATHER THAN A DETAIL VIEW
 *
 * Because it decides whether a result arrives today. On one morning this
 * account saw `ibm_fez` with 24 835 jobs waiting and `ibm_marrakesh` with 15 —
 * four orders of magnitude apart, on two devices with identical qubit counts,
 * identical processor families and near-identical error rates. Every other
 * field in this response is a tie-break next to that one, so it travels in the
 * list rather than behind a second request nobody makes.
 *
 * `status.name` matters for the same reason and is just as invisible from a
 * qubit count: a device can be `paused` for maintenance with a short queue,
 * which looks like the best choice on every axis except the one where a job
 * submitted to it does not start.
 */

import { z } from 'zod'

/**
 * A device as the listing describes it.
 *
 * Every field past `name` is optional, and that is not laziness about somebody
 * else's API — it is the same argument `deviceTargetFromIbm` makes in
 * `@qsim/transpile`: a missing number must stay missing. A `queue_length`
 * defaulted to zero would rank a device this system knows nothing about above
 * one it has measured, which is the exact inversion the field exists to prevent.
 */
const DeviceSchema = z.object({
  name: z.string().min(1),
  status: z
    .object({
      name: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  qubits: z.number().int().nonnegative().optional(),
  queue_length: z.number().int().nonnegative().optional(),
  processor_type: z
    .object({
      family: z.string().optional(),
      revision: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
})

export const BackendListSchema = z.object({
  devices: z.array(DeviceSchema),
})

/** The 2024-shaped answer: a list of names. Recognised so it can be refused. */
export const LegacyBackendListSchema = z.object({
  devices: z.array(z.string()),
})

/** One device, as this system passes it around. */
export interface IbmBackend {
  readonly name: string
  /** `online`, `paused`, `offline`, … as the service spells it. */
  readonly status: string | null
  /** Why it is in that status, when the service says. */
  readonly reason: string | null
  readonly qubits: number | null
  /** Jobs waiting on this device. The number that decides the wait. */
  readonly queueLength: number | null
  /** `Heron r2`, when both halves are present. */
  readonly processor: string | null
  /**
   * Whether a job submitted now would be expected to run.
   *
   * Derived rather than reported: the service says `online`, `paused` or
   * `offline`, and only the first means "will start". A device that is paused
   * for maintenance accepts submissions perfectly well and then holds them,
   * which is the failure mode a person needs warned about *before* they choose,
   * not after.
   */
  readonly operational: boolean
}

/** The one status that means a submitted job is expected to start. */
const OPERATIONAL = 'online'

export function toBackend(device: z.infer<typeof DeviceSchema>): IbmBackend {
  const family = device.processor_type?.family
  const revision = device.processor_type?.revision
  return {
    name: device.name,
    status: device.status?.name ?? null,
    reason: device.status?.reason ?? null,
    qubits: device.qubits ?? null,
    queueLength: device.queue_length ?? null,
    processor:
      family === undefined
        ? null
        : revision === undefined
          ? family
          : `${family} r${String(revision)}`,
    operational: device.status?.name === OPERATIONAL,
  }
}

/**
 * Devices ordered the way somebody choosing one would want them.
 *
 * Operational first, then by shortest queue, then by name so the order is
 * stable between two calls that see the same numbers. A device whose queue is
 * unknown sorts last within its group rather than first: "no number" is not
 * "no queue", and the ranking must never reward a device this system failed to
 * learn anything about.
 */
export function byAvailability(a: IbmBackend, b: IbmBackend): number {
  if (a.operational !== b.operational) return a.operational ? -1 : 1
  const left = a.queueLength ?? Number.POSITIVE_INFINITY
  const right = b.queueLength ?? Number.POSITIVE_INFINITY
  if (left !== right) return left - right
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * The `/backends/{name}/status` document.
 *
 * A second source for the queue depth, and the fresher one: the listing is
 * cached hard enough that a device paused a minute ago can still read `online`
 * there. Used by the detail route, which is the one a person is looking at
 * while they decide.
 */
export const BackendStatusSchema = z.object({
  state: z.boolean().optional(),
  status: z.string().optional(),
  message: z.string().optional(),
  length_queue: z.number().int().nonnegative().optional(),
})

export interface IbmBackendStatusReading {
  readonly status: string | null
  readonly queueLength: number | null
  readonly operational: boolean
}

export function toStatusReading(
  document: z.infer<typeof BackendStatusSchema>
): IbmBackendStatusReading {
  return {
    status: document.status ?? null,
    queueLength: document.length_queue ?? null,
    /*
     * `state` is a boolean the service sends beside the word, and it is the
     * authoritative one: a device can report `status: "maintenance"` with
     * `state: true` while it drains. When both are present they agree in every
     * reading taken; when only the word is present, `online` is the only value
     * that means running.
     */
    operational: document.state ?? document.status === OPERATIONAL,
  }
}

/**
 * The two documents `deviceTargetFromIbm` reads.
 *
 * ── Every field is optional, and unknown ones are dropped ────────────────
 *
 * Optional because that is `@qsim/transpile`'s rule about somebody else's
 * calibration and this schema must not undo it: a missing number becomes
 * `undefined` rather than a zero, because a zero would claim a *perfect* gate
 * and the placement search would cheerfully choose the qubits it knows least
 * about.
 *
 * Dropped because the live configuration document carries forty keys — pulse
 * timings, instruction signatures, coordinates for a chip diagram — and this
 * system reads four of them. Stripping is not tidiness: it is what makes the
 * parsed value exactly the type `deviceTargetFromIbm` accepts, with no cast
 * between this package and the one that does the arithmetic. A cast there would
 * be the seam where a shape change stops being a compile error.
 */
const PropertyRowSchema = z.object({
  name: z.string().optional(),
  value: z.number().optional(),
})

export const ConfigurationSchema = z.object({
  backend_name: z.string().optional(),
  n_qubits: z.number().int().nonnegative().optional(),
  basis_gates: z.array(z.string()).optional(),
  coupling_map: z.array(z.array(z.number().int())).optional(),
})

export const PropertiesSchema = z.object({
  last_update_date: z.string().optional(),
  /** Per qubit, a list of `{ name, value }` rows: T1, T2, readout_error, … */
  qubits: z.array(z.array(PropertyRowSchema)).optional(),
  /** Per calibrated gate, which qubits it acts on and its measured error. */
  gates: z
    .array(
      z.object({
        gate: z.string().optional(),
        qubits: z.array(z.number().int()).optional(),
        parameters: z.array(PropertyRowSchema).optional(),
      })
    )
    .optional(),
})
