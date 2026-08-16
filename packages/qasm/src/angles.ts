/**
 * Angles, written the way a target language spells them.
 *
 * Both output languages of this package take the same two forms — a decimal
 * literal, or a rational multiple of π — so the formatting lives here once
 * rather than twice. OpenQASM 3 has `pi` as a built-in constant; Python gets
 * it from `math`, which is why `usesPi` exists: the Qiskit emitter has to
 * decide whether to write the import.
 *
 * ── WHY THE π FORM IS RECOGNISED BY EXACT EQUALITY ───────────────────────
 *
 * `pi/2` is enormously more readable than `1.5707963267948966`, and a reader
 * comparing an export against a textbook wants the first. But recognising it
 * with a tolerance would mean the exporter is allowed to *change* the circuit
 * — an angle a hundredth of an ulp away from π/2 would leave as π/2, and the
 * exported file would then describe an operation the simulator never ran.
 * That is precisely the class of silent divergence this milestone exists to
 * prevent, so the test is `===` against the double the ratio itself produces.
 * An angle that is not exactly a small multiple of π is printed as a decimal,
 * however ugly, and round-trips bit for bit.
 *
 * `String(value)` is what makes that claim true for the decimal branch: it
 * produces the shortest decimal that reads back as the same double, which is
 * the definition of a lossless print. The trailing `.0` is then added for
 * integral values, because an integer literal where a float belongs is an
 * implicit cast in OpenQASM and an `int` in Python, and neither is what the
 * document said.
 */

/** Largest denominator recognised in the π form. */
const MAX_DENOMINATOR = 16

/** Largest numerator recognised in the π form, in absolute value. */
const MAX_NUMERATOR = 64

/** A rational multiple of π: `numerator · π / denominator`. */
export interface PiMultiple {
  readonly numerator: number
  readonly denominator: number
}

/**
 * The ratio `value / π` as a small fraction, or `null` when `value` is not
 * *exactly* the double that fraction produces. Zero answers `null`: it is
 * spelled `0.0`, not `0*pi`.
 *
 * Denominators are tried in ascending order, so the reduced form wins when it
 * is exact — `π/2` rather than `2·π/4`. When only the unreduced form is the
 * right double (which happens for denominators that are not powers of two,
 * where the two spellings can differ by an ulp), the unreduced form is what
 * comes out: an ugly literal that is right beats a tidy one that is not.
 */
export function asPiMultiple(value: number): PiMultiple | null {
  if (!Number.isFinite(value) || value === 0) return null
  const ratio = value / Math.PI
  for (let denominator = 1; denominator <= MAX_DENOMINATOR; denominator++) {
    const numerator = Math.round(ratio * denominator)
    if (numerator === 0 || Math.abs(numerator) > MAX_NUMERATOR) continue
    if ((numerator * Math.PI) / denominator === value) {
      return { numerator, denominator }
    }
  }
  return null
}

/**
 * An angle as source text: `pi`, `-pi/2`, `3*pi/4`, or a decimal literal.
 *
 * `3*pi/4` parses as `(3*pi)/4` in both OpenQASM 3 and Python, so no
 * parentheses are needed and none are written.
 */
export function formatAngle(value: number): string {
  if (!Number.isFinite(value)) {
    // Neither language has a literal for these, and no gate in the catalog
    // has a meaning at one. `matrixFor` refuses them too, one layer down.
    throw new RangeError(
      `An angle must be a finite number to be exported, got ${String(value)}.`
    )
  }

  const pi = asPiMultiple(value)
  if (pi === null) return decimalLiteral(value)

  const sign = pi.numerator < 0 ? '-' : ''
  const magnitude = Math.abs(pi.numerator)
  const head = magnitude === 1 ? 'pi' : `${magnitude}*pi`
  return pi.denominator === 1
    ? `${sign}${head}`
    : `${sign}${head}/${pi.denominator}`
}

/** Whether any of these angles will be written using `pi`. */
export function usesPi(values: readonly number[]): boolean {
  return values.some((value) => asPiMultiple(value) !== null)
}

/**
 * The shortest decimal that reads back as the same double, always carrying a
 * fractional part or an exponent so that it is unambiguously a float.
 */
function decimalLiteral(value: number): string {
  const text = String(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}
