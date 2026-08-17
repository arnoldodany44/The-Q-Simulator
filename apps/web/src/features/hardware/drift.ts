/**
 * Whether the document on screen is the document the device ran.
 *
 * Its own module because it is a pure function over two ids, and
 * `HardwareResultView.tsx` is a file of components: a non-component export
 * there costs Fast Refresh for the whole file, so editing any part of the
 * comparison panel would reload the page instead of hot-swapping it. The
 * reasoning below is the interesting half and it moves with the code.
 */

import type { HardwareJob } from '@qsim/contract'

/** Whether the document on screen is the document the device ran. */
export type VersionDrift =
  /** The job names a version and it is the one being shown. */
  | 'same'
  /** The job names a version and it is not this one. */
  | 'changed'
  /**
   * Nothing to compare: the row predates version pinning, or the circuit could
   * not be loaded. Not the same as agreement, and it is not reported as one.
   */
  | 'unknown'

/**
 * ── WHY AN EDIT MUST STOP THE COMPARISON, NOT ANNOTATE IT ────────────────
 *
 * The three columns exist to attribute a difference to the device. Every one
 * of the figures on the panel — the fidelity, the total variation, "on the
 * device |01⟩ lost the most" — is a subtraction between the first column and
 * the third, so a first column computed from a *different circuit* prints an
 * edit in the place reserved for physics. A Bell pair rewritten as a single `x`
 * produces "the device moved 94.5 % of the probability", which is a true
 * subtraction and a false sentence.
 *
 * A device queue is hours deep, so this is the ordinary case rather than an
 * edge case: submit in the evening, open the page tomorrow, and the circuit has
 * been edited twice in between. Only a change in register *width* was caught
 * before, by the width guard below, and any same-width edit went through in
 * silence.
 */
export function driftOf(
  job: Pick<HardwareJob, 'program'>,
  currentVersionId: string | null
): VersionDrift {
  const submitted = job.program?.versionId
  if (submitted === undefined || currentVersionId === null) return 'unknown'
  return submitted === currentVersionId ? 'same' : 'changed'
}
