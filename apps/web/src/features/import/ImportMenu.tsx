/**
 * The overflow at the end of the circuit toolbar, and the dialog behind it.
 *
 * ── WHY THE IMPORT MOVED HERE ────────────────────────────────────────────
 *
 * It used to be a panel above the canvas, beside the export. That put the one
 * control on the page that *replaces the whole document* permanently on
 * screen, next to five that do not, and it cost a card's worth of height to
 * say so. Behind a menu it is still one press away and no longer competing
 * with the controls a reader uses constantly.
 *
 * The dialog is what makes that safe rather than merely tidier: an import
 * clears the undo history, so it should be a thing you went and opened, and a
 * modal is the affordance that says "this is a step of its own" without a
 * confirmation prompt nobody reads.
 *
 * ── WHY THIS IS MOUNTED BY THE PAGE AND NOT BY THE TOOLBAR ───────────────
 *
 * `CircuitEditor` takes it as an opaque `toolbarOverflow` node, exactly as it
 * takes `canvasOverlay` for the comment markers and the presence carets, and
 * for the same two reasons.
 *
 * The weight half is the concrete one here: this component's graph contains
 * `@qsim/qasm`, a whole OpenQASM reader. Importing it from
 * `features/circuit-editor` would put the parser in the editor's chunk, paid
 * for by everyone who opens `/new` and used by the few who arrive with a file.
 * As a node handed in from the route it stays in its own chunk.
 *
 * The seam half: the editor edits the circuit already open. Replacing that
 * circuit with another one is a command about the *document*, which is the
 * page's business — the same line that puts the URL, the save control and the
 * export on the page rather than in the editor.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { Modal } from '../../components/Modal'
import type { CircuitStore } from '../circuit-editor/useCircuitStore'
import { ImportPanel } from './ImportPanel'

export interface ImportMenuProps {
  readonly store: CircuitStore
}

export function ImportMenu({ store }: ImportMenuProps) {
  const { t } = useTranslation(['editor', 'import'])
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  /*
   * Counts successful imports, so the live region below can announce each one.
   *
   * The panel's own status line goes with the dialog when it closes, and a
   * reader who cannot see the canvas would otherwise be told nothing at all —
   * the dialog would simply vanish. Keyed on a count rather than a boolean for
   * the reason `CircuitEditor`'s status line is: two identical announcements in
   * a row leave the text node untouched, and a live region that did not change
   * says nothing.
   */
  const [announcement, setAnnouncement] = useState(0)
  const container = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)

  /*
   * A menu that stays open after a click elsewhere is a menu that covers what
   * the reader was reaching for. Pointer-down rather than click so it closes
   * on the press that begins the next action, and Escape because that is what
   * every other dismissible thing on this page answers to.
   *
   * Bound only while open: an app-wide listener that spends every pointer
   * event asking "is the menu open" for a menu that is almost never open is
   * work done for nothing.
   */
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      // Back to the button that opened it, or focus is left on the body and
      // the next Tab starts from the top of the page.
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  return (
    <div className="toolbar-overflow" ref={container}>
      <button
        ref={trigger}
        type="button"
        className="toolbar-overflow__trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('editor:toolbar.more')}
        title={t('editor:toolbar.more')}
        onClick={() => {
          setMenuOpen((open) => !open)
        }}
      >
        {/*
         * Through `Notation` because it is a glyph and not a word: three dots
         * mean the same thing in all three languages, and writing it as a bare
         * string is what `i18next/no-literal-string` exists to catch. The
         * button's name comes from `aria-label` above, so the glyph is
         * decoration and nothing depends on it being read aloud.
         */}
        <Notation value="⋯" />
      </button>

      {menuOpen ? (
        <div className="toolbar-overflow__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="toolbar-overflow__item"
            onClick={() => {
              setMenuOpen(false)
              setDialogOpen(true)
            }}
          >
            {t('editor:toolbar.import')}
          </button>
        </div>
      ) : null}

      {/*
       * Outside the dialog on purpose: this has to survive the close that the
       * successful import triggers.
       */}
      <p className="toolbar-overflow__status" role="status">
        {announcement === 0 ? null : (
          <span key={announcement}>{t('editor:toolbar.imported')}</span>
        )}
      </p>

      <Modal
        open={dialogOpen}
        title={t('import:heading')}
        onClose={() => {
          setDialogOpen(false)
        }}
      >
        <ImportPanel
          store={store}
          /*
           * Close on a successful read, and only then.
           *
           * Left open, the dialog covers the circuit it just loaded, which is
           * indistinguishable from a button that did nothing — that is exactly
           * how this was reported, twice, on a panel whose import was working
           * the whole time. The evidence a reader wants is the canvas, so the
           * dialog stops standing in front of it.
           *
           * A failure keeps it open: the sentence naming the line, and the box
           * holding the text with that line in it, are only useful together.
           */
          onImported={() => {
            setDialogOpen(false)
            setAnnouncement((count) => count + 1)
          }}
        />
      </Modal>
    </div>
  )
}
