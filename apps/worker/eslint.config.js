import { baseConfig } from '@qsim/config/eslint/base'

export default [
  {
    /*
     * `build.js` is outside the TypeScript project, like every build script in
     * this repo. `src/testing/fake-child.mjs` is outside it deliberately too:
     * it is forked by the pool tests as a real child process, and a child
     * process is started by Node with no Vitest transform in front of it — so
     * it has to be JavaScript that Node can run as it stands. See its own
     * header.
     */
    ignores: ['build.js', 'src/testing/fake-child.mjs'],
  },
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    ignores: ['src/env.ts', 'src/worker.ts', 'src/simulate.child.ts'],
    rules: {
      /*
       * The same rule `apps/api` applies, for the same reason: configuration is
       * parsed once, in `env.ts`, and every other module receives the validated
       * object. A module that reads `process.env` directly has an input nothing
       * validated, so its failure is a surprise at job time rather than a
       * refusal to boot.
       *
       * `simulate.child.ts` is exempt because it *is* a process entry point —
       * it reads `process.on`, `process.send` and `process.exit`, which is the
       * whole of its job.
       */
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'Read configuration from the validated WorkerEnv object instead. ' +
            'process.env is parsed once, in src/env.ts.',
        },
      ],
    },
  },
]
