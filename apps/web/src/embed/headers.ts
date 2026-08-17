/**
 * The two header sets, and why they are opposites — §11.
 *
 * This module is the single authority for what `apps/web` sends on which
 * path. It is imported by `vite.config.ts`, so the dev server and `vite
 * preview` send exactly these; and `verification/embed-isolation/
 * vercel-matches-the-module.test.ts` reads `vercel.json` and asserts the
 * deployment sends them too. A header set that only holds in development is a
 * header set that holds nowhere, and the drift is invisible until somebody
 * frames the production site.
 *
 * Nothing here imports anything. It runs inside Vite's Node process and
 * inside jsdom, and it has to keep doing both.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * FRAMING: TWO ANSWERS, AND THEY MUST BE OPPOSITE
 * ═════════════════════════════════════════════════════════════════════════
 *
 * THE ORDINARY APP MUST NOT BE FRAMED. It holds a session: the editor saves,
 * the settings screen deletes an account, the star and fork controls act on
 * one press. That is the exact profile clickjacking exists for — a hostile
 * page frames `/settings`, makes the frame transparent, and lines its own
 * "play" button up over "delete my account". `X-Frame-Options: DENY` plus
 * `frame-ancestors 'none'` says no, and the app loses nothing by it, because
 * nothing in the product ever wanted to frame the app.
 *
 * THE EMBED MUST BE FRAMED BY ANYONE. It is for a teacher's blog and a
 * lecture slide — origins this project cannot enumerate and has no business
 * approving one at a time. `frame-ancestors *` and, crucially, NO
 * `X-Frame-Options` at all: that header has no "any origin" value, its
 * `ALLOW-FROM` variant is dead in every current browser, and a `SAMEORIGIN`
 * left on this path by an over-broad rule would break every embed in the
 * world while looking like a tightening.
 *
 * Both headers are sent on the app rather than only the modern one: browsers
 * that honour `frame-ancestors` ignore `X-Frame-Options` when both are
 * present, so the legacy header costs nothing and covers what is left.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * CROSS-ORIGIN ISOLATION: THE EMBED GIVES UP SharedArrayBuffer, ON PURPOSE
 * ═════════════════════════════════════════════════════════════════════════
 *
 * The app sends `COOP: same-origin` and `COEP: require-corp` so the tab is
 * cross-origin isolated and the simulation worker can hand a 16 MB statevector
 * across the thread boundary without copying it (`features/simulation/
 * protocol.ts`).
 *
 * Neither header can do that job inside somebody else's page, and the reason
 * is structural rather than a matter of configuration:
 *
 *   - `crossOriginIsolated` is a property of the whole frame tree. A framed
 *     document is only isolated if the TOP-LEVEL document is, and the
 *     top-level document belongs to the teacher's site. So an embed is never
 *     cross-origin isolated, whatever it sends, and `SharedArrayBuffer` is
 *     therefore unavailable to it — not degraded, absent.
 *   - `COOP` is defined for top-level browsing contexts and is ignored in an
 *     iframe outright.
 *
 * So the embed sends neither, and that is a decision rather than an omission:
 *
 *   1. `COEP: require-corp` would buy nothing (see above) and cost something:
 *      it makes every subresource fail unless it carries CORP, so one future
 *      asset served without the header would take the embed down for a
 *      benefit that could never have been collected.
 *   2. Keeping COOP/COEP would make the embed behave DIFFERENTLY when opened
 *      directly (top-level, isolated, shared memory) from when framed (not
 *      isolated, transfer path). Two paths, one of which only the author ever
 *      exercises. Sending neither means the embed runs the transfer path
 *      always, framed or not, so what is tested is what ships.
 *
 * The fallback that then runs is the documented one and not a new one:
 * `sharedMemoryAvailable()` reads `crossOriginIsolated`, returns false, the
 * request carries `sharedMemory: false`, and `encodeState` transfers the
 * engine's buffers instead of sharing them — the path `protocol.test.ts`
 * already covers. `useEmbedSimulation.ts` asks for the capability rather than
 * assuming it, exactly as `useSimulation` does.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BEING FRAMED BY A COEP PAGE NEEDS BOTH CORP *AND* COEP, AND CORP ALONE
 * WAS NOT ENOUGH.
 *
 * A parent page that has itself opted into `COEP: require-corp` — a site using
 * SharedArrayBuffer for its own reasons, which is exactly the technical
 * audience §2 names — may only frame a document that says it is willing. This
 * module used to say `Cross-Origin-Resource-Policy: cross-origin` was that
 * permission. It is not: CORP governs SUBRESOURCES. A nested *document* loaded
 * into a `require-corp` parent must additionally carry a
 * `Cross-Origin-Embedder-Policy` of its own, or the load is refused outright
 * with `net::ERR_BLOCKED_BY_RESPONSE` — before any script runs, so none of the
 * "never show a blank frame" machinery below can even report it. Measured
 * against `vite preview` and against the `vercel.json` rules: with CORP alone
 * the frame is an empty error page; with `COEP: require-corp` added to the
 * embed document it loads, renders and simulates.
 *
 * So the embed sends COEP after all, and the reasoning above survives intact
 * because COEP is not what isolates a page — COOP *and* COEP together are, and
 * only for a top-level document:
 *
 *   - Framed, `crossOriginIsolated` stays false, because it is a property of
 *     the whole frame tree and the top is somebody else's. Confirmed inside
 *     the working frame.
 *   - Opened directly, `crossOriginIsolated` is still false, because there is
 *     no COOP. So the two paths remain one path, which is the property
 *     decision 2 above is actually about, and the transfer path in
 *     `protocol.ts` is still what runs everywhere.
 *
 * The cost point 1 above raised is real and is bounded here rather than
 * theoretical: under `require-corp` every no-cors subresource needs CORP.
 * Every subresource this document loads is same-origin — its own chunks, its
 * own woff2, its own worker — which satisfies the check by definition; the one
 * cross-origin request it makes is `fetchEmbed`, in CORS mode, which COEP
 * allows. `img-src 'none'` in the policy below is what keeps that inventory
 * closed.
 *
 * `Cross-Origin-Resource-Policy: cross-origin` stays, because it is the half
 * of the permission that covers the embed being loaded AS a subresource.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE CONTENT-SECURITY-POLICY
 * ═════════════════════════════════════════════════════════════════════════
 *
 * The app gets one directive, `frame-ancestors 'none'`, and the embed gets a
 * whole policy. That asymmetry is deliberate: a complete policy for the app
 * has to cover React's inline style attributes, Vite's dev preamble, the
 * Supabase client, three-dimensional canvases and a WebSocket — a piece of
 * work with its own failure modes, and one that would make this file the
 * place where an unrelated screen breaks. The embed is a small, closed
 * surface written in one directory, so a policy over it can be written
 * completely and kept true.
 *
 * `connect-src` is the one directive that names a scheme rather than a host,
 * and the reason is worth stating plainly rather than hiding: the API's origin
 * is `VITE_API_URL`, a build-time variable, and a static header file cannot
 * name a value it does not know. The choice was between a directive that is
 * wrong on some deployments and one that is broader than it would like to be.
 * Broader wins, because the narrow version fails closed on the deployments it
 * is wrong about — an embed that cannot reach its own API renders nothing —
 * while the broad version still forbids `http:`, still forbids every other
 * kind of subresource outright through `default-src 'none'`, and is enforced
 * over one script this project wrote: `fetchEmbed.ts` makes exactly one
 * request, to one URL, with `credentials: 'omit'`.
 *
 * `style-src` carries `'unsafe-inline'` and cannot avoid it. The histogram
 * renders a bar's length and a phasor's angle as inline `style` attributes,
 * which is the right way to express a value that changes per element — and a
 * nonce cannot cover a style attribute, only a `<style>` element. Inline
 * styles are also not the risk class inline *scripts* are: the thing
 * `'unsafe-inline'` buys an attacker here is CSS, and `script-src` stays
 * `'self'` with no escape hatch.
 */

/** One HTTP header, in the shape both `vercel.json` and Connect want. */
export interface HttpHeader {
  readonly key: string
  readonly value: string
}

/**
 * What a development machine talks to, and only a development machine.
 *
 * Two things live on localhost during `pnpm dev` and neither is on the same
 * port: Vite's HMR socket (5173, pinned by `--strictPort`) and `apps/api`
 * (8080 by default, and configurable). The port wildcard is deliberate rather
 * than lazy — enumerating them would be a list that goes stale the first time
 * somebody changes `PORT`, and the symptom would be an embed that renders
 * "the circuit could not be loaded" against a healthy local API.
 *
 * It is absent from the deployed policy, where `'self' https:` covers the API
 * and nothing reaches a loopback address.
 */
const DEV_ORIGINS = 'ws://localhost:* http://localhost:*'

/**
 * The embed document's policy.
 *
 * `dev` adds exactly two relaxations and nothing else, so that what the e2e
 * suite loads is as close to the deployed policy as a dev server can be:
 *
 *   1. `'unsafe-inline'` in `script-src`, because `@vitejs/plugin-react`
 *      injects an inline module preamble into every HTML file it serves. It
 *      is not in the built output.
 *   2. The loopback origins a development machine talks to, in `connect-src`
 *      — Vite's HMR socket and the local `apps/api`. Neither a `ws:` scheme
 *      nor a loopback `http:` is covered by `https:`, and the deployed
 *      directive must not be widened until it is.
 *
 * Both are absent from what `vercel.json` carries, and the verification test
 * asserts that by comparing against `embedContentSecurityPolicy(false)`.
 */
export function embedContentSecurityPolicy(dev = false): string {
  const scriptSrc = dev ? "'self' 'unsafe-inline'" : "'self'"
  const connectSrc = dev ? `'self' ${DEV_ORIGINS}` : "'self' https:"

  return [
    // Everything not named below is refused. Every directive after this one
    // is therefore an explicit grant rather than a restriction.
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    // See the header: the histogram's geometry is inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    // The three self-hosted woff2 of §10. No third-party font request is made
    // from inside somebody else's page, which is why they are self-hosted.
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    /*
     * The simulation worker. `blob:` is here because a bundler may emit a
     * worker as an object URL — Vite does in some configurations — and a
     * policy that forbade it would fail at the one moment the build changed
     * strategy, in production, with the diagram rendered and the analysis
     * blank.
     */
    "worker-src 'self' blob:",
    // The embed draws SVG inline and loads no images at all. Named rather
    // than left to `default-src` so the intent is legible.
    "img-src 'none'",
    // Nothing here submits, and nothing here rewrites the base URL. Both are
    // the classic levers for turning an injected fragment into a request.
    "form-action 'none'",
    "base-uri 'none'",
    // The embed frames nothing, which also means it cannot be made the middle
    // of somebody's frame chain.
    "frame-src 'none'",
    /*
     * ANY origin. This is the whole point of the route, and it is exactly
     * inverted from the app's `'none'` below. See the header.
     */
    'frame-ancestors *',
  ].join('; ')
}

/**
 * Everything the app sends, on every path that is not the embed.
 *
 * The four that were here before this milestone are unchanged; the two that
 * are new are the framing refusal.
 */
export const APP_HEADERS: readonly HttpHeader[] = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
]

/**
 * Everything the embed sends.
 *
 * Read this list for what is ABSENT as much as for what is present: no
 * `X-Frame-Options` and no `Cross-Origin-Opener-Policy`. Each absence is
 * argued in the header, and each would break or hollow out the route if it
 * were added by an over-broad rule elsewhere — which is why the deployment's
 * app rule is written as a negative lookahead rather than as a catch-all these
 * values then override.
 *
 * `Cross-Origin-Embedder-Policy` IS present, and the header explains at length
 * why it has to be: without it a `require-corp` parent cannot frame this at
 * all. It does not isolate the document, because COOP is absent and isolation
 * needs both.
 *
 * `Referrer-Policy` is stricter here than on the app. The app sends
 * `strict-origin-when-cross-origin`, which leaks the full path to same-origin
 * navigations; an embed's referrer travels to whatever the embedded page asks
 * for, and the path of an embed is the slug of an UNLISTED circuit — the
 * credential §11 sized at 126 bits. `no-referrer` is the only value that
 * cannot spend it.
 */
export const EMBED_HEADERS: readonly HttpHeader[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  /*
   * The two halves of "a COEP page may frame this". CORP answers for the embed
   * loaded as a subresource; COEP answers for it loaded as a nested document,
   * which is the case an `<iframe>` actually is. Sending only the first — as
   * this list did — meant the header was declared for a property it never
   * bought, and the embed was blocked by exactly the sites it names.
   */
  { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  /*
   * A document served into a stranger's page has no business asking for
   * hardware. None of these is used, so denying them costs nothing and stops
   * a future dependency from acquiring one quietly.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Content-Security-Policy', value: embedContentSecurityPolicy(false) },
]

/**
 * Whether a request path belongs to the embed.
 *
 * `/embed.html` is the built entry itself, which a browser requests directly
 * only in development; `/embed` and `/embed/…` are the addresses a teacher
 * pastes. All three take the embed's headers, because all three deliver the
 * same document.
 *
 * Takes a PATHNAME, never a full URL with its query: `/embed?c=…` is an embed
 * and `/embedding-guide` — a route nobody has written and nobody may — is
 * not, and a prefix test against `'/embed'` alone would confuse them.
 */
export function isEmbedPath(pathname: string): boolean {
  return (
    pathname === '/embed' ||
    pathname === '/embed.html' ||
    pathname.startsWith('/embed/')
  )
}

/**
 * The `source` pattern `vercel.json` has to carry for the app's header rule,
 * derived from `isEmbedPath` rather than written twice.
 *
 * The deployment used `/((?!embed).*)`, which excludes every path that merely
 * *begins* with "embed" — `/embedded`, `/embeds`, `/embed-guide`. No embed
 * rule matched those either, so Vercel sent ZERO headers for them while the
 * rewrite catch-all still served the whole application: no `X-Frame-Options`,
 * no `frame-ancestors`, no COOP, no COEP, no `nosniff`. The dev server, driven
 * by `headersFor` above, refuses those addresses correctly; only the
 * deployment disagreed, and only for paths nobody thought to probe.
 *
 * The lookahead therefore has to name the three spellings `isEmbedPath`
 * accepts and nothing wider. `verification/embed-isolation/` asserts this
 * string appears in `vercel.json` and that the regex agrees with
 * `isEmbedPath`, path by path.
 */
export const APP_HEADER_SOURCE = '/((?!embed$|embed\\.html$|embed/).*)'

/** The headers a given path gets. One function, so nothing can disagree. */
export function headersFor(
  pathname: string,
  dev = false
): readonly HttpHeader[] {
  if (!isEmbedPath(pathname)) return APP_HEADERS
  if (!dev) return EMBED_HEADERS
  return EMBED_HEADERS.map((header) =>
    header.key === 'Content-Security-Policy'
      ? { key: header.key, value: embedContentSecurityPolicy(true) }
      : header
  )
}
