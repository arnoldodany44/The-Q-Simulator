import { describe, expect, it } from 'vitest'

import {
  EMPTY_PROGRESS,
  LESSON_PROGRESS_STORAGE_KEY,
  mergeProgress,
  parseProgress,
  progressFor,
  readStoredProgress,
  writeStoredProgress,
  type LessonProgressEntry,
} from './progress'

/**
 * The bookmark. Two properties matter more than the rest, and both are things
 * a reader would notice as data loss:
 *
 *   - a lesson that has ever been finished stays finished, on every device;
 *   - a store that cannot be read is an empty map, never an exception, because
 *     `localStorage` throws outright in a private window and a lesson must
 *     still open there.
 */

function entry(
  slug: string,
  stepIndex: number,
  completed: boolean,
  updatedAt: string
): LessonProgressEntry {
  return { slug, stepIndex, completed, updatedAt }
}

/** A `Storage` that is one object, so a test needs no jsdom globals. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => {
      map.clear()
    },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe('merging two views of the same bookmarks', () => {
  it('takes the more recent write', () => {
    const merged = mergeProgress(
      { a: entry('a', 2, false, '2026-08-01T00:00:00.000Z') },
      { a: entry('a', 5, false, '2026-08-02T00:00:00.000Z') }
    )
    expect(merged['a']?.stepIndex).toBe(5)
  })

  it('lets a bookmark move backwards, because re-reading is a real thing', () => {
    const merged = mergeProgress(
      { a: entry('a', 5, false, '2026-08-01T00:00:00.000Z') },
      { a: entry('a', 1, false, '2026-08-02T00:00:00.000Z') }
    )
    expect(merged['a']?.stepIndex).toBe(1)
  })

  /*
   * The assertion this whole module exists for. Finish a lesson on a laptop,
   * open page one on a phone, and the laptop must not be told it never
   * finished.
   */
  it('never un-finishes a lesson', () => {
    const merged = mergeProgress(
      { a: entry('a', 6, true, '2026-08-01T00:00:00.000Z') },
      { a: entry('a', 0, false, '2026-08-02T00:00:00.000Z') }
    )
    expect(merged['a']).toMatchObject({ stepIndex: 0, completed: true })
  })

  it('keeps lessons only one side knows about', () => {
    const merged = mergeProgress(
      { a: entry('a', 1, false, '2026-08-01T00:00:00.000Z') },
      { b: entry('b', 2, false, '2026-08-01T00:00:00.000Z') }
    )
    expect(Object.keys(merged).sort()).toEqual(['a', 'b'])
  })

  it('is stable when one side is empty', () => {
    const one = { a: entry('a', 1, false, '2026-08-01T00:00:00.000Z') }
    expect(mergeProgress(one, EMPTY_PROGRESS)).toEqual(one)
    expect(mergeProgress(EMPTY_PROGRESS, one)).toEqual(one)
  })
})

describe('reading a lesson out of the map', () => {
  it('answers step zero for a lesson nobody has opened', () => {
    expect(progressFor(EMPTY_PROGRESS, 'superposition')).toMatchObject({
      slug: 'superposition',
      stepIndex: 0,
      completed: false,
    })
  })
})

describe('the browser store', () => {
  it('round-trips', () => {
    const storage = memoryStorage()
    const map = { a: entry('a', 3, true, '2026-08-01T00:00:00.000Z') }
    writeStoredProgress(map, storage)
    expect(readStoredProgress(storage)).toEqual(map)
  })

  it('is empty when there is nothing stored', () => {
    expect(readStoredProgress(memoryStorage())).toEqual({})
  })

  it('is empty rather than fatal when the value is not JSON', () => {
    const storage = memoryStorage({
      [LESSON_PROGRESS_STORAGE_KEY]: 'not json at all',
    })
    expect(readStoredProgress(storage)).toEqual({})
  })

  it('is empty rather than fatal when storage itself throws', () => {
    const hostile = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('a private window')
      },
      setItem: () => {
        throw new Error('quota exceeded')
      },
    } as Storage
    expect(readStoredProgress(hostile)).toEqual({})
    expect(() => {
      writeStoredProgress({}, hostile)
    }).not.toThrow()
  })

  it('answers an empty map when there is no storage at all', () => {
    expect(readStoredProgress(null)).toEqual({})
    expect(() => {
      writeStoredProgress({}, null)
    }).not.toThrow()
  })

  /*
   * The value has been sitting in a store any script on this origin can write
   * to. A `stepIndex` of `"3"` reaching the player as a string would index
   * nothing, so entries are narrowed field by field rather than cast.
   */
  it('drops entries that are not the shape it writes', () => {
    const parsed = parseProgress({
      good: { stepIndex: 1, completed: false, updatedAt: '2026-08-01' },
      stringy: { stepIndex: '1', completed: false, updatedAt: '2026-08-01' },
      negative: { stepIndex: -1, completed: false, updatedAt: '2026-08-01' },
      fractional: { stepIndex: 1.5, completed: false, updatedAt: '2026-08-01' },
      noFlag: { stepIndex: 1, updatedAt: '2026-08-01' },
      noDate: { stepIndex: 1, completed: false },
      notAnObject: 7,
      nothing: null,
    })
    expect(Object.keys(parsed)).toEqual(['good'])
  })

  it('is empty for a stored value that is not an object', () => {
    expect(parseProgress('[]')).toEqual({})
    expect(parseProgress(null)).toEqual({})
    expect(parseProgress(42)).toEqual({})
  })
})
