/**
 * The manual language switch of decision D2.
 *
 * It lives in its own component because every page needs it and none of them
 * should own it: the preference is persisted by the detector (see
 * `i18n/index.ts`), so a user who switches to French on the landing page
 * arrives in the editor in French, and a second copy of this logic would be
 * a second place for that to stop being true.
 *
 * The language names are deliberately written in their own language —
 * `Español`, not `Spanish` — which is why they are identical in all three
 * catalogs. Someone who cannot read the current interface still has to be
 * able to find their way out of it.
 */

import { useTranslation } from 'react-i18next'

import {
  SUPPORTED_LANGUAGES,
  changeLanguage,
  resolveLanguage,
  type SupportedLanguage,
} from '../i18n'

export function LanguagePicker() {
  const { t, i18n } = useTranslation('common')
  const active = resolveLanguage(i18n.language)

  return (
    <label className="language-picker">
      <span>{t('language.label')}</span>
      <select
        value={active}
        onChange={(event) => {
          // A rejected switch leaves the control showing the language that is
          // actually rendered, because `value` is derived from `i18n.language`
          // rather than held here — so the select snaps back rather than
          // lying. Reported rather than swallowed: silence here looks exactly
          // like a control that does nothing.
          void changeLanguage(event.target.value as SupportedLanguage).catch(
            (cause: unknown) => {
              console.error('the language could not be switched', cause)
            }
          )
        }}
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {t(`language.${language}`)}
          </option>
        ))}
      </select>
    </label>
  )
}
