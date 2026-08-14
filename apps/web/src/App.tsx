import { formatKet } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import { useTranslation } from 'react-i18next'

import { Notation } from './components/Notation'
import {
  SUPPORTED_LANGUAGES,
  changeLanguage,
  resolveLanguage,
  type SupportedLanguage,
} from './i18n'

/**
 * Scaffold landing page. Its job at M0.0 is to prove the wiring works:
 * both shared workspace packages resolve from the app, and the three
 * catalogs load and switch. The real landing arrives in M0.9.
 */
export function App() {
  const { t, i18n } = useTranslation(['landing', 'common'])
  const active = resolveLanguage(i18n.language)

  return (
    <main className="page">
      <header className="page__header">
        <h1>{t('common:appName')}</h1>

        <label className="language-picker">
          <span>{t('common:language.label')}</span>
          <select
            value={active}
            onChange={(event) => {
              void changeLanguage(event.target.value as SupportedLanguage)
            }}
          >
            {SUPPORTED_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {t(`common:language.${language}`)}
              </option>
            ))}
          </select>
        </label>
      </header>

      <p className="tagline">{t('landing:tagline')}</p>
      <p>{t('landing:intro')}</p>

      <p className="notice">{t('landing:scaffoldNotice')}</p>

      <dl className="wiring-check">
        <dt>
          <Notation value="@qsim/schema" />
        </dt>
        <dd>{CIRCUIT_SCHEMA_VERSION}</dd>
        <dt>
          <Notation value="@qsim/core" />
        </dt>
        <dd>
          <Notation value={`|${formatKet(5, 3)}⟩`} />
        </dd>
      </dl>
    </main>
  )
}
