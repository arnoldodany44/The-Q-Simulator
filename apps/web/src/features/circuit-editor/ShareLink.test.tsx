import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { ShareLink } from './ShareLink'
import type { CircuitUrlView } from './useCircuitUrl'

/**
 * The copy control. Its job is small and its failure modes are not: the
 * clipboard API is absent over plain HTTP and refusable by permission at any
 * moment, so the assertions below are mostly about what happens when it does
 * not work — the field beside the button is the path that always does.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'execCommand')
})

type Language = 'en' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['editor'],
    defaultNS: 'editor',
    resources: { en: { editor: enEditor }, fr: { editor: frEditor } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function viewOf(overrides: Partial<CircuitUrlView> = {}): CircuitUrlView {
  return {
    link: 'https://example.test/new?c=PAYLOAD',
    tooLarge: false,
    rejected: null,
    dismiss: vi.fn(),
    ...overrides,
  }
}

function draw(view: CircuitUrlView, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ShareLink url={view} />
    </I18nextProvider>
  )
}

/** Replaces `navigator.clipboard` for one test. */
function stubClipboard(writeText: () => Promise<void>): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText },
  })
}

/**
 * Installs `document.execCommand`, which jsdom does not implement at all —
 * so it cannot be spied on and has to be defined outright. Deleted again in
 * `afterEach`, because a global that only exists inside one test is a global
 * the next test must not inherit.
 */
function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => result)
  Object.defineProperty(document, 'execCommand', {
    value: exec,
    configurable: true,
    writable: true,
  })
  return exec
}

describe('the link field', () => {
  it('shows the link, ready to select', () => {
    draw(viewOf())
    const field = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Link to this circuit',
    })
    expect(field.value).toBe('https://example.test/new?c=PAYLOAD')
    expect(field.readOnly).toBe(true)
  })

  it('selects the whole link when it takes focus', () => {
    draw(viewOf())
    const field = screen.getByRole<HTMLInputElement>('textbox')
    fireEvent.focus(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
  })

  it('is empty and the button is off when there is nothing to share', () => {
    draw(viewOf({ link: null }))
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('')
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Copy link' })
        .disabled
    ).toBe(true)
  })
})

describe('copying', () => {
  it('reports success', async () => {
    stubClipboard(() => Promise.resolve())
    draw(viewOf())

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByText('Link copied.')).toBeDefined()
  })

  it('reports a refusal instead of failing silently', async () => {
    // A denied permission, a page served over http, an embedded webview: the
    // reader has to be told to use the field, not left with a button that
    // appears to do nothing.
    stubClipboard(() => Promise.reject(new Error('denied')))
    stubExecCommand(false)
    draw(viewOf())

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(
      await screen.findByText(/The link could not be copied/)
    ).toBeDefined()
  })

  it('falls back to the selection when the clipboard API is missing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const exec = stubExecCommand(true)
    draw(viewOf())

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect(await screen.findByText('Link copied.')).toBeDefined()
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('stops claiming the link was copied once the link changes', async () => {
    stubClipboard(() => Promise.resolve())
    const { rerender } = draw(viewOf())

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await screen.findByText('Link copied.')).toBeDefined()

    rerender(
      <I18nextProvider i18n={i18nFor('en')}>
        <ShareLink url={viewOf({ link: 'https://example.test/new?c=OTHER' })} />
      </I18nextProvider>
    )

    expect(screen.queryByText('Link copied.')).toBeNull()
  })
})

describe('what cannot be shared, and what did not open', () => {
  it('says when the circuit is past what a link can carry', () => {
    draw(viewOf({ link: null, tooLarge: true }))
    expect(
      screen.getByText('This circuit is too large to fit in a link.')
    ).toBeDefined()
  })

  it('raises the refusal of an incoming link as an alert', () => {
    draw(viewOf({ rejected: 'not-a-circuit' }))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('does not match the format')
  })

  it('can be dismissed', () => {
    const dismiss = vi.fn()
    draw(viewOf({ rejected: 'too-large', dismiss }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalled()
  })

  it('says all of it in French too', () => {
    draw(viewOf({ rejected: 'not-deflate' }), 'fr')
    expect(screen.getByRole('button', { name: 'Copier le lien' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('abîmé')
  })
})
