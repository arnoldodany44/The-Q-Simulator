/**
 * What the specs are allowed to know about the editor.
 *
 * Everything here addresses the page the way a user does — by role, by
 * accessible name, by pixel — and nothing reaches into the store, the
 * circuit JSON or a React internal. That restriction is the point of the
 * suite: the unit tests already prove each layer in isolation, so an
 * end-to-end test that asserted `store.getState().circuit` would only prove
 * them again while skipping the join between them.
 *
 * The one concession is `data-gate` on the palette chips. A chip's visible
 * label is notation (`H`, `CNOT`) and its accessible name is the same, so
 * addressing it by name would work — but `Rz` and `Rz(θ)` are one keystroke
 * apart in the palette and a substring match between them is a coin flip.
 * The attribute already exists for the palette's own roving focus; it is not
 * a hook added for the tests.
 */

import { expect, type Locator, type Page } from '@playwright/test'

/** The three shipped languages (D2). */
export type UiLanguage = 'en' | 'es' | 'fr'

/**
 * Mirrors `LANGUAGE_STORAGE_KEY` in `src/i18n/index.ts`. It is written out
 * rather than imported because that module runs `import.meta.glob`, which
 * only exists inside Vite — importing it here would crash the Node-side test
 * runner before a single browser opened.
 */
const LANGUAGE_STORAGE_KEY = 'qsim.language'

/** Wires a fresh document starts with, from `DEFAULT_QUBITS`. */
export const QUBITS = 3

/**
 * Opens `/new` with the language pinned.
 *
 * Seeding `localStorage` before the app boots is what makes the language
 * deterministic: i18next's detector reads storage first and only then falls
 * back to `navigator.language`, so a machine set to French cannot quietly
 * change what these tests are asserting.
 */
export async function openEditor(
  page: Page,
  language: UiLanguage = 'en'
): Promise<void> {
  await page.addInitScript(
    ([key, value]: [string, string]) => {
      window.localStorage.setItem(key, value)
    },
    [LANGUAGE_STORAGE_KEY, language] as [string, string]
  )
  await page.goto('/new')
  // The catalogs load before the first render, so a visible grid means the
  // editor is mounted *and* translated — there is no frame in between.
  await expect(grid(page)).toBeVisible()
}

/** The language stored for the next visit. D2 asks for the choice to stick. */
export function storedLanguage(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) => window.localStorage.getItem(key),
    LANGUAGE_STORAGE_KEY
  )
}

/* ------------------------------------------------------------------ *
 * Addressing the editor
 * ------------------------------------------------------------------ */

export function grid(page: Page): Locator {
  return page.getByRole('grid')
}

/**
 * A wire's row, found by its own name rather than by position. Wire names
 * are notation and identical in all three languages, so this is the one
 * anchor on the canvas that survives a language switch.
 */
export function wireRow(page: Page, qubit: number): Locator {
  return page.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: `q${qubit}`, exact: true }),
  })
}

/** The cell where a wire meets a moment. */
export function cellAt(page: Page, qubit: number, column: number): Locator {
  return wireRow(page, qubit).getByRole('gridcell').nth(column)
}

/** A palette chip. */
export function gateChip(page: Page, gate: string): Locator {
  return page.locator(`button[data-gate="${gate}"]`)
}

/**
 * The editor's live region: the refusal that has just happened, or the
 * question a half-placed multi-qubit gate is waiting on.
 *
 * Addressed by class rather than by role because there are two live regions
 * on the page — dnd-kit mounts its own `role="status"` for the drag
 * announcements — and that is correct behaviour, not a bug to work around.
 * A reader hears both; a test has to say which one it means.
 */
export function statusLine(page: Page): Locator {
  return page.locator('p.circuit-editor__status')
}

/**
 * The canvas's spoken summary — how many qubits, columns and operations the
 * circuit has. It is the shortest honest answer to "what is on the canvas",
 * and it is generated from the same `Circuit` the SVG is drawn from.
 *
 * It sits beside the grid and reaches it through `aria-describedby`, not
 * inside it: `role="grid"` may own rows and rowgroups only, and a paragraph
 * among them is a child assistive technology is free to discard.
 */
export function circuitSummary(page: Page): Locator {
  return page.locator('p.circuit-canvas__summary')
}

export function toolbarButton(page: Page, name: string): Locator {
  return page.getByRole('toolbar').getByRole('button', { name })
}

/* ------------------------------------------------------------------ *
 * The simulation panel (M0.6)
 * ------------------------------------------------------------------ */

/** What the pipeline is doing: waiting, running, ready, or refused. */
export function simulationState(page: Page): Locator {
  return page.locator('p.simulation-panel__state')
}

/**
 * The panel's own live region. Addressed by class for the same reason as
 * `statusLine`: the page carries several `role="status"` nodes on purpose,
 * and a test has to say which one it means.
 */
export function simulationFailure(page: Page): Locator {
  return page.locator('p.simulation-panel__failure')
}

/**
 * The value of one reported fact, found through the term beside it — so the
 * assertion survives the panel gaining or reordering rows, which it will when
 * M0.7 replaces it.
 */
export function simulationFact(page: Page, term: string): Locator {
  return page
    .locator('.simulation-panel__fact')
    .filter({ hasText: term })
    .locator('dd')
}

export function languagePicker(page: Page): Locator {
  return page.getByRole('combobox')
}

/* ------------------------------------------------------------------ *
 * Interacting
 * ------------------------------------------------------------------ */

/**
 * Drags one element onto another with a real pointer.
 *
 * Playwright's own `dragTo` sends a single move between press and release,
 * and dnd-kit sees that as one event that is both the activation and the
 * drop — no drag ever starts. The gesture is therefore spelled out: past the
 * 4px activation distance first (`CircuitEditor.tsx` sets it so a click that
 * selects is not read as a drag), then across in steps, then a beat at rest
 * before the release, because dnd-kit resolves the drop target from the last
 * move it processed rather than from where the button came up.
 */
export async function dragOnto(
  page: Page,
  source: Locator,
  target: Locator
): Promise<void> {
  const from = await centreOf(source)
  const to = await centreOf(target)

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 8, from.y + 8)
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box, 'the element has no box to drag from or to').not.toBeNull()
  // `expect` above already failed the test if the box is null; this keeps
  // the compiler informed without a non-null assertion.
  if (box === null) throw new Error('unreachable: null bounding box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Presses Tab until the grid's single tab stop — the cursor cell — has focus. */
export async function tabToGrid(page: Page): Promise<void> {
  const origin = cellAt(page, 0, 0)
  // The stops before the grid are the home link, the language picker, the
  // palette (one stop, roving) and the toolbar. Counting them here would
  // make this break every time the page grows a control, so it walks until
  // it arrives and lets the assertion below report a grid Tab cannot reach.
  for (let press = 0; press < 30; press += 1) {
    if (await hasFocus(origin)) return
    await page.keyboard.press('Tab')
  }
  await expect(origin).toBeFocused()
}

function hasFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => node === document.activeElement)
}

/**
 * The shortest keystroke path to a Bell pair, for tests that need one but
 * are not about how it got there.
 *
 * `bell-pair.spec.ts` deliberately does not use this. That spec *is* the
 * milestone's definition of done, so its steps and the state between them
 * belong in the spec where they can be read, not behind a call.
 */
export async function buildBellPairByKeyboard(page: Page): Promise<void> {
  await tabToGrid(page)
  await page.keyboard.press('h')
  await page.keyboard.press('Enter')
  await page.keyboard.press('c')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
}

/* ------------------------------------------------------------------ *
 * Watching for pointer input
 * ------------------------------------------------------------------ *
 *
 * §10 requires the editor to be operable with no pointer at all, and a
 * keyboard test proves that only if it really never touches one. Asserting
 * it from the outside is unreliable — a stray `click()` added later would
 * pass unnoticed — so the page itself records every pointer event that
 * reaches it and the test reads the record back.
 *
 * `click` is deliberately not watched: a button activated by Enter fires one
 * too, and counting that as pointer input would make the guard fire on the
 * very keyboard use it exists to protect.
 */

const POINTER_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'touchstart']

interface PointerWitness {
  __qsimPointerEvents?: string[]
}

export async function watchPointerInput(page: Page): Promise<void> {
  await page.addInitScript((types: string[]) => {
    const witness = window as unknown as PointerWitness
    const seen: string[] = []
    witness.__qsimPointerEvents = seen
    for (const type of types) {
      window.addEventListener(
        type,
        (event) => {
          seen.push(event.type)
        },
        true
      )
    }
  }, POINTER_EVENTS)
}

/**
 * Every pointer event the page saw, or `null` when the witness was never
 * installed. The two are kept apart deliberately: a missing witness would
 * otherwise report "no pointer input" and the guard would pass forever after
 * quietly breaking.
 */
export function pointerInputSeen(page: Page): Promise<string[] | null> {
  return page.evaluate(
    () => (window as unknown as PointerWitness).__qsimPointerEvents ?? null
  )
}

/* ------------------------------------------------------------------ *
 * What a Bell pair looks like
 * ------------------------------------------------------------------ */

/**
 * The cell descriptions a Bell pair produces, in each shipped language.
 *
 * Written out rather than read from the catalogs on purpose. A test that
 * imported `editor.json` would compare the app's output against the same
 * file the app rendered from, and would pass just as happily if every value
 * in it were an empty string. These are the sentences a user is supposed to
 * hear; if a translation changes, that is a decision, and a decision should
 * cost a test edit.
 */
interface CanvasPhrases {
  /** Fragment of the grid's summary: three wires, two moments, two gates. */
  readonly summary: string
  readonly control: string
  readonly target: string
  readonly free: string
}

const CANVAS_PHRASES: Readonly<Record<UiLanguage, CanvasPhrases>> = {
  en: {
    summary: 'Qubits: 3. Columns: 2. Operations: 2.',
    control: 'CNOT control',
    target: 'CNOT target controlled by q0',
    free: 'free',
  },
  es: {
    summary: 'Qubits: 3. Columnas: 2. Operaciones: 2.',
    control: 'CNOT control',
    // "controlado", not "controlada": the participle follows the noun
    // "objetivo" that the segment before it contributes, and the two are
    // always read as one phrase.
    target: 'CNOT objetivo controlado por q0',
    free: 'libre',
  },
  fr: {
    summary: 'Qubits : 3. Colonnes : 2. Opérations : 2.',
    control: 'CNOT contrôle',
    target: 'CNOT cible contrôlée par q0',
    free: 'libre',
  },
}

/** `H` is notation; it reads the same in every language (D2). */
const HADAMARD = 'H'

/**
 * Asserts that the canvas shows a Bell pair: a Hadamard on q0 in the first
 * moment, and a CNOT in the second whose control is q0 and whose target is
 * q1 — with q2 and the rest of the first column untouched.
 *
 * The claim is made three ways, because the canvas makes it three ways: the
 * summary counts the operations, the grid describes each cell, and
 * `expectBellPairDrawn` checks the glyphs the SVG actually put on screen.
 */
export async function expectBellPair(
  page: Page,
  language: UiLanguage = 'en'
): Promise<void> {
  const phrases = CANVAS_PHRASES[language]

  await expect(circuitSummary(page)).toContainText(phrases.summary)

  await expect(cellAt(page, 0, 0)).toHaveAccessibleName(HADAMARD)
  await expect(cellAt(page, 0, 1)).toHaveAccessibleName(phrases.control)
  await expect(cellAt(page, 1, 1)).toHaveAccessibleName(phrases.target)

  // Nothing else was placed along the way: the wire under the Hadamard, and
  // the spare qubit the document starts with, are still empty.
  await expect(cellAt(page, 1, 0)).toHaveAccessibleName(phrases.free)
  await expect(cellAt(page, QUBITS - 1, 0)).toHaveAccessibleName(phrases.free)
  await expect(cellAt(page, QUBITS - 1, 1)).toHaveAccessibleName(phrases.free)
}

/**
 * The same circuit as a sighted user meets it: two drawn operations, an `H`
 * in a box, and a control dot sitting directly above the ⊕ it fires.
 *
 * The accessible grid and the SVG are two renderings of one `Circuit`
 * (`CircuitCanvas.tsx`), so checking only the first would leave the half
 * most users actually look at unproven.
 */
export async function expectBellPairDrawn(page: Page): Promise<void> {
  await expect(page.locator('.qsim-operations .qsim-op')).toHaveCount(2)
  await expect(page.locator('.qsim-box__label')).toHaveText([HADAMARD])

  const dot = await centreOf(page.locator('circle.qsim-control'))
  const plus = await centreOf(page.locator('circle.qsim-plus'))

  expect(dot.x, 'the control and its target share a moment').toBeCloseTo(
    plus.x,
    1
  )
  expect(dot.y, 'the control sits on the wire above its target').toBeLessThan(
    plus.y
  )
}
