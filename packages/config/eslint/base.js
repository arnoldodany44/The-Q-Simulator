import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Base flat config shared by every workspace.
 *
 * Type-aware linting is on (`projectService`), which is why the project is
 * pinned to TypeScript 6.x: typescript-eslint 8 declares support for
 * `>=4.8.4 <6.1.0` and cannot parse TypeScript 7 output.
 *
 * @param {object} options
 * @param {string} options.tsconfigRootDir Absolute path of the consuming workspace.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function baseConfig({ tsconfigRootDir }) {
  return tseslint.config(
    {
      ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.config.js'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        ecmaVersion: 2022,
        globals: { ...globals.es2021 },
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        // Unused variables are an error, but an underscore prefix opts out.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        // `import type` must be explicit — required by verbatimModuleSyntax.
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        'no-console': ['warn', { allow: ['warn', 'error'] }],
        eqeqeq: ['error', 'always', { null: 'ignore' }],
      },
    },
    {
      // Tests are allowed to be loose about non-null assertions and any.
      files: ['**/*.test.ts', '**/*.test.tsx', '**/*.bench.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
      },
    },
    prettier
  )
}
