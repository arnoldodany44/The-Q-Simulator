/**
 * Losing work, and the one case where leaving the page really does — M1.4a.
 *
 * ── THE DECISION, AND WHY IT IS NOT AUTOSAVE ──────────────────────────────
 *
 * Three options were on the table: autosave, a prompt on every exit, or a
 * local draft. What ships is the draft, and the draft is the address bar.
 *
 * **Autosave is wrong here specifically.** Every save appends an immutable
 * version. Autosaving would mint one per pause in typing, and a history whose
 * value is "these are the states I chose to keep" becomes a keystroke log —
 * the same argument `useCircuitUrl` makes for `replaceState` over `pushState`,
 * one layer up. It would also make the conflict case unreadable: two tabs
 * autosaving produce interleaved versions nobody asked for and nobody can
 * reconcile. And it cannot be the whole answer anyway, because an anonymous
 * user has no server to autosave to — so it would leave two different stories
 * about what happens to unsaved work, told by the same editor.
 *
 * **A prompt on every exit is mostly a lie.** `beforeunload` cannot show
 * custom text in any current browser, it does nothing at all for in-app
 * navigation, and — the part that matters — it would be warning about a loss
 * that does not happen. Phase 0's codec already writes the document into `?c=`
 * as it is edited. Reload `/c/abc?c=…` and the edit comes back; it is in the
 * URL, on every route, for signed-in and anonymous readers alike.
 *
 * **So the draft is the URL**, which is not a new mechanism to learn and not a
 * second copy to keep in sync: it is the same one that has been the save file
 * since Phase 0, and it makes the state visible in the address bar rather than
 * hidden in storage a user cannot inspect or clear. `routes/editor.tsx` also
 * removes the parameter once the document matches its saved version, so a
 * clean `/c/abc` means "this is exactly what is stored" and `/c/abc?c=…` means
 * "plus an edit that is not".
 *
 * ── Which leaves one real gap, and this hook is it ────────────────────────
 *
 * A circuit too large for a URL gets no `?c=` at all (`exceedsUrlBudget`), by
 * design: a stale payload in the address bar is a link that promises a
 * different circuit from the one on screen. For that document, and only that
 * document, closing the tab genuinely loses the edit — so that is exactly when
 * the browser's own dialog is armed. A warning that fires only when something
 * is actually at stake is a warning people read.
 */

import { useEffect } from 'react'

export interface UnsavedWorkOptions {
  /**
   * Whether the document on screen would survive a reload. False means it
   * exists nowhere but in this tab's memory.
   */
  readonly carried: boolean
  /** Nothing to lose — an empty canvas, or one that matches what is stored. */
  readonly hasWork: boolean
}

export function useUnsavedWork({ carried, hasWork }: UnsavedWorkOptions): void {
  const atRisk = hasWork && !carried

  useEffect(() => {
    if (!atRisk) return

    const warn = (event: BeforeUnloadEvent): void => {
      /*
       * Both, because browsers disagree about which one arms the dialog and
       * neither is expensive. No message is set: every current browser
       * replaced custom text with its own generic sentence years ago, so a
       * string here would be untranslated text that nobody ever sees — the
       * worst of both halves of D2.
       */
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [atRisk])
}
