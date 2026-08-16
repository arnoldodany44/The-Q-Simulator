import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enExport from '../../i18n/locales/en/export.json'
import esExport from '../../i18n/locales/es/export.json'
import frExport from '../../i18n/locales/fr/export.json'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { ExportPanel } from './ExportPanel'
import { EXPORT_FORMATS } from './formats'

/**
 * The panel, from a reader's side of it: five buttons, one status line, and a
 * file that reaches the browser.
 *
 * `saveFile` is the seam that is stubbed — everything below it is checked in
 * `download.test.ts`, and letting a real anchor click happen in jsdom only
 * tests jsdom. What is asserted here is that the *right* file arrives: the
 * name, the media type, and enough of the bytes to know which format it is.
 */

vi.mock('./download', async (importOriginal) => {
  // Everything but `saveFile` stays real: the media types are asserted below
  // and a doubled constant is a constant that can be wrong.
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, saveFile: vi.fn() }
})

const { saveFile } = await import('./download')
const saved = vi.mocked(saveFile)

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['export'],
    defaultNS: 'export',
    resources: {
      en: { export: enExport },
      es: { export: esExport },
      fr: { export: frExport },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function draw(language: Language = 'en', title = 'Bell pair') {
  const store = createCircuitStore()
  store.getState().placeGate('h', [0], 0)
  render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ExportPanel store={store} title={title} />
    </I18nextProvider>
  )
  return store
}

beforeEach(() => {
  saved.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** An image that never decodes, which is what jsdom and a refusal both are. */
class FailingImage {
  private listeners = new Map<string, () => void>()

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener)
  }

  set src(_value: string) {
    queueMicrotask(() => {
      this.listeners.get('error')?.()
    })
  }
}

describe('ExportPanel', () => {
  it('offers every format in the table, each as its own button', () => {
    draw()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(EXPORT_FORMATS.length)
    // The visible label is the format name, invariant across locales (D2).
    for (const label of ['OpenQASM 3', 'Qiskit', 'JSON', 'SVG', 'PNG']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('names each button as an action, not as a noun', () => {
    draw()
    // "Download as OpenQASM 3" — the visible label is part of the accessible
    // name (WCAG 2.5.3), and the verb is what a screen reader hears first.
    expect(
      screen.getByRole('button', { name: /download as openqasm 3/i })
    ).toBeTruthy()
  })

  it('hands the browser an OpenQASM file named after the circuit', async () => {
    draw()
    fireEvent.click(
      screen.getByRole('button', { name: /download as openqasm 3/i })
    )

    await waitFor(() => {
      expect(saved).toHaveBeenCalledTimes(1)
    })
    const [filename, blob] = saved.mock.calls[0]!
    expect(filename).toBe('bell-pair.qasm')
    expect(await blob.text()).toContain('OPENQASM 3.0;')
  })

  it('exports the circuit on screen, not the one that was saved', async () => {
    const store = draw()
    act(() => {
      store.getState().placeGate('x', [0], 1)
    })

    fireEvent.click(
      screen.getByRole('button', { name: /download as openqasm 3/i })
    )
    await waitFor(() => {
      expect(saved).toHaveBeenCalled()
    })
    // The X was placed after the panel rendered and never saved to a server.
    expect(await saved.mock.calls[0]![1].text()).toContain('x q[0];')
  })

  it('draws an SVG that carries the reader’s language inside it', async () => {
    draw('fr')
    fireEvent.click(screen.getByRole('button', { name: /télécharger en svg/i }))

    await waitFor(() => {
      expect(saved).toHaveBeenCalled()
    })
    const text = await saved.mock.calls[0]![1].text()
    // The `<title>` and `<desc>` of an exported diagram are user-facing text
    // and go through the catalogs like any other (D2) — this is the one place
    // where a catalog string leaves the page.
    expect(text).toContain('Circuit quantique')
    expect(text).toContain('1 porte')
  })

  /*
   * Slower than its neighbours on purpose: 1 234 is the smallest count that
   * groups, and grouping is the whole assertion. Rendering that many gate
   * nodes through jsdom is what costs the seconds, not the formatting.
   */
  it(
    'writes the figures inside the file the way French writes numbers',
    { timeout: 30_000 },
    async () => {
      /*
       * These three used to interpolate `{{count}}` straight, which made them the
       * only figures in the product that skipped `Intl.NumberFormat` — "1234
       * portes" in a file whose reader's every other number reads "1 234". It is
       * also the figure most likely to be read with nothing beside it to correct
       * the impression, because this string travels out of the page.
       */
      const store = createCircuitStore()
      for (let column = 0; column < 1234; column += 1) {
        store.getState().placeGate('h', [0], column)
      }
      render(
        <I18nextProvider i18n={i18nFor('fr')}>
          <ExportPanel store={store} title="Long" />
        </I18nextProvider>
      )
      fireEvent.click(
        screen.getByRole('button', { name: /télécharger en svg/i })
      )

      await waitFor(() => {
        expect(saved).toHaveBeenCalled()
      })
      const text = await saved.mock.calls[0]![1].text()
      /*
       * The group separator is ICU's to choose and it has moved before (see
       * `format.ts` on the minus sign), so the class is written as escapes
       * rather than as the character itself: U+202F today, U+00A0 in older
       * data, and an ordinary space if it ever changes again. What is being
       * asserted is that the thousands are *grouped*, not which glyph groups
       * them.
       */
      expect(text).toMatch(/1[\u202f\u00a0\s]234 portes/)
      expect(text).not.toContain('1234 portes')
    }
  )

  it('says what it handed over, in a live region', async () => {
    draw()
    fireEvent.click(screen.getByRole('button', { name: /download as json/i }))
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('bell-pair.json')
    })
  })

  it('reports a failure without losing anything', async () => {
    // A browser that cannot render the SVG into an image — jsdom is one, and
    // so is any engine that refuses the decode. The PNG is the only export
    // with a failure path a user can actually meet.
    vi.stubGlobal('Image', FailingImage)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    draw()

    fireEvent.click(screen.getByRole('button', { name: /download as png/i }))
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'could not be created'
      )
    })
    expect(saved).not.toHaveBeenCalled()
    // Every button is usable again: nothing about the document changed.
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it('falls back to a generic file name for an untitled circuit', async () => {
    draw('en', '')
    fireEvent.click(screen.getByRole('button', { name: /download as json/i }))
    await waitFor(() => {
      expect(saved).toHaveBeenCalled()
    })
    expect(saved.mock.calls[0]![0]).toBe('circuit.json')
  })

  it.each(['en', 'es', 'fr'] as const)(
    'has a description for every format in %s',
    (language) => {
      draw(language)
      const rendered = document.body.textContent ?? ''
      // A raw key would render as `formats.qasm3`; a missing translation would
      // render the English one, which the catalogs' own parity test cannot see
      // and this can, because the sentences differ per language.
      expect(rendered).not.toContain('formats.')
      expect(rendered).not.toContain('status.')
      const catalog = { en: enExport, es: esExport, fr: frExport }[language]
      for (const format of EXPORT_FORMATS) {
        expect(rendered).toContain(catalog.formats[format])
      }
    }
  )
})
