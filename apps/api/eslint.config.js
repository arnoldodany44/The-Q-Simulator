import { baseConfig } from '@qsim/config/eslint/base'

export default [
  /*
   * The build script, like every `*.config.js` in this repo, is outside the
   * TypeScript project — type-aware linting has nothing to say about a file
   * that only exists to invoke esbuild, and including it in `tsconfig.json`
   * would put it in the program the API is typechecked as.
   */
  { ignores: ['build.js'] },
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    ignores: ['src/env.ts', 'src/server.ts'],
    rules: {
      /*
       * The environment is read in exactly two places: `env.ts`, which parses
       * and validates it, and `server.ts`, which hands the raw record to
       * `loadEnv` before anything else runs. Every other module receives a
       * validated `ApiEnv` object.
       *
       * The rule is not tidiness. A module that reads `process.env` directly
       * has an input nothing validated, so the failure it produces is a
       * per-request surprise rather than a refusal to boot — which is the
       * exact failure mode this milestone exists to eliminate. It also makes
       * the module untestable without mutating global state.
       */
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'Read configuration from the validated ApiEnv object instead. ' +
            'process.env is parsed once, in src/env.ts.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:process',
              message:
                'Read configuration from the validated ApiEnv object ' +
                'instead. process.env is parsed once, in src/env.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    // `src/testing/` is exempt because it does the opposite job: it *mints*
    // tokens, with a key pair it generated itself, so that the auth tests can
    // exercise the real verifier instead of mocking it.
    ignores: ['src/auth/**', 'src/testing/**'],
    rules: {
      /*
       * Token verification lives in `src/auth/` and nowhere else. A route
       * that decodes a JWT itself — even "just to read the sub for a log
       * line" — is one `decodeJwt` away from trusting an unverified claim,
       * and that mistake reads as harmless in review. Keeping the import
       * itself out of the rest of the app makes it impossible to make
       * quietly.
       */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'jose',
              message:
                'JWTs are verified in src/auth/ only. Use request.auth, ' +
                'which carries the already-verified identity.',
            },
          ],
        },
      ],
    },
  },
]
