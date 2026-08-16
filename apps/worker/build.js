/**
 * Builds `dist/worker.js` and `dist/simulate.child.js` (§12.4).
 *
 * ── Why this is not just `tsc` ────────────────────────────────────────────
 *
 * The same reason `apps/api/build.js` is not, and that file carries the full
 * argument. In short: `@qsim/db`, `@qsim/jobs` and `@qsim/schema` are consumed
 * as TypeScript *source*, and Node can strip types but never rewrites a module
 * specifier — so a `from './client.js'` that TypeScript would have rewritten at
 * emit sends Node looking for a file that was never emitted. esbuild implements
 * TypeScript's own `.js` → `.ts` resolution, so inlining the workspace packages
 * makes the specifiers resolve the way their author meant.
 *
 * ── TWO ENTRY POINTS, AND THEY MUST LAND SIDE BY SIDE ─────────────────────
 *
 * This is the one thing that differs from the API's build, and it is not
 * cosmetic. `pool.ts` forks a child, and `worker.ts` resolves that child as
 * `new URL('./simulate.child.js', import.meta.url)` — a sibling of the bundle
 * it is resolving from. If only `worker.ts` were built, the worker would start,
 * report healthy, accept a job, and fail every single one with
 * `WORKER_CRASHED`, because the module it forks does not exist. Nothing in the
 * test suite can see that: the pool tests fork a fixture by an explicit path,
 * and `runSimulationJob` is tested as a function.
 *
 * So the child is a second entry point of the same build, `verifyChildEmitted`
 * below fails the build if it is missing, and the two are emitted into one
 * directory so the sibling resolution is true by construction.
 *
 * The child is a separate *bundle* rather than a chunk, deliberately: splitting
 * would put shared code in a third file, and a forked module with a relative
 * import is one more thing that can be wrong at runtime and nowhere else. Both
 * files inline the engine; the duplication costs disk and buys a child that is
 * a single self-contained file.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { build, context } from 'esbuild'

/**
 * Fails the build when a bundle imports a package this one does not declare.
 *
 * Verbatim in spirit from `apps/api/build.js`, and for the same reason: pnpm's
 * isolated `node_modules` means a package declared only by `@qsim/db` is not
 * resolvable from `apps/worker/dist`, so an undeclared external is an
 * ERR_MODULE_NOT_FOUND before a line of the worker runs — and nothing else in
 * the pipeline can see it, because turbo builds the artifact and never executes
 * it while every test resolves through Vitest.
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
      `${outfile} imports ${names}, which apps/worker does not declare. A ` +
        'bundle owns the runtime dependencies of what it inlines — add them ' +
        'to dependencies in apps/worker/package.json, or the built worker ' +
        'dies at module load with ERR_MODULE_NOT_FOUND.'
    )
  }
}

/**
 * Fails the build when the forked child is absent.
 *
 * The failure it prevents is a worker that starts, passes its health check and
 * fails every job — see the header. Checking the file exists is a poor
 * substitute for running it, and it is the check that would actually have
 * caught the mistake.
 */
function verifyChildEmitted(childFile) {
  if (existsSync(childFile)) return
  throw new Error(
    `${childFile} was not emitted. pool.ts forks it as a sibling of ` +
      'worker.js; without it every job fails with WORKER_CRASHED and the ' +
      'process still reports healthy.'
  )
}

const declaredDependencies = new Set(
  Object.keys(
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
      .dependencies ?? {}
  )
)

/**
 * Resolves `@qsim/*` to the file Node itself would pick, then compiles it in
 * rather than leaving it external.
 *
 * `import.meta.resolve` and not a hand-written path, so each package's own
 * `exports` map stays the single source of truth.
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

const OUT_DIR = 'dist'
const WORKER_FILE = `${OUT_DIR}/worker.js`
const CHILD_FILE = `${OUT_DIR}/simulate.child.js`

function verifyAll() {
  verifyChildEmitted(CHILD_FILE)
  verifyExternals(WORKER_FILE, declaredDependencies)
  verifyExternals(CHILD_FILE, declaredDependencies)
}

/** Rebuild, then restart the worker on the files just written. */
const restartWorker = {
  name: 'restart-worker',
  setup(pluginBuild) {
    let child = null

    pluginBuild.onEnd((result) => {
      if (result.errors.length > 0) return

      try {
        verifyAll()
      } catch (error) {
        // In watch mode this must not kill the loop: report and wait for the
        // edit that fixes it.
        console.error(error.message)
        return
      }

      // SIGTERM rather than SIGKILL so the restart exercises the same shutdown
      // path production does — including killing the pool's children, which is
      // the one that leaks if it is skipped.
      child?.kill('SIGTERM')
      child = spawn(
        process.execPath,
        ['--env-file-if-exists=../../.env', WORKER_FILE],
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
  entryPoints: ['src/worker.ts', 'src/simulate.child.ts'],
  outdir: OUT_DIR,
  bundle: true,
  platform: 'node',
  // Matches the `engines` floor in the root package.json, so a syntax level
  // Railway's Node cannot parse fails here rather than at startup.
  target: 'node22',
  format: 'esm',
  // Read only by this process's own logs.
  sourcemap: true,
  // Everything from npm is resolved at runtime; the plugin overrides this for
  // `@qsim/*`.
  packages: 'external',
  plugins: [inlineWorkspacePackages],
  logLevel: 'warning',
}

if (process.argv.includes('--watch')) {
  const ctx = await context({
    ...options,
    plugins: [...options.plugins, restartWorker],
  })
  await ctx.watch()
} else {
  const result = await build(options)
  if (result.errors.length > 0) process.exit(1)
  verifyAll()
}
