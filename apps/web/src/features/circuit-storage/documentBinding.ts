/**
 * Which saved circuit the document on screen descends from — M1.4a.
 *
 * ── Why this is a store and not React state ───────────────────────────────
 *
 * The first save navigates: `/new` becomes `/c/:slug`, and those are two
 * `<Route>` elements, so React unmounts the editor route and mounts it again.
 * Any binding held in a component's state dies in that gap — and the symptom
 * is not a blank screen but something worse: the freshly mounted route sees no
 * binding, decides the circuit must be loaded from the server, and calls
 * `loadCircuit`, which clears the undo history. The user presses Save and
 * loses every step they could have undone, for a document that did not change.
 *
 * A module-scoped store outlives the route swap for the same reason
 * `useCircuitStore` does, and this file deliberately mirrors it: a factory for
 * tests, one shared instance for the app.
 *
 * ── What it holds, and what it refuses to hold ────────────────────────────
 *
 * §9 splits the world: Zustand owns the document being edited, React Query
 * owns what came from the server. A binding is neither in full, so the split
 * decides field by field.
 *
 *   - `circuitId`, `slug`, `versionNum` — the *identity* of what this document
 *     descends from. Not server state: it is a fact about the editing session,
 *     and it survives the server's copy changing under it. That is precisely
 *     what makes a stale save detectable.
 *   - `circuit` — the base document, kept so "has this been edited?" is a
 *     comparison rather than a guess. It is a `Circuit`, the same kind of value
 *     the editor store and the clipboard hold.
 *
 * Deliberately absent: the title, the description, the visibility, the owner,
 * the counts. Every one of those is the server's answer, it can change without
 * this tab doing anything, and React Query already caches it under
 * `circuitKeys.detail`. A copy here would be a second version of the truth
 * that nothing invalidates — the exact drift §9's rule exists to prevent.
 */

import { create } from 'zustand'
import type { Circuit } from '@qsim/schema'

/**
 * The version a document descends from.
 *
 * `versionNum` is the whole of the conflict story: versions are immutable and
 * monotonic on the server, so "the number I started from" compared against
 * "the number the server is at now" is what tells a save that it is about to
 * land on top of work it has never seen.
 */
export interface DocumentBase {
  /** The circuit row's id, which is stable across a rename. */
  readonly circuitId: string
  /** Its slug: the `/c/:slug` address and the handle every route accepts. */
  readonly slug: string
  /** The version the editor was seeded from, or the last one it wrote. */
  readonly versionNum: number
  /** That version's document, to compare the editor against. */
  readonly circuit: Circuit
}

export interface DocumentBindingState {
  readonly base: DocumentBase | null
  /** Adopt a server version as what the open document descends from. */
  bind(base: DocumentBase): void
  /** Forget it: the document on screen belongs to no saved circuit. */
  release(): void
}

export function createDocumentBinding() {
  return create<DocumentBindingState>()((set) => ({
    base: null,
    bind: (base) => {
      set({ base })
    },
    release: () => {
      set((state) => (state.base === null ? state : { base: null }))
    },
  }))
}

/** The app's binding. Tests build their own, so no state leaks between them. */
export const useDocumentBinding = createDocumentBinding()

export type DocumentBindingStore = ReturnType<typeof createDocumentBinding>
