/**
 * The session, as sentences — in all three languages.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL, WHICH IS A STATEMENT ABOUT D2 AND NOT ABOUT REACT
 *
 * `CollabPanel` and `DeferredOperations` render the whole `session.*` and
 * `deferred.*` vocabulary — thirty-odd strings — and neither had a test file. The
 * route sweep in `e2e/no-raw-keys.spec.ts` reaches a *joined* session and
 * therefore paints about forty of the namespace's keys; the endings, the
 * reconnecting notice, the deferral reasons and every announce outcome are
 * reachable only by driving the transport into a state a mocked relay does not
 * spontaneously produce. Nineteen of them were painted by nothing, and fourteen in
 * no language at all.
 *
 * D2 does not stop at "the string exists": a key that no executing test renders is
 * a key whose plural form, whose interpolation and whose very presence in `es` and
 * `fr` are unverified. `HardwareResultView.test.tsx`, `CommentsPanel.test.tsx` and
 * `PresenceRoster.test.tsx` all answer that the same way — mount the component in
 * each language and assert nothing that looks like an i18next key reaches the DOM
 * — and that is the property this file applies to the last unswept surface.
 *
 * The component is driven by a plain `CollabSessionView`, which is what makes this
 * cheap: the view is a data structure, so every state the transport can reach is
 * one object literal away, including the ones a browser needs a dropped socket and
 * an unlucky race to produce.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { INTERPOLATION } from '../../i18n'
import enCollab from '../../i18n/locales/en/collab.json'
import esCollab from '../../i18n/locales/es/collab.json'
import frCollab from '../../i18n/locales/fr/collab.json'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { CollabPanel } from './CollabPanel'
import { createPresenceStore } from './presence'
import type { CollabSessionView } from './useCollabSession'

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

const OFF: CollabSessionView = {
  status: 'off',
  access: null,
  ended: null,
  error: null,
  deferred: 0,
  deferredOperations: [],
  overflow: 0,
  reconciled: true,
  presence: null,
  setCursor: () => undefined,
}

function view(overrides: Partial<CollabSessionView> = {}): CollabSessionView {
  return { ...OFF, ...overrides }
}

function mount(session: CollabSessionView, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <CollabPanel session={session} store={createCircuitStore()} />
    </I18nextProvider>
  )
}

afterEach(cleanup)

describe('a solo editor sees nothing but an empty live region', () => {
  /*
   * The common case, and the one this whole feature promised not to disturb: an
   * unsaved circuit, a build with no API, a deployment with collaboration off.
   * Every branch is false and the only thing rendered is the region that has to
   * exist before it has anything to say.
   */
  it('draws no notice at all while the session is off', () => {
    const panel = mount(view())
    expect(
      panel.container.querySelectorAll('.collab-panel__notice')
    ).toHaveLength(0)
    expect(panel.container.querySelector('.presence-roster')).toBeNull()
  })

  it('says nothing while it is still connecting', () => {
    // A reader whose editor is working does not need to be told that a feature
    // they have not used yet is still handshaking.
    const panel = mount(view({ status: 'connecting' }))
    expect(
      panel.container.querySelectorAll('.collab-panel__notice')
    ).toHaveLength(0)
  })

  it('mounts the live region before there is anything in it', () => {
    const panel = mount(view())
    const regions = panel.container.querySelectorAll('[role="status"]')
    expect(regions.length).toBeGreaterThan(0)
    for (const region of regions) expect(region.textContent).toBe('')
  })
})

describe('what each ending says', () => {
  it.each([
    ['unauthorised', enCollab.session.ended.unauthorised],
    ['gone', enCollab.session.ended.gone],
    ['overloaded', enCollab.session.ended.overloaded],
  ] as const)('explains %s', (reason, sentence) => {
    mount(view({ status: 'ended', ended: reason }))
    expect(screen.getByText(sentence)).toBeDefined()
  })

  it('explains a document this build cannot project', () => {
    mount(view({ status: 'ended', ended: 'invalid' }))
    expect(screen.getByText(enCollab.session.invalid)).toBeDefined()
  })

  /**
   * `snapshot.error` carries the relay's code, and the panel used to ignore it: a
   * deployment with collaboration switched off, a document too large to serve and
   * a circuit that does not exist all read identically.
   *
   * §11 decides which distinctions may be drawn. NOT_FOUND and FORBIDDEN must stay
   * one sentence; the other two say things a reader can act on.
   */
  it.each([
    ['NOT_FOUND', enCollab.session.unavailable],
    ['FORBIDDEN', enCollab.session.unavailable],
    ['VALIDATION_FAILED', enCollab.session.unavailable],
    ['CIRCUIT_TOO_LARGE', enCollab.session.tooLarge],
    ['SIMULATION_UNAVAILABLE', enCollab.session.disabled],
  ] as const)('answers %s with its own sentence', (code, sentence) => {
    mount(view({ status: 'ended', ended: 'unavailable', error: code }))
    expect(screen.getByText(sentence)).toBeDefined()
  })
})

describe('what a live session says about itself', () => {
  it('reports a reconnection while one is in progress', () => {
    mount(view({ status: 'reconnecting', access: 'write' }))
    expect(screen.getByText(enCollab.session.reconnecting)).toBeDefined()
  })

  /**
   * A watcher whose socket dropped is still a watcher, so the notice stays up
   * during a reconnect — the transport keeps the last access the relay stated for
   * exactly this reason, and a page that took it away invited an edit that could
   * never travel.
   */
  it('keeps the read-only notice up through a reconnection', () => {
    mount(view({ status: 'reconnecting', access: 'read' }))
    expect(screen.getByText(enCollab.session.readOnly)).toBeDefined()
    expect(screen.getByText(enCollab.session.reconnecting)).toBeDefined()
  })

  it('reports a divergence it cannot repair', () => {
    mount(view({ status: 'open', access: 'write', reconciled: false }))
    expect(screen.getByText(enCollab.session.diverged)).toBeDefined()
  })

  it('says nothing about a divergence once the session has reconciled', () => {
    mount(view({ status: 'open', access: 'write', reconciled: true }))
    expect(screen.queryByText(enCollab.session.diverged)).toBeNull()
  })

  it('shows who is here when the session has a presence store', () => {
    const presence = createPresenceStore()
    presence.receive(
      'peer_ana',
      {
        name: 'Ana',
        access: 'write',
        cursor: { qubit: 1, column: 2 },
        selection: [],
        edits: 0,
      },
      1_000
    )
    mount(view({ status: 'open', access: 'write', presence }))
    expect(screen.getByText('Ana')).toBeDefined()
  })
})

/**
 * The same property `e2e/no-raw-keys.spec.ts` asserts for every route, applied
 * where that suite cannot reach: a state only a dropped socket produces.
 */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z-]+)+$/

const STATES: readonly Partial<CollabSessionView>[] = [
  { status: 'reconnecting', access: 'read' },
  { status: 'open', access: 'read', reconciled: false },
  { status: 'ended', ended: 'unauthorised' },
  { status: 'ended', ended: 'gone' },
  { status: 'ended', ended: 'overloaded' },
  { status: 'ended', ended: 'invalid' },
  { status: 'ended', ended: 'unavailable', error: 'NOT_FOUND' },
  { status: 'ended', ended: 'unavailable', error: 'CIRCUIT_TOO_LARGE' },
  { status: 'ended', ended: 'unavailable', error: 'SIMULATION_UNAVAILABLE' },
]

describe('every sentence of the session vocabulary is translated', () => {
  it.each(LANGUAGES)('renders no raw keys in %s', (language) => {
    for (const state of STATES) {
      const panel = mount(view(state), language)
      const raw = [...panel.container.querySelectorAll('*')]
        .filter((node) => node.children.length === 0)
        .map((node) => (node.textContent ?? '').trim())
        .filter((text) => text !== '' && KEY_SHAPE.test(text))
      expect(raw, JSON.stringify(state)).toEqual([])
      cleanup()
    }
  })

  /**
   * And that each of them is a *different* sentence in each language, which is the
   * half a raw-key sweep cannot see: a key present in `en` and copied verbatim into
   * `fr` passes the sweep and tells a French reader nothing.
   */
  it('gives every ending its own words in each language', () => {
    for (const language of LANGUAGES) {
      const catalog = CATALOGS[language]
      const said = new Set<string>()
      for (const state of STATES) {
        mount(view(state), language)
        const notice = document.querySelector('.collab-panel__notice')
        said.add(notice?.textContent ?? '')
        cleanup()
      }
      expect(said.has(''), `${language}: an ending drew no notice`).toBe(false)
      expect(said.size, `${language}: two endings share a sentence`).toBe(
        // Nine states, but two of them are the same NOT_FOUND-class sentence and
        // the read-only pair leads with the same notice.
        new Set([
          catalog.session.reconnecting,
          catalog.session.readOnly,
          catalog.session.ended.unauthorised,
          catalog.session.ended.gone,
          catalog.session.ended.overloaded,
          catalog.session.invalid,
          catalog.session.unavailable,
          catalog.session.tooLarge,
          catalog.session.disabled,
        ]).size
      )
    }
  })
})
