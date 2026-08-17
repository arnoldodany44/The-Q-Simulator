/**
 * The reader's bookmarks, from whichever stores this visit has — §3.6.
 *
 * The model and the merge rule are in `progress.ts`; this is the React half:
 * it holds the local map, asks the API for the account's when there is a
 * session, and writes to both.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE LOCAL WRITE IS SYNCHRONOUS AND THE REMOTE ONE IS NOT AWAITED.
 *
 * `record` returns nothing and never rejects. Pressing "next" must move the
 * lesson on the frame it was pressed — the whole page is one reading position
 * — so the local map is updated immediately and the request goes out beside
 * it. A failed write leaves the account one step behind and the browser
 * correct, which is the failure everybody would choose, and the next press
 * sends the whole state again because the route is a `PUT` on (caller, slug)
 * rather than a delta.
 *
 * That is also why nothing here surfaces a network error. There is no action
 * for the reader to take, the content is unaffected, and an alert over a
 * lesson because a bookmark did not save would be the interruption the feature
 * exists to avoid.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE QUERY IS OFF FOR AN ANONYMOUS READER, AND THAT IS NOT AN OPTIMISATION.
 *
 * `GET /lessons/progress` is `auth: 'required'`, so an anonymous call is a 401
 * cached under the key the signed-in view will then read — the same trap
 * `useAccount` documents. `enabled` is the session's status and nothing else.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LessonProgressList } from '@qsim/contract'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useSession } from '../auth'
import {
  lessonKeys,
  listLessonProgress,
  saveLessonProgress,
  useApiClient,
} from '../../lib/api'
import {
  EMPTY_PROGRESS,
  mergeProgress,
  readStoredProgress,
  writeStoredProgress,
  type LessonProgressMap,
} from './progress'

export interface LessonProgressStore {
  /** Every bookmark this reader has, local and remote already merged. */
  readonly progress: LessonProgressMap
  /**
   * Whether every store this visit has has answered.
   *
   * True immediately for an anonymous reader — `localStorage` is synchronous —
   * and, for a signed-in one, once the account's bookmarks have arrived *or
   * failed to*. A failure resolves it rather than holding it open, because the
   * local map is a complete answer on its own and a lesson that would not open
   * without the network would be worse than one that opens a step early.
   *
   * The player reads its starting position once, at mount, so a route that
   * mounted it before this was true would put a resuming reader back at step
   * one and then have no way to correct it that was not a remount.
   */
  readonly ready: boolean
  /**
   * Records a position. Local always, the account too when there is one.
   * Never throws and never blocks the frame — see the header.
   */
  readonly record: (slug: string, stepIndex: number, completed: boolean) => void
}

/** The account's bookmarks in the shape `progress.ts` works in. */
function toMap(list: LessonProgressList | undefined): LessonProgressMap {
  if (list === undefined) return EMPTY_PROGRESS
  const out: Record<string, LessonProgressMap[string]> = {}
  for (const item of list.items) {
    out[item.slug] = {
      slug: item.slug,
      stepIndex: item.stepIndex,
      completed: item.completed,
      updatedAt: item.updatedAt.toISOString(),
    }
  }
  return out
}

export function useLessonProgress(): LessonProgressStore {
  const session = useSession()
  const client = useApiClient()
  const queryClient = useQueryClient()
  const signedIn = session.status === 'authenticated'

  /*
   * Read once, in an initialiser. What `localStorage` said when this component
   * mounted is a fact about this visit, and re-reading it on every render
   * would fight the writes below — the same reasoning `useCircuitUrl` gives
   * about the address bar.
   */
  const [local, setLocal] = useState<LessonProgressMap>(() =>
    readStoredProgress()
  )

  const remote = useQuery({
    queryKey: lessonKeys.progress(),
    queryFn: ({ signal }) => listLessonProgress(client, { signal }),
    enabled: signedIn,
  })

  const save = useMutation({
    mutationFn: (input: {
      slug: string
      stepIndex: number
      completed: boolean
    }) =>
      saveLessonProgress(client, input.slug, {
        stepIndex: input.stepIndex,
        completed: input.completed,
      }),
    /*
     * Nothing is invalidated on success. The cache entry is patched in place
     * below, because a refetch on every press of "next" would put a round trip
     * between the reader and the next paragraph for a number this tab already
     * knows.
     */
    onSuccess: (saved) => {
      queryClient.setQueryData<LessonProgressList>(
        lessonKeys.progress(),
        (current) => {
          const items = (current?.items ?? []).filter(
            (item) => item.slug !== saved.slug
          )
          return { items: [saved, ...items] }
        }
      )
    },
    // A bookmark that did not save is not news the reader can act on.
    onError: () => undefined,
  })

  const account = useMemo(() => toMap(remote.data), [remote.data])
  const progress = useMemo(
    () => (signedIn ? mergeProgress(local, account) : local),
    [signedIn, local, account]
  )

  /*
   * SIGNING IN CARRIES THIS BROWSER'S READING UP TO THE ACCOUNT.
   *
   * Without this, a reader who read three lessons anonymously and then created
   * an account would find the account empty — the merge above would show them
   * their local progress, and the first write from another device would look
   * like it had erased it. The upload is the merged state, so it is idempotent
   * and it is also what repairs a write that failed earlier.
   *
   * Only entries this browser is ahead on are sent, which keeps it to the
   * lessons that actually differ rather than nine requests on every sign-in.
   */
  const mutate = save.mutate
  useEffect(() => {
    if (!signedIn || !remote.isSuccess) return
    for (const [slug, entry] of Object.entries(local)) {
      const theirs = account[slug]
      const ahead =
        theirs === undefined ||
        entry.updatedAt > theirs.updatedAt ||
        (entry.completed && !theirs.completed)
      if (!ahead) continue
      mutate({
        slug,
        stepIndex: entry.stepIndex,
        completed: entry.completed || (theirs?.completed ?? false),
      })
    }
    // `local` is deliberately absent: this runs when a session resolves and
    // when the account's bookmarks arrive, not on every step the reader takes
    // — `record` already sends those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, remote.isSuccess, account, mutate])

  const record = useCallback(
    (slug: string, stepIndex: number, completed: boolean) => {
      const entry = {
        slug,
        stepIndex,
        completed,
        updatedAt: new Date().toISOString(),
      }
      setLocal((current) => {
        // Merged rather than assigned, so `completed` cannot be walked back by
        // a reader who reopens a finished lesson at step 0.
        const next = mergeProgress(current, { [slug]: entry })
        writeStoredProgress(next)
        return next
      })
      if (signedIn) mutate({ slug, stepIndex, completed })
    },
    [signedIn, mutate]
  )

  /*
   * `session.status === 'loading'` counts as not ready too: the stored session
   * has not been read yet, so "is there an account" has no answer, and a
   * player mounted in that frame would resume from the local map and then be
   * unable to take the account's word for it.
   */
  const ready =
    session.status === 'anonymous' ||
    (signedIn && (remote.isSuccess || remote.isError))

  return { progress, ready, record }
}
