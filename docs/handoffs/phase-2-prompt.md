# Phase 2 implementation prompt

```text
Implement and verify Phase 2 of One Developer Army in the existing repository. Do not start Phase 3.

First inspect the actual repository and preserve all existing changes. Read README.md,
docs/handoffs/phase-1.md, docs/09-implementation-roadmap.md section 9.3, the architecture, dashboard,
observability, onboarding, plugin/routing, data-contract, agent/prompt, and sandbox chapters, plus every applicable
AGENTS.md. Treat the Phase 1 handoff as evidence to verify, not a substitute for inspecting code. Phase 1 is complete;
do not regress or reimplement it. Native macOS/Linux lifecycle expansion is explicitly deferred and is not a Phase 2
blocker.

Implement only Phase 2 — Durable state machine and HITL — across work packages 2.1 through 2.8:

- Add the versioned TaskRunWorkflow, task queues, Activity boundaries, immutable run manifests, correction budgets,
  and an explicit workflow-versioning policy.
- Implement durable, idempotent run-start and cancellation command dispatch with stable workflow IDs, outbox
  delivery, pending receipt lookup, and same-key/different-payload conflict behavior.
- Add read-only repository inventory plus fake-backed context and planning Activities with authoritative schemas for
  plans, clarifications, constraints, decisions, receipts, and workflow/projection events.
- Build revision-guarded run, step, checkpoint, and commit-ordered event projections that replay without overwriting
  newer state.
- Implement typed Temporal Updates for human gates, atomic concurrent-decision reservation, stable retry receipts,
  stale-version denial, rejection constraint provenance, feedback preservation, and gate supersession.
- Build the minimal accessible control UI: run list, readable plan, gate card, inline reason editor, and explicit
  offline, stale, pending, rejected, approved, cancelled, and exhausted-budget states.
- Prove API, worker, and Temporal restart recovery at every gate boundary; cooperative cancellation; pending-gate
  revocation; continue-as-new safety; and that no Activity remains idle while waiting for a human.
- Deliver the deterministic fake demonstration: ingest → clarify → plan → reject → replan with provenance-bearing
  feedback → approve → fake completion.

Use fake provider and execution backends for acceptance. Do not make paid model calls, real ticket writes, package or
image publications, pushes, or tags. Preserve Phase 1 security boundaries, broker restrictions, durable identities,
redaction, and local-only operation. Migrations must remain forward-compatible and rollback must use compatible
repairs rather than destructive downgrades.

Verification must include strict build/type/lint/format/documentation and schema-drift checks, all offline tests,
Temporal workflow replay fixtures for the initial version and a compatible evolution, simultaneous conflicting gate
decisions, same-key retries, different-payload rejection, network loss after durable decisions, stale gate versions,
projection replay ordering, cancellation, continue-as-new, fake end-to-end demonstration, full digest-pinned Compose
health, real PostgreSQL migrations, and restart drills for API, worker, and Temporal at every gate boundary. Record
exact commands and passed, failed, and unverified evidence.

Produce the Phase 2 release artifacts from roadmap 9.3: API contract, Temporal worker image, minimal dashboard,
fake-run demo, workflow replay fixtures, local recovery runbook, and upgrade compatibility report. Do not claim
completion based only on unit tests or mocked workflow semantics.

Update docs/handoffs/phase-2.md with implementation decisions, exact verification evidence, migration/workflow
versions, recovery instructions, known limitations, and the Phase 3 boundary. Only if every Phase 2 exit criterion
and release artifact is genuinely complete, create docs/handoffs/phase-3-prompt.md. That prompt must instruct the
next session to inspect the repository, read the completed Phase 2 handoff and Phase 3 roadmap, preserve completed
work, implement and verify only Phase 3, and produce the equivalent Phase 4 continuation prompt. Phase 4's successor
must be a final completion report. If Phase 2 remains incomplete, update this prompt or create a Phase 2 resume prompt
instead. Never start Phase 3 automatically.
```
