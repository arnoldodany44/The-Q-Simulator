# The Q Simulator

A quantum circuit laboratory in the browser — build circuits by dragging gates, watch the
state evolve in real time, save and version your work, and run the same circuit on real
IBM Quantum hardware.

> **Status:** Phase 0 is live at **[the-q-simulator.vercel.app](https://the-q-simulator.vercel.app)** —
> a circuit editor with live simulation, no account and no backend. Next is
> Phase 1: accounts, persistence and a public gallery. See the
> [work plan](docs/plan-de-trabajo.md).

Everything in Phase 0 runs in the reader's own tab. The simulation happens in a
Web Worker, nothing is uploaded, and a circuit travels inside its own link.

## Getting started

```bash
corepack enable pnpm
pnpm install
pnpm dev          # web client on http://localhost:5173
```

| Command                      | What it does                                    |
| ---------------------------- | ----------------------------------------------- |
| `pnpm dev`                   | Runs every app in watch mode                    |
| `pnpm verify`                | Lint, typecheck, test, build and boundary check |
| `pnpm test`                  | Test suites only                                |
| `pnpm --filter web test:e2e` | End-to-end suite (Playwright)                   |
| `pnpm boundaries`            | Package dependency rules only                   |
| `pnpm format`                | Rewrites files with Prettier                    |

The end-to-end suite is not part of `pnpm verify`: it drives a real browser
against a real dev server, which is minutes rather than seconds, so it runs on
`main` (`.github/workflows/e2e.yml`) rather than on every pull request. It
starts Vite itself, but the browser has to be present — once per machine:

```
pnpm --filter web exec playwright install chromium
```

## Layout

```
apps/web            React client (Vite)                    → Vercel
apps/api            Fastify 5 REST service                 → Railway
packages/qsim       @qsim/core     — simulation engine, zero dependencies
packages/schema     @qsim/schema   — circuit JSON contract, Zod validators
packages/contract   @qsim/contract — REST wire contract, shared by web and api
packages/qasm       @qsim/qasm     — OpenQASM 3, Qiskit and JSON serialisers
packages/db         @qsim/db       — Prisma schema, migrations, client singleton
packages/config     @qsim/config   — shared ESLint and TypeScript config
```

`packages/qsim` and `packages/schema` are consumed by both the client and (from
Phase 1) the server, and must stay a single implementation: the client
simulates for live feedback while the server simulates authoritatively to
validate challenges. A divergence between them would let a user see "solved"
locally and "failed" remotely. Dependency rules enforce the boundaries and run
in CI — see `.dependency-cruiser.cjs`.

`apps/api` verifies Supabase user tokens against the project's **public**
signing keys (ES256, fetched from `SUPABASE_JWKS_URL` and cached), not against
a shared secret. Specification §11 still describes the legacy HS256 scheme;
the asymmetric one is strictly better and is what the code does, because an
attacker who reads every environment variable the API holds still cannot mint
a token. Every visibility rule is enforced in the query layer rather than by
Postgres RLS, which Prisma bypasses by connecting as `postgres`.

It is also the one workspace whose build is a **bundle** rather than `tsc`
output. The shared packages are published as TypeScript source, and Node can
strip types but never rewrites a module specifier — so `node dist/server.js`
would fail on the `./client.js` that `@qsim/db` was compiled to expect.
`apps/api/build.js` explains that in full.

`packages/contract` exists because of that last rule. The browser cannot see
the Prisma types the API's responses are projected from, so the request and
response shapes are declared once, in a package both apps import, instead of
being hand-copied into the client — a copy compiles forever and diverges
silently. It also holds the error-code vocabulary: the API answers with a code
and never with display text, and `apps/web` translates that code into `es`,
`en` and `fr` (D2), with a test that refuses a code no catalog has a sentence
for. The client that consumes all of this is `apps/web/src/lib/api`, which is
the only place in the frontend that builds a URL or sets a header.

`packages/db` is server-only and the browser never imports it. Its client is
generated from `prisma/schema.prisma` into `src/generated/`, which is
gitignored: `pnpm install` regenerates it, and so does any turbo task that
needs it. If it goes missing between installs, `pnpm --filter @qsim/db generate`
brings it back.

**The database is shared: development and production are the same Supabase
project.** There is no second copy. Create migrations with
`prisma migrate dev --create-only`, read the generated SQL, then apply it with
`prisma migrate deploy` — never plain `migrate dev`, which offers to reset on
any drift. `pnpm --filter @qsim/db test` asserts that no committed migration
contains a destructive statement or touches Supabase's `auth` schema.

Because there is one database, no suite reaches it by default — `pnpm verify`
runs entirely offline. Three opt-in suites exist for the questions only Postgres
can answer, and all three clean up after themselves:

```bash
QSIM_DB_INTROSPECTION=1 pnpm --filter @qsim/db test   # read-only, after a migration
QSIM_DB_INTEGRATION=1   pnpm --filter @qsim/db test   # writes, then deletes what it wrote
QSIM_LIVE_DRIVE=1       pnpm --filter api test        # the whole feature set, end to end
```

The second creates everything under two reserved identities and deletes those
two `User` rows afterwards, letting `ON DELETE CASCADE` remove the rest — so it
can never touch a row it did not create. It earns its keep: it is what caught
that Prisma 7's driver adapter reports a unique-constraint violation with no
`meta.target` at all, which had silently disabled two retry paths written from
the documentation (`packages/db/src/prisma-errors.ts`). It is also the only
place the tag-replacement race is visible, because reproducing it needs more
than one database connection and the pooler URL carries `connection_limit=1`.

The third drives two people through publish, browse, star, fork, export and
profile against the real database, through the real Fastify app. Its identities
exist only in `public.User` and its bearer tokens are signed by a key pair
generated in the test process: Supabase owns `auth.users` and nothing here may
write to it, so the verifier, issuer, audience and `sub` checks are the
production ones and only the signing key is local.

## Documentation

| Document                                             | Contents                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`docs/especificacion.md`](docs/especificacion.md)   | Full technical specification — scope, architecture, simulation engine, data model, API, design system |
| [`docs/plan-de-trabajo.md`](docs/plan-de-trabajo.md) | Execution plan — milestones, dependency graph, definitions of done, blockers                          |

## Frozen conventions

These are decided once and never revisited casually. Changing them late poisons the codebase.

| #      | Decision             | Value                                                                                                                                                                                                              |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** | **Qubit ordering**   | **Little-endian — qubit 0 is the least significant bit.** For statevector index `i`, qubit `q` is `(i >> q) & 1`. This matches Qiskit; any other convention makes Qiskit export silently produce mirrored results. |
| **D2** | UI languages         | Spanish, English and French from day one (`react-i18next`, fallback `en`, browser detection, persisted manual selector). Gate names, state notation and proper nouns are never translated.                         |
| **D3** | Package scope        | `@qsim/*`                                                                                                                                                                                                          |
| **D4** | URL circuit encoding | minified JSON → deflate → base64url                                                                                                                                                                                |
| **D5** | Test runner          | Vitest, all packages                                                                                                                                                                                               |
| **D6** | Numeric precision    | `Float64`, renormalize every 64 gates, test tolerance `1e-10`                                                                                                                                                      |

## Language convention

Code, comments, docstrings, this README and commit messages are in **English**.
Internal design documents under `docs/` are in **Spanish**.

## Requirements

- Node.js 22.12+ (developed on 24.19)
- pnpm 11 (via `corepack enable pnpm`)
- Docker (from Phase 2, for local Redis)

Dependency versions live in the pnpm catalog in `pnpm-workspace.yaml`, not in
individual `package.json` files. Upgrade in one place.

TypeScript is pinned to 6.x rather than 7.x on purpose: `typescript-eslint`
declares support for `<6.1.0`, and dropping to untyped linting would disable
the boundary and i18n rules this project relies on. Revisit when
typescript-eslint ships TypeScript 7 support.
