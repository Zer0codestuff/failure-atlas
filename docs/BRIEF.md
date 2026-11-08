# Failure Atlas build brief

Status: approved for implementation through the owner's existing Gumloop trigger on 28 October 2026.

## Outcome

Build a local application for reproducing agent-workflow failures, inspecting what happened at each step, and verifying whether a change fixes the failure. A developer can inject faults into simulated tools, compare runs, and export a reproducible regression case.

The owner is Gabriele Monni, GitHub account `Zer0codestuff`. The target repository is `failure-atlas`. Match the visual identity of https://gabrielemonni.me. Keep source, UI, documentation, metadata, and prompts in English. Never use em dashes.

The first complete product must work without a provider key or external service. It should demonstrate real deterministic execution of local workflows and simulated tools. Add a documented integration with an actual agent or model interface after the core works. Clearly distinguish fixture runs from real model executions.

## Product contract

A developer can:

1. Open a shipped scenario or import a supported trace.
2. Inspect an ordered timeline of requests, responses, state changes, retries, and checks.
3. Choose a supported execution point and configure a specific fault.
4. Run a controlled local workflow with that fault and watch recorded events appear.
5. Identify the first failed invariant, inspect its evidence, and compare the changed run with a baseline.
6. Change the supported workflow policy, rerun, and verify recovery with independent assertions.
7. Export the scenario, fixtures, trace, assertions, and versions as a regression bundle that runs from a CLI.

An imported trace that lacks executable workflow state is inspectable, but cannot become an executable agent by inference. Make unsupported operations explicit.

## Three execution modes

Keep these modes distinct in the data model and interface:

- **Recorded playback:** display recorded events and responses without calling a model or tool. Playback never proves that an agent would make the same decision again.
- **Deterministic simulation:** execute one of the supported local workflow definitions against fixture tools, a virtual clock, and seeded faults. Repeated runs of the same pinned scenario reproduce the same meaningful events.
- **Live execution:** use an explicitly configured local adapter to call an actual model or permitted tool. Capture a new trace. Do not promise determinism merely because a seed or temperature is supplied.

Forking at a checkpoint is available only when the runner has the state and implementation needed to resume. A fork is a new simulated or live run with lineage to its parent. It must not overwrite the original trace or suggest that a hypothetical branch actually occurred.

## Scenarios worth shipping

Implement at least twelve focused scenarios with a faulty and a corrected workflow policy where a correction is meaningful. Group them by mechanism, not by artificial severity scores.

Required cases:

1. A rate-limited tool returns a retry delay and the workflow either honors it or retries incorrectly.
2. A timeout occurs before a side effect, requiring a bounded retry.
3. A response is lost after a simulated write succeeds, exposing duplicate side effects without idempotency.
4. A duplicate trigger event arrives and should not repeat the same completed job.
5. A tool response changes schema or omits a required field.
6. A partial search result omits an expected source and the report must disclose the gap.
7. A source becomes stale and a cached result should no longer be presented as current.
8. Parallel responses arrive out of order and must retain the correct correlation IDs.
9. Cancellation occurs during a retry or parallel task and prevents new work from starting.
10. A workflow exhausts its declared step or retry limit and records the unresolved state.
11. A simulated untrusted document contains instructions that conflict with the task. Check the local policy boundary and record any attempted unauthorized action without executing it externally.
12. A report references a missing or unsupported source and a citation check fails.

Include a repository-creation scenario inspired by the owner's automation. Simulate an incoming repository event, a linked brief, implementation steps, and a resulting artifact. Test duplicate events, an inaccessible brief, and an incomplete result. This scenario must use local fixture objects and must never create real GitHub repositories while testing.

Also ship a research-and-report scenario with source snapshots and a deliberately missing citation. Use synthetic or clearly licensed materials. Synthetic tests demonstrate specific behavior under controlled conditions; they do not establish general model safety or reliability.

## Execution and trace architecture

Use TypeScript with a shared deterministic engine that runs in a browser worker and a Node CLI. A React/Vite frontend with Canvas or SVG for the timeline and dependency graph is a reasonable choice. Select libraries based on the requirements and verify their current interfaces.

Define versioned schemas for scenario definitions, workflow policies, checkpoints, fixture tool contracts, fault plans, assertions, events, and bundles. Make every run immutable once finalized. Use stable IDs, parent-run links, ordered event sequence numbers, and explicit timestamps. Distinguish virtual time from wall-clock time.

Fixture response matching should include tool identity, canonicalized arguments, relevant state, and occurrence or request identity. Reject ambiguous matches. Do not replay responses merely by tool name when arguments changed. Record fixture misses as errors.

Fault injection must be explicit about its target, activation condition, and effect. Support before-request, after-tool-commit, and before-response points where relevant. Model simulated side effects in a state store so an idempotency check can detect duplicates rather than rely on textual output.

Use a deterministic scheduling policy for the fixture runner. Make concurrency interleavings explicit and reproducible. A virtual clock should allow retry and timeout scenarios to complete promptly without real delays. Preserve state needed for a supported checkpoint fork.

On an unrecognized schema version, display a useful incompatibility error or use a documented migration. Do not silently drop events or invent missing state. Parsing an arbitrary JSON file is not proof of trace-format compatibility.

## Assertions and comparison

Implement deterministic assertions for tool input/output schemas, required evidence, allowed tool calls, ordering, retry bounds, cancellation, idempotency, completion state, and preserved invariants. Each result must link to the exact events and relevant state that support it.

Separate an execution error, an assertion failure, and an unavailable check. Do not count skipped or unimplemented checks as passes. A green badge requires actual evaluated evidence.

The comparison view should align runs by semantic step and request lineage, not only wall-clock position. Highlight the first observed divergence and its downstream events. Describe it as an observed divergence, not a proven root cause. When a check identifies a violated invariant, state what was violated.

If using model-based grading later, retain the rubric, grader model, raw response, parse result, and trace version. Label the judgment as model-generated and keep it separate from deterministic checks. Do not present a single aggregate reliability score without its denominator and scenario coverage.

## Integration scope

Implement and document the native scenario/trace format first. Then add one real integration with a reproducible fixture or local stub: a supported model tool-calling adapter, an agent framework, or an explicit subset of OpenTelemetry agent traces.

If using OpenTelemetry or MCP, read the current official specification and pin the supported schema or protocol revision. Do not assume legacy initialization behavior remains valid across revisions. Imported events lacking enough information for execution remain playback-only.

Keep provider credentials in the local runner environment, not in frontend bundles, reports, or browser storage. Do not embed credentials in exported scenarios. Live tool operations are disabled by default; external writes require explicit configuration by the person running the tool. A useful fixture-based product must remain available when no credentials are configured.

Never represent an OpenAI-compatible endpoint as universal support for every provider. Document exact supported request/response features, streamed events, cancellation behavior, and limitations. If a real provider cannot be tested in the available environment, deliver the working stub test and mark live validation pending.

## Visual direction

Use the live portfolio and its reading view as references. The current source is on `master` in `Zer0codestuff/Zer0codestuff.github.io`, not the retired `main`. If the private source is unavailable, the public site and these verified tokens are sufficient.

Use black `#000000`, near-black panels `#0a0a0a`, white text, green `#3cdc78`, and alert red `#ff4646`. Display type is Martian Mono; body and controls use JetBrains Mono. Secondary white text uses the reference opacities 0.74 and 0.62 subject to readability checks. Use thin low-opacity separators and minimal chrome.

The primary view is a readable execution timeline with an adjacent event inspector. On smaller screens, make inspection sequential. The fault controls should stay close to the chosen event. A compact graph can show dependencies, with ASCII glyphs as a restrained visual signature. Each edge must represent an actual relationship, not decoration.

Show status through text and symbols as well as color. Keep raw JSON behind an intentional inspection control, with readable wrapping and copy/export. Essential explanations should describe the workflow event in plain language.

Open directly into a working example. Avoid a marketing-only landing page, forced introduction, moving background behind traces, rainbow graphs, oversized headings, decorative cards, custom cursors, and fake activity. Respect reduced motion and keyboard access. The timeline must remain usable without animation.

## Milestones and acceptance

### 1. One complete failure and recovery

Build the native schema, a small workflow runner, a fixture tool, a state store, and the duplicate-side-effect scenario. Show the faulty run, its failed invariant, the corrected idempotent run, and an exported regression that works from the CLI.

### 2. Deterministic faults and replay

Add virtual time, retry/timeout behavior, stable request matching, cancellation, event ordering, and supported checkpoint forks. Verify that identical scenarios reproduce normalized event streams and state hashes, while a changed fault or policy yields the expected difference. Test against independently specified expected behavior.

### 3. Trace inspection and comparison

Connect the timeline, inspector, dependency graph, and run comparison to actual engine events. Explain the first divergence with inspectable evidence. Inspect the running UI at 1440, 1024, 768, and 390 CSS pixels, with keyboard operation, reduced motion, loading, errors, and viewport bounds. Save actual screenshots.

### 4. Scenario collection and real adapter

Complete the twelve required scenarios and add one integration with an explicit supported scope. Validate the adapter with malformed responses, streamed or partial data where supported, cancellation, and a credential-free local stub. Clearly separate fixture tests from any actual provider test.

### 5. Portability and measured performance

Export and reimport a regression bundle in a clean environment. Verify expected assertion outcomes and source-run integrity. Measure trace import, rendering, search, comparison, and export on a documented generated trace such as 10,000 events. Record input shape, browser/runtime, hardware where known, timings, and memory where measurable. Optimize demonstrated bottlenecks and preserve event fidelity.

## Data handling

Keep traces and scenarios local by default. Provide redaction before export, with an inspection step showing what will leave the machine. Redact secrets, authorization headers, and user-selected fields without claiming that automatic redaction finds everything. Do not include private imported traces in example bundles, screenshots, or source control.

Validate imported data and archive size limits. Render source text as text, not executable HTML. Imported scenarios use a declarative schema; do not execute arbitrary JavaScript or shell commands embedded in them. Replay never calls an external service. Live execution must be an explicit mode with a configured adapter.

## Completion and repository rules

Work through the milestones until the product contract and acceptance criteria pass. Save progress at milestone boundaries and record actual checks. Fix concrete defects rather than repeat unchanged checks or pad documentation.

Create and maintain a concise root `AGENTS.md` with purpose, architecture, run/build/test commands, current status, recent changes, constraints, known issues, and an explicit Do not list. Summarize updates when reporting progress.

The repository starts empty for the owner's trigger. Save this adopted brief in the implementation branch. Use feature branches and pull requests. Keep Zer0codestuff as the sole commit author and omit agent signatures and coauthor trailers. Do not push implementation directly to the default branch.

If the empty repository prevents an initial pull request without a base branch, prepare the implementation on a non-default branch and report the exact bootstrap requirement. Do not bypass the owner's rule. This substantial new application needs owner review before merging.

Deliver source, reproducible setup and CLI commands, focused verification evidence, actual screenshots, and explicit limitations. Preserve completed work and name concrete blockers. Do not publish the application, connect a hosting service, or change the personal portfolio without the requested preview and deployment decision.

## References

- Visual reference: https://gabrielemonni.me/?view=read
- Related evaluation tooling: https://www.promptfoo.dev/docs/configuration/expected-outputs/
- OpenTelemetry agent conventions entry point: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
- MCP current versioning: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- Gumloop sandbox: https://docs.gumloop.com/core-concepts/agent_sandbox_and_secrets

