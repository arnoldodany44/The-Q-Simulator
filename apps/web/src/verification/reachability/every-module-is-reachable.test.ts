/**
 * THE GUARDRAIL FOR THE DEFECT CLASS THIS PROJECT HAS SHIPPED TWICE.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG, TWICE, AND WHY NOTHING CAUGHT IT
 *
 * Phase 1 shipped `useSimulation` with no importer, so the editor simulated
 * nothing. Fase 5 shipped the whole collaboration transport — `circuitDocument.ts`,
 * `sharedUndo.ts`, `presence.ts`, `presenceChannel.ts`, `presenceMarks.ts`,
 * `PresenceCursors.tsx`, `PresenceRoster.tsx` — with no importer outside its own
 * tests and the verification suites' own `peers.ts` helpers, so no user action
 * could open a channel and no `CircuitSession` row could ever be written. Both
 * times every suite was green the whole time, because every suite drove its own
 * layer directly. Both times it was found by a person opening the page.
 *
 * The rule that was missing is not "does something import this module" — every one
 * of those files had importers. It is:
 *
 *   **Is this module reachable from something a browser loads?**
 *
 * `.dependency-cruiser.cjs`'s `no-orphans` cannot answer that. It is `severity:
 * 'warn'`, so `pnpm boundaries` exits 0 on it, and its predicate is "nothing
 * imports this at all" — which would have caught `sharedUndo.ts` as a warning and
 * none of the other six.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW THIS ANSWERS IT
 *
 * It walks the real import graph from the two entry points `index.html` and
 * `embed.html` name, following only *static* imports and `import()` calls, and
 * asserts that every production module under `src/features` and `src/routes` is in
 * the resulting set. A module that only tests and verification helpers import is
 * not in it, and the test says so by name.
 *
 * ── Why a hand-rolled scan rather than a bundler or a lint rule ───────────
 *
 * Because the question is small and the answers have to be *names*. Vite could
 * answer it by building, at the cost of a build inside the unit suite;
 * dependency-cruiser could express it as a `reachable` rule, at the cost of a
 * regex-shaped configuration whose failure message is a rule id. What a person
 * needs when this goes red is the list of files they wrote and forgot to mount, and
 * a hundred lines of `readFile` and a regex produce exactly that.
 *
 * The resolution is deliberately naive — relative specifiers, the `.js`-for-`.ts`
 * rewrite `verbatimModuleSyntax` requires, and directory `index` files — because
 * every specifier in this tree is one of those three. A specifier this cannot
 * resolve is *reported*, so the scan cannot quietly stop following the graph and
 * declare everything reachable.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** `apps/web/src`, from this file. */
const SRC = resolve(import.meta.dirname, '../..')

/**
 * What a browser actually loads.
 *
 * Two documents — `index.html` and `embed.html` — and one worker. A worker is a
 * real entry point that no `import` reaches: `new Worker(new URL('./x.worker.ts',
 * import.meta.url))` is a *string* as far as any import graph is concerned, which
 * is exactly why it has to be listed rather than discovered. Vite compiles it as
 * its own bundle; leaving it out would report the simulation worker and the two
 * job modules under it as unreachable, and they are the opposite of that — they are
 * what every run in the product goes through.
 */
const ENTRIES = [
  'main.tsx',
  'embed/main.tsx',
  'features/simulation/simulation.worker.ts',
]

/**
 * Where a module has to be reachable from an entry point to count as shipped.
 *
 * `features` and `routes` are the two folders that exist to be *mounted*.
 * `components`, `lib` and `i18n` are libraries used from those, and a helper
 * nobody has called yet is a different (and much smaller) problem than a feature
 * nobody has mounted.
 */
const MUST_BE_REACHED = ['features', 'routes']

/**
 * Files that are not modules of the product.
 *
 * Tests, the verification suites (which are tests with a longer argument), the
 * testing helpers a test imports, and type declarations.
 */
const NOT_PRODUCTION =
  /(\.test\.[jt]sx?$)|(^verification\/)|(\/testing\.tsx?$)|(\.d\.ts$)/

const SOURCE = /\.(ts|tsx)$/

/** Every `from '…'`, `import '…'` and `import('…')` specifier in a file. */
const SPECIFIERS =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g

function listSources(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(SRC, directory), {
    withFileTypes: true,
  })) {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...listSources(path))
      continue
    }
    if (SOURCE.test(entry.name)) found.push(path)
  }
  return found
}

/**
 * A relative specifier as a path under `src`, or `null` when it is not one.
 *
 * `null` is a package (`react`, `@qsim/collab`), an asset (`.css`) or an alias —
 * none of which is a module of this tree.
 */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = join(dirname(from), specifier).replaceAll('\\', '/')
  // `verbatimModuleSyntax` makes a TypeScript import of a sibling spell `.js`.
  const stem = base.replace(/\.js$/, '').replace(/\.jsx$/, '')
  for (const candidate of [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
  ]) {
    if (!SOURCE.test(candidate)) continue
    try {
      if (statSync(join(SRC, candidate)).isFile()) return candidate
    } catch {
      /* not this one */
    }
  }
  return null
}

interface Walk {
  readonly reached: Set<string>
  /** Relative specifiers that resolved to nothing, so a gap is never silent. */
  readonly unresolved: string[]
}

function walk(entries: readonly string[]): Walk {
  const reached = new Set<string>()
  const unresolved: string[] = []
  const queue = [...entries]

  while (queue.length > 0) {
    const module = queue.pop()
    if (module === undefined || reached.has(module)) continue
    reached.add(module)

    const text = readFileSync(join(SRC, module), 'utf8')
    for (const match of text.matchAll(SPECIFIERS)) {
      const specifier = match[1]
      if (specifier === undefined || !specifier.startsWith('.')) continue
      // A stylesheet or an asset. Not a module, and not a gap either.
      if (/\.(css|svg|png|json|wasm)$/.test(specifier)) continue
      const target = resolveSpecifier(module, specifier)
      if (target === null) {
        unresolved.push(`${module} → ${specifier}`)
        continue
      }
      if (!reached.has(target)) queue.push(target)
    }
  }

  return { reached, unresolved }
}

describe('every feature the product ships is reachable from a page', () => {
  const { reached, unresolved } = walk(ENTRIES)

  /*
   * First, because it is what makes the assertion below mean anything: a
   * specifier this scan cannot follow is a branch of the graph it never walked,
   * and every module beyond it would be reported unreachable — or, worse, the
   * walk would stop short and the *rest* of the tree would look reachable because
   * nothing asked about it.
   */
  it('followed every relative import it found', () => {
    expect(unresolved).toEqual([])
  })

  it('leaves no production module importable only by its own tests', () => {
    const production = MUST_BE_REACHED.flatMap((directory) =>
      listSources(directory).filter((path) => !NOT_PRODUCTION.test(path))
    )
    // The scan has to have found something, or an empty list would pass forever.
    expect(production.length).toBeGreaterThan(100)

    const stranded = production.filter((path) => !reached.has(path))
    expect(
      stranded,
      'these modules are imported only by tests or verification helpers, so no ' +
        'user action can reach them — mount them from a route, or delete them'
    ).toEqual([])
  })

  /**
   * The specific regression, named.
   *
   * `routes/editor.tsx` is where §3.4 becomes reachable, and the seven mounts it
   * feeds are each pinned by an assertion in `routes/editor.test.tsx`. This checks
   * the layer above that: that the transport, the bridge, the presence pair and the
   * two panels are in the graph a browser loads at all.
   */
  it('reaches the collaboration transport from the editor route', () => {
    for (const module of [
      'features/collab/collabSession.ts',
      'features/collab/useCollabSession.ts',
      'features/collab/circuitDocument.ts',
      'features/collab/sharedUndo.ts',
      'features/collab/presence.ts',
      'features/collab/presenceChannel.ts',
      'features/collab/presenceMarks.ts',
      'features/collab/PresenceCursors.tsx',
      'features/collab/PresenceRoster.tsx',
      'features/collab/CollabPanel.tsx',
      'features/collab/DeferredOperations.tsx',
      'features/collab/deferredResolution.ts',
    ]) {
      expect(reached.has(module), module).toBe(true)
    }
  })
})
