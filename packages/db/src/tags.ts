import type { Prisma } from './generated/prisma/client.js'

/**
 * Tag names, and the one place their spelling is decided — §3.4, M1.5.
 *
 * ── Why normalisation is a storage concern and not a UI one ───────────────
 *
 * `Tag.name` is `@unique`. That single constraint is what makes a tag a
 * *facet* — one row per concept, so `?tag=grover` finds every circuit anybody
 * filed under Grover. Without a canonical spelling the constraint protects
 * nothing useful: `Grover`, `grover`, ` grover ` and `Grover.` are four rows,
 * four facets, and four partial answers to the same question. Worse, the
 * damage is permanent — rows written under the wrong spelling stay wrong, and
 * merging them later is a data migration over other people's circuits.
 *
 * So the rule lives here, beside the code that writes the row, for the same
 * reason `generateCircuitSlug` does (there is even a boundary rule about it):
 * a value that identifies a row must be minted where rows are written, once,
 * rather than agreed upon by however many callers happen to exist. The read
 * path uses the very same function — `?tag=Grover` is normalised before it
 * becomes a `where` — so a facet cannot be written under one spelling and
 * looked up under another.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * A tag is Unicode-normalised (NFKC), lowercased, re-normalised, and every run
 * of characters that is neither a letter, a number nor a combining mark is
 * folded to a single hyphen, with leading and trailing hyphens removed. What
 * survives must contain at least one letter or digit and be 1 to 32 characters.
 * Anything else is `null` — a refusal, never a silent rewrite.
 *
 *   `  Deutsch–Jozsa  ` → `deutsch-jozsa`
 *   `Téléportation`     → `téléportation`
 *   `İSTANBUL`          → `istanbul`
 *   `#QFT!!`            → `qft`
 *   `---`               → null
 *
 * Accented letters are kept, and that is deliberate rather than lazy. This
 * product is trilingual by decision (D2) and stripping diacritics would spell
 * two of its three languages wrong — `intrication` is not `intrincación`, and
 * a French user's tag is not a mangled English one. `\p{L}` covers every
 * alphabet, so a tag in Greek or Japanese works exactly as well, and `\p{M}`
 * is what makes that true of the alphabets that write their vowels as marks
 * rather than as letters.
 *
 * The folding also happens to make every tag *storable*: control characters
 * and lone surrogates are neither letters nor numbers, so they cannot survive
 * it. That is a consequence and not the mechanism — free-text fields still go
 * through `storableText` in @qsim/schema.
 */

/** Shortest a tag may be once normalised. */
export const MIN_TAG_LENGTH = 1

/**
 * Longest a tag may be once normalised. A tag is a facet in a URL and on a
 * card, not a sentence; anything longer belongs in the description.
 */
export const MAX_TAG_LENGTH = 32

/**
 * Most tags one circuit may carry.
 *
 * A cap is needed because tags are the one part of a circuit whose cost is
 * paid by *other people's* queries: each one is a row in the join table that
 * every `?tag=` scan walks past. Eight is more than any circuit in the
 * specification's examples needs and small enough that a script cannot use
 * the tag table as free storage.
 */
export const MAX_TAGS_PER_CIRCUIT = 8

/**
 * Every run of "not a letter, not a number and not a combining mark" becomes
 * one hyphen.
 *
 * `\p{M}` is in the keep set because a combining mark is *part of a word*, not
 * a separator between two. Without it every script that writes its vowels as
 * marks was cut into pieces: `हिंदी` became `ह-द`, and the rule this module
 * states ("one row per concept") was true only for the alphabets that
 * precompose.
 */
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu

/** Whether anything in here is a letter or a digit rather than punctuation. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/**
 * Case mappings that would otherwise split one word into two facets.
 *
 * `String.prototype.toLowerCase` maps U+0130 (LATIN CAPITAL LETTER I WITH DOT
 * ABOVE) to `i` followed by U+0307 COMBINING DOT ABOVE, because that is what
 * Unicode's default — locale-independent — case mapping says. Nothing then
 * recomposes it: `i` + U+0307 has no precomposed form, so NFC leaves it alone
 * and `İstanbul` and `Istanbul` normalise to two different strings, two rows,
 * two facets, and neither `?tag=` finds the other's circuits.
 *
 * The Turkic tailoring in Unicode's own CaseFolding.txt folds U+0130 to a bare
 * `i`, and that is what is applied here — before lowercasing, so the mark is
 * never produced in the first place rather than stripped afterwards. Stripping
 * marks generally would be the wrong fix: it is exactly what would mangle the
 * scripts `SEPARATORS` above was widened to protect.
 */
const CASE_TAILORINGS = /\u0130/gu

/**
 * The canonical spelling of a tag, or `null` when nothing usable survives.
 *
 * `null` is a real answer and callers must handle it: the API turns it into a
 * 400 naming the offending element, because a tag that silently disappears —
 * or silently becomes something else — is worse than a rejected request.
 */
export function normalizeTagName(raw: string): string | null {
  const folded = raw
    .normalize('NFKC')
    .replace(CASE_TAILORINGS, 'i')
    .toLowerCase()
    // Case mapping does not preserve normalisation — `İ` is not the only
    // character whose lowercase form recomposes differently — so the form is
    // re-established after it rather than assumed to have survived.
    .normalize('NFKC')
    .replace(SEPARATORS, '-')
    .replace(/^-+|-+$/g, '')

  if (folded.length < MIN_TAG_LENGTH) return null
  // A run of nothing but combining marks now survives the fold above, and a
  // facet with no letter and no digit in it is the same "nothing usable" the
  // empty case is. Refused, not repaired.
  if (!HAS_LETTER_OR_DIGIT.test(folded)) return null
  // Length is counted in code points, not UTF-16 units, so an emoji-adjacent
  // alphabet does not get half the budget. (Nothing outside L and N survives
  // the fold, but astral letters — Deseret, Gothic — do.)
  if ([...folded].length > MAX_TAG_LENGTH) return null
  return folded
}

/** Whether a name is already in canonical form. */
export function isNormalizedTagName(value: string): boolean {
  return normalizeTagName(value) === value
}

/**
 * Normalises a list, dropping duplicates and keeping the caller's order.
 *
 * Returns the offending positions rather than throwing, so the API can name
 * `body.tags.2` in the 400 instead of saying "one of your tags is wrong".
 */
export function normalizeTagNames(raw: readonly string[]): {
  readonly names: string[]
  readonly invalid: number[]
} {
  const names: string[] = []
  const invalid: number[] = []
  const seen = new Set<string>()

  raw.forEach((value, index) => {
    const name = normalizeTagName(value)
    if (name === null) {
      invalid.push(index)
      return
    }
    // `Grover` and `grover` in one request are one tag, not a duplicate-key
    // error. Deduplicating here also keeps `MAX_TAGS_PER_CIRCUIT` honest.
    if (seen.has(name)) return
    seen.add(name)
    names.push(name)
  })

  return { names, invalid }
}

/**
 * The slice of a transaction these helpers touch. Narrow on purpose: it says
 * in the type that tagging reads and writes two tables — plus the one raw
 * statement `setCircuitTags` needs to lock the circuit it is replacing the
 * tags of, which Prisma's query API has no spelling for.
 */
export type TagWriter = Pick<
  Prisma.TransactionClient,
  'tag' | 'circuitTag' | '$queryRaw'
>

/**
 * More tags than one circuit may carry.
 *
 * Thrown rather than truncated, because truncation would decide *which* of
 * somebody's tags to throw away and then answer 200 as though it had not. The
 * API's own schema bounds a request at `MAX_TAGS` before this can be reached,
 * so a caller who sees this has bypassed it — which is precisely when a loud
 * failure is worth more than a tidy one.
 */
export class TagLimitError extends Error {
  readonly count: number

  constructor(count: number) {
    super(
      `A circuit may carry at most ${String(MAX_TAGS_PER_CIRCUIT)} tags, ` +
        `got ${String(count)}.`
    )
    this.name = 'TagLimitError'
    this.count = count
  }
}

/**
 * Attaches tags to a circuit, creating the `Tag` rows that do not exist yet.
 *
 * ── Why this cannot race ──────────────────────────────────────────────────
 *
 * The obvious implementation — look up each name, insert the missing ones —
 * loses to any concurrent save that mentions the same tag: both transactions
 * see `grover` missing, both insert, and one gets P2002 on `Tag.name`. That
 * is not a rare case, because a popular tag is by definition one many people
 * are writing at the same time, and the failure lands on an unrelated save of
 * an unrelated circuit.
 *
 * `createMany({ skipDuplicates: true })` compiles to `INSERT … ON CONFLICT DO
 * NOTHING`, which is decided by Postgres inside one statement: the loser of
 * the race is told "0 rows" rather than raising, and the following read finds
 * the winner's row. Both inserts here are that shape, so neither the tag nor
 * the join row can produce a conflict this code has to interpret.
 *
 * `names` must already be normalised — `normalizeTagNames` is how — because
 * this is the write that makes a spelling permanent.
 */
export async function attachCircuitTags(
  tx: TagWriter,
  circuitId: string,
  names: readonly string[]
): Promise<void> {
  /*
   * The cap, enforced where the rows are written rather than only where a
   * request is parsed. `MAX_TAGS_PER_CIRCUIT` used to be a number this module
   * exported and nothing consulted: the only bound was Zod's `.max()` on one
   * request body, which bounds a request and not a row — and `forkCircuit`
   * copies a source circuit's tags straight into a `create`, so an over-tagged
   * row could reproduce itself through a path no request body passes through.
   */
  if (names.length > MAX_TAGS_PER_CIRCUIT) {
    throw new TagLimitError(names.length)
  }
  if (names.length === 0) return

  await tx.tag.createMany({
    data: names.map((name) => ({ name })),
    skipDuplicates: true,
  })
  const tags = await tx.tag.findMany({
    where: { name: { in: [...names] } },
    select: { id: true },
  })
  await tx.circuitTag.createMany({
    data: tags.map((tag) => ({ circuitId, tagId: tag.id })),
    skipDuplicates: true,
  })
}

/**
 * The tag names a circuit carries, read back from the join table.
 *
 * Called after a write instead of echoing the names that were passed in.
 * Echoing would be right today and would stop being right the moment
 * anything else can attach a tag — and "the response said so" is a poor way
 * to find out that it does not match the row.
 */
export async function readCircuitTagNames(
  tx: TagWriter,
  circuitId: string
): Promise<string[]> {
  const rows = await tx.circuitTag.findMany({
    where: { circuitId },
    select: { tag: { select: { name: true } } },
  })
  return rows.map((row) => row.tag.name).sort()
}

/**
 * Replaces a circuit's tags with exactly this set.
 *
 * The removal is scoped by tag id rather than expressed as a relation filter
 * on the name, so it is one indexed delete rather than a subquery — and an
 * empty set is spelled as its own statement rather than trusting how an empty
 * `notIn` is compiled.
 *
 * `Tag` rows left with no circuits are not collected. That is deliberate: a
 * tag nobody uses costs one narrow row, and a sweep that deletes tags would
 * have to race every save that is about to reference one.
 *
 * ── WHY THIS TAKES A LOCK, WHEN `attachCircuitTags` DELIBERATELY DOES NOT ──
 *
 * "Replace" is a read-then-write over a *set*, and Postgres has no constraint
 * that can decide one. `attachCircuitTags` gets away without a lock because
 * every statement in it is `INSERT … ON CONFLICT DO NOTHING`, which Postgres
 * arbitrates inside one statement; there is no `ON CONFLICT` for "and nothing
 * else may be here".
 *
 * Without the lock, under READ COMMITTED, the delete below removes only the
 * join rows visible in this transaction's own snapshot. Two concurrent PATCHes
 * therefore each delete the *pre-existing* set, each insert their own eight,
 * and neither insert conflicts with the other: both answer 200 and the circuit
 * ends up carrying sixteen tags — sixteen gallery facets, on a card whose
 * shape promises at most eight, and a fork then copies all sixteen onto a new
 * circuit with no concurrency involved at all. Measured: four concurrent
 * PATCHes of eight disjoint names each left 32 rows.
 *
 * `SELECT … FOR UPDATE` on the parent `Circuit` row serialises them. The
 * second transaction blocks until the first commits and then — READ COMMITTED
 * takes a fresh snapshot per statement — sees the first writer's rows and
 * replaces them, which is what "replace" was supposed to mean. The lock is
 * held for two small statements on one circuit, and every caller reaches it
 * through the same path, so there is no second lock order to deadlock against.
 *
 * `circuits.ts` argues *against* `FOR UPDATE` for version numbering, and both
 * arguments are the same one: use the constraint when there is a constraint,
 * and a lock only when there is not.
 */
export async function setCircuitTags(
  tx: TagWriter,
  circuitId: string,
  names: readonly string[]
): Promise<void> {
  if (names.length > MAX_TAGS_PER_CIRCUIT) {
    throw new TagLimitError(names.length)
  }

  /*
   * Before either statement, and before the read that decides what to keep.
   * `$queryRaw` interpolates the id as a bound parameter, not as text.
   */
  await tx.$queryRaw`SELECT 1 FROM "Circuit" WHERE "id" = ${circuitId} FOR UPDATE`

  if (names.length === 0) {
    await tx.circuitTag.deleteMany({ where: { circuitId } })
    return
  }

  const keep = await tx.tag.findMany({
    where: { name: { in: [...names] } },
    select: { id: true },
  })
  await tx.circuitTag.deleteMany({
    where: { circuitId, tagId: { notIn: keep.map((tag) => tag.id) } },
  })
  await attachCircuitTags(tx, circuitId, names)
}
