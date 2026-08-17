import { describe, expect, it } from 'vitest'
import { InvalidCrnError, baseUrlFor, isQuantumCrn, parseCrn } from './crn.js'
import { TEST_CRN, TEST_CRN_EU } from './testing/transport.js'

describe('parseCrn', () => {
  it('reads the region from the sixth segment', () => {
    expect(parseCrn(TEST_CRN).region).toBe('us-east')
    expect(parseCrn(TEST_CRN_EU).region).toBe('eu-de')
  })

  /*
   * The measured failure this whole module exists for: an instance in eu-de
   * answers 404 on the global host, with a perfectly good token behind it.
   */
  it('sends a non-us-east instance to its own regional host', () => {
    expect(parseCrn(TEST_CRN).baseUrl).toBe(
      'https://quantum.cloud.ibm.com/api/v1'
    )
    expect(parseCrn(TEST_CRN_EU).baseUrl).toBe(
      'https://eu-de.quantum.cloud.ibm.com/api/v1'
    )
  })

  it('sends a region it has never heard of to that region, not to the default', () => {
    const crn = TEST_CRN.replace('us-east', 'ap-tok')
    expect(parseCrn(crn).baseUrl).toBe(
      'https://ap-tok.quantum.cloud.ibm.com/api/v1'
    )
  })

  it('refuses a CRN for another IBM service', () => {
    const crn = TEST_CRN.replace('quantum-computing', 'cloudantnosqldb')
    expect(() => parseCrn(crn)).toThrow(InvalidCrnError)
  })

  it('refuses a truncated CRN rather than building a host from an account id', () => {
    expect(() => parseCrn('crn:v1:bluemix:public:quantum-computing')).toThrow(
      InvalidCrnError
    )
  })

  it('refuses an empty region rather than producing https://.quantum…', () => {
    const crn = TEST_CRN.replace(':us-east:', '::')
    expect(() => parseCrn(crn)).toThrow(InvalidCrnError)
    expect(baseUrlFor('us-east')).not.toContain('//.')
  })

  it('refuses a region that would smuggle a host into the URL', () => {
    const crn = TEST_CRN.replace('us-east', 'evil.example.com')
    expect(() => parseCrn(crn)).toThrow(InvalidCrnError)
  })

  /* §11 and this package's redaction rule: a CRN names an account. */
  it('never puts the CRN in the message of its own refusal', () => {
    const crn = TEST_CRN.replace('quantum-computing', 'cloudantnosqldb')
    try {
      parseCrn(crn)
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCrnError)
      expect((error as Error).message).not.toContain('crn:v1')
      expect((error as Error).message).not.toContain('0000000')
    }
  })

  it('answers a predicate without throwing, for a Zod refine', () => {
    expect(isQuantumCrn(TEST_CRN)).toBe(true)
    expect(isQuantumCrn('not a crn')).toBe(false)
  })
})
