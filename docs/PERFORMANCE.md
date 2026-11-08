# Performance

Measured on 2026-11-08. Reproduce with `npm run bench` (engine, Node) and `npm run build:web && npm run bench:browser` (UI, headless Chromium). Raw results are written to `bench/out/` (not committed).

## Input

`bench/scale.ts` generates a scaled copy of the duplicate-charge scenario: **760 independent checkouts** through the same workflow, each with its own fixtures, with the charge response dropped after commit for every 10th order (76 faults).

| | Trace A (retry without key) | Trace B (retry with key) |
| --- | --- | --- |
| Events | 10,338 | 10,338 |
| JSON size | 3.7 MB | 3.9 MB |
| Event mix | 2,356 requests, 2,280 responses, 2,356 state changes, 760 triggers, 760 tasks, 760 checkpoints, 760 notes, 76 faults, 76 errors, 76 retries, 76 sleeps | same shape |

The regression bundle of trace A, including a redacted copy of the trace, is 7.6 MB.

## Environment

- Node v22.23.4, linux x64, Intel Xeon @ 2.60 GHz, 4 vCPUs, 7.8 GB RAM (cloud sandbox; numbers vary by ±10% between runs)
- Chromium 156.0.8078.73 headless via Playwright, viewport 1440x900

## Engine (Node, median of 5)

| Operation | Time |
| --- | --- |
| Simulate the 10,338-event run | 535 ms |
| Serialize trace to JSON | 14 ms |
| Import: parse, validate every event, verify integrity hash | 182 ms |
| Search by order id (3 hits) | 3.8 ms |
| Search text + kind filter (76 hits) | 2.0 ms |
| Search with no match | 2.7 ms |
| Compare A and B (10,414 aligned rows) | 292 ms |
| Build dependency graph (6,308 nodes, 5,700 edges) | 23 ms |
| Export bundle with redaction preview | 611 ms |
| Verify bundle (integrity + full re-execution) | 875 ms |

Heap (`process.memoryUsage().heapUsed`): 9 MB at start, 71 MB with both traces, their JSON text and the bundle text in memory.

The comparison found the first divergence at the first charge request (`$.data.args.idempotencyKey`), with 8,636 rows the same, 1,626 changed, and 76 only in each run.

## UI (headless Chromium, median of 3)

| Operation | Time |
| --- | --- |
| Import trace A and render the timeline | 243 ms |
| Type a search and render filtered rows | 24 ms |
| Clear the search | 18 ms |
| Scroll to the last event | 10 ms |
| Import trace B, choose A as baseline, render the first divergence | 1,076 ms |

Times are wall clock from Playwright, so each includes a few ms of protocol overhead. The import time covers the file read, worker-side parse/validation/integrity hash, structured clone to the main thread, and the first render. The timeline is virtualized: 30 row elements are in the DOM for 10,338 events. Main-thread JS heap after the comparison: 22 MB (the worker heap is separate and not included).

## Optimizations made from measurements

The first measurements showed super-linear growth: 50 orders simulated in 0.2 s but 200 orders took 3.1 s. CPU profiles pointed to three causes, each fixed without changing event content or hashes for shipped scenarios:

1. **Checkpoint prefix hashes** hashed the whole event list at every checkpoint (quadratic). They are now computed at finalization in one pass with an incremental SHA-256 whose state is cloned at each checkpoint. A test asserts the result equals `hashEvents` of each prefix and that forks still verify.
2. **Fixture lookup** scanned and re-canonicalized every fixture for every request. Fixtures are now indexed once per scenario by tool and canonical arguments; argument-field matchers are checked in declaration order. Tests assert identical misses (including the "nearest" list), ambiguities and scores.
3. **Undeclared checkpoints** hashed the full simulated state although they can never be forked. Only checkpoints a scenario declares now capture state; others are recorded as reached.

Canonical JSON also no longer builds a path string for every value; the path is reconstructed only when an unsupported value needs to be reported.

| Operation | Original | After fix 1 | After all fixes |
| --- | --- | --- | --- |
| Simulate 200 orders (2,722 events) | 3,131 ms | 288 ms | 130 ms |
| Simulate 760 orders (10,338 events) | not measured | 2,492 ms | 535 ms |
| Verify the 10,338-event bundle | not measured | 2,761 ms | 875 ms |

## Remaining costs

Import, export and verification are dominated by the synchronous pure-JS SHA-256 and canonical JSON. That implementation is kept so the browser worker and Node produce byte-identical hashes without async APIs. Comparison in the UI also pays for cloning both traces into the worker on every baseline change.
