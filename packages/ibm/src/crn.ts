/**
 * The Cloud Resource Name, and the one field in it that decides whether every
 * request in this package answers 200 or 404.
 *
 * ── The trap, measured ───────────────────────────────────────────────────
 *
 * An IBM Cloud CRN has ten colon-separated segments:
 *
 *   crn : v1 : bluemix : public : quantum-computing : <region> : a/<account>
 *       : <instance> : :
 *
 * The sixth is the **region**, and it is not decoration. An instance
 * provisioned in `eu-de` is served from `https://eu-de.quantum.cloud.ibm.com`
 * and answers **404** on the global host — with a perfectly good CRN, a
 * perfectly good token and a live instance behind it. A 404 reads as "no such
 * backend", so the failure points at the request rather than at the host, which
 * is why this is a parser with a name and not an inline `split(':')[5]`.
 *
 * ── The host rule ────────────────────────────────────────────────────────
 *
 * `us-east` is served from the unprefixed host; every other region is served
 * from `<region>.` in front of it. Written that way round — one named exception
 * and a rule for the rest — rather than as a map of known regions, because a
 * region IBM adds tomorrow should reach its own host rather than fall back to
 * a wrong one. A fallback here is the 404 above, arrived at by a different
 * route.
 *
 * ── The parse is strict, and refuses rather than guesses ─────────────────
 *
 * A CRN reaches this package from a form field somebody typed into. It is
 * refused unless it has the right prefix, the right service name and a
 * plausible region, because every alternative is worse: a truncated CRN would
 * silently become a request to a host named after an account id, and an empty
 * region would produce `https://.quantum.cloud.ibm.com`, which resolves to
 * nothing and reports a DNS failure three layers from the cause.
 */

/** What every quantum instance's CRN begins with. */
const PREFIX = 'crn:v1:'

/** The service segment. Anything else is a CRN for some other IBM product. */
const SERVICE = 'quantum-computing'

/**
 * The region that is served from the unprefixed host.
 *
 * One constant rather than a list, because the rule is "this one is special"
 * and not "these are the regions that exist". See the header.
 */
const GLOBAL_REGION = 'us-east'

/** The apex the Quantum API is served from, regional prefix aside. */
const API_HOST = 'quantum.cloud.ibm.com'

/** Everything below `/api` this package addresses. */
const API_PATH = '/api/v1'

/**
 * A region as IBM Cloud spells one: two or three lowercase letters, a hyphen,
 * a word. Bounded so a hostile CRN cannot put arbitrary text into a hostname.
 */
const REGION = /^[a-z]{2,4}-[a-z0-9]{2,8}$/

/** Bound on the whole string, so a megabyte cannot reach a header. */
export const MAX_CRN_LENGTH = 512

/** A CRN this package could not use, named for what was wrong with it. */
export class InvalidCrnError extends Error {
  readonly code = 'IBM_CREDENTIAL_INVALID'

  constructor(detail: string) {
    // The CRN itself is never in this message. It names an account.
    super(`the instance CRN is not usable: ${detail}`)
    this.name = 'InvalidCrnError'
  }
}

export interface ParsedCrn {
  readonly region: string
  /** `https://…/api/v1`, with no trailing slash. Every path is appended raw. */
  readonly baseUrl: string
}

/**
 * The region and base URL a CRN implies.
 *
 * @throws {InvalidCrnError} for anything that is not a quantum-computing CRN
 * with a plausible region.
 */
export function parseCrn(crn: string): ParsedCrn {
  const value = crn.trim()
  if (value.length === 0) throw new InvalidCrnError('it is empty')
  if (value.length > MAX_CRN_LENGTH) {
    throw new InvalidCrnError(`it is longer than ${String(MAX_CRN_LENGTH)}`)
  }
  if (!value.startsWith(PREFIX)) {
    throw new InvalidCrnError(`it does not begin with "${PREFIX}"`)
  }

  const segments = value.split(':')
  if (segments.length < 8) {
    throw new InvalidCrnError(
      `it has ${String(segments.length)} colon-separated segments; a CRN has ten`
    )
  }
  if (segments[4] !== SERVICE) {
    /*
     * The service name, quoted from the *expectation* and never from the input.
     * Echoing the segment would put part of somebody's CRN in a message that
     * ends up in a log and, through the API's error envelope, on a screen.
     */
    throw new InvalidCrnError(`it is not a "${SERVICE}" resource`)
  }

  const region = segments[5] ?? ''
  if (!REGION.test(region)) {
    throw new InvalidCrnError('its region segment is not a region')
  }

  return { region, baseUrl: baseUrlFor(region) }
}

/**
 * The API root for a region.
 *
 * Exported separately because a caller who already knows the region — a test,
 * a health probe — should not have to synthesise a CRN to ask.
 */
export function baseUrlFor(region: string): string {
  const host = region === GLOBAL_REGION ? API_HOST : `${region}.${API_HOST}`
  return `https://${host}${API_PATH}`
}

/**
 * Whether a string is shaped like a quantum CRN, without throwing.
 *
 * For a Zod `refine`, where the message is the schema's to write.
 */
export function isQuantumCrn(value: string): boolean {
  try {
    parseCrn(value)
    return true
  } catch {
    return false
  }
}
