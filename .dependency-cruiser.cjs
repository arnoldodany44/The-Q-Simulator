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
        'is what makes it extractable to its own public package later. ' +
        '`src/testing/` is exempt alongside the test files it exists for: it ' +
        'holds assertions shared between suites, imports `vitest` to make ' +
        'them, and is excluded from the build by tsconfig.build.json — so it ' +
        'is never part of what would be extracted.',
      from: {
        path: '^packages/qsim/src/',
        pathNot: ['\\.test\\.ts$', '^packages/qsim/src/testing/'],
      },
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
      name: 'db-depends-only-on-schema',
      severity: 'error',
      comment:
        'Per §12.3 the db package may reach for packages/schema and Prisma, ' +
        'and nothing else in the workspace. In particular it must not import ' +
        'packages/qsim: the engine is what validates a challenge submission, ' +
        'and if the persistence layer could run it, "the server simulates ' +
        'authoritatively" would quietly become "the database layer decides".',
      from: { path: '^packages/db/src/' },
      to: { path: '^packages/(?!db/|schema/)' },
    },
    {
      name: 'contract-depends-only-on-schema',
      severity: 'error',
      comment:
        'packages/contract is bundled into the browser, so its dependency ' +
        'list is a list of things that ship to every visitor. It may reach ' +
        'packages/schema (the circuit document is part of several request ' +
        'and response bodies) and nothing else in the workspace. In ' +
        'particular not packages/db: the whole reason this package exists is ' +
        'that apps/web may not import Prisma, and a contract that reached ' +
        'for a Prisma type would reintroduce exactly the edge the boundary ' +
        'forbids — through a package that looks harmless. Where a Postgres ' +
        'enum must be visible to both ends it is re-declared in ' +
        'src/visibility.ts and apps/api asserts the two agree.',
      from: { path: '^packages/contract/src/' },
      to: { path: '^packages/(?!contract/|schema/)' },
    },
    {
      name: 'contract-touches-no-node-builtins',
      severity: 'error',
      comment:
        'The wire contract is imported by a Node process and by a browser ' +
        'bundle alike, so it may not reach for either environment ' +
        '(§12.3, rule 2). A Node builtin here would break the browser build ' +
        'rather than fail a test.',
      from: { path: '^packages/contract/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'contract-carries-no-framework',
      severity: 'error',
      comment:
        'It describes what travels, not who reads it. React or i18next here ' +
        'would mean display concerns leaked into the contract — and the ' +
        'contract deliberately carries no display text, only codes the ' +
        'client translates. Fastify or Prisma here would mean the browser ' +
        'bundle grew a server framework. `zod` is the one runtime ' +
        'dependency, and it is the same one packages/schema already ships.',
      from: { path: '^packages/contract/src/' },
      to: {
        // Two spellings for the same reason `api-is-server-only` needs two:
        // an undeclared dependency does not resolve, and depcruise then
        // reports the bare specifier rather than a node_modules path.
        path: [
          'node_modules/(react|react-dom|react-i18next|i18next|@dnd-kit|react-router|zustand|zundo|fastify|@prisma)(/|$)',
          '^(react|react-dom|react-i18next|i18next|@dnd-kit|react-router|zustand|zundo|fastify|@prisma)(/|$)',
        ],
      },
    },
    {
      name: 'slugs-are-minted-where-rows-are-written',
      severity: 'error',
      comment:
        'Only packages/db may import nanoid. A circuit slug is the whole of ' +
        "an UNLISTED circuit's access control (§11), so it is generated in " +
        'the same module that writes the row and retries on the unique ' +
        'index — never handed in by a caller and never invented a second ' +
        'time somewhere else with a different length.',
      from: { pathNot: '^packages/db/src/' },
      to: {
        // Two spellings, for the same reason `api-is-server-only` needs two:
        // an undeclared dependency does not resolve and appears as the bare
        // specifier rather than as a node_modules path.
        path: ['node_modules/nanoid(/|$)', '^nanoid(/|$)'],
      },
    },
    {
      name: 'db-client-is-not-imported-directly',
      severity: 'error',
      comment:
        'The generated Prisma client is re-exported from packages/db/src/' +
        'index.ts. Reaching into src/generated from outside the package ' +
        'binds a consumer to a path that prisma generate owns and that has ' +
        'already changed shape once across a major version.',
      from: { pathNot: '^packages/db/' },
      to: { path: '^packages/db/src/generated/' },
    },
    {
      name: 'api-is-server-only',
      severity: 'error',
      comment:
        'apps/api is a Node process behind Railway, not a renderer. An ' +
        'import of React, i18next or an editor library means logic landed in ' +
        'the wrong app — and it means user-facing English is being written ' +
        'in a place no i18n catalog covers. API responses carry a ' +
        'machine-readable code and apps/web translates it; nothing the API ' +
        'produces is ever displayed verbatim.',
      from: { path: '^apps/api/src/' },
      to: {
        /*
         * Two patterns for the same set, because a module that is *not* a
         * dependency of apps/api does not resolve — and depcruise then puts
         * the bare specifier in `resolved` rather than a node_modules path.
         * Matching only the installed form would make this rule fire for an
         * import that was declared and stay silent for one that was not,
         * which is backwards.
         */
        path: [
          'node_modules/(react|react-dom|react-i18next|i18next|zustand|zundo|@dnd-kit|react-router)(/|$)',
          '^(react|react-dom|react-i18next|i18next|zustand|zundo|@dnd-kit|react-router)(/|$)',
        ],
      },
    },
    {
      name: 'api-verifies-tokens-in-one-place',
      severity: 'error',
      comment:
        'Only apps/api/src/auth may reach for `jose`. A route that decodes a ' +
        'JWT itself — even "just to read the sub for a log line" — is one ' +
        '`decodeJwt` away from trusting an unverified claim, and that ' +
        'mistake reads as harmless in review. Route code uses request.auth, ' +
        'which holds an identity this process verified. `src/testing/` is ' +
        'exempt because it does the opposite job: it mints tokens, from a ' +
        'key pair it generated, so the auth tests exercise the real verifier.',
      from: {
        path: '^apps/api/src/',
        pathNot: ['^apps/api/src/auth/', '^apps/api/src/testing/'],
      },
      to: { dependencyTypes: ['npm'], path: 'node_modules/jose(/|$)' },
    },
    {
      name: 'api-testing-helpers-stay-in-tests',
      severity: 'error',
      comment:
        'apps/api/src/testing mints signed JWTs from a locally generated key ' +
        'pair. It is excluded from the build for that reason; an import from ' +
        'production code would put a token factory inside the deployed ' +
        'image and, worse, would compile a file the build does not emit.',
      from: {
        path: '^apps/api/src/',
        pathNot: '(^apps/api/src/testing/|\\.test\\.ts$)',
      },
      to: { path: '^apps/api/src/testing/' },
    },
    {
      name: 'web-testing-helpers-stay-in-tests',
      severity: 'error',
      comment:
        'apps/web/src/lib/api/testing.ts builds fake `Response` objects and a ' +
        '`fetch` that answers from a queue. Importing it from a component ' +
        'would put a stub transport inside the shipped bundle — and would do ' +
        'it invisibly, since the tests would still pass.',
      from: {
        path: '^apps/web/src/',
        pathNot: '\\.test\\.tsx?$',
      },
      to: { path: '^apps/web/src/lib/api/testing\\.ts$' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular imports break tree shaking and confuse module init order.',
      from: {
        /*
         * The generated Prisma client is mutually recursive by construction:
         * every model module imports the Prisma namespace for its input
         * types, and the namespace re-exports every model. That is fine
         * because the cycles are between types, which are erased — and it is
         * not fixable by us in any case, since `prisma generate` rewrites
         * these files from schema.prisma. The exemption is on `from` only,
         * so a cycle that reaches back into hand-written code is still an
         * error.
         */
        pathNot: '^packages/db/src/generated/',
      },
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
          /*
           * The API's process entry point. Nothing imports it — Railway
           * runs `node dist/server.js` — which is what an entry point is,
           * not what dead code is.
           */
          '^apps/api/src/server\\.ts$',
          /*
           * The generated Prisma client emits entry points this project does
           * not use — `browser.ts` for a client-side bundle it will never
           * have, `models.ts` as an alternative barrel. They are still
           * cruised, so the rules about who may import them stay live; they
           * are only exempt from being called dead code, which they are not:
           * nobody wrote them and nobody can delete them.
           */
          '^packages/db/src/generated/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    /*
     * Workspace build output only, anchored to `apps/*` and `packages/*`.
     *
     * The obvious pattern, `(^|/)(dist|coverage)/`, is over-broad in a way
     * that is invisible until a rule silently stops working: plenty of npm
     * packages resolve to a file inside their own `dist/` — `jose` is
     * `dist/webapi/index.js` — so an unanchored exclusion drops them from the
     * graph entirely, and any rule written about them can never fire. That is
     * worse than no rule, because it looks like one.
     */
    exclude: { path: '^(apps|packages)/[^/]+/(dist|coverage)/' },
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
