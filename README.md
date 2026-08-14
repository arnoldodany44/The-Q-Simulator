# The Q Simulator

A quantum circuit laboratory in the browser — build circuits by dragging gates, watch the
state evolve in real time, save and version your work, and run the same circuit on real
IBM Quantum hardware.

> **Status:** pre-scaffold. See the [work plan](docs/plan-de-trabajo.md) for the current milestone.

## Documentation

| Document | Contents |
|---|---|
| [`docs/especificacion.md`](docs/especificacion.md) | Full technical specification — scope, architecture, simulation engine, data model, API, design system |
| [`docs/plan-de-trabajo.md`](docs/plan-de-trabajo.md) | Execution plan — milestones, dependency graph, definitions of done, blockers |

## Frozen conventions

These are decided once and never revisited casually. Changing them late poisons the codebase.

| # | Decision | Value |
|---|---|---|
| **D1** | **Qubit ordering** | **Little-endian — qubit 0 is the least significant bit.** For statevector index `i`, qubit `q` is `(i >> q) & 1`. This matches Qiskit; any other convention makes Qiskit export silently produce mirrored results. |
| **D2** | UI languages | Spanish, English and French from day one (`react-i18next`, fallback `en`, browser detection, persisted manual selector). Gate names, state notation and proper nouns are never translated. |
| **D3** | Package scope | `@qsim/*` |
| **D4** | URL circuit encoding | minified JSON → deflate → base64url |
| **D5** | Test runner | Vitest, all packages |
| **D6** | Numeric precision | `Float64`, renormalize every 64 gates, test tolerance `1e-10` |

## Language convention

Code, comments, docstrings, this README and commit messages are in **English**.
Internal design documents under `docs/` are in **Spanish**.

## Requirements

- Node.js 22 LTS
- pnpm 10 (via `corepack enable pnpm`)
- Docker (from Phase 2, for local Redis)
