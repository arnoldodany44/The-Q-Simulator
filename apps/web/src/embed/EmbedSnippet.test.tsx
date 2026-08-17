import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enEmbed from '../i18n/locales/en/embed.json'
import esEmbed from '../i18n/locales/es/embed.json'
import frEmbed from '../i18n/locales/fr/embed.json'
import { EmbedSnippet } from './EmbedSnippet'
import { buildSnippet, suggestedFrameHeight } from './snippet'

/**
 * The control a teacher actually uses.
 *
 * Two things are worth pinning here and neither is about layout. The first is
 * ESCAPING: a circuit title is arbitrary text and the snippet is a string
 * *for copying out of React*, so it has to escape itself — a title with a
 * quotation mark would otherwise close the attribute and continue as markup
 * in somebody else's page. The second is the visibility gate: a snippet for a
 * PRIVATE circuit would render "this circuit is not available" inside a blog
 * post, which is a worse way to tell an author than a sentence here.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['embed'],
    defaultNS: 'embed',
    resources: {
      en: { embed: enEmbed },
      es: { embed: esEmbed },
      fr: { embed: frEmbed },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function draw(
  overrides: Partial<Parameters<typeof EmbedSnippet>[0]> = {},
  language: Language = 'en'
) {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <EmbedSnippet
        slug="V1StGXR8Z5jdHi6B"
        title="Bell pair"
        qubitCount={2}
        visibility="PUBLIC"
        origin="https://qsim.test"
        {...overrides}
      />
    </I18nextProvider>
  )
}

function markup(): string {
  return screen.getByRole<HTMLTextAreaElement>('textbox').value
}

describe('the markup a teacher pastes', () => {
  it('points at the embed route on this origin', () => {
    draw()
    expect(markup()).toContain(
      'src="https://qsim.test/embed/c/V1StGXR8Z5jdHi6B'
    )
  })

  it('pins the language the teacher is reading in', () => {
    // An embed sits inside a page written in one language, so the frame must
    // not detect the *reader's*. See `embed/paths.ts`.
    draw({}, 'fr')
    expect(markup()).toContain('lang=fr')
  })

  it('titles the frame, which is an accessibility requirement', () => {
    // WCAG 4.1.2: a frame with no title is announced as "frame", and six of
    // them in an article are announced as six frames.
    draw()
    expect(markup()).toContain('title="Bell pair"')
  })

  it('defers frames below the fold, which is the whole "six is cheap" claim', () => {
    draw()
    expect(markup()).toContain('loading="lazy"')
  })

  it('links back from the caption rather than only from inside the frame', () => {
    /*
     * A link in the parent page is an ordinary link in a document the teacher
     * controls, and it survives a strict `sandbox` — one inside the frame
     * needs `allow-popups` to open anything.
     */
    draw()
    expect(markup()).toContain(
      '<a href="https://qsim.test/c/V1StGXR8Z5jdHi6B">'
    )
  })
})

describe('escaping', () => {
  it('cannot be broken out of by a title', () => {
    const hostile = '" onload="alert(1)'
    draw({ title: hostile })

    const text = markup()
    expect(text).not.toContain('onload="alert(1)"')
    expect(text).toContain('&quot;')
  })

  it('escapes the three characters that matter, in both positions', () => {
    const snippet = buildSnippet({
      url: 'https://qsim.test/embed/c/abc',
      page: 'https://qsim.test/c/abc',
      title: '<script>&"',
      height: 400,
      credit: 'made with <3',
    })

    expect(snippet).toContain('title="&lt;script&gt;&amp;&quot;"')
    expect(snippet).toContain('made with &lt;3')
    expect(snippet).not.toMatch(/<script>/)
  })
})

describe('which circuits get a snippet', () => {
  it.each(['PUBLIC', 'UNLISTED'])('offers one for %s', (visibility) => {
    draw({ visibility })
    expect(screen.getByRole('textbox')).not.toBeNull()
  })

  it('refuses a PRIVATE circuit and says what to change', () => {
    draw({ visibility: 'PRIVATE' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/Only public circuits/)).not.toBeNull()
  })
})

describe('copying', () => {
  it('reports success', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    })
    draw()

    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('Markup copied.')).not.toBeNull()
  })

  it('falls back to the field when the clipboard refuses', async () => {
    /*
     * `navigator.clipboard` is absent over plain HTTP and refusable by
     * permission at any moment. The field beside the button is the path that
     * always works, so the failure message points at it rather than
     * apologising.
     */
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(() => Promise.reject(new Error('denied'))),
      },
    })
    draw()

    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(/Ctrl\+C/)).not.toBeNull()
  })
})

describe('the suggested height', () => {
  it('grows with the register, because both halves of the frame do', () => {
    // A cross-origin frame cannot size itself — that needs `postMessage`
    // between two origins, which is the channel an embed should not open — so
    // the number is an estimate the teacher can adjust.
    expect(suggestedFrameHeight(4)).toBeGreaterThan(suggestedFrameHeight(1))
  })

  it('stops growing once the histogram stops adding bars', () => {
    // The chart draws at most 32 basis states (§3.2), so past five qubits
    // only the diagram grows and the estimate must not run away.
    const difference = suggestedFrameHeight(12) - suggestedFrameHeight(11)
    expect(difference).toBeLessThan(100)
  })
})

describe('the three languages (D2)', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders %s without a raw key',
    (language) => {
      const { container } = draw({}, language)

      const leaves = [...container.querySelectorAll('*')]
        .filter((element) => element.children.length === 0)
        .map((element) => (element.textContent ?? '').trim())
      expect(
        leaves.filter((text) => /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/.test(text))
      ).toEqual([])
    }
  )
})
