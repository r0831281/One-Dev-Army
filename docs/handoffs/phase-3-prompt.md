# Phase 3 continuation prompt

Implement and verify Phase 3 of One Developer Army in the existing repository. Do not start Phase 4.

First inspect the actual repository and preserve all existing changes. Read `README.md`,
`docs/handoffs/phase-2.md`, `docs/09-implementation-roadmap.md` section 9.4, the architecture, dashboard,
observability, onboarding, plugin/routing, data-contract, agent/prompt, and sandbox chapters, plus every applicable
`AGENTS.md`. Treat the Phase 2 handoff as evidence to verify, not a substitute for inspecting code. Phase 1 and Phase
2 are complete; do not regress or reimplement them. Preserve the immutable manifest and durable command identities,
outbox reconciliation, typed gate Updates, feedback provenance, monotonic projections, workflow replay fixtures,
local-only defaults, broker restrictions, redaction, cooperative cancellation, and compatible-repair migration
policy.

Implement only Phase 3 — agents, sandboxes, and telemetry — across work packages 3.1 through 3.8 in roadmap section
9.4. Use fake providers first and keep all live provider probes explicitly opt-in. Build profiles and deterministic
prompt artifacts; provider adapters; hardened Docker execution and command receipts; the QA/reviewer loop; immutable
usage accounting and budgets; durable redacted live telemetry; optional E2B only behind explicit consent and parity
checks; and reconciled reporter integration. The final gate must bind to the exact sealed patch, tests, review, and
usage evidence, and any candidate mutation must invalidate prior evidence.

Verify every Phase 3 exit criterion with the appropriate real local services. Include provider fixture contracts,
prompt hash stability, sandbox traversal/symlink/privilege/socket/metadata-egress/limit denials, worker-death command
recovery without duplicate tests, cleanup after success/cancellation/expiry, usage retry/cache/reasoning
reconciliation, unpriced and exhausted-budget behavior, stream reconnect/gaps/epoch/backpressure/log-overflow and
Collector outage, source-publication timeout reconciliation, workflow replay and restart compatibility, strict
build/type/lint/format/documentation/schema-drift checks, full digest-pinned Compose health, and forward-compatible
real PostgreSQL migrations. Record exact commands and passed, failed, and unverified evidence. Do not claim
completion from unit tests or mocked workflow semantics alone.

Produce every Phase 3 release artifact from roadmap 9.4: provider/sandbox packages, hardened images, prompt
templates, full execution demo, cost-accounting fixtures, security-focused integration report, and retention/export
tools. Do not make paid model calls, publish real source comments/statuses, push, merge, tag, publish packages/images,
or enable remote execution without explicit user authorization.

Update `docs/handoffs/phase-3.md` with implementation decisions, exact evidence, migration/workflow/schema/image
versions, recovery instructions, known limitations, and the Phase 4 boundary. Only if every Phase 3 exit criterion
and release artifact is genuinely complete, create `docs/handoffs/phase-4-prompt.md`. That prompt must direct the next
session to inspect the repository, read the completed Phase 3 handoff and Phase 4 roadmap, preserve completed work,
implement and verify only Phase 4, and produce a final completion report rather than another continuation prompt. If
Phase 3 remains incomplete, update this prompt or create a Phase 3 resume prompt instead. Never start Phase 4
automatically.
