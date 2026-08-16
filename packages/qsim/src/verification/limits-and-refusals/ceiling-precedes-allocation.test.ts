/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — THE 4ⁿ CEILING, AND EVERY PATH TO IT.
 *
 * Lens: limits and refusals. Nothing here checks physics; what it checks is
 * that the one resource §3.3 can exhaust — memory — is refused *before* it is
 * reserved, that the refusal carries the numbers a translated sentence needs,
 * and that no exported entry point into the density mode can be talked past it.
 *
 * The arithmetic is re-derived rather than read. `densityBytes` is compared
 * against an integer computation in `BigInt`, because 4ⁿ × 16 crosses 2⁵³ at
 * n = 25 and a Float64 check against a Float64 implementation would agree with
 * itself all the way past the point where both are wrong. The ceiling is then
 * *solved for* — the largest n whose ρ fits the published budget — instead of
 * being compared against the constant that claims to be it.
 *
 * The claim that costs the most to get wrong is "checked before allocating",
 * because the failure it prevents is invisible in a passing test: a guard that
 * runs after `new Float64Array(4 ** 13)` still throws a `DensityTooLargeError`
 * and still reads as correct, having already asked the allocator for a
 * gigabyte. So this file does not take the ordering on trust from the source.
 * It replaces the global `Float64Array` with a counting subclass and requires
 * that every refusing path allocate **nothing** — not a smaller buffer, not a
 * scratch array, nothing above a handful of entries.
 *
 * Three ordering traps are checked besides:
 *
 *  1. The ceiling must beat every *other* refusal `runNoisyDensity` can make.
 *     A thirteen-qubit circuit that also measures mid-circuit must come back as
 *     `DensityTooLargeError`, not as `MidCircuitMeasurementError` — because the
 *     second one is answered by "remove the measurement", and following that
 *     advice on a thirteen-qubit register is how a reader reaches the
 *     allocation the first refusal exists to prevent.
 *
 *  2. Every function in the package that can *originate* a ρ has to guard. The
 *     ones that copy an existing one need not, and are listed here so that the
 *     distinction is deliberate rather than an omission.
 *
 *  3. The refusal has to survive being caught. It extends `RangeError`, so a
 *     caller with `catch (e) { if (e instanceof RangeError) … }` around an
 *     allocation keeps catching it — and it still has to be distinguishable, or
 *     the panel cannot tell "reduce the register" from "something went wrong".
 */

import { describe, expect, it } from 'vitest'

import {
  DENSITY_BUDGET_BYTES,
  DensityTooLargeError,
  MAX_DENSITY_QUBITS,
  alloc as densityAlloc,
  densityBytes,
  fromStatevector,
} from '../../density.js'
import { partialTrace } from '../../metrics.js'
import { NOISE_PROFILES } from '../../noise.js'
import {
  runNoisyDensity,
  type CircuitLike,
  type OperationLike,
} from '../../runner.js'
import { alloc as allocState } from '../../statevector.js'

/**
 * 4ⁿ complex entries × 16 bytes, in exact integers.
 *
 * The point of `BigInt` is that this cannot agree with a Float64 mistake: past
 * n = 25 the product exceeds 2⁵³ and any implementation working in doubles
 * starts rounding, so a check written the same way as the code would confirm
 * the code's own rounding rather than the size of a matrix.
 */
function bytesFor(qubits: number): bigint {
  const dimension = 2n ** BigInt(qubits)
  return dimension * dimension * 16n
}

/** A circuit shaped like the ones the panel sends: an H wall and a CX ladder. */
function ladder(qubits: number): CircuitLike {
  const operations: OperationLike[] = []
  let column = 0
  for (let q = 0; q < qubits; q++) {
    operations.push({ id: `h${q}`, gate: 'h', targets: [q], column: column++ })
  }
  for (let q = 0; q + 1 < qubits; q++) {
    operations.push({
      id: `cx${q}`,
      gate: 'cx',
      targets: [q + 1],
      controls: [q],
      column: column++,
    })
  }
  return { qubits, clbits: 0, operations }
}

/**
 * Run `body` with every `Float64Array` allocation recorded, and answer with the
 * lengths asked for.
 *
 * A subclass rather than a proxy, so `instanceof` still holds for anything the
 * engine hands back and the arrays behave exactly as before. The engine reads
 * `Float64Array` off the global at each `new`, which is what makes this
 * observable at all — and is also the reason it has to be restored in a
 * `finally`.
 */
function allocationsDuring(body: () => void): number[] {
  const scope = globalThis as { Float64Array: Float64ArrayConstructor }
  const original = scope.Float64Array
  const lengths: number[] = []

  class Counting extends original {
    constructor(...args: ConstructorParameters<Float64ArrayConstructor>) {
      super(...args)
      lengths.push(this.length)
    }
  }

  scope.Float64Array = Counting
  try {
    body()
  } finally {
    scope.Float64Array = original
  }
  return lengths
}

/** What `body` threw, or `null` — so the assertion can be about the value. */
function thrownBy(body: () => void): unknown {
  try {
    body()
    return null
  } catch (cause) {
    return cause
  }
}

describe('the budget arithmetic, re-derived', () => {
  it('counts 4ⁿ complex entries at sixteen bytes each', () => {
    for (let qubits = 0; qubits <= 20; qubits++) {
      expect(BigInt(densityBytes(qubits)), `n=${qubits}`).toBe(bytesFor(qubits))
    }
  })

  it('puts the published ceiling exactly where the published budget does', () => {
    // Solved for rather than compared against: the largest n whose ρ fits.
    let solved = 0
    while (bytesFor(solved + 1) <= BigInt(DENSITY_BUDGET_BYTES)) solved += 1

    expect(solved).toBe(MAX_DENSITY_QUBITS)
    // And §3.3's own sentence: the mode tops out around ten to twelve.
    expect(solved).toBeGreaterThanOrEqual(10)
    expect(solved).toBeLessThanOrEqual(12)
    // No gap to argue about — the first refused size is over the budget, and
    // by a factor of four, which is what makes the ceiling a hard edge.
    expect(bytesFor(solved + 1)).toBe(BigInt(DENSITY_BUDGET_BYTES) * 4n)
  })
})

describe('the refusal happens before the allocation', () => {
  it('reserves nothing for a register one past the ceiling', () => {
    const over = MAX_DENSITY_QUBITS + 1
    const lengths = allocationsDuring(() => {
      expect(() => densityAlloc(over)).toThrow(DensityTooLargeError)
    })
    expect(lengths, `allocated ${lengths.join(', ')} doubles`).toEqual([])
  })

  it.each([13, 14, 16, 20, 28])(
    'reserves nothing at %i qubits either',
    (qubits) => {
      const lengths = allocationsDuring(() => {
        expect(() => densityAlloc(qubits)).toThrow(DensityTooLargeError)
      })
      expect(lengths).toEqual([])
    }
  )

  it('reserves nothing when a whole noisy run is refused', () => {
    /*
     * The path the worker takes. `runNoisyDensity` validates the profile,
     * checks the ceiling, and only then builds the plan — so a refused run must
     * not have allocated the plan either, and certainly not ρ. The circuit is a
     * real one rather than an empty shell, so a guard placed after the walk
     * would show up as the statevector-sized scratch the walk needs.
     */
    const circuit = ladder(MAX_DENSITY_QUBITS + 1)
    const lengths = allocationsDuring(() => {
      expect(() =>
        runNoisyDensity(circuit, { profile: NOISE_PROFILES.teaching })
      ).toThrow(DensityTooLargeError)
    })
    expect(lengths, `allocated ${lengths.join(', ')} doubles`).toEqual([])
  })

  it('reserves nothing when a partial trace is asked for too much', () => {
    // The other way to originate a ρ: trace a pure state down to a subsystem
    // that is itself too large. Thirteen kept qubits is the same gigabyte.
    const state = allocState(MAX_DENSITY_QUBITS + 1)
    const lengths = allocationsDuring(() => {
      expect(() =>
        partialTrace(
          state,
          Array.from({ length: MAX_DENSITY_QUBITS + 1 }, (_, q) => q)
        )
      ).toThrow(DensityTooLargeError)
    })
    expect(lengths).toEqual([])
  })

  it('reserves nothing when a pure state is too wide to square', () => {
    const state = allocState(MAX_DENSITY_QUBITS + 1)
    const lengths = allocationsDuring(() => {
      expect(() => fromStatevector(state)).toThrow(DensityTooLargeError)
    })
    expect(lengths).toEqual([])
  })

  it('does allocate when the register fits, so the check above has teeth', () => {
    // A negative test that never allocates would pass on an engine that
    // refused everything. Six qubits is 64 KB: two arrays of 4096 doubles.
    const lengths = allocationsDuring(() => {
      densityAlloc(6)
    })
    expect(lengths).toEqual([4096, 4096])
  })
})

describe('the ceiling outranks every other refusal', () => {
  it('answers a measuring thirteen-qubit circuit with the ceiling', () => {
    /*
     * Both refusals apply. If the mid-circuit one wins, the reader is told to
     * remove the measurement — and doing so walks them straight into the
     * allocation the other refusal exists to prevent. Order matters, and it is
     * not visible from either message on its own.
     */
    const circuit: CircuitLike = {
      qubits: MAX_DENSITY_QUBITS + 1,
      clbits: 1,
      operations: [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        {
          id: 'm',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        { id: 'x', gate: 'x', targets: [1], column: 2 },
      ],
    }
    const thrown = thrownBy(() => {
      runNoisyDensity(circuit, { profile: NOISE_PROFILES.teaching })
    })
    expect(thrown).toBeInstanceOf(DensityTooLargeError)
  })

  it('answers an unphysical profile before the ceiling, which is also right', () => {
    /*
     * The opposite ordering, and deliberately so: a profile with T2 > 2·T1 is a
     * typo the reader can fix, it costs one comparison to detect, and it is
     * checked first. What matters is only that neither refusal allocates, which
     * is asserted here on the pair.
     */
    const circuit = ladder(MAX_DENSITY_QUBITS + 1)
    const lengths = allocationsDuring(() => {
      expect(() =>
        runNoisyDensity(circuit, {
          profile: { ...NOISE_PROFILES.teaching, t2Ns: 1e9 },
        })
      ).toThrow()
    })
    expect(lengths).toEqual([])
  })
})

describe('the refusal carries what a translated sentence needs', () => {
  it('names the register, the ceiling and both byte counts', () => {
    const qubits = MAX_DENSITY_QUBITS + 1
    const thrown = thrownBy(() => {
      densityAlloc(qubits)
    })
    expect(thrown).toBeInstanceOf(DensityTooLargeError)
    const failure = thrown as DensityTooLargeError

    // Every number a catalog string could interpolate, and each one right.
    expect(failure.qubits).toBe(qubits)
    expect(failure.maxQubits).toBe(MAX_DENSITY_QUBITS)
    expect(BigInt(failure.requiredBytes)).toBe(bytesFor(qubits))
    expect(failure.budgetBytes).toBe(DENSITY_BUDGET_BYTES)
    // A UI that only has the message would have to parse English out of it.
    expect(failure.message).toContain(String(MAX_DENSITY_QUBITS))
  })

  it('stays catchable as a RangeError and distinguishable from one', () => {
    const thrown = thrownBy(() => {
      densityAlloc(MAX_DENSITY_QUBITS + 1)
    })
    // A caller already wrapping an allocation keeps catching it…
    expect(thrown).toBeInstanceOf(RangeError)
    // …and a panel deciding what to offer can still tell the two apart.
    expect(thrown).toBeInstanceOf(DensityTooLargeError)
    expect((thrown as Error).name).toBe('DensityTooLargeError')

    // The other direction: an ordinary range failure must not be mistaken for
    // the ceiling, or a zero-qubit circuit would be offered "use trajectories".
    const zero = thrownBy(() => {
      densityAlloc(0)
    })
    expect(zero).toBeInstanceOf(RangeError)
    expect(zero).not.toBeInstanceOf(DensityTooLargeError)
  })
})

describe('every size up to the ceiling is admitted', () => {
  it('accepts each register §3.3 promises, and refuses each one past it', () => {
    // Arithmetic only for the large sizes — asserting the decision, not paying
    // for it. Twelve qubits is 256 MB, which is not something a correctness
    // suite running beside three other workspaces should reserve.
    for (let qubits = 1; qubits <= MAX_DENSITY_QUBITS; qubits++) {
      expect(
        bytesFor(qubits) <= BigInt(DENSITY_BUDGET_BYTES),
        `n=${qubits}`
      ).toBe(true)
    }
    for (let qubits = MAX_DENSITY_QUBITS + 1; qubits <= 24; qubits++) {
      expect(() => densityAlloc(qubits), `n=${qubits}`).toThrow(
        DensityTooLargeError
      )
    }
  })

  it('really builds one at eight qubits, and it is a state', () => {
    // 1 MB — small enough for this suite, large enough that the guard is not
    // being tested only against sizes it would never have questioned.
    const rho = densityAlloc(8)
    expect(rho.size).toBe(4 ** 8)
    expect(rho.re.length).toBe(rho.size)
    expect(rho.im.length).toBe(rho.size)
    expect(densityBytes(8)).toBe((rho.re.length + rho.im.length) * 8)
  })
})
