/**
 * Bringing a hardware result home, which is where this milestone's endianness
 * trap lives.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT COMES BACK
 *
 * A completed job answers with, per classical register, a list of samples —
 * one per shot — written as **hexadecimal**:
 *
 *     results[0].data.c.samples = ["0x3", "0x0", "0x2", …]
 *
 * Each string is the register read as a single integer. Bit `k` of that
 * integer is classical bit `k`: `0x3` on a two-bit register means `c[0] = 1`
 * and `c[1] = 1`; `0x2` means `c[0] = 0` and `c[1] = 1`.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY THE LAYOUT DOES NOT APPEAR IN THE CONVERSION, AND WHY THAT IS THE
 * EASIEST THING HERE TO GET WRONG
 *
 * The transpiler permutes **qubits**. It does not permute **classical bits**:
 * the source document said `c[1] = measure q[0]`, and what is submitted says
 * `c[1] = measure $53`. The qubit moved; the bit it writes into did not. So
 * the register that comes back is already in the document's own order, and
 * undoing the layout here would *introduce* a permutation rather than remove
 * one.
 *
 * That is the trap. "Results come back indexed by physical qubit" is the
 * intuition everybody has, and acting on it produces code that looks like it
 * is being careful and is silently wrong — wrong in a way a Bell pair cannot
 * reveal, because a Bell pair's distribution is symmetric under exactly the
 * relabelling being tested. `verification/endianness.test.ts` therefore uses
 * circuits that are asymmetric on purpose: an `x` on one wire and nothing on
 * the other, measured into deliberately crossed classical bits.
 *
 * When something genuinely *is* indexed by physical qubit — a calibration
 * array, a per-qubit mitigation table — `invertLayout` and `logicalBitstring`
 * below are the way back, and they are separate functions precisely so that
 * using one where the other belongs is visible at the call site.
 *
 * ════════════════════════════════════════════════════════════════════════
 * BITSTRING ORDER
 *
 * A label is written **highest bit first**, the same order `@qsim/core`'s
 * `formatRegister` and `formatKet` use, so a histogram of hardware counts and
 * a histogram of simulated counts have identical keys and can be laid over one
 * another without a translation step (§3.7's three-column comparison). Qubit 0
 * and classical bit 0 are the *least* significant and are therefore printed
 * last — decision D1.
 */

/** Counts keyed exactly as `@qsim/core`'s shot-mode results are. */
export type ShotCounts = Readonly<Record<string, number>>

const HEX = /^(?:0[xX])?[0-9a-fA-F]+$/

/**
 * `0b101` is a perfectly good hexadecimal number — `b` is a hex digit — and it
 * is almost certainly a binary literal that reached the wrong reader. Read as
 * hex it is 45 313 rather than 5, which is a wrong answer wearing a right
 * one's clothes, so the prefix is refused by name.
 */
const BINARY_PREFIX = /^0[bB]/

/**
 * One sample as an integer.
 *
 * `BigInt` rather than `Number` because the contract allows 64 classical bits
 * and a double stops representing consecutive integers at 2⁵³. A register of
 * 60 bits parsed with `parseInt` would return a value close to the right one
 * and never the right one, and every count would land in the wrong bucket.
 */
export function sampleValue(sample: string): bigint {
  const text = sample.trim()
  if (BINARY_PREFIX.test(text) || !HEX.test(text)) {
    throw new RangeError(
      `"${sample}" is not a hexadecimal sample. A backend writes them as ` +
        `"0x3"; anything else means the result was read from the wrong field.`
    )
  }
  return BigInt(
    text.startsWith('0x') || text.startsWith('0X') ? text : `0x${text}`
  )
}

/**
 * One sample as a bitstring of exactly `clbits` characters, highest classical
 * bit first.
 *
 * A value that does not fit the register is refused rather than truncated: it
 * means the register width passed in disagrees with the one the job ran, and
 * every label produced from then on would be quietly wrong.
 */
export function bitsOfSample(sample: string, clbits: number): string {
  if (!Number.isInteger(clbits) || clbits < 1 || clbits > 64) {
    throw new RangeError(
      `A classical register has between 1 and 64 bits, got ${clbits}.`
    )
  }
  const value = sampleValue(sample)
  if (value >= 1n << BigInt(clbits)) {
    throw new RangeError(
      `Sample "${sample}" does not fit in ${clbits} classical bit(s). The ` +
        `register width does not match the job that produced it.`
    )
  }
  let out = ''
  for (let bit = clbits - 1; bit >= 0; bit--) {
    out += (value >> BigInt(bit)) & 1n ? '1' : '0'
  }
  return out
}

/**
 * A job's samples folded into counts, keyed the way `@qsim/core` keys its own.
 *
 * The layout is deliberately not a parameter. See the header: the classical
 * register is not permuted by transpilation, so there is nothing here to undo.
 */
export function countsFromSamples(
  samples: readonly string[],
  clbits: number
): ShotCounts {
  const counts: Record<string, number> = {}
  for (const sample of samples) {
    const label = bitsOfSample(sample, clbits)
    counts[label] = (counts[label] ?? 0) + 1
  }
  return counts
}

/**
 * `physical → logical`, the inverse of a layout.
 *
 * A `Map` rather than an array because it is sparse: a 156-qubit device holds
 * a two-qubit circuit, and an array would be 154 holes and two entries, which
 * reads as "qubit 3 is logical `undefined`" at every call site instead of
 * "qubit 3 is not part of this circuit".
 */
export function invertLayout(
  layout: readonly number[]
): ReadonlyMap<number, number> {
  const inverse = new Map<number, number>()
  for (const [logical, physical] of layout.entries()) {
    inverse.set(physical, logical)
  }
  return inverse
}

/**
 * A bitstring over *physical* qubits, rewritten over the circuit's own.
 *
 * Only for data that really is indexed by qubit rather than by classical bit —
 * per-qubit mitigation tables, a device-wide state readout. Both strings are
 * highest-index-first, so `physical` has one character per device qubit and
 * the answer has one per logical qubit. A logical qubit whose physical
 * partner is out of range is an error, not a zero.
 */
export function logicalBitstring(
  physical: string,
  layout: readonly number[]
): string {
  const width = physical.length
  let out = ''
  for (let logical = layout.length - 1; logical >= 0; logical--) {
    const wire = layout[logical] as number
    const index = width - 1 - wire
    const bit = physical[index]
    if (bit === undefined) {
      throw new RangeError(
        `Logical qubit ${logical} sits on physical qubit ${wire}, which is ` +
          `outside a ${width}-character reading of the device.`
      )
    }
    out += bit
  }
  return out
}
