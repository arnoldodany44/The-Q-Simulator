import { act, cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import type { PresenceState } from '@qsim/contract'

import enCollab from '../../i18n/locales/en/collab.json'
import esCollab from '../../i18n/locales/es/collab.json'
import frCollab from '../../i18n/locales/fr/collab.json'
import { PresenceRoster } from './PresenceRoster'
import {
  EDIT_ANNOUNCE_QUIET_MS,
  createPresenceStore,
  type PresenceStore,
} from './presence'

/**
 * The accessible half of presence.
 *
 * What is asserted here is the part a sighted test cannot see: that the roster is a
 * list somebody can walk on demand, that the live region exists *before* it has
 * anything to say, that it says arrivals, departures and edits — and that it says
 * nothing whatsoever about a cursor moving, which is the requirement that makes the
 * feature usable rather than merely present.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enCollab> = {
  en: enCollab,
  es: esCollab,
  fr: frCollab,
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['collab'],
    defaultNS: 'collab',
    resources: {
      en: { collab: CATALOGS.en },
      es: { collab: CATALOGS.es },
      fr: { collab: CATALOGS.fr },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function state(overrides: Partial<PresenceState> = {}): PresenceState {
  return {
    name: 'Ada',
    access: 'write',
    cursor: { qubit: 0, column: 4 },
    selection: [],
    edits: 0,
    ...overrides,
  }
}

function mount(
  store: PresenceStore,
  { language = 'en', qubits = 2 }: { language?: Language; qubits?: number } = {}
) {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <PresenceRoster store={store} qubits={qubits} />
    </I18nextProvider>
  )
}

/** The live region's text, which is what a screen reader would say. */
function announcement(): string {
  const region = document.querySelector('[role="status"]')
  return region?.textContent ?? ''
}

afterEach(cleanup)

describe('a solo session', () => {
  it('shows no roster at all', () => {
    // Most sessions have one person in them, and the common case must look exactly
    // as it did before this milestone: no chrome, no list, no name.
    const store = createPresenceStore()
    mount(store)
    expect(screen.queryByRole('list')).toBeNull()
  })

  /**
   * THE DEFECT THIS PINS. A live region inserted into the DOM together with its
   * first content is frequently not announced at all — the assistive technology has
   * nothing to compare against. So the region exists from the first render, empty.
   */
  it('still mounts the live region, empty', () => {
    const store = createPresenceStore()
    mount(store)
    const region = document.querySelector('[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.textContent).toBe('')
  })
})

describe('who is here', () => {
  it('lists every peer with a name, what they are doing and where', () => {
    const store = createPresenceStore()
    mount(store)

    act(() => {
      store.receive('p1', state(), 1_000)
      store.receive(
        'p2',
        state({
          name: 'Beto',
          access: 'read',
          cursor: { qubit: 1, column: 0 },
        }),
        1_000
      )
    })

    expect(screen.getByText('2 other people are here')).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('Ada')
    expect(items[0]?.textContent).toContain('editing')
    expect(items[0]?.textContent).toContain('at qubit 0, column 4')
    // A watcher is named as one in words, not only by a hollow swatch: colour and
    // shape are both unavailable to a listener.
    expect(items[1]?.textContent).toContain('watching')
  })

  it('names the classical register rather than a wire that does not exist', () => {
    const store = createPresenceStore()
    mount(store, { qubits: 2 })
    act(() => {
      store.receive('p1', state({ cursor: { qubit: 2, column: 3 } }), 1_000)
    })

    expect(screen.getByRole('listitem').textContent).toContain(
      'at the classical register, column 3'
    )
  })

  it('says how many gates somebody is holding, in words', () => {
    // The frame carries at most eight outlines; the sentence carries the count,
    // which is the part a person actually reads.
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ selection: ['op-1', 'op-2'] }), 1_000)
    })
    expect(screen.getByRole('listitem').textContent).toContain(
      'holding 2 gates'
    )
  })

  it('has a word for somebody who never signed in', () => {
    // §3.4 admits an anonymous watcher to a PUBLIC session. The server sends a null
    // and the *word* is the client's, because D2 owns every user-facing string.
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ name: null, access: 'read' }), 1_000)
    })
    expect(screen.getByRole('listitem').textContent).toContain('Someone')
  })

  it('drops the roster again when the last peer goes', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })
    act(() => {
      store.receive('p1', null, 1_100)
    })
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('what the live region says', () => {
  it('announces an arrival', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })
    expect(announcement()).toBe('Ada is now in this circuit.')
  })

  it('announces a departure', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })
    act(() => {
      store.receive('p1', null, 1_100)
    })
    expect(announcement()).toBe('Ada has left this circuit.')
  })

  it('announces an edit, and says where', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ edits: 1 }), 1_000)
    })
    act(() => {
      store.receive(
        'p1',
        state({ edits: 2, cursor: { qubit: 1, column: 4 } }),
        1_100
      )
    })
    expect(announcement()).toBe('Ada edited at qubit 1, column 4.')
  })

  /**
   * THE REQUIREMENT. A region that spoke every cursor movement would be unusable:
   * a peer crossing a twenty-column circuit is dozens of updates, and the listener
   * would hear coordinates over everything else they were doing.
   */
  it('says nothing at all when somebody merely moves', () => {
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
    })
    const afterArrival = announcement()

    act(() => {
      for (let column = 0; column < 20; column += 1) {
        store.receive(
          'p1',
          state({ cursor: { qubit: 0, column } }),
          1_100 + column
        )
      }
      store.receive(
        'p1',
        state({ cursor: { qubit: 0, column: 19 }, selection: ['op-1'] }),
        1_200
      )
    })

    expect(announcement()).toBe(afterArrival)
    // …while the *list* has followed them, because a list interrupts nobody.
    expect(screen.getByRole('listitem').textContent).toContain(
      'at qubit 0, column 19'
    )
  })

  it('speaks twice when the same thing happens twice', () => {
    /*
     * Two identical sentences in a row render the same string, and React would leave
     * the text node untouched: no mutation, no announcement, and the second edit
     * appears not to have happened. The node is keyed on the event's sequence
     * number, which is what makes it a change the region can see.
     */
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state({ edits: 1 }), 1_000)
    })
    act(() => {
      store.receive('p1', state({ edits: 2 }), 1_100)
    })
    const first = document.querySelector('[role="status"] span')
    /*
     * Past `EDIT_ANNOUNCE_QUIET_MS`, so this is a second *edit* and not one more
     * frame of the same drag — which the store deliberately does not speak, or the
     * region would read the identical sentence eight times a second for as long as
     * somebody held a slider.
     */
    act(() => {
      store.receive('p1', state({ edits: 3 }), 1_100 + EDIT_ANNOUNCE_QUIET_MS)
    })
    const second = document.querySelector('[role="status"] span')

    expect(second?.textContent).toBe(first?.textContent)
    expect(second).not.toBe(first)
    expect(second?.textContent).not.toBe('')
  })

  it('says nothing when this tab is the one that left', () => {
    // The peers did not go anywhere; the connection did. Announcing four departures
    // would describe the wrong event to the one person who cannot see what happened.
    const store = createPresenceStore()
    mount(store)
    act(() => {
      store.receive('p1', state(), 1_000)
      store.receive('p2', state({ name: 'Beto' }), 1_000)
    })
    act(() => {
      store.clear()
    })
    expect(announcement()).toBe('')
  })
})

describe('all three languages', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders %s with no raw keys',
    (language) => {
      const store = createPresenceStore()
      mount(store, { language })
      act(() => {
        store.receive('p1', state({ selection: ['op-1'] }), 1_000)
      })

      const text = `${screen.getByRole('list').textContent ?? ''} ${announcement()}`
      expect(text).not.toContain('presence.')
      expect(text).toContain('Ada')
      expect(text).toContain('4')
    }
  )
})
