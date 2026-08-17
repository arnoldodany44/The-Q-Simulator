import { baseConfig } from '@qsim/config/eslint/base'

export default [
  /*
   * The wasm-pack driver, like `apps/api/build.js` and every `*.config.js` in
   * this repo, is outside the TypeScript project. Type-aware linting has
   * nothing to say about a file whose whole job is to shell out to `cargo`,
   * and putting it in `tsconfig.json` would add it to the program this
   * package is typechecked as.
   */
  { ignores: ['scripts/**', 'pkg/**', 'crate/**'] },
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
]
