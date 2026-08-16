/**
 * Fork — from a gallery card, and from a circuit open in the editor (M1.5b).
 *
 * ── What a fork is, and why the landing has to say so ─────────────────────
 *
 * `POST /circuits/:id/fork` copies the source's current version into a new
 * circuit owned by the caller, PRIVATE regardless of the source's visibility
 * (see `forkCircuit` in @qsim/db: forking a public circuit is not publishing
 * one). The caller then lands in the editor on *their own copy*, which looks
 * exactly like the circuit they were reading a second ago — and that is the
 * whole risk. A reader who does not notice the change of ownership will
 * believe they are editing the original, and the first thing they will do is
 * be surprised by something.
 *
 * So the attribution travels with the navigation and the editor states it in
 * words: this is your copy of *that* circuit, by *that* author.
 *
 * The attribution itself is carried in history state rather than read back
 * from the server, because the server deliberately will not say — see
 * `forkAttribution.ts`, which holds that argument and the reading of it.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'

import { circuitPagePath } from '../circuit-storage/paths'
import { useSession } from '../auth'
import { useApiErrorMessage, useForkCircuit } from '../../lib/api'
import {
  FORKED_FROM_STATE_KEY,
  forkAttributionFrom,
} from './forkAttribution.js'

export interface ForkButtonProps {
  /** Addressed by slug, so an UNLISTED circuit somebody was sent can be forked. */
  readonly slug: string
  readonly title: string
  readonly username: string
  /** `quiet` on a card, where the primary action is opening the circuit. */
  readonly variant?: 'primary' | 'quiet'
}

export function ForkButton({
  slug,
  title,
  username,
  variant = 'quiet',
}: ForkButtonProps) {
  const { t } = useTranslation('gallery')
  const describeError = useApiErrorMessage()
  const session = useSession()
  const navigate = useNavigate()
  const fork = useForkCircuit()

  /*
   * Hidden rather than offered while the session is unknown, and hidden for an
   * anonymous reader: `POST /circuits/:id/fork` is `auth: 'required'`, so the
   * control could only ever fail. Unlike the star — which is a one-click thing
   * worth inviting a sign-in for — a fork lands the reader in an editor, and
   * routing them through sign-in on the way there loses the circuit they were
   * looking at. The gallery's own sign-in invitation covers the general case.
   */
  if (session.status !== 'authenticated') return null

  return (
    <>
      <button
        className={
          variant === 'primary'
            ? 'fork-button fork-button--primary'
            : 'fork-button'
        }
        type="button"
        aria-disabled={fork.isPending}
        onClick={() => {
          if (fork.isPending) return
          fork.mutate(
            { handle: slug },
            {
              onSuccess: (created) => {
                /*
                 * The server's own slug, from the response it just sent —
                 * `useForkCircuit` has already seeded the detail cache under
                 * it, so the editor opens without a second round trip.
                 */
                void navigate(circuitPagePath(created.circuit.slug), {
                  state: {
                    [FORKED_FROM_STATE_KEY]: { title, username },
                  },
                })
              },
            }
          )
        }}
      >
        {fork.isPending ? t('fork.working') : t('fork.action')}
      </button>

      {fork.isError ? (
        <p className="fork-button__error" role="alert">
          {describeError(fork.error)}
        </p>
      ) : null}
    </>
  )
}

/**
 * The sentence a fork lands on: this is your copy of somebody else's circuit.
 *
 * ── Why it is a block and not a tint ──────────────────────────────────────
 *
 * `VersionPreview` made the same call for the same reason: a page that shows
 * one document in the frame of another is a page a reader can misread, and the
 * cost of that mistake is edits made to the wrong thing. A fork looks exactly
 * like the circuit it came from — that is what a fork *is* — so the only thing
 * separating "I am editing my copy" from "I am editing theirs" is this
 * paragraph. It is `role="status"`, so it is announced rather than merely
 * painted, and it names both the source and its author.
 *
 * ── Why it is dismissible and does not come back ──────────────────────────
 *
 * It is a fact about the navigation that just happened, not a property of the
 * circuit, so it belongs on screen until the reader has read it and not after.
 * It lives in history state, so a reload clears it too — the claim it makes is
 * one only this tab can vouch for, and nothing on the server would confirm it
 * (see the header).
 *
 * ── Why it takes focus ────────────────────────────────────────────────────
 *
 * Because it is where the fork *landed*. A keyboard user who pressed "Fork" on
 * a gallery card was deposited on `document.body` of a different route — a
 * document with some fifty tab stops and no anchor — and a screen-reader user
 * heard this notice announced while their virtual cursor sat at the top of a
 * page they had not read. `role="status"` says the words out loud; it does not
 * put the reader anywhere.
 *
 * So this is the landing place, in the same way `VersionPreview` focuses its
 * heading after a restore and `ProviderReturnAlert` focuses its region: a
 * `tabIndex={-1}` container, focused once on arrival, so the next Tab
 * continues from the sentence that explains what just happened rather than
 * from the beginning of the document.
 */
export function ForkedFromNotice() {
  const { t } = useTranslation('gallery')
  const location = useLocation()
  const [dismissed, setDismissed] = useState(false)
  const region = useRef<HTMLDivElement>(null)

  const attribution = forkAttributionFrom(location.state)

  /*
   * Keyed on the attribution rather than on mount, so arriving from a second
   * fork in the same session moves focus again — and so a re-render for any
   * other reason does not steal it back from wherever the reader has since
   * moved.
   */
  const landing = attribution === null ? null : attribution.title
  useEffect(() => {
    if (landing === null) return
    region.current?.focus()
  }, [landing])

  if (attribution === null || dismissed) return null

  return (
    <div
      className="forked-notice"
      role="status"
      // Focusable by script, never in the tab order: this is a destination, not
      // a control, and adding a stop to every editor page would be noise.
      tabIndex={-1}
      ref={region}
    >
      <p className="forked-notice__heading">{t('forked.heading')}</p>
      {/*
       * The title and the username are the source author's own words, rendered
       * as text and escaped by React. They are interpolated into a translated
       * sentence rather than concatenated with one, which is what keeps the
       * word order the translator's decision rather than English's (D2).
       */}
      <p>
        {t('forked.body', {
          title: attribution.title,
          author: attribution.username,
        })}
      </p>
      <button
        className="page__cta page__cta--quiet"
        type="button"
        onClick={() => {
          setDismissed(true)
        }}
      >
        {t('forked.dismiss')}
      </button>
    </div>
  )
}
