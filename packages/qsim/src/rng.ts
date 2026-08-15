/**
 * Seeded pseudo-randomness — the engine's only source of chance.
 *
 * Everything that samples takes an `Rng` instead of calling `Math.random()`,
 * for three reasons that all pay for themselves:
 *
 *  - **Tests.** A histogram assertion against an unseeded generator is a flaky
 *    test by construction. With a seed, the chi-squared value of §13 is a
 *    constant that either passes or reports a real regression.
 *  - **Agreement between machines.** The client simulates for live feedback
 *    and the server simulates to validate the same circuit (§11). If a shared
 *    seed produced different counts on the two sides, a user would see one
 *    histogram locally and be judged against another.
 *  - **Injection.** A test can pass a scripted stream — `{ next: () => 0.9 }`
 *    — to force a branch that a real generator reaches once in a million.
 *
 * WHY A HAND-WRITTEN GENERATOR: §12.3 — this package has no dependencies.
 *
 * WHY xoshiro128** AND NOT xorshift128+ OR PCG32. Both of those are 64-bit
 * designs and JavaScript has no 64-bit integer arithmetic. Emulating one means
 * `BigInt`, which allocates on every operation and is roughly an order of
 * magnitude slower, or splitting each word into halves by hand — precisely the
 * kind of code that is subtly wrong in one engine and right in another, which
 * is the one failure this file exists to prevent. xoshiro128** is the 32-bit
 * member of the same family: it uses only `Math.imul`, shifts and xor, all of
 * them exactly defined on 32-bit words by the language, so a seed yields the
 * same stream in every browser and in Node. Period 2¹²⁸−1, passes BigCrush.
 *
 * NOT CRYPTOGRAPHIC. Nothing here guards a secret; imitating shot noise is the
 * whole job.
 */

/** A stream of uniform doubles in `[0, 1)`. */
export interface Rng {
  next(): number
}

/** 2⁵³, the number of distinct doubles `next()` can return. */
const TWO_53 = 9007199254740992

/** 2²⁶, the weight of the high word inside a 53-bit mantissa. */
const TWO_26 = 67108864

/** 32-bit rotate left — the primitive xoshiro is built from. */
function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}

/**
 * SplitMix32, used only to expand the seed.
 *
 * xoshiro needs 128 bits of well-mixed state, and seeds are things like `1` or
 * a circuit id. Feeding a sparse value straight into the state leaves the
 * generator correlated for its first few outputs — neighbouring seeds would
 * start with visibly similar streams, which is exactly what a test sweeping
 * `seed = 0…19` would trip over. SplitMix32 spreads one integer over four
 * words with avalanche, and is the seeding routine xoshiro's authors
 * recommend.
 */
function splitmix32(seed: number): () => number {
  let counter = seed >>> 0
  return (): number => {
    counter = (counter + 0x9e3779b9) >>> 0
    let mixed = counter
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad)
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97)
    return (mixed ^ (mixed >>> 15)) >>> 0
  }
}

/**
 * A generator seeded by `seed`. Only the low 32 bits of the seed are used, so
 * seeds are effectively taken modulo 2³².
 */
export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new RangeError(`An RNG seed must be an integer, got ${seed}.`)
  }

  // Uint32Array rather than four locals: every store masks back to 32 bits, so
  // the state cannot drift into the doubles that `^` and `<<` produce.
  const state = new Uint32Array(4)
  const expand = splitmix32(seed)
  for (let i = 0; i < 4; i++) state[i] = expand()
  // All-zero is xoshiro's single fixed point — it would emit zeros forever.
  // SplitMix32 makes it astronomically unlikely; ruling it out costs one test.
  if ((state[0] | state[1] | state[2] | state[3]) === 0) state[0] = 1

  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(state[1], 5), 7), 9) >>> 0
    const shifted = state[1] << 9
    state[2] ^= state[0]
    state[3] ^= state[1]
    state[1] ^= state[2]
    state[0] ^= state[3]
    state[2] ^= shifted
    state[3] = rotl(state[3], 11)
    return result
  }

  return {
    next(): number {
      // Two words, not one. A single 32-bit draw quantises the unit interval
      // into 2³² steps, and the sampler of `measure.ts` searches a cumulative
      // distribution whose slices are 2⁻ⁿ wide: at 28 qubits a slice would be
      // 16 steps across, and any outcome rarer than 2⁻³² could never be drawn
      // at all. Filling the full 53-bit mantissa puts the quantisation below
      // anything the amplitudes themselves can express.
      const high = nextUint32() >>> 5 // 27 bits
      const low = nextUint32() >>> 6 // 26 bits
      return (high * TWO_26 + low) / TWO_53
    },
  }
}

/**
 * A seed for a run nobody seeded — the single sanctioned use of `Math.random`
 * in the engine.
 *
 * It exists so that "unseeded" still means "seeded, with a seed we can show
 * the user and replay": the caller keeps the number, and the run becomes
 * reproducible after the fact.
 */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0
}
