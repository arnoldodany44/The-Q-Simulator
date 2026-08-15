/**
 * Saving: what happens between the button and the row — M1.4a.
 *
 * ── Why this is not `useSaveVersion` ──────────────────────────────────────
 *
 * `lib/api/useCircuits.ts` has one hook per route, which is the right shape
 * for a transport. A save is not one route: it is a read to find out whether
 * saving is still safe, then a write, then a check on what the write returned,
 * and on an existing circuit possibly a `PATCH` beside it. Spreading that
 * across three call sites in a component is how the pre-flight ends up skipped
 * on one of the paths.
 *
 * ── A stale save is a result, not an error ────────────────────────────────
 *
 * `mutation.error` is for things that went wrong: a network that dropped, a
 * 403, a malformed response. A save the *client* declined to send because the
 * server has moved on is none of those — it is a question for the user, with
 * two legitimate answers. So it comes back through `data` as
 * `{ kind: 'stale' }`, which also keeps it out of every generic "something
 * failed" banner in the app.
 *
 * ── The order of the two writes ───────────────────────────────────────────
 *
 * The document first, the metadata second. Both can fail, and the failures are
 * not equal: a version that did not get written is work the user still has to
 * re-do, while a title that did not get renamed is a rename they can repeat in
 * two seconds. Whichever runs second is the one that is skipped when the first
 * fails, so the document goes first.
 *
 * ── Retries stay off ──────────────────────────────────────────────────────
 *
 * `createQueryClient` disables mutation retries because `POST /circuits`
 * creates a row and nothing in §8 offers an idempotency key. That applies here
 * with double force: a retried version append would write the same document
 * twice under two version numbers, which is not an error the user can see and
 * not one anything cleans up.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import type {
  CircuitDetail,
  CircuitVersion,
  CircuitWithVersion,
  UpdateCircuitRequest,
  Visibility,
} from '@qsim/contract'
import type { Circuit } from '@qsim/schema'

import {
  circuitKeys,
  createCircuit,
  createVersion,
  getCircuit,
  updateCircuit,
  useApiClient,
} from '../../lib/api'
import {
  racedOn,
  staleAgainst,
  type RacedSave,
  type StaleSave,
} from './saveDecisions.js'
import {
  useDocumentBinding,
  type DocumentBase,
  type DocumentBindingStore,
} from './documentBinding.js'

/** The metadata half of a save, which is the same on both paths. */
export interface CircuitDetails {
  readonly title: string
  readonly description: string | null
  readonly visibility: Visibility
}

export type SaveVariables =
  | {
      readonly kind: 'create'
      readonly circuit: Circuit
      readonly details: CircuitDetails
      readonly message: string | null
    }
  | {
      readonly kind: 'version'
      readonly base: DocumentBase
      /** `null` when only the metadata changed: no version is appended. */
      readonly circuit: Circuit | null
      readonly message: string | null
      /** `null` when nothing about the metadata changed. */
      readonly details: UpdateCircuitRequest | null
      /**
       * Skip the pre-flight and append anyway. This is the user answering the
       * conflict, and it is honest because history is append-only: their
       * version lands *after* the one they had not seen, and both survive.
       */
      readonly force?: boolean
    }

export type SaveResult =
  | {
      readonly kind: 'created'
      readonly circuit: CircuitDetail
      readonly version: CircuitVersion
    }
  | {
      readonly kind: 'saved'
      /** `null` when the save was metadata only. */
      readonly version: CircuitVersion | null
      readonly detail: CircuitDetail | null
      /** Set when the write landed on a number it was not promised. */
      readonly raced: RacedSave | null
    }
  | {
      readonly kind: 'stale'
      readonly conflict: StaleSave
      /** What the server holds now, so "open theirs" costs no second fetch. */
      readonly latest: CircuitWithVersion
    }

export type SaveMutation = UseMutationResult<SaveResult, unknown, SaveVariables>

export interface SaveCircuitOptions {
  readonly binding?: DocumentBindingStore
}

export function useSaveCircuit({
  binding = useDocumentBinding,
}: SaveCircuitOptions = {}): SaveMutation {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<SaveResult, unknown, SaveVariables>({
    mutationFn: async (variables): Promise<SaveResult> => {
      if (variables.kind === 'create') {
        const created = await createCircuit(client, {
          title: variables.details.title,
          description: variables.details.description,
          visibility: variables.details.visibility,
          circuit: variables.circuit,
          ...(variables.message === null ? {} : { message: variables.message }),
        })
        return {
          kind: 'created',
          circuit: created.circuit,
          version: created.version,
        }
      }

      const { base } = variables

      if (variables.force !== true) {
        /*
         * The pre-flight, and the reason it is a bare call rather than a
         * cached read: a save has to be judged against what the server holds
         * *now*, and `staleTime` exists precisely to avoid asking that
         * question. Thirty seconds of staleness is right for a listing and
         * wrong for the one read whose whole purpose is to be current.
         */
        const latest = await getCircuit(client, base.slug)
        const conflict = staleAgainst(
          base.versionNum,
          latest.version.versionNum
        )
        if (conflict !== null) {
          // Cached anyway: the user is about to be shown a choice between two
          // documents, and one of them is this.
          queryClient.setQueryData(circuitKeys.detail(base.slug), latest)
          return { kind: 'stale', conflict, latest }
        }
      }

      const version =
        variables.circuit === null
          ? null
          : (
              await createVersion(client, base.slug, {
                circuit: variables.circuit,
                ...(variables.message === null
                  ? {}
                  : { message: variables.message }),
              })
            ).version

      const detail =
        variables.details === null
          ? null
          : (await updateCircuit(client, base.slug, variables.details)).circuit

      return {
        kind: 'saved',
        version,
        detail,
        /*
         * The post-flight. The pre-flight closed a window it could not close
         * completely — another tab can save in the milliseconds between the
         * read and the write — and the response says exactly which number was
         * allocated, so the leftover case is detectable rather than merely
         * unlikely. A forced save skips it because its whole premise is that
         * the user already knows.
         */
        raced:
          version === null || variables.force === true
            ? null
            : racedOn(base.versionNum, version.versionNum),
      }
    },

    onSuccess: (result) => {
      if (result.kind === 'stale') return

      if (result.kind === 'created') {
        // The response already holds the circuit and its first version, so the
        // navigation to `/c/:slug` that follows finds the document in cache
        // and never blanks the editor to fetch what this tab is holding.
        queryClient.setQueryData(circuitKeys.detail(result.circuit.slug), {
          circuit: result.circuit,
          version: result.version,
        })
        binding.getState().bind({
          circuitId: result.circuit.id,
          slug: result.circuit.slug,
          versionNum: result.version.versionNum,
          circuit: result.version.circuit,
        })
        void queryClient.invalidateQueries({ queryKey: circuitKeys.lists() })
        return
      }

      const current = binding.getState().base
      if (current !== null && result.version !== null) {
        /*
         * The new base is the version the server *echoed*, not the document
         * this tab sent. They are the same value — the response is parsed
         * through the same schema the request was built from — and taking the
         * server's makes that an assertion rather than an assumption: if they
         * ever diverged, the editor would immediately read as dirty instead of
         * quietly believing it was in sync.
         */
        binding.getState().bind({
          ...current,
          versionNum: result.version.versionNum,
          circuit: result.version.circuit,
        })
      }

      const handle = current?.slug
      if (handle !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: circuitKeys.detail(handle),
        })
      }
      void queryClient.invalidateQueries({ queryKey: circuitKeys.lists() })
    },
  })
}
