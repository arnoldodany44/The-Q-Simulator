/**
 * A circuit in a query string — decision D4, work plan M0.9.
 *
 * `JSON → deflate → base64url`, in `?c=`. This is what makes Phase 0
 * shareable with no backend at all: a link is the whole document, so a
 * teacher can paste a circuit into a chat window and a student can open it
 * on a phone that has never seen this app before.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY fflate AND NOT `CompressionStream`.
 *
 * The platform can deflate — `new CompressionStream('deflate-raw')` is in
 * every browser this app targets. It was still the wrong choice here, and
 * availability is not the reason:
 *
 *  1. **It is a stream, so it is async.** `encode`/`decode` would return
 *     promises, and the URL is read once, synchronously, before the editor's
 *     first paint. An async decode means the editor mounts on a blank
 *     document and swaps it a tick later — a visible flash, an extra
 *     simulation, and a `?c=` payload that is briefly contradicted by the
 *     canvas underneath it. It would also make these functions unusable from
 *     a router loader or a test without plumbing promises through both.
 *  2. **Two engines, one string.** Phase 1 mints share links on the server as
 *     well. fflate produces byte-identical output in Node and in a browser;
 *     `CompressionStream` is implemented by the host, and Node's zlib and
 *     Chromium's zlib are not obliged to agree on the same bytes for the same
 *     input. Links that differ by engine are links that fail to compare.
 *  3. **A fallback we would ship anyway.** A browser without
 *     `CompressionStream` — anything older than Safari 16.4, and any embedded
 *     webview built on it — needs a bundled inflater to open a link at all.
 *     Since that bundle has to exist, using it unconditionally means one code
 *     path that is always exercised instead of two, one of which is only ever
 *     exercised by the browsers we test least.
 *
 * So there is no capability check and no degraded mode: an old browser gets
 * exactly the behaviour a new one gets. The cost is fflate's ~8 kB in the
 * bundle, which is less than one of the three font files.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE JSON IS PACKED FIRST, AND THE MEASUREMENT THAT FORCED IT.
 *
 * The work plan's acceptance test is "a Bell pair serialises in under 120
 * characters". Measured, the contract's own shape does not:
 *
 *     contract JSON, minified   172 bytes → deflate 113 → base64url 151
 *     packed JSON, minified      57 bytes → deflate  53 → base64url  71
 *
 * Deflate cannot rescue the first number. At this size its window has nothing
 * to repeat yet, so almost all of the 172 bytes are key names paid in full —
 * `"schemaVersion"`, `"operations"`, `"targets"`, `"column"` — and a URL
 * cannot afford them. `pack()` therefore writes the same document
 * positionally, as nested arrays, and `unpack()` puts the keys back. It is
 * still minified JSON and still deflated, exactly as D4 says; what changed is
 * that the field names are implied by position instead of being transmitted
 * once per operation.
 *
 * The packed form is a *wire* format and never a stored one. It is produced
 * here, consumed here, and the only thing that ever leaves this module is a
 * `Circuit` that `parseCircuit` has judged. `PACKED_CIRCUIT_KEYS` and
 * `PACKED_OPERATION_KEYS` name the fields the packer covers, and
 * `circuit-url.test.ts` compares them against the contract's own schemas — so
 * a field added to `@qsim/schema` fails a test here instead of silently
 * disappearing from every shared link.
 *
 * ────────────────────────────────────────────────────────────────────────
 * A URL IS UNTRUSTED INPUT.
 *
 * Anyone can send anyone a link. `decode` therefore assumes the payload is
 * hostile and answers with a code rather than throwing, at every stage:
 *
 *  - the parameter is length-capped *before* base64 is even attempted, and
 *    checked against the base64url alphabet rather than handed to `atob`,
 *    which is lenient about whitespace and padding;
 *  - the inflater is given a fixed output buffer, so a decompression bomb
 *    cannot allocate: fflate writes into the buffer it was handed and never
 *    grows it, so a payload that would expand past the cap is detected by the
 *    output filling the buffer instead of by watching memory disappear;
 *  - the text is decoded with a *fatal* `TextDecoder`, so invalid UTF-8 is a
 *    refusal rather than a string full of U+FFFD;
 *  - and the last step is always `safeParseCircuit`. Nothing reaches the
 *    engine without the contract's judgement, and the issues it produces come
 *    back with the failure so the caller can log them.
 *
 * Every code in `CIRCUIT_URL_ERRORS` has a sentence in all three catalogs
 * (D2); this module holds no user-facing prose, for the same reason the
 * circuit store does not.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EXACTNESS. `decode(encode(c))` deep-equals `c` for every circuit the
 * contract accepts, with one documented exception: JSON has no negative zero,
 * so a parameter of `-0` comes back as `0`. The two are the same angle and
 * the same rotation, and `===` cannot tell them apart either.
 */

import {
  safeParseCircuit,
  type Circuit,
  type Condition,
  type Control,
  type CustomGate,
  type Operation,
  type ParamValue,
  type Parameter,
  type ValidationIssue,
} from '@qsim/schema'
import { deflateSync, inflateSync } from 'fflate'

/** The query parameter a shared circuit travels in (work plan M0.9). */
export const CIRCUIT_URL_PARAM = 'c'

/**
 * Longest `?c=` payload `decode` will look at, in characters.
 *
 * Eight thousand base64url characters is six kilobytes of deflate, which is
 * far more circuit than anyone puts in a link and still short of the point
 * where browsers, proxies and chat clients start truncating URLs. It is the
 * first line of defence and the cheapest: an oversized payload is refused
 * before a single byte is decoded, so the work a hostile link can ask for is
 * bounded before any of it happens.
 */
export const MAX_PARAM_LENGTH = 8192

/**
 * Ceiling on the *decompressed* payload, in bytes — the decompression-bomb
 * guard.
 *
 * Deflate reaches 1032:1 in the limit, so the 6 kB `MAX_PARAM_LENGTH` allows
 * could name six megabytes of output. 256 kB is roughly three thousand
 * operations of packed JSON, an order of magnitude more than the largest
 * circuit this editor can draw, and it is enforced by construction rather
 * than by checking afterwards: the inflater is handed a buffer of exactly
 * this size plus one and never allocates another, so the extra byte can only
 * be reached by a payload that wanted more than the cap.
 */
export const MAX_DECODED_BYTES = 256 * 1024

/**
 * The work plan's budget: a Bell pair fits in a link of under 120 characters.
 * Exported so the test that pins it names the same number the plan does.
 */
export const BELL_PARAM_BUDGET = 120

/**
 * Every way a payload can be refused. Codes, not sentences: `decode` runs in
 * a module with no i18next instance, and the UI renders these through the
 * `editor` catalog in all three languages (D2).
 */
export const CIRCUIT_URL_ERRORS = [
  /** The parameter is absent or empty. */
  'empty',
  /** Longer than `MAX_PARAM_LENGTH`; refused before decoding. */
  'too-long',
  /** Not base64url: wrong alphabet, or `atob` refused it. */
  'not-base64',
  /** Base64 decoded, but the bytes are not a deflate stream. */
  'not-deflate',
  /** Decompressed past `MAX_DECODED_BYTES`. */
  'too-large',
  /** Not valid UTF-8, or not valid JSON. */
  'not-json',
  /** Valid JSON that the circuit contract refuses. */
  'not-a-circuit',
] as const

export type CircuitUrlError = (typeof CIRCUIT_URL_ERRORS)[number]

export type CircuitUrlResult =
  | { readonly ok: true; readonly circuit: Circuit }
  | {
      readonly ok: false
      readonly code: CircuitUrlError
      /**
       * The contract's own diagnostics when it was the contract that refused.
       * Developer-facing English, for the console — never for a user.
       */
      readonly issues: readonly ValidationIssue[]
    }

/**
 * The circuit fields `pack` covers. Compared against `CircuitSchema.shape` by
 * the test suite, so a field added to the contract cannot silently stop being
 * shared.
 */
export const PACKED_CIRCUIT_KEYS = [
  'schemaVersion',
  'qubits',
  'clbits',
  'operations',
  'qubitLabels',
  'parameters',
  'customGates',
] as const

/** The same, for one operation. Checked against `OperationSchema.shape`. */
export const PACKED_OPERATION_KEYS = [
  'id',
  'gate',
  'targets',
  'column',
  'controls',
  'params',
  'clbitTargets',
  'condition',
] as const

/**
 * How many leading slots of a packed circuit are mandatory: everything up to
 * and including `operations`. The optional tail is trimmed when it is empty,
 * which is what keeps the common circuit — no labels, no parameters, no
 * custom gates — from paying three `null`s per link.
 */
const REQUIRED_CIRCUIT_SLOTS = 4

/** The same for an operation: id, gate, targets and column always travel. */
const REQUIRED_OPERATION_SLOTS = 4

/** The base64url alphabet, whole-string. No padding, no whitespace, no `+/`. */
const BASE64URL = /^[A-Za-z0-9_-]+$/

/* ─────────────────────────────── the API ────────────────────────────── */

/**
 * A circuit as a `?c=` payload: packed, minified, deflated, base64url.
 *
 * Pure and total — every circuit the contract accepts encodes. It does not
 * refuse an oversized result either: whether a link is too long to be worth
 * offering is the caller's judgement (`exceedsUrlBudget`), because a circuit
 * that is too big to *share* is still a circuit worth having on screen.
 */
export function encode(circuit: Circuit): string {
  const json = JSON.stringify(pack(circuit))
  const deflated = deflateSync(new TextEncoder().encode(json), {
    // Level 9 costs microseconds at these sizes and is what makes the
    // difference on a large circuit, where the packed form is highly
    // repetitive; `mem: 12` gives the matcher the largest hash table fflate
    // offers, for the same reason.
    level: 9,
    mem: 12,
  })
  return toBase64Url(deflated)
}

/**
 * A `?c=` payload back into a circuit, or a reason it is not one.
 *
 * Never throws and never returns an unvalidated circuit — see the header.
 */
export function decode(param: string | null | undefined): CircuitUrlResult {
  if (param === null || param === undefined || param === '') {
    return failed('empty')
  }
  if (param.length > MAX_PARAM_LENGTH) return failed('too-long')
  if (!BASE64URL.test(param)) return failed('not-base64')

  let deflated: Uint8Array
  try {
    deflated = fromBase64Url(param)
  } catch {
    return failed('not-base64')
  }

  let inflated: Uint8Array
  try {
    // The bomb guard. fflate writes into the buffer it is handed and never
    // grows it (`resize` is off whenever `out` is supplied), so this call
    // cannot allocate more than the cap however the stream is crafted. The
    // spare byte is the detector: only a payload that wanted more than
    // `MAX_DECODED_BYTES` can fill it.
    inflated = inflateSync(deflated, {
      out: new Uint8Array(MAX_DECODED_BYTES + 1),
    })
  } catch {
    return failed('not-deflate')
  }
  if (inflated.length > MAX_DECODED_BYTES) return failed('too-large')

  let value: unknown
  try {
    // `fatal` on purpose: a lenient decoder turns malformed bytes into
    // U+FFFD and hands JSON.parse a string that may well parse, which would
    // make a corrupted link fail somewhere later and less clearly.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(inflated)
    value = JSON.parse(text)
  } catch {
    return failed('not-json')
  }

  const parsed = safeParseCircuit(unpack(value))
  if (!parsed.ok) return failed('not-a-circuit', parsed.issues)
  return { ok: true, circuit: parsed.circuit }
}

/**
 * Whether a payload is too long to put in a link.
 *
 * The same ceiling `decode` enforces, asked *before* a URL is built: a link
 * this app would refuse to open is a link it must not hand out.
 */
export function exceedsUrlBudget(param: string): boolean {
  return param.length > MAX_PARAM_LENGTH
}

/**
 * The shareable address of a circuit: an existing URL with `?c=` replaced.
 *
 * Everything else in the URL is kept — the path, and any other query the page
 * was opened with — because this is also what the editor writes back into the
 * address bar, and a share that quietly dropped an unrelated parameter would
 * be a share that changed the page.
 */
export function circuitUrl(base: string, param: string | null): string {
  const url = new URL(base)
  if (param === null) url.searchParams.delete(CIRCUIT_URL_PARAM)
  else url.searchParams.set(CIRCUIT_URL_PARAM, param)
  return url.toString()
}

/** The `?c=` payload of a query string, or null when there is none. */
export function readCircuitParam(search: string): string | null {
  return new URLSearchParams(search).get(CIRCUIT_URL_PARAM)
}

/* ────────────────────────── the packed wire form ────────────────────── */

/*
 * A packed circuit is
 *
 *     [ schemaVersion, qubits, clbits, operations,
 *       qubitLabels?, parameters?, customGates? ]
 *
 * and a packed operation is
 *
 *     [ id, gate, targets, column, controls?, params?, clbitTargets?, condition? ]
 *
 * with the optional tail trimmed when every remaining slot is empty. A
 * negative control travels as `[qubit, state]` and a positive one as a bare
 * number, which is the same distinction the contract itself makes; a
 * condition travels as `[clbit, equals]`; a parameter as `[name, value]`; a
 * custom gate as `[qubits, operations, symbol?]` under its own name.
 *
 * Nothing here judges the values it copies. `unpack` is deliberately total
 * and deliberately credulous: it rebuilds whatever shape it was given and
 * hands it to `safeParseCircuit`, which is the only judge in the system (the
 * same rule the circuit store states in its header). A packed payload full of
 * nonsense therefore produces a `not-a-circuit` refusal listing exactly what
 * is wrong with it, rather than a bespoke second validator here that would
 * eventually disagree with the first.
 */

function pack(circuit: Circuit): unknown[] {
  const slots: unknown[] = [
    circuit.schemaVersion,
    circuit.qubits,
    circuit.clbits,
    circuit.operations.map(packOperation),
    circuit.qubitLabels ?? null,
    circuit.parameters?.map(packParameter) ?? null,
    circuit.customGates === undefined
      ? null
      : mapValues(circuit.customGates, packCustomGate),
  ]
  return trimTail(slots, REQUIRED_CIRCUIT_SLOTS)
}

function packOperation(operation: Operation): unknown[] {
  const slots: unknown[] = [
    operation.id,
    operation.gate,
    operation.targets,
    operation.column,
    operation.controls?.map(packControl) ?? null,
    operation.params ?? null,
    operation.clbitTargets ?? null,
    operation.condition === undefined
      ? null
      : packCondition(operation.condition),
  ]
  return trimTail(slots, REQUIRED_OPERATION_SLOTS)
}

function packControl(control: Control): unknown {
  return typeof control === 'number' ? control : [control.qubit, control.state]
}

function packCondition(condition: Condition): unknown {
  return [condition.clbit, condition.equals]
}

function packParameter(parameter: Parameter): unknown {
  return [parameter.name, parameter.value]
}

function packCustomGate(gate: CustomGate): unknown[] {
  const slots: unknown[] = [
    gate.qubits,
    gate.operations.map(packOperation),
    gate.symbol ?? null,
  ]
  return trimTail(slots, 2)
}

function unpack(packed: unknown): unknown {
  // Not an array at all: hand it on unchanged so the contract is the thing
  // that says what is wrong with it, in its own words.
  if (!Array.isArray(packed)) return packed
  const [version, qubits, clbits, operations, labels, parameters, customGates] =
    packed as unknown[]

  return {
    schemaVersion: version,
    qubits,
    ...present('clbits', clbits),
    operations: mapMaybe(operations, unpackOperation),
    ...present('qubitLabels', labels),
    ...present('parameters', mapMaybe(parameters, unpackParameter)),
    ...present(
      'customGates',
      isRecord(customGates)
        ? mapValues(customGates, unpackCustomGate)
        : undefined
    ),
  }
}

function unpackOperation(packed: unknown): unknown {
  if (!Array.isArray(packed)) return packed
  const [id, gate, targets, column, controls, params, clbitTargets, condition] =
    packed as unknown[]

  return {
    id,
    gate,
    targets,
    column,
    ...present('controls', mapMaybe(controls, unpackControl)),
    ...present('params', params as ParamValue[] | undefined),
    ...present('clbitTargets', clbitTargets),
    ...present('condition', unpackCondition(condition)),
  }
}

function unpackControl(packed: unknown): unknown {
  if (!Array.isArray(packed)) return packed
  const [qubit, state] = packed as unknown[]
  return { qubit, state }
}

function unpackCondition(packed: unknown): unknown {
  if (packed === null || packed === undefined) return undefined
  if (!Array.isArray(packed)) return packed
  const [clbit, equals] = packed as unknown[]
  return { clbit, equals }
}

function unpackParameter(packed: unknown): unknown {
  if (!Array.isArray(packed)) return packed
  const [name, value] = packed as unknown[]
  return { name, value }
}

function unpackCustomGate(packed: unknown): unknown {
  if (!Array.isArray(packed)) return packed
  const [qubits, operations, symbol] = packed as unknown[]
  return {
    qubits,
    operations: mapMaybe(operations, unpackOperation),
    ...present('symbol', symbol),
  }
}

/* ───────────────────────────── small helpers ────────────────────────── */

/**
 * Drops trailing empty slots, never going below `keep`.
 *
 * `null` and `undefined` are the only things treated as empty. An empty
 * *array* is kept: `controls: []` is a legal document that means something
 * different from `controls` being absent, and a round trip that erased the
 * difference would be a round trip that edited the circuit.
 */
function trimTail(slots: unknown[], keep: number): unknown[] {
  let end = slots.length
  while (end > keep && slots[end - 1] == null) end -= 1
  return slots.slice(0, end)
}

/**
 * `{ key: value }` when the value is really there, `{}` otherwise — so an
 * optional field is absent rather than present and `undefined`. The contract
 * is strict about unknown keys and exact about which are optional, and a
 * round trip that added `qubitLabels: undefined` would no longer deep-equal
 * the circuit it started from.
 */
function present<K extends string, V>(
  key: K,
  value: V | null | undefined
): Partial<Record<K, V>> {
  return value == null ? {} : ({ [key]: value } as Record<K, V>)
}

/**
 * Maps an array, passing anything that is not one straight through so the
 * contract is what faults it. `undefined` for an absent slot, which
 * `present()` then drops.
 */
function mapMaybe(value: unknown, map: (entry: unknown) => unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (!Array.isArray(value)) return value
  return (value as unknown[]).map(map)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rebuilds a record with every value mapped, onto a **null prototype**.
 *
 * The null prototype is the whole point, not tidiness. `customGates` is keyed
 * by an identifier the payload chooses, and `__proto__` matches the
 * contract's identifier pattern — so on an ordinary object literal,
 * `out[key] = value` for that one key would reach the prototype setter
 * instead of creating a property, and a hostile link would be assigning
 * `Object.prototype`. With no prototype there is no setter, and the key
 * becomes the ordinary own property the contract will then judge.
 */
function mapValues<T, R>(
  record: Readonly<Record<string, T>>,
  map: (value: T) => R
): Record<string, R> {
  const out = Object.create(null) as Record<string, R>
  for (const [key, value] of Object.entries(record)) out[key] = map(value)
  return out
}

function failed(
  code: CircuitUrlError,
  issues: readonly ValidationIssue[] = []
): CircuitUrlResult {
  return { ok: false, code, issues }
}

/* ──────────────────────────────── base64url ─────────────────────────── */

/**
 * Bytes to base64url, unpadded.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a 256 kB array is a
 * quarter of a million arguments and a stack overflow. 0x8000 is the usual
 * safe window and costs one concatenation per 32 kB.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

/**
 * base64url back to bytes. The alphabet has already been checked by the
 * caller, so the only thing left that can fail here is a length that is not a
 * valid base64 block, which `atob` reports by throwing.
 */
function fromBase64Url(param: string): Uint8Array {
  const base64 = param.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
