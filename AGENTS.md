# AGENTS.md

## Purpose

Failure Atlas is a local-first lab for agent and workflow failures: deterministic simulation with fault injection, trace inspection, run comparison, checkpoint forks, and regression bundles verified by a CLI. The adopted build brief is `docs/BRIEF.md`.

## Architecture

- `src/engine/` is pure TypeScript with no DOM or Node dependencies, so the same code runs in the browser worker and the CLI.
  - `runner.ts`: virtual-time scheduler; workflows are generators that yield operations. Produces finalized, immutable `Trace` objects.
  - `fixtures.ts`: indexed fixture matching (tool, canonical args or declared fields, state, occurrence, logical id). Misses and ambiguities are execution errors.
  - `assertions.ts`: state- and event-based checks with `pass | fail | error | unavailable | not-applicable`.
  - `compare.ts`: Myers alignment on semantic keys, first observed divergence, downstream events. `graph.ts`: evidence-backed dependency graph.
  - `bundle.ts`, `redact.ts`, `validate.ts`, `hash.ts` (canonical JSON + incremental SHA-256).
- `src/scenarios/`: workflow definitions plus declarative scenario data (13 scenarios). `tests/expected-outcomes.ts` is the independent spec of what every scenario/policy/preset must produce.
- `src/integrations/otel.ts`: OTLP/JSON GenAI import, pinned to semantic-conventions-genai commit `51a0f580f8a6ad804ca4de5e033683c6fbbe5906` (development stability).
- `src/live/`: OpenAI-compatible live adapter and the credential-free local stub used by tests.
- `src/cli/main.ts`: CLI. `src/web/`: React UI; `worker.ts` hosts the engine, `protocol.ts` defines messages.
- `bench/`: generated 10k-event benchmark. `scripts/`: screenshots, UI interaction checks, browser benchmark, clean-environment bundle check.

## Commands

```bash
npm install
npm run dev               # web UI
npm test                  # vitest (94 tests)
npm run typecheck
npm run build             # dist/web + dist/cli/fa.mjs
npm run fa -- <command>   # CLI from source (list, run, compare, fork, graph, export, verify, inspect, matrix, live)
npm run bench             # engine benchmark -> bench/out/
npm run build:web && npm run ui-check && npm run screenshots && npm run bench:browser   # Playwright; CHROMIUM_PATH optional
npm run check:clean-env   # export + verify bundles with only fa.mjs in an empty directory
```

## Current status

All five brief milestones are implemented on `feat/initial-implementation` (draft PR #1): 13 scenarios, deterministic faults/replay/forks, timeline/inspector/graph/compare UI, OTLP import and live adapter, regression bundles with redaction preview, measured performance (`docs/PERFORMANCE.md`). Awaiting owner review; not deployed.

## Recent changes

- Web UI: scenario rail, virtualized timeline, inspector with fault composer and checkpoint fork, checks, compare, graph, policy editor, state, export with redaction preview, runs list, responsive layouts down to 390 px.
- Performance: linear checkpoint prefix hashing, indexed fixture lookup, no state capture at undeclared checkpoints, faster canonical JSON (simulation of 10,338 events 2.5 s -> 0.5 s).
- Comparison ignores engine annotations (run header, fork resume note) when picking the first divergence.

## Constraints

- Simulation must stay deterministic: never read wall-clock time or `Math.random` inside the engine; use the virtual clock and seeded RNG. Wall time appears only in `wt`, which is excluded from hashes.
- Changing event content or ordering changes trace hashes and invalidates existing bundles; bump `ENGINE_VERSION` and note it when that is intended.
- Imported data is untrusted: validate, enforce `LIMITS`, render as text, never execute.
- Replay and tests never call external services. Live mode is explicit and needs `FA_LIVE_*` variables.
- Branch work only; the owner merges. Commits are authored by the owner with no agent signatures or co-author trailers.

## Known issues

- Forks only from original simulation runs at declared checkpoints; forked runs cannot be bundled.
- Imported native traces for scenarios not in the local registry can be inspected and compared but not exported.
- Large-trace import/export time is dominated by pure-JS SHA-256 (kept for identical hashes in worker and Node).
- The live adapter is validated only against the local stub.

## Do not

- Do not push to `main` or merge PRs.
- Do not add network calls to simulation, replay, tests, or the default UI.
- Do not commit private or imported traces, real credentials, or files from `bench/out/` and `scratch/`.
- Do not count `unavailable` or `not-applicable` assertions as passes, or describe a divergence as a proven root cause.
- Do not deploy, connect hosting, or change the personal portfolio without the owner's decision.
