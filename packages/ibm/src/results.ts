/**
 * The results document, and the one place this package refuses to be helpful.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT COMES BACK
 *
 *     { "results": [
 *         { "data": { "c": { "samples": ["0x3","0x0","0x2"], "num_bits": 2 } },
 *           "metadata": { … } } ],
 *       "metadata": { … } }
 *
 * One entry per pub, and this system submits exactly one. Inside it, one entry
 * per **classical register**, keyed by the register's name in the submitted
 * program — `c` for everything `emitPhysicalQasm` writes. The samples are the
 * register read as an integer, one per shot, in hexadecimal.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE FINDS THE SAMPLES. IT DOES NOT CONVERT THEM.
 *
 * That is deliberate and it is the milestone's endianness decision expressed as
 * a package boundary. `countsFromSamples` lives in `@qsim/transpile`, beside
 * the emitter that decided which classical bit each measurement writes into,
 * and its header carries the argument in full: the transpiler permutes
 * *qubits* and not *classical bits*, so the register that comes home is already
 * in the source document's own order and applying the layout here would
 * introduce a permutation rather than remove one.
 *
 * The reason it matters that the conversion is not duplicated here: the
 * mistake it guards against is invisible. A Bell pair's distribution is
 * symmetric under exactly the relabelling being tested, so a wrong conversion
 * passes every "did we get 00 and 11" check anybody writes — and a real device
 * gives you nothing to compare against, because there is no ideal answer beside
 * it. Two implementations of that conversion would be two chances to get it
 * wrong and one place to notice.
 *
 * So what this file exports is `samplesOf`: the hexadecimal strings, found and
 * bounded, handed to the one function that knows what they mean.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * "NOT READY" IS NOT A FAILURE
 *
 * A results read on a job that has not finished answers **400** with error code
 * 1234 on the live service — not the 204 the documentation describes. Both are
 * treated as "ask again later" and neither is an error, because a poll that
 * classified them as one would fail a job for the crime of still running.
 */

import { z } from 'zod'
import { IbmError } from './errors.js'

/**
 * How many shots a single result may carry.
 *
 * The Open Plan's ceiling on a submission is far below this; the bound exists
 * because this array is parsed into memory in a worker that is also holding
 * other jobs, and a response of unbounded length from a third party is
 * unbounded memory in a process with a container limit. 200 000 is two orders
 * above anything this system submits.
 */
export const MAX_SAMPLES = 200_000

/**
 * A hexadecimal sample, bounded on the way in.
 *
 * Sixteen hex digits is 64 bits, which is the contract's ceiling on a classical
 * register. `bitsOfSample` refuses a value that does not fit the register it
 * was told about, so this is not the check that matters — it is the gate that
 * stops a megabyte-long "sample" reaching a `BigInt` constructor.
 */
const SampleSchema = z.string().min(1).max(18)

const RegisterSchema = z.object({
  samples: z.array(SampleSchema).max(MAX_SAMPLES).optional(),
  num_bits: z.number().int().min(1).max(64).optional(),
})

const PubResultSchema = z.object({
  data: z.record(z.string(), RegisterSchema).optional(),
})

export const ResultsDocumentSchema = z.object({
  results: z.array(PubResultSchema).optional(),
})

export type ResultsDocument = z.infer<typeof ResultsDocumentSchema>

export interface RegisterSamples {
  /** The classical register's name in the submitted program. */
  readonly register: string
  /** One hexadecimal string per shot, exactly as the service sent them. */
  readonly samples: readonly string[]
  /** The register's width as the service reports it, or null. */
  readonly numBits: number | null
}

/**
 * The samples of the one pub this system submits.
 *
 * ── Why the register is chosen by name and not by position ───────────────
 *
 * `data` is an object, and object key order is a property of a serialiser
 * rather than of a result. Taking "the first register" would make the answer
 * depend on how the service happened to write its JSON — which is stable in
 * practice and is exactly the kind of stability that changes on a Tuesday.
 * So the caller names the register it emitted, and a document that does not
 * contain it is a failure rather than a fallback: a job whose result is read
 * from the wrong register is a histogram of the wrong measurements, and it
 * looks perfectly plausible.
 *
 * The one convenience: when the document holds exactly one register and the
 * caller asked for a name that is not there, the error says which names *are*,
 * because that is the difference between a five-minute fix and an afternoon.
 */
export function samplesOf(
  document: ResultsDocument,
  register: string
): RegisterSamples {
  const first = document.results?.[0]
  if (first === undefined) {
    throw new IbmError(
      'IBM_MALFORMED_RESPONSE',
      'the results document carries no pub result'
    )
  }
  const data = first.data ?? {}
  const found = data[register]
  if (found?.samples === undefined) {
    const available = Object.keys(data).sort().join(', ')
    throw new IbmError(
      'IBM_MALFORMED_RESPONSE',
      `the results document has no samples for register "${register}"` +
        (available === '' ? '' : `; it has ${available}`)
    )
  }
  return {
    register,
    samples: found.samples,
    numBits: found.num_bits ?? null,
  }
}

/**
 * Whether a results read means "not yet" rather than "no".
 *
 * Both spellings the service uses: the documented 204, and the 400-with-1234
 * the live service actually answers. Kept as one predicate so a caller cannot
 * handle one and forget the other — which would show up as jobs failing at
 * random, depending on which branch the service felt like taking.
 */
export function resultsPending(
  status: number,
  codes: readonly number[],
  notReadyCode: number
): boolean {
  if (status === 204) return true
  return status === 400 && codes.includes(notReadyCode)
}
