import { bitsOfSample, countsFromSamples } from '@qsim/transpile'
import { describe, expect, it } from 'vitest'
import { RESULTS_NOT_READY, serviceErrorCodes } from './errors.js'
import {
  MAX_SAMPLES,
  ResultsDocumentSchema,
  resultsPending,
  samplesOf,
} from './results.js'
import { RECORDED, resultsOf } from './testing/transport.js'

function parse(body: string) {
  return ResultsDocumentSchema.parse(JSON.parse(body))
}

describe('samplesOf', () => {
  it('finds the named register', () => {
    const reading = samplesOf(parse(resultsOf(['0x3', '0x0'])), 'c')
    expect(reading.samples).toEqual(['0x3', '0x0'])
    expect(reading.numBits).toBe(2)
  })

  /*
   * Object key order is a property of a serialiser rather than of a result, so
   * "the first register" is not a thing a reader may rely on. Reading the wrong
   * register produces a histogram of the wrong measurements that looks
   * perfectly plausible.
   */
  it('refuses to guess when the register it was asked for is absent', () => {
    expect(() => samplesOf(parse(resultsOf(['0x1'], 'meas')), 'c')).toThrow(
      /register "c"/
    )
  })

  it('names the registers that are there, because that is the whole fix', () => {
    expect(() => samplesOf(parse(resultsOf(['0x1'], 'meas')), 'c')).toThrow(
      /meas/
    )
  })

  it('refuses a document with no pub result at all', () => {
    expect(() => samplesOf(parse('{"results":[]}'), 'c')).toThrow(
      /no pub result/
    )
  })

  it('bounds what a third party can make this process allocate', () => {
    const huge = JSON.stringify({
      results: [
        { data: { c: { samples: Array(MAX_SAMPLES + 1).fill('0x0') } } },
      ],
    })
    expect(() => ResultsDocumentSchema.parse(JSON.parse(huge))).toThrow()
  })
})

describe('resultsPending', () => {
  it('recognises both spellings of "not yet"', () => {
    const codes = serviceErrorCodes(JSON.parse(RECORDED.resultsNotReady))
    expect(codes).toContain(RESULTS_NOT_READY)
    expect(resultsPending(400, codes, RESULTS_NOT_READY)).toBe(true)
    expect(resultsPending(204, [], RESULTS_NOT_READY)).toBe(true)
  })

  it('does not confuse another 400 with a job that is still running', () => {
    expect(resultsPending(400, [1291], RESULTS_NOT_READY)).toBe(false)
    expect(resultsPending(500, [], RESULTS_NOT_READY)).toBe(false)
  })

  it('reads a numeric code and never a string that looks like one', () => {
    expect(serviceErrorCodes({ errors: [{ code: '1234' }] })).toEqual([])
  })
})

/**
 * The endianness path, asserted here as well as in `@qsim/transpile`, because
 * this is the package that decides *which strings* reach the conversion — and
 * an off-by-one in the plumbing looks exactly like an off-by-one in the
 * arithmetic.
 *
 * Every case is asymmetric on purpose. A Bell pair's `{"00","11"}` is symmetric
 * under exactly the mistake being tested and would pass either way.
 */
describe('the hexadecimal samples, read the project s way (D1)', () => {
  it('reads bit k of the integer as classical bit k', () => {
    // 0x1 = c[0]=1, c[1]=0. Printed highest bit first, that is "01".
    expect(bitsOfSample('0x1', 2)).toBe('01')
    // 0x2 = c[0]=0, c[1]=1 → "10".
    expect(bitsOfSample('0x2', 2)).toBe('10')
  })

  it('folds an asymmetric distribution into asymmetric counts', () => {
    const reading = samplesOf(
      parse(resultsOf(['0x1', '0x1', '0x1', '0x2'])),
      'c'
    )
    const counts = countsFromSamples(reading.samples, 2)
    expect(counts).toEqual({ '01': 3, '10': 1 })
    // The check that a reversed reading would fail: the two buckets are not
    // interchangeable, and swapping them changes the answer.
    expect(counts['01']).not.toBe(counts['10'])
  })
})
