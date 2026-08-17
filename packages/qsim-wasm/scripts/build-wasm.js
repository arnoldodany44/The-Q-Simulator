#!/usr/bin/env node
/**
 * Build the two `.wasm` artifacts — baseline and SIMD.
 *
 * NOT part of `pnpm build`. That task runs on every machine that touches the
 * repo and in every CI job, and most of them have no Rust toolchain; wiring a
 * `cargo` invocation into it would turn "clone and install" into "clone,
 * install a compiler, and install". The TypeScript half of this package
 * builds and tests without ever running this script, against the
 * linear-memory stand-in in `src/testing/` — see its header for what that
 * does and does not prove.
 *
 * So this is opt-in, and it says clearly what is missing when it cannot run:
 *
 *   pnpm --filter @qsim/wasm build:wasm
 *
 * WHY TWO ARTIFACTS. `simd128` is a compile target feature, not a runtime
 * branch. A module built with it contains v128 instructions and an engine
 * without the proposal rejects it at validation, before anything executes —
 * so a single module that "uses SIMD when available" is not expressible.
 * `detect.ts` probes the engine and picks; this produces both to pick from.
 *
 * The SIMD build differs from the baseline only in codegen flags. The source
 * is identical, deliberately: hand-written intrinsics would be a second
 * implementation of arithmetic that has to stay bit-identical to TypeScript,
 * and LLVM vectorises the pairing loops from the scalar source without being
 * allowed to reassociate any floating-point operation. That last part is what
 * keeps both artifacts exactly equal to the reference rather than merely
 * close to it.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const crate = join(root, 'crate')
const out = join(root, 'pkg')

/** Whether a command exists and answers `--version`. */
function has(command) {
  const probe = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  return probe.status === 0
}

const missing = ['cargo', 'wasm-pack'].filter((tool) => !has(tool))
if (missing.length > 0) {
  console.error(
    `\nCannot build the WebAssembly kernel: ${missing.join(' and ')} not found.\n\n` +
      `  rustup toolchain install 1.84.0\n` +
      `  rustup target add wasm32-unknown-unknown\n` +
      `  cargo install wasm-pack\n\n` +
      `This is not required to work on the repository. Without it the engine\n` +
      `runs the TypeScript kernel — phase 1 of the performance plan, which is\n` +
      `complete on its own — and @qsim/wasm's own suite runs against the\n` +
      `linear-memory stand-in in src/testing/.\n`
  )
  process.exit(1)
}

function build({ name, features, flags }) {
  const stage = join(root, `.pkg-${name}`)
  rmSync(stage, { recursive: true, force: true })

  const args = [
    'build',
    crate,
    '--target',
    'web',
    '--release',
    '--out-dir',
    stage,
    '--out-name',
    name,
  ]
  if (features.length > 0) args.push('--features', features.join(','))

  const result = spawnSync('wasm-pack', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, RUSTFLAGS: flags },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)

  mkdirSync(out, { recursive: true })
  // Only the `.wasm` is kept. The generated JS glue is not used: `exports.ts`
  // instantiates the module itself and stubs the imports by reflection, so
  // that this package has no build-time coupling to a wasm-bindgen version
  // and no static import of an artifact that usually is not there.
  const artifact = join(stage, `${name}_bg.wasm`)
  if (!existsSync(artifact)) {
    console.error(`wasm-pack produced no ${name}_bg.wasm in ${stage}`)
    process.exit(1)
  }
  copyFileSync(artifact, join(out, `${name}.wasm`))
  rmSync(stage, { recursive: true, force: true })
  console.error(`built pkg/${name}.wasm`)
}

build({ name: 'kernel', features: [], flags: '' })
build({
  name: 'kernel-simd',
  features: ['simd'],
  flags: '-C target-feature=+simd128',
})
