import globals from 'globals'
import i18next from 'eslint-plugin-i18next'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

import { baseConfig } from './base.js'

/**
 * Flat config for the React app.
 *
 * The `i18next/no-literal-string` rule is the enforcement half of decision D2
 * (trilingual UI from day one). Without it, a hardcoded string slips in, the
 * three catalogs drift, and nothing fails until a user sees English text in
 * the French UI. With it, the drift is a build error.
 *
 * @param {object} options
 * @param {string} options.tsconfigRootDir Absolute path of the consuming workspace.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function reactConfig({ tsconfigRootDir }) {
  return [
    ...baseConfig({ tsconfigRootDir }),
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        globals: { ...globals.browser },
      },
      plugins: {
        'react-hooks': reactHooks,
        'react-refresh': reactRefresh,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
        'react-refresh/only-export-components': [
          'warn',
          { allowConstantExport: true },
        ],
      },
    },
    {
      // User-facing surface only. Config, tests and the i18n catalogs
      // themselves are exempt.
      files: ['src/**/*.tsx'],
      ignores: ['src/**/*.test.tsx'],
      plugins: { i18next },
      rules: {
        'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }],
      },
    },
  ]
}
