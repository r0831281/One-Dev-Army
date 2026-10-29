# Phase 4 continuation prompt

Inspect the actual One Developer Army repository and preserve all existing changes. Read `README.md`, `docs/handoffs/phase-3.md`, roadmap section 9.5, every architecture/contract chapter relevant to Phase 4, and every applicable `AGENTS.md`. Treat the Phase 3 handoff as evidence to verify against code and artifacts, not a substitute for inspection.

Phase 1 setup/ingestion, Phase 2 durable workflows/gates, and Phase 3 agents/sandboxes/telemetry are complete. Preserve immutable manifests and command identities, outbox and external-operation reconciliation, typed gate Updates, feedback provenance, monotonic projections, replay fixtures, prompt/profile hashes, candidate-bound evidence, immutable usage accounting, local-only defaults, broker restrictions, redaction, cancellation, and compatible migrations/workflows.

Implement and verify only Phase 4 from roadmap section 9.5. Do not regress or reimplement earlier phases and do not begin later stable-release work. Keep live provider, remote execution, source writes, merge, publication, push, and tag paths opt-in under the existing policy boundaries.

Use real local services wherever the Phase 4 exit criteria require them. Record exact commands, passed/failed/unverified evidence, migration/workflow/schema/image versions, recovery instructions, and known limitations. Do not claim completion from unit tests or mocked workflow behavior alone. Produce every Phase 4 release artifact and a final completion report; do not create another continuation prompt.
