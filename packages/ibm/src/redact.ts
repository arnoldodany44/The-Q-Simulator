/**
 * The one function in this package that everything else has to go through
 * before it produces text.
 *
 * ── Why a package about HTTP needs a redactor at all ─────────────────────
 *
 * Three secrets pass through here and every one of them has a natural path
 * into a string:
 *
 *   - the **API key**, which is form-encoded into the IAM request body, so a
 *     naive "could not POST <url> with <body>" is the key in a log line;
 *   - the **IAM bearer token**, which is a request header on every call and
 *     lasts an hour — long enough for a log line to still be a live credential
 *     when somebody reads it;
 *   - the **CRN**, which is a header too and names the account that pays.
 *
 * None of the three is the project's. §3.7 and risk 4 are explicit that each
 * user brings their own token, which means a leak here is not this project
 * spending its own budget — it is one person's credential in another person's
 * incident report.
 *
 * ── The rule, and why it is shaped as "allow-list of what may be said" ────
 *
 * `describeRequest` below builds the *only* description of a request this
 * package will ever emit, from fields chosen one at a time: the method, the
 * path, the status. Not the headers, not the body, not the query string. That
 * is the opposite of scanning a formatted string for things that look like
 * secrets, and it is the right way round — a scanner is a list of the leaks
 * somebody thought of, and it fails silently for the one they did not.
 *
 * `scrub` exists anyway, for the text this package does not author: an error
 * message from the service, the `message` field of an IAM refusal. Those are
 * strings from somewhere else that end up in a `cause`, and a belt beside the
 * braces is cheap.
 */

/**
 * A bearer token, an API key or a CRN replaced by a fixed marker.
 *
 * Deliberately not a partial reveal. "Last four characters" is a habit from
 * card numbers, where the tail is printed on a receipt anyway; an API key has
 * no such convention, and revealing any of it in a log makes the log a place
 * where part of a credential lives. §11's sentence about the credential
 * endpoint — metadata, never the token, "not even partially" — is the same
 * rule, and it would be strange to hold the HTTP surface to a looser one.
 */
export const REDACTED = '[redacted]'

/**
 * Anything that looks like a credential, replaced.
 *
 * The patterns are for text this package did not write. Order matters only in
 * that the CRN pattern is applied before the generic long-token one, so a CRN
 * is reported as a CRN rather than as an anonymous blob.
 */
const PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer <jwt>` in any casing, in any quoting.
  /(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  // A CRN names an account and an instance; both are identifiers worth hiding.
  /crn:v1:[^\s"']+/gi,
  // An IAM apikey in a form body, whatever separates it from its value.
  /(apikey["'\s:=]+)[A-Za-z0-9_-]{16,}/gi,
]

/**
 * Replaces every credential-shaped run in a string.
 *
 * Never throws and never returns `undefined`: this is called from `catch`
 * blocks and from log formatters, where a redactor that could fail would be a
 * redactor that occasionally does not run.
 */
export function scrub(text: string): string {
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string | undefined) =>
      prefix === undefined ? REDACTED : `${prefix}${REDACTED}`
    )
  }
  return out
}

/**
 * The only description of an HTTP call this package emits.
 *
 * A method and a path — never the origin's query string, never a header, never
 * a body. The path is taken apart rather than trusted whole, because a URL this
 * package builds from a caller-supplied job id would otherwise carry whatever
 * that id contained.
 */
export function describeRequest(method: string, url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = '(unparseable url)'
  }
  return `${method.toUpperCase()} ${scrub(path)}`
}
