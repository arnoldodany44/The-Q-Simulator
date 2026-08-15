import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { AppRoutes } from './App'
import enCommon from './i18n/locales/en/common.json'
import enEditor from './i18n/locales/en/editor.json'
import enGates from './i18n/locales/en/gates.json'
import enLanding from './i18n/locales/en/landing.json'

/**
 * The route table, and only the route table. Each page has its own tests;
 * what is left to prove is that the two paths reach the two pages — a
 * mistake that costs nothing to make and is invisible until someone opens
 * the app.
 */

afterEach(cleanup)

function i18n(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common', 'editor', 'gates', 'landing'],
    defaultNS: 'common',
    resources: {
      en: {
        common: enCommon,
        editor: enEditor,
        gates: enGates,
        landing: enLanding,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function at(path: string) {
  return render(
    <I18nextProvider i18n={i18n()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </I18nextProvider>
  )
}

describe('routes', () => {
  it('shows the landing page at the root', () => {
    at('/')
    expect(
      screen.getByText('A quantum circuit laboratory in your browser')
    ).toBeDefined()
    expect(
      screen.getByRole('link', { name: 'Open the circuit editor' })
    ).toBeDefined()
    // The landing draws a canvas but no palette: it is not the editor.
    expect(screen.queryByRole('button', { name: 'CNOT' })).toBeNull()
  })

  it('shows the editor at /new', () => {
    at('/new')
    expect(screen.getByRole('grid', { name: 'Circuit grid' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'CNOT' })).toBeDefined()
    expect(
      screen.getByRole('toolbar', { name: 'Circuit actions' })
    ).toBeDefined()
  })
})
