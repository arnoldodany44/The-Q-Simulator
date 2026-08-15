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
apps/web            React client (Vite)
packages/qsim       @qsim/core   — simulation engine, zero dependencies
packages/schema     @qsim/schema — circuit JSON contract, Zod validators
packages/config     @qsim/config — shared ESLint and TypeScript config
```

`packages/qsim` and `packages/schema` are consumed by both the client and (from
Phase 1) the server, and must stay a single implementation: the client
simulates for live feedback while the server simulates authoritatively to
validate challenges. A divergence between them would let a user see "solved"
locally and "failed" remotely. Four dependency rules enforce the boundaries and
run in CI — see `.dependency-cruiser.cjs`.

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
