/**
 * What the document holds and the canvas does not, in three languages — and the
 * two accessibility properties the panel has to satisfy to be worth having.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE PANEL NEEDS A TEST FILE OF ITS OWN
 *
 * `deferred.*` is nineteen strings and the route sweep in
 * `e2e/no-raw-keys.spec.ts` paints five of them: the rest need a merge that
 * conflicts in a particular way, a list longer than the ceiling, an overflowing
 * document, or a button press. Fourteen were rendered by no test in any language.
 *
 * The two behaviours asserted below are the ones a browser run found and no unit
 * test could have:
 *
 *   1. **The live region exists before it speaks.** A `role="status"` inserted into
 *      the DOM together with its first content is frequently never announced, so
 *      "your gate was held back" — the sentence this whole panel exists to deliver
 *      — was the one sentence nobody heard.
 *   2. **A successful repair does not drop focus.** The press removes the row the
 *      button was in, and `document.body` is a dozen controls above where a
 *      keyboard reader was.
 */

import type { DeferredOperation } from '@qsim/collab'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCircuit, type Circuit } from '@qsim/schema'

import { INTERPOLATION } from '../../i18n'
import enCollab from '../../i18n/locales/en/collab.json'
import esCollab from '../../i18n/locales/es/collab.json'
import frCollab from '../../i18n/locales/fr/collab.json'
import {
  createCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import { DeferredOperations, MAX_LISTED_DEFERRALS } from './DeferredOperations'

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enCollab> = {
  en: enCollab,
  es: esCollab,
  fr: frCollab,
}

const LANGUAGES = ['en', 'es', 'fr'] as const

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['collab'],
    defaultNS: 'collab',
    resources: {
      en: { collab: CATALOGS.en },
      es: { collab: CATALOGS.es },
      fr: { collab: CATALOGS.fr },
    },
    // The app's own interpolation, so the instance behaves as the product does.
    interpolation: { ...INTERPOLATION },
    react: { useSuspense: false },
  })
  return instance
}

/** A circuit with one gate at (q0, column 0), which is what blocks the rest. */
function circuit(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 2,
    clbits: 1,
    operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
  })
}

function storeWith(open: Circuit = circuit()): CircuitStore {
  const store = createCircuitStore()
  store.getState().loadCircuit(open)
  return store
}

function deferral(
  overrides: Partial<DeferredOperation> = {}
): DeferredOperation {
  return {
    slot: 'slot_a',
    reason: 'column-conflict',
    blockedBy: ['op_1'],
    operation: { id: 'op_9', gate: 'x', targets: [0], column: 0 },
    ...overrides,
  }
}

interface MountOptions {
  readonly entries?: readonly DeferredOperation[]
  readonly overflow?: number
  readonly canEdit?: boolean
  readonly store?: CircuitStore
  readonly language?: Language
}

function mount(options: MountOptions = {}) {
  const {
    entries = [],
    overflow = 0,
    canEdit = true,
    store = storeWith(),
    language = 'en',
  } = options
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <DeferredOperations
        entries={entries}
        overflow={overflow}
        store={store}
        canEdit={canEdit}
      />
    </I18nextProvider>
  )
}

function region(): HTMLElement | null {
  return document.querySelector('.deferred-panel__status')
}

afterEach(cleanup)

describe('the ordinary session, where nothing conflicts', () => {
  it('draws no chrome at all', () => {
    const view = mount()
    expect(view.container.querySelector('.deferred-panel__heading')).toBeNull()
    expect(view.container.querySelector('.deferred-panel__list')).toBeNull()
    expect(
      view.container.querySelector('.deferred-panel--quiet')
    ).not.toBeNull()
  })

  /**
   * THE REQUIREMENT THAT MADE THIS FILE NECESSARY.
   *
   * The panel used to return `null` while quiet, so the region and its first
   * sentence entered the DOM in one commit and the announcement was lost. It is
   * mounted from the first render, empty, and only its child changes.
   */
  it('mounts the live region empty, before it has anything to say', () => {
    mount()
    expect(region()).not.toBeNull()
    expect(region()?.textContent).toBe('')
  })

  /**
   * The group's name, which a raw-key sweep cannot see because it is an
   * `aria-label` rather than text — and it is the only thing a keyboard reader
   * hears when a repair sends focus here.
   */
  it.each(LANGUAGES)('names the group it sends focus to, in %s', (language) => {
    const view = mount({ language })
    expect(
      view.container
        .querySelector('.deferred-panel')
        ?.getAttribute('aria-label')
    ).toBe(CATALOGS[language].deferred.label)
  })
})

describe('what the panel says about a held-back operation', () => {
  it('names the gate, the cell it wanted and the reason', () => {
    const view = mount({ entries: [deferral()] })

    expect(
      view.container.querySelector('.deferred-panel__heading')?.textContent
    ).toBe(enCollab.deferred.heading_one.replace('{{formatted}}', '1'))
    expect(screen.getByText(enCollab.deferred.hint)).toBeDefined()
    expect(
      screen.getByText(
        enCollab.deferred.wanted
          .replace('{{qubit}}', '0')
          .replace('{{column}}', '0')
      )
    ).toBeDefined()
    expect(
      screen.getByText(enCollab.deferred.reason['column-conflict'])
    ).toBeDefined()
  })

  it.each([
    ['clbit-in-use', enCollab.deferred.reason['clbit-in-use']],
    ['out-of-register', enCollab.deferred.reason['out-of-register']],
    ['malformed', enCollab.deferred.reason.malformed],
    ['invalid', enCollab.deferred.reason.invalid],
  ] as const)('explains %s in words', (reason, sentence) => {
    mount({ entries: [deferral({ reason, blockedBy: [] })] })
    expect(screen.getByText(sentence)).toBeDefined()
  })

  it('says an unreadable slot is unreadable rather than guessing', () => {
    mount({
      entries: [
        deferral({ reason: 'malformed', blockedBy: [], operation: undefined }),
      ],
    })
    expect(screen.getByText(enCollab.deferred.unreadable)).toBeDefined()
    expect(screen.getByText(enCollab.deferred.unresolvable)).toBeDefined()
  })

  it('counts the ones it does not list', () => {
    const entries = Array.from({ length: MAX_LISTED_DEFERRALS + 3 }, (_, at) =>
      deferral({ slot: `slot_${String(at)}`, blockedBy: [] })
    )
    const view = mount({ entries })

    expect(
      view.container.querySelectorAll('.deferred-panel__entry')
    ).toHaveLength(MAX_LISTED_DEFERRALS)
    expect(
      view.container.querySelector('.deferred-panel__more')?.textContent
    ).toBe(enCollab.deferred.more_other.replace('{{formatted}}', '3'))
  })

  it('reports slots past what one circuit can hold', () => {
    const view = mount({ overflow: 4 })
    expect(
      view.container.querySelector('.deferred-panel__overflow')?.textContent
    ).toBe(enCollab.deferred.overflow_other.replace('{{formatted}}', '4'))
  })
})

describe('the two buttons, and who gets them', () => {
  it('offers the reveal and the repair to a writer', () => {
    mount({ entries: [deferral()] })
    expect(
      screen.getByRole('button', { name: enCollab.deferred.reveal })
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: enCollab.deferred.makeRoom })
    ).toBeDefined()
  })

  it('offers only the reveal to a watcher', () => {
    // A drawing decision, never a permission: §11 puts authorisation on the relay,
    // which refuses the update whatever this page drew.
    mount({ entries: [deferral()], canEdit: false })
    expect(
      screen.queryByRole('button', { name: enCollab.deferred.makeRoom })
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: enCollab.deferred.reveal })
    ).toBeDefined()
  })

  it('offers widening for an operation outside the register', () => {
    mount({
      entries: [
        deferral({
          reason: 'out-of-register',
          blockedBy: [],
          operation: { id: 'op_9', gate: 'x', targets: [5], column: 2 },
        }),
      ],
    })
    expect(
      screen.getByRole('button', { name: enCollab.deferred.widen })
    ).toBeDefined()
  })

  it('selects the blocker and says that it did', () => {
    const store = storeWith()
    mount({ entries: [deferral()], store })

    act(() => {
      screen.getByRole('button', { name: enCollab.deferred.reveal }).click()
    })

    expect(store.getState().selection).toEqual(['op_1'])
    expect(region()?.textContent).toBe(enCollab.deferred.announce.revealed_one)
  })

  it('says so when what was holding it has already gone', () => {
    const store = storeWith()
    mount({ entries: [deferral({ blockedBy: ['op_gone'] })], store })

    act(() => {
      screen.getByRole('button', { name: enCollab.deferred.reveal }).click()
    })

    expect(region()?.textContent).toBe(enCollab.deferred.announce.gone)
  })

  /**
   * THE OTHER REQUIREMENT THAT MADE THIS FILE NECESSARY.
   *
   * The repair empties the list — the panel is handed its entries by the session,
   * which recomputes them from the document — so the row and its button are gone
   * in the same commit that announces success. `CommentThreadView` states the rule
   * this project follows about focus and a control that stops existing; the panel
   * moves focus to itself, which is labelled and holds the region that speaks.
   */
  it('keeps focus in the panel after a repair, and says what happened', () => {
    const store = storeWith()
    mount({ entries: [deferral()], store })

    const button = screen.getByRole('button', {
      name: enCollab.deferred.makeRoom,
    })
    act(() => {
      button.focus()
      button.click()
    })

    // The edit really happened: everything at column 0 moved right.
    expect(store.getState().circuit.operations[0]?.column).toBe(1)
    expect(region()?.textContent).toBe(enCollab.deferred.announce.madeRoom)
    expect(document.activeElement).not.toBe(document.body)
    expect((document.activeElement as HTMLElement | null)?.className).toContain(
      'deferred-panel'
    )
  })

  it('keeps focus on the reveal, which does not remove itself', () => {
    mount({ entries: [deferral()] })
    const button = screen.getByRole('button', {
      name: enCollab.deferred.reveal,
    })
    act(() => {
      button.focus()
      button.click()
    })
    expect(document.activeElement).toBe(button)
  })

  /**
   * The "the document changed under us" path, which is reachable and not
   * theoretical: the deferral names a column, the peer that was blocking it has
   * since moved or deleted the blocker, and there is now nothing at that column
   * to push right. `makeRoom` moves nothing, reports false, and the panel says so
   * rather than claiming a repair it did not make.
   */
  it('says so when there is no longer anything to make room from', () => {
    const store = storeWith()
    mount({
      entries: [
        deferral({
          blockedBy: [],
          operation: { id: 'op_9', gate: 'x', targets: [0], column: 5 },
        }),
      ],
      store,
    })

    act(() => {
      screen.getByRole('button', { name: enCollab.deferred.makeRoom }).click()
    })

    expect(region()?.textContent).toBe(enCollab.deferred.announce.refused)
    // And nothing moved, which is what makes the sentence true.
    expect(store.getState().circuit.operations[0]?.column).toBe(0)
  })
})

/**
 * The same property `e2e/no-raw-keys.spec.ts` asserts for every route, applied
 * where that suite cannot reach: a merge that conflicts five different ways.
 */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z-]+)+$/

describe('every sentence of the deferral vocabulary is translated', () => {
  it.each(LANGUAGES)('renders no raw keys in %s', (language) => {
    const entries = [
      deferral(),
      deferral({ slot: 'slot_b', reason: 'clbit-in-use' }),
      deferral({
        slot: 'slot_c',
        reason: 'out-of-register',
        blockedBy: [],
        operation: { id: 'op_7', gate: 'x', targets: [5], column: 2 },
      }),
      deferral({ slot: 'slot_d', reason: 'malformed', blockedBy: [] }),
      deferral({
        slot: 'slot_e',
        reason: 'invalid',
        blockedBy: [],
        operation: undefined,
      }),
      deferral({ slot: 'slot_f', reason: 'column-conflict' }),
      deferral({ slot: 'slot_g', reason: 'column-conflict' }),
    ]
    const view = mount({ entries, overflow: 1_234, language })

    const raw = [...view.container.querySelectorAll('*')]
      .filter((node) => node.children.length === 0)
      .map((node) => (node.textContent ?? '').trim())
      .filter((text) => text !== '' && KEY_SHAPE.test(text))
    expect(raw).toEqual([])
  })

  /**
   * §10: a figure reaches the reader through `Intl.NumberFormat`. The roster and
   * this panel used to interpolate raw numbers, so a French page showed
   * «colonne 1234» beside a timeline that said «1 234».
   */
  it('formats its figures for the reader’s locale', () => {
    const view = mount({ overflow: 1_234, language: 'fr' })
    const said = view.container.textContent ?? ''
    expect(said).toContain(new Intl.NumberFormat('fr').format(1_234))
    expect(said).not.toContain('1234')
  })

  it.each(LANGUAGES)('announces each outcome in %s', (language) => {
    for (const key of [
      'announce.revealed_one',
      'announce.gone',
      'announce.madeRoom',
      'announce.widened',
      'announce.refused',
    ] as const) {
      const path = key.split('.')
      const outcome = CATALOGS[language].deferred.announce as Record<
        string,
        string
      >
      expect(outcome[path[1] as string], `${language}: ${key}`).toBeTypeOf(
        'string'
      )
    }
    // And the panel renders one of them, in this language, for real.
    const store = storeWith()
    mount({ entries: [deferral()], store, language })
    act(() => {
      screen
        .getByRole('button', { name: CATALOGS[language].deferred.reveal })
        .click()
    })
    expect(region()?.textContent).toBe(
      CATALOGS[language].deferred.announce.revealed_one
    )
  })
})
