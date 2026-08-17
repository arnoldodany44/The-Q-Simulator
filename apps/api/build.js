/**
 * Builds `dist/server.js`, the file Railway runs (§12.4).
 *
 * ── Why this is not just `tsc` ────────────────────────────────────────────
 *
 * `tsc -p tsconfig.build.json` emits perfectly good JavaScript for this
 * package's own files, and the result cannot start. The reason is a
 * consequence of a decision made two milestones ago and is worth writing
 * down, because the error it produces points at the wrong place:
 *
 *     Cannot find module '…/packages/db/src/client.js'
 *       imported from '…/packages/db/src/index.ts'
 *
 * `@qsim/db` and `@qsim/schema` are consumed **as source**: their
 * `package.json` sends every runtime condition to `./src/index.ts`, and their
 * builds emit declarations only. That is deliberate — it is what lets Vite
 * hot-reload them and what keeps a stale `dist/` out of the web bundle — and
 * it works because Vite and Vitest compile TypeScript.
 *
 * Node does not. It can *strip types* from a `.ts` file, but stripping is not
 * compiling: it never rewrites a module specifier. So when Node loads
 * `packages/db/src/index.ts` and that file says `from './client.js'` — the
 * extension TypeScript requires you to write, and rewrites at emit — Node
 * looks for a `client.js` that was never emitted, and stops.
 *
 * Three ways out, and only one of them is contained:
 *
 *   1. Give the packages a real JavaScript build. Blocked for `@qsim/db`:
 *      the generated Prisma client imports with explicit `.ts` extensions,
 *      which needs `allowImportingTsExtensions`, which TypeScript only allows
 *      when nothing is emitted. It would also change what Vitest resolves for
 *      every other workspace, which is a lot of blast radius for one deploy.
 *   2. A custom Node resolve hook that retries `.js` as `.ts`. Works, and
 *      makes the production start command depend on a loader nobody expects.
 *   3. Bundle. The workspace packages are inlined — esbuild implements
 *      TypeScript's own `.js` → `.ts` resolution, so the specifiers resolve
 *      the way their author meant — and everything from npm stays external
 *      and is resolved from `node_modules` at runtime, as usual.
 *
 * This is (3), and it is also what the milestone brief asks for: unlike the
 * browser packages, this app needs a real JavaScript build.
 *
 * ── What is inlined, and what that costs ──────────────────────────────────
 *
 * Only `@qsim/*` is inlined. Everything else — Fastify, Prisma, jose, pino —
 * stays external, so the bundle is small, the stack traces name real
 * packages, and nothing that does its own dynamic `require` is disturbed.
 *
 * The cost is one honest consequence: inlining `@qsim/db` means this package
 * now imports `@prisma/client`, `@prisma/adapter-pg` and `nanoid` directly at
 * runtime, so it declares all three. A bundle owns the runtime dependencies of
 * what it inlines.
 *
 * That rule is checkable rather than remembered: `verifyExternals` below reads
 * the bare specifiers esbuild left in the output and fails the build if any of
 * them is not declared in this package's `dependencies`. The failure that
 * motivated it was `nanoid` — declared by `@qsim/db`, imported by the bundle,
 * absent from `apps/api`, and therefore an ERR_MODULE_NOT_FOUND at the first
 * line of `node dist/server.js` that no test could see, because the tests
 * resolve through Vitest and never through the artifact.
 *
 * Type checking is not this script's job — esbuild does not typecheck. That
 * is `pnpm typecheck` (`tsc --noEmit`), which turbo runs as its own task.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { build, context } from 'esbuild'

/**
 * Fails the build when the bundle imports a package this one does not declare.
 *
 * pnpm's isolated `node_modules` is what makes this fatal rather than untidy:
 * a package declared by `@qsim/db` is simply not resolvable from
 * `apps/api/dist`, so an undeclared external is an ERR_MODULE_NOT_FOUND before
 * a single line of the server runs. Nothing else in the pipeline can see it —
 * turbo builds the artifact and never executes it, and every test resolves
 * through Vitest.
 *
 * Reads the emitted file rather than the module graph so it checks what Node
 * will actually be asked for. Subpath imports (`@prisma/client/runtime/client`)
 * are reduced to their package name; `node:` builtins are ignored.
 *
 * Run over every artifact this script emits, not only the server: the seed
 * (Phase 3) inlines `@qsim/db` too, and it runs on the release path where a
 * missing dependency would stop a deploy rather than merely fail a request.
 */
function verifyExternals(outfile, declared) {
  const source = readFileSync(outfile, 'utf8')
  const specifiers = new Set()
  for (const match of source.matchAll(/^\s*import\s[^;]*?from\s*"([^"]+)"/gm)) {
    specifiers.add(match[1])
  }
  for (const match of source.matchAll(/^\s*import\s*"([^"]+)"/gm)) {
    specifiers.add(match[1])
  }

  const missing = []
  for (const specifier of specifiers) {
    if (specifier.startsWith('node:') || specifier.startsWith('.')) continue
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]
    if (!declared.has(name)) missing.push(name)
  }

  if (missing.length > 0) {
    const names = [...new Set(missing)].sort().join(', ')
    throw new Error(
      `dist/server.js imports ${names}, which apps/api does not declare. A ` +
        'bundle owns the runtime dependencies of what it inlines — add them ' +
        'to dependencies in apps/api/package.json, or the built server dies ' +
        'at module load with ERR_MODULE_NOT_FOUND.'
    )
  }
}

const declaredDependencies = new Set(
  Object.keys(
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
      .dependencies ?? {}
  )
)

/**
 * Resolves `@qsim/*` to the file Node itself would pick, then hands it to
 * esbuild to compile instead of leaving it external.
 *
 * `import.meta.resolve` is used rather than a hand-written path so the
 * package's own `exports` map stays the single source of truth: if a package
 * ever does gain a real JavaScript build, this picks it up with no change
 * here.
 */
const inlineWorkspacePackages = {
  name: 'inline-workspace-packages',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@qsim\// }, (args) => ({
      path: fileURLToPath(import.meta.resolve(args.path)),
      external: false,
    }))
  },
}

/**
 * Rebuild, then restart the server on the file that was just written.
 *
 * `pnpm dev` goes through the bundle rather than running `src/server.ts`
 * directly, and for the same reason the production build does: Node cannot
 * load the workspace packages as source. Running the entry point straight
 * fails on its own first relative import. The bundle rebuilds in tens of
 * milliseconds, so the loop still feels like a watcher.
 */
const restartServer = {
  name: 'restart-server',
  setup(pluginBuild) {
    let child = null

    pluginBuild.onEnd((result) => {
      if (result.errors.length > 0) return

      try {
        verifyExternals(options.outfile, declaredDependencies)
      } catch (error) {
        // In watch mode this must not kill the loop: report and wait for the
        // edit that fixes it.
        console.error(error.message)
        return
      }

      // SIGTERM rather than SIGKILL so the restart exercises the same
      // shutdown path production does.
      child?.kill('SIGTERM')
      child = spawn(
        process.execPath,
        ['--env-file-if-exists=../../.env', 'dist/server.js'],
        { stdio: 'inherit' }
      )
    })

    process.on('SIGINT', () => {
      child?.kill('SIGTERM')
      process.exit(0)
    })
  },
}

const options = {
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  /*
   * Matches the `engines` floor in the root package.json. Kept explicit so a
   * syntax level Railway's Node cannot parse fails here rather than at
   * startup.
   */
  target: 'node22',
  format: 'esm',
  // Read only by the server's own logs. The error handler never sends a
  // stack to a client.
  sourcemap: true,
  /*
   * Everything from npm is resolved at runtime. The plugin above runs first
   * and overrides this for `@qsim/*`.
   */
  packages: 'external',
  plugins: [inlineWorkspacePackages],
  logLevel: 'warning',
}

/**
 * The second artifact: the challenge seed (Phase 3), which `release.sh` runs
 * between `prisma migrate deploy` and the server.
 *
 * Built with the same options and as its own `build()` call rather than as a
 * second entry point of the first, because the watch loop above is wired to a
 * single `outfile` and restarts the server on every rebuild — and a dev loop
 * has no reason to re-run a seed. So the seed is emitted by `pnpm build` and
 * not by `pnpm dev`, which is exactly where each one is needed.
 */
const seedOptions = {
  ...options,
  entryPoints: ['src/seed-challenges.ts'],
  outfile: 'dist/seed-challenges.js',
}

if (process.argv.includes('--watch')) {
  const ctx = await context({
    ...options,
    plugins: [...options.plugins, restartServer],
  })
  await ctx.watch()
} else {
  for (const target of [options, seedOptions]) {
    const result = await build(target)
    if (result.errors.length > 0) process.exit(1)
    verifyExternals(target.outfile, declaredDependencies)
  }
}
