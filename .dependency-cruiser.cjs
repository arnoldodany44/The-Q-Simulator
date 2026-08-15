/**
 * Package boundary rules — specification §12.3.
 *
 * These four rules are the difference between a monorepo and a pile of
 * folders. In a monorepo the violations creep in silently: an import that
 * "just works" locally because everything resolves, and then the shared
 * engine can no longer run in a Web Worker because someone reached for
 * `fs`. Enforcing them in CI is the only way they hold.
 *
 * Run with: pnpm boundaries
 */
module.exports = {
  forbidden: [
    {
      name: 'packages-no-apps',
      severity: 'error',
      comment:
        'A shared package must never import from an app. If a package needs ' +
        'something an app has, that something is in the wrong place — move it ' +
        'down into a package.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'web-no-db',
      severity: 'error',
      comment:
        'The frontend talks to the API, never to Postgres. Importing the db ' +
        'package into the browser bundle would ship the Prisma client and, ' +
        'worse, imply database credentials exist client-side.',
      from: { path: '^apps/web/' },
      to: { path: '^packages/db/' },
    },
    {
      name: 'apps-are-independent',
      severity: 'error',
      comment:
        'Apps never import each other. Shared logic between api and worker ' +
        'belongs in a package.',
      from: { path: '^apps/([^/]+)/' },
      to: {
        path: '^apps/([^/]+)/',
        pathNot: '^apps/$1/',
      },
    },
    {
      name: 'qsim-is-portable',
      severity: 'error',
      comment:
        'The simulation engine must produce identical results in a browser ' +
        'Web Worker and in a Node process, so it may not touch Node builtins. ' +
        'Its tsconfig sets "types": [] to catch this at compile time too; ' +
        'this rule catches explicit imports.',
      from: { path: '^packages/qsim/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'qsim-has-no-dependencies',
      severity: 'error',
      comment:
        'The engine is dependency-free by design (§12.3). Zero dependencies ' +
        'is what makes it extractable to its own public package later.',
      from: { path: '^packages/qsim/src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'] },
    },
    {
      name: 'landing-carries-no-editor',
      severity: 'error',
      comment:
        'The landing page is the entry chunk (M0.9b): App.tsx keeps it out of ' +
        'the lazy editor split precisely so that it paints on the first round ' +
        'trip. One import is all it takes to undo that — reaching into the ' +
        'document store pulls Zustand and Zundo, into the canvas pulls ' +
        'dnd-kit, into @qsim/schema pulls Zod, into circuit-url pulls fflate ' +
        '— and the damage is invisible in every test, showing up only as a ' +
        'slower page. So the landing may reach exactly one module of the ' +
        'editor, `geometry.ts`, which is pure arithmetic and is what keeps ' +
        'the demo diagram and the editor canvas drawing the same wires. ' +
        'Type-only imports are exempt: they are erased before a byte is ' +
        'bundled, which is why the demo circuits are typed as `Circuit` ' +
        'while their schema version is a local constant.',
      from: {
        path: '^apps/web/src/(routes/landing\\.tsx$|features/landing/)',
        pathNot: '\\.test\\.tsx?$',
      },
      to: {
        path: [
          '^packages/schema/',
          '^apps/web/src/lib/circuit-url\\.ts$',
          '^apps/web/src/features/circuit-editor/(?!geometry\\.ts$)',
        ],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular imports break tree shaking and confuse module init order.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A module nothing imports is usually dead code left behind.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)(eslint|vite|vitest|turbo)\\.config\\.(js|ts)$',
          '(^|/)main\\.tsx$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      /*
       * `development` leads the list on purpose. The workspace packages
       * export declarations under `types` and their sources under
       * `development`/`default`, and `exclude` drops `dist/` from the graph
       * — so resolving them through `types` would make every app→package
       * edge point at an excluded file and quietly disappear, taking the
       * boundary rules with it. What we want to cruise is what actually
       * gets bundled, which is the source.
       */
      conditionNames: [
        'development',
        'import',
        'require',
        'node',
        'default',
        'types',
      ],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
