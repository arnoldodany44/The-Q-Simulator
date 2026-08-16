/**
 * Star and unstar, from wherever a circuit is shown — M1.5b.
 *
 * ── The optimistic half, and the half that matters more ───────────────────
 *
 * `useStarCircuit` writes the guess into every cache that draws a star and
 * puts the snapshots back if the request fails, so this component renders
 * whatever the cache currently says and never holds a copy of it. That is the
 * whole reason there is no local state here: a component that kept its own
 * `starred` boolean would keep showing it after the rollback, and the brief's
 * requirement — a failed star must visibly revert rather than leaving a lie on
 * screen — would be true of the cache and false of the pixels.
 *
 * The failure still has to be *said*, not merely undone. A star that silently
 * springs back is indistinguishable from a mis-click, so the refusal is
 * announced in a live region beside the button, in the reader's language, from
 * the code the API sent (§11, D2).
 *
 * ── What it does when nobody is signed in ─────────────────────────────────
 *
 * It offers the way in rather than a button that can only fail. `POST
 * /circuits/:id/star` is `auth: 'required'`, so an anonymous click has exactly
 * one useful outcome, and rendering it as a link to sign-in — carrying where
 * to come back to — is that outcome without the round trip. The session is
 * three-state: "not known yet" is not "signed out", and rendering a sign-in
 * invitation at somebody who is already signed in is a defect even when it
 * lasts two frames.
 *
 * ── Why the count is inside the button ────────────────────────────────────
 *
 * Because the button is what changes it. A number beside a control that moves
 * when the control is pressed, announced as part of that control's name, is
 * one thing to find and one thing to hear; a separate `<span>` is a second
 * thing a screen reader reaches later, after the sentence that made it stale.
 *
 * `aria-pressed` is what carries the state to assistive technology — the
 * filled star is a shape, the label says the action, and neither of them is a
 * colour (§10).
 */

import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'

import { useSession } from '../auth'
import { INTENDED_PATH_STATE_KEY, SIGN_IN_PATH } from '../auth/paths'
import { useApiErrorMessage, useStarCircuit } from '../../lib/api'

export interface StarButtonProps {
  /** Addressed by slug — see `StarVariables.handle` for why never the id. */
  readonly slug: string
  readonly circuitId: string
  readonly starred: boolean
  readonly starCount: number
}

export function StarButton({
  slug,
  circuitId,
  starred,
  starCount,
}: StarButtonProps) {
  const { t, i18n } = useTranslation('gallery')
  const describeError = useApiErrorMessage()
  const session = useSession()
  const location = useLocation()
  const star = useStarCircuit()

  const numbers = new Intl.NumberFormat(i18n.language)
  const count = numbers.format(starCount)

  if (session.status === 'loading') {
    /*
     * Holds the button's space rather than rendering nothing, so a card does
     * not reflow under the reader when the stored session resolves. It is
     * `aria-hidden` because it says nothing worth hearing.
     */
    return <span className="star-button star-button--pending" aria-hidden />
  }

  if (session.status !== 'authenticated') {
    return (
      <Link
        className="star-button star-button--signin"
        to={SIGN_IN_PATH}
        /*
         * Where to come back to, in router state rather than in a query
         * parameter: `features/auth/paths.ts` argues that an address in
         * `?next=` leaks — into history, into `Referer`, into a shared link —
         * and an UNLISTED slug *is* its access control. The same key the route
         * guard writes, so the sign-in screen needs to know about only one.
         */
        state={{
          [INTENDED_PATH_STATE_KEY]: `${location.pathname}${location.search}`,
        }}
      >
        <StarShape filled={false} />
        <span className="star-button__count tabular-numbers">{count}</span>
        <span className="visually-hidden">{t('star.signIn')}</span>
      </Link>
    )
  }

  return (
    <>
      <button
        className={starred ? 'star-button star-button--on' : 'star-button'}
        type="button"
        aria-pressed={starred}
        /*
         * `aria-disabled` rather than `disabled` while a request is in flight,
         * for the reason every other control in this app gives: a disabled
         * button cannot hold focus, so the keyboard user who just pressed it is
         * returned to the document body. The handler declines instead.
         */
        aria-disabled={star.isPending}
        onClick={() => {
          if (star.isPending) return
          star.mutate({ handle: slug, circuitId, starred: !starred })
        }}
      >
        <StarShape filled={starred} />
        <span className="star-button__count tabular-numbers">{count}</span>
        <span className="visually-hidden">
          {starred ? t('star.remove') : t('star.add')}
        </span>
      </button>

      {star.isError ? (
        /*
         * The rollback already put the star back; this says why. Without it a
         * refused star is a control that flickered, which reads as a mis-click
         * rather than as a server that said no.
         */
        <p className="star-button__error" role="alert">
          {describeError(star.error)}
        </p>
      ) : null}
    </>
  )
}

/**
 * The star itself: filled when this viewer has starred the circuit, outlined
 * when they have not.
 *
 * Shape rather than shade, exactly as `GateNode` draws a negative control as a
 * ring instead of a paler dot: the difference has to survive a bad monitor,
 * colour blindness and a screenshot at a third of its size (§10 — colour is
 * never the only carrier of meaning).
 */
function StarShape({ filled }: { readonly filled: boolean }) {
  return (
    <svg
      className={filled ? 'star-shape star-shape--filled' : 'star-shape'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4L2.6 9.4l6.5-.9z" />
    </svg>
  )
}
