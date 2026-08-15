import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  authError,
  createFakeAuth,
} from '../features/auth/testing.js'
import type { FakeAuthPort } from '../features/auth/testing.js'
import enAuth from '../i18n/locales/en/auth.json'
import enCommon from '../i18n/locales/en/common.json'
import esAuth from '../i18n/locales/es/auth.json'
import esCommon from '../i18n/locales/es/common.json'
import frAuth from '../i18n/locales/fr/auth.json'
import frCommon from '../i18n/locales/fr/common.json'
import { RequestPasswordResetRoute } from './reset-password'

/**
 * The screen that must not answer a question.
 *
 * "We sent you a link" for a registered address and "no account with that
 * email" for an unregistered one is a membership oracle: an attacker with a
 * list of addresses learns which of them have accounts here, one unauthenticated
 * request at a time. The property is kept by *not branching*, so the test that
 * matters compares two runs with different addresses and asserts the answer is
 * the same sentence with the address swapped in.
 *
 * A *failure* is shown only when it cannot possibly depend on the address —
 * an unreachable network, no auth project, a string the server calls
 * malformed. Everything else renders the confirmation, and the tests below say
 * why: measured against the live project, a rate-limit refusal is reachable
 * only for an address that has an account, so rendering it turned this screen
 * into the oracle its own copy promises it is not.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

const CATALOGS = {
  en: { auth: enAuth, common: enCommon },
  es: { auth: esAuth, common: esCommon },
  fr: { auth: frAuth, common: frCommon },
} as const

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['auth', 'common'],
    defaultNS: 'auth',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function open(auth: FakeAuthPort, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/reset-password']}>
            <RequestPasswordResetRoute />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

/**
 * The whitespace normalisation Testing Library applies to the DOM, applied to
 * the expected string as well.
 *
 * French sets U+00A0 before ':', ';', '!' and '?' — the catalogs carry it and
 * `locale-parity.test.ts` insists on it — and `\s` matches it, so the DOM text
 * arrives here with an ordinary space while the catalog string still has the
 * non-breaking one. Comparing them raw fails on French and only on French.
 */
function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Asks for a link, and answers with the confirmation that came back. */
async function ask(
  address: string,
  language: Language = 'en',
  auth: FakeAuthPort = createFakeAuth({ settled: null })
) {
  const catalog = CATALOGS[language].auth
  open(auth, language)
  fireEvent.change(screen.getByLabelText(catalog.fields.email), {
    target: { value: address },
  })
  fireEvent.click(screen.getByRole('button', { name: catalog.reset.submit }))
  const privacy = await screen.findByText(normalized(catalog.reset.privacy))
  const text = normalized(privacy.parentElement?.textContent ?? '')
  return { auth, text }
}

describe('the confirmation', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'is the same for a registered and an unregistered address in "%s"',
    async (language) => {
      const registered = await ask('ada@example.test', language)
      cleanup()
      const unknown = await ask('nobody@example.test', language)

      // Identical once the address is taken out: no branch, so nothing to read.
      const template = (text: string, address: string) =>
        text.replace(address, '{{email}}')
      expect(template(registered.text, 'ada@example.test')).toBe(
        template(unknown.text, 'nobody@example.test')
      )
    }
  )

  it('is phrased conditionally, and says why', async () => {
    const { text } = await ask('ada@example.test')

    // "If an account exists for …" — the wording carries the same promise the
    // absence of a branch does, for the reader who is wondering.
    expect(text).toContain(enAuth.reset.privacy)
    expect(text).toContain('ada@example.test')
  })

  it('replaces the form, so there is nothing to submit twice', async () => {
    await ask('ada@example.test')
    expect(screen.queryByLabelText('Email address')).toBeNull()
  })
})

describe('the request itself', () => {
  it('points the emailed link at the screen that can complete it', async () => {
    const { auth } = await ask('ada@example.test')

    expect(auth.calls.resetPasswordForEmail).toEqual([
      {
        email: 'ada@example.test',
        redirectTo: 'https://qsim.test/update-password',
      },
    ])
  })
})

describe('the form', () => {
  it('is labelled, and asks a password manager for an address rather than a login', () => {
    open(createFakeAuth({ settled: null }))

    const email = screen.getByLabelText('Email address')
    expect(email.getAttribute('type')).toBe('email')
    // `email`, not `username`: there is no password field here to pair with.
    expect(email.getAttribute('autocomplete')).toBe('email')
  })

  it('catches an address that is obviously not one, before sending', async () => {
    const auth = createFakeAuth({ settled: null })
    open(auth)
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))

    const email = screen.getByLabelText('Email address')
    await waitFor(() => {
      expect(email.getAttribute('aria-invalid')).toBe('true')
    })
    expect(document.activeElement).toBe(email)
    expect(auth.calls.resetPasswordForEmail).toHaveLength(0)
  })
})

describe('when the request cannot be made', () => {
  /**
   * Submits an address and answers with whatever the screen rendered: the
   * confirmation, or the failure alert.
   */
  async function outcomeFor(error: unknown): Promise<string> {
    const auth = createFakeAuth({ settled: null })
    auth.script.resetPasswordError = error
    open(auth)
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))

    const shown = await screen.findByText(
      (_, node) =>
        node?.textContent === enAuth.reset.privacy ||
        node?.getAttribute('role') === 'alert'
    )
    return shown.textContent ?? ''
  }

  /*
   * THE ORACLE THIS SCREEN EXISTS NOT TO BE.
   *
   * Measured against the live project: `POST /auth/v1/recover` answers an
   * address with no account `200 {}` every time, and a registered one `429
   * over_email_send_rate_limit` whenever the mail quota is spent or the
   * per-address minimum interval has not elapsed — because GoTrue only
   * consults the mail limiter on the path that actually sends a message, and
   * that path exists only for an address that has an account. Rendering the
   * failure sorted the registered addresses from the unregistered ones, one
   * request each, no credentials, while the page printed a sentence promising
   * it could not.
   */
  it.each(['over_email_send_rate_limit', 'over_request_rate_limit'])(
    'answers %s with the same confirmation an unknown address gets',
    async (code) => {
      const shown = await outcomeFor(authError(code, 429))
      expect(shown).toBe(enAuth.reset.privacy)
      cleanup()
      expect(await outcomeFor(null)).toBe(enAuth.reset.privacy)
    }
  )

  it('answers an unrecognised failure the same way, rather than guessing', async () => {
    // Fails closed: a code nobody has thought about yet cannot become an
    // oracle by default.
    expect(await outcomeFor(authError('some_future_code', 400))).toBe(
      enAuth.reset.privacy
    )
  })

  it('still reports a failure that cannot depend on the address', async () => {
    /*
     * An unreachable network is a fact about this browser, not about the
     * address, and hiding it behind "check your inbox" would tell somebody to
     * wait for a message that was never sent — with nothing they could do.
     */
    const unreachable = Object.assign(new Error('offline'), {
      name: 'AuthRetryableFetchError',
    })
    expect(await outcomeFor(unreachable)).toBe(
      enAuth.errors.NETWORK_UNREACHABLE
    )
    expect(screen.getByLabelText('Email address')).toBeDefined()
  })
})
