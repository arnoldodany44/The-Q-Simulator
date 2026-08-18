/**
 * A modal dialog, built on the platform's `<dialog>` rather than on a div.
 *
 * ── WHY THE NATIVE ELEMENT ───────────────────────────────────────────────
 *
 * Everything a modal has to do to be usable with a keyboard, `showModal()`
 * already does, and does correctly: it traps focus inside the dialog, it
 * closes on Escape, it makes the rest of the document inert so a screen
 * reader cannot wander out of it, and it puts the dialog in the top layer so
 * no `z-index` anywhere else can cover it. Re-implementing that in React is
 * several hundred lines that are wrong in ways nobody notices until somebody
 * navigates without a mouse.
 *
 * What is left for this component is the part the platform does not do:
 * mirroring an `open` prop onto the element's imperative API, returning the
 * result through `onClose` however the dialog was dismissed, and giving it a
 * heading that names it.
 *
 * ── THE `onClose` CONTRACT ───────────────────────────────────────────────
 *
 * `<dialog>` fires `close` for *every* dismissal — Escape, `close()`, the form
 * method — so `onClose` is wired there and not to the button. A caller that
 * only listened to its own close button would leave `open` true after Escape,
 * and the next attempt to open the dialog would do nothing because it already
 * believed it was open.
 *
 * Focus returns to whatever opened the dialog on its own: the element remains
 * in the DOM and the browser restores focus to the previously focused element
 * when the top layer is dismissed.
 *
 * ── THE jsdom GUARD ──────────────────────────────────────────────────────
 *
 * `showModal` is absent in some jsdom versions, and a test that renders an
 * open dialog should assert on its contents rather than crash on a missing
 * method. The fallback sets the `open` attribute, which renders the contents
 * without the top layer — enough for a test, never reached in a browser.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface ModalProps {
  readonly open: boolean
  /** Called for every dismissal, including Escape. */
  readonly onClose: () => void
  /** Names the dialog, as its heading and to assistive technology. */
  readonly title: string
  readonly children: ReactNode
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  const { t } = useTranslation('common')
  const titleId = useId()
  const ref = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal()
      else element.setAttribute('open', '')
    } else if (!open && element.open) {
      if (typeof element.close === 'function') element.close()
      else element.removeAttribute('open')
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      /*
       * The backdrop is painted by the dialog element itself, so a click that
       * lands on the element rather than on the panel inside it is a click
       * outside the content. Comparing against the ref is what distinguishes
       * the two; `event.target` for anything in the panel is that child.
       */
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="modal__panel">
        <div className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="modal__close" onClick={onClose}>
            {t('actions.close')}
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
