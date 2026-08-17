/**
 * Where the reader stopped — the model, and the browser half of the store.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TWO STORES, AND THE LOCAL ONE IS NOT A CACHE OF THE REMOTE ONE.
 *
 * An anonymous reader's bookmark lives in `localStorage`. That is not a
 * degraded version of an account: it is the right store for the fact. Nobody
 * else can read it, it costs no round trip, it survives a reload, and it is
 * exactly as durable as the reader's expectation ("this browser remembers
 * where I was"). A signed-in reader gets the account as well, because their
 * expectation is different — "my account remembers", on any device.
 *
 * So the local store is always written, for everybody. The signed-in reader
 * has both, and `mergeProgress` decides what the pair means.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE MERGE RULE, AND WHY IT IS NOT "THE SERVER WINS".
 *
 * The interesting moment is signing in on a browser that has been reading
 * anonymously: three steps into a lesson here, five steps into it on the
 * account. "The server wins" throws away the work of the session the reader is
 * *in*, which is the one they can see. "The client wins" throws away the other
 * device's, silently.
 *
 * The rule is: **the more recent write wins, and a lesson that has ever been
 * finished stays finished.** The timestamp is what both sides already have,
 * `completed` is monotone by construction (the API ORs it too, see
 * `@qsim/db`'s `lessons.ts`), and the two together mean neither device can
 * un-finish or rewind the other by merely opening the page.
 *
 * Clocks disagree between a browser and a server, which is a real weakness of
 * a timestamp rule and a tolerable one here: the units are lessons and steps,
 * the cost of losing is re-reading one page, and the alternative — a version
 * counter per lesson per device — is a synchronisation protocol for a bookmark.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT STORED.
 *
 * The reader's circuit. Resuming mid-build sounds better than it is: it means
 * a second unversioned document store keyed by nothing, and it means the
 * lesson's own step no longer determines what is on the canvas — so "go back
 * one step" would stop having an answer. Somebody who wants to keep a circuit
 * has the editor and `POST /circuits`.
 */

export interface LessonProgressEntry {
  readonly slug: string
  /** The step the reader is standing on, zero-based. */
  readonly stepIndex: number
  /** Whether they have reached the end at least once. Never goes back. */
  readonly completed: boolean
  /** When this was written. ISO-8601, in whichever clock wrote it. */
  readonly updatedAt: string
}

export type LessonProgressMap = Readonly<Record<string, LessonProgressEntry>>

export const EMPTY_PROGRESS: LessonProgressMap = Object.freeze({})

/**
 * One key for every lesson, not one per lesson.
 *
 * A key per lesson would be nine keys to enumerate, and enumerating
 * `localStorage` by prefix is how a store ends up reading somebody else's.
 */
export const LESSON_PROGRESS_STORAGE_KEY = 'qsim.lessons'

/**
 * Combines two views of the same bookmarks. Later write wins per lesson, and
 * `completed` is the union. See the header for why.
 */
export function mergeProgress(
  left: LessonProgressMap,
  right: LessonProgressMap
): LessonProgressMap {
  const merged: Record<string, LessonProgressEntry> = { ...left }
  for (const [slug, entry] of Object.entries(right)) {
    merged[slug] = mergeEntry(merged[slug], entry)
  }
  return merged
}

function mergeEntry(
  left: LessonProgressEntry | undefined,
  right: LessonProgressEntry
): LessonProgressEntry {
  if (left === undefined) return right
  const newer = right.updatedAt >= left.updatedAt ? right : left
  // `completed` is the union rather than the newer side's value: finishing a
  // lesson on one device and re-reading page one on another must not undo it.
  if (newer.completed || !(left.completed || right.completed)) return newer
  return { ...newer, completed: true }
}

/** The entry for one lesson, or a fresh one parked at step 0. */
export function progressFor(
  progress: LessonProgressMap,
  slug: string
): LessonProgressEntry {
  return (
    progress[slug] ?? {
      slug,
      stepIndex: 0,
      completed: false,
      updatedAt: new Date(0).toISOString(),
    }
  )
}

/* ── The browser store ─────────────────────────────────────────────────── */

/**
 * What is in `localStorage`, or nothing.
 *
 * Every failure is the empty map rather than a throw: the store is a
 * convenience, `localStorage` throws outright in a Safari private window and
 * when a quota is full, and a reader who cleared their site data should get a
 * lesson at step 0 rather than a blank page. A value that is present but not
 * the shape this module writes is treated the same way — it is either a much
 * older version of this app or somebody else's key.
 */
export function readStoredProgress(
  storage: Storage | null = defaultStorage()
): LessonProgressMap {
  if (storage === null) return EMPTY_PROGRESS
  try {
    const raw = storage.getItem(LESSON_PROGRESS_STORAGE_KEY)
    if (raw === null) return EMPTY_PROGRESS
    return parseProgress(JSON.parse(raw))
  } catch {
    return EMPTY_PROGRESS
  }
}

/** Writes the whole map. Failure is silent, for the reasons above. */
export function writeStoredProgress(
  progress: LessonProgressMap,
  storage: Storage | null = defaultStorage()
): void {
  if (storage === null) return
  try {
    storage.setItem(LESSON_PROGRESS_STORAGE_KEY, JSON.stringify(progress))
  } catch {
    // A full quota is not a reason to interrupt a lesson.
  }
}

/**
 * Narrows unknown JSON to the map, dropping anything that is not an entry.
 *
 * Field by field rather than by a cast, because this value has been sitting in
 * a store any script on this origin could have written to, and a `stepIndex`
 * of `"3"` would otherwise reach the player as a string and index nothing.
 */
export function parseProgress(input: unknown): LessonProgressMap {
  if (typeof input !== 'object' || input === null) return EMPTY_PROGRESS
  const out: Record<string, LessonProgressEntry> = {}
  for (const [slug, value] of Object.entries(
    input as Record<string, unknown>
  )) {
    const entry = parseEntry(slug, value)
    if (entry !== null) out[slug] = entry
  }
  return out
}

function parseEntry(slug: string, value: unknown): LessonProgressEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const stepIndex = record['stepIndex']
  const completed = record['completed']
  const updatedAt = record['updatedAt']
  if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex)) return null
  if (stepIndex < 0) return null
  if (typeof completed !== 'boolean') return null
  if (typeof updatedAt !== 'string') return null
  return { slug, stepIndex, completed, updatedAt }
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Accessing the property itself throws when cookies are blocked.
    return null
  }
}
