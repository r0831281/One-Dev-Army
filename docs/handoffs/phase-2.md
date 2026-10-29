# Phase 2 implementation handoff

Date: 2026-10-27. Release slice: `0.2.0-phase.2`. Scope: durable state machine and human-in-the-loop control only.
Phase 3 has not been started.

## Implemented decisions

- `TaskRunWorkflow` version 1 uses queue `oda-task-run-v1`, immutable manifest hashes, capped Activity retry, typed
  `submitGateDecision` and `cancelRun` Updates, deterministic UUID/time APIs, and no Activity during human waits.
- Start, cancel, and decision intents are durable `command_requests`. Stable workflow IDs are
  `task/{taskId}/run/{runId}`; decision Update IDs equal the API idempotency key. Canonical payload hashes make
  same-key/same-payload replay stable and same-key/different-payload reuse a conflict.
- Repository inventory skips symlinks, `.git`, dependencies, build output, and test scratch; it is read-only and
  bounded. Context review, planning, and completion use deterministic fake Activities without provider/source writes.
- JSON Schema remains authoritative for manifests, inventory, clarification, plans, decisions, receipts, run/step
  projections, and event envelopes. Generated TypeScript is checked for exact drift.
- Run and step projections accept only higher revisions. Checkpoints and gate decisions are immutable. Outbox sequence
  allocation remains transactionally commit ordered.
- Gate handlers reserve synchronously before their first await. Rejections create provenance-bearing constraints;
  superseded gates retain feedback, stale versions fail, and exhausted human-replan budgets open a recovery gate.
- Cancellation revokes a pending gate or cancels the scoped heartbeating fake Activity, then prevents further work.
  Continue-as-new runs only after a completed gate handler at a quiescent boundary and carries logical counters,
  constraints, receipts, manifest references, and the public run ID.
- The dashboard is a local static artifact served by the loopback API. It provides a run list, readable plan, gate
  card, inline rejection editor, focus/reduced-motion support, and explicit offline, stale, pending, rejected,
  approved, cancelled, and exhausted-budget copy. It never advances optimistically.

## Workflow and migration versions

| Item                    | Phase 2 value                                      |
| ----------------------- | -------------------------------------------------- |
| Product migration head  | 4 (`004_phase2_workflows.sql`)                     |
| Contract schema major   | 1.0                                                |
| Event protocol major    | 1.0                                                |
| Workflow type/version   | `TaskRunWorkflow` / 1                              |
| Task queue              | `oda-task-run-v1`                                  |
| Temporal service        | 1.28.1, digest pinned in Compose                   |
| Temporal TypeScript SDK | 1.25.0                                             |
| Worker base             | Digest-pinned Node 22 Alpine, non-root `node` user |

## Release artifacts

| Artifact                              | Location                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| API contract                          | `docs/reference/phase2-api.openapi.yaml`                             |
| Temporal worker image source          | `apps/worker/Dockerfile`                                             |
| Local immutable worker identity       | `infra/release-manifest.json`                                        |
| Minimal dashboard                     | `apps/dashboard/index.html`                                          |
| Fake-run demonstration/history        | `tools/verify-phase2.mjs`, `artifacts/phase-2/fake-run-history.json` |
| Workflow replay fixtures              | `apps/worker/fixtures/initial.json`, `compatible-evolution.json`     |
| Recovery runbook                      | `docs/runbooks/phase-2-recovery.md`                                  |
| Upgrade compatibility report          | `docs/reports/phase-2-upgrade-compatibility.md`                      |
| Machine-readable verification summary | `artifacts/phase-2/verification.json`                                |

## Exact verification evidence

The following offline commands passed on Windows with Node 22 and pnpm 11.25.0:

```powershell
pnpm check:markdown
pnpm check:docs
pnpm check:contracts
pnpm check:phase2-artifacts
pnpm lint
pnpm format
pnpm typecheck
pnpm test
```

The 21/21-test suite includes offline replay of both checked-in Temporal histories, projection ordering, authoritative
contract rejection cases, read-only inventory/fake planning, dashboard state/accessibility assertions, and all Phase
1 regression tests.

The following real-service commands passed:

```powershell
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 180
pnpm build
node tools/verify-postgres.mjs
node tools/verify-phase2.mjs --restart-drill
docker build -f apps/worker/Dockerfile -t oda-worker:phase2 .
docker run --rm --network none oda-worker:phase2 node --version
docker compose -f infra/compose.yaml ps
```

Real PostgreSQL applied migration head 4 and retained the Phase 1 ingestion, immutable-context, command, crash, and
external-write checks. The Phase 2 verifier used the real pinned Temporal service and PostgreSQL. It passed:

- API child-process stop/start and projection reads at every clarification, plan, replanned, and recovery boundary;
- worker shutdown/recreation at each boundary;
- actual Temporal container restart and health recovery at every gate kind, preserving gate ID/version/artifact;
- two concurrent conflicting decisions with exactly one success;
- stable same-key receipt, different-payload conflict, stale-gate denial, and lookup after a deliberately discarded
  durable Update response;
- feedback provenance in planner revision 2, rejection supersession, and exhausted-budget recovery;
- cancellation of a heartbeating Activity and pending-gate revocation;
- safe continue-as-new with changed Temporal run ID and stable logical run ID;
- initial and compatible-evolution replay fixtures through `Worker.runReplayHistory`;
- zero open Activities when each human decision was accepted;
- the full ingest → clarify → plan → reject → provenance-bearing replan → approve → fake-complete demonstration.

All four digest-pinned Compose services reported healthy after the restart drill. The worker image built from the
digest-pinned base, ran as user `node`, and completed a network-disabled Node smoke test. Its final local image ID is
`sha256:7e995473fc9878af36b772503c8c6f67b15d7fb3a2aff4a6602e72aaf9324388`. No image was pushed.

## Failed attempts retained as evidence

Failures discovered during implementation were corrected and rerun:

- Managed sandbox runs initially denied Docker/loopback access; the same commands passed with explicit local-service
  permission.
- The first worker image build failed closed on unapproved `@swc/core` and `protobufjs` lifecycle scripts. The exact
  pinned packages are now the only `allowBuilds` entries; the rebuild passed.
- The first real workflow run exposed unsupported `structuredClone` inside the Temporal isolate. Deterministic JSON
  cloning replaced it and the replay/integration runs passed.
- A worker-restart test exposed a gate-reservation race between projection commit and the next workflow task. The
  reservation is now cleared before publishing a gate; simultaneous-decision tests pass.
- A stale pending Phase 1 command initially blocked Phase 2 dispatch. The dispatcher now selects only Phase 2 command
  kinds and isolates non-retryable failures; recovery reruns passed.
- The first final stale-gate assertion inspected only the Temporal SDK wrapper message even though its typed cause was
  the expected `GATE_VERSION_CONFLICT`. The verifier now inspects that structured cause; the complete drill reran and
  passed.
- The post-release-artifact format check found that regenerated replay histories were valid but not Prettier-normalized.
  Both fixtures were normalized, replayed successfully, and the format and artifact checks passed afterward.

No failed gate remains in the final verification summary.

## Recovery and rollback

Follow `docs/runbooks/phase-2-recovery.md`. Keep product and Temporal volumes together. Pending commands reconcile by
their original keys. A lost decision response is looked up by key; never create a replacement intent. Rollback keeps
migration 004 and deploys only a replay-compatible prior worker. Destructive database down migrations, Temporal
history resets, manifest rewrites, and gate-record edits are prohibited.

## Known limitations and unverified items

- Native macOS/Linux lifecycle expansion remains deferred by the Phase 1 release decision and is not a Phase 2
  blocker.
- The dashboard passed structural accessibility/state tests, but no claim is made for certification by a particular
  screen reader/browser matrix or hardware-independent performance target.
- Provider and execution backends are fake. No paid model call, real ticket write, repository mutation, package/image
  publication, push, tag, or registry signature/transparency record was attempted.
- The worker image identity is local and unpublished. A registry digest must replace it before any future release
  publication.
- The API remains the local Node HTTP implementation inherited from Phase 1 rather than the future Fastify/Next.js
  presentation stack; its Phase 2 contract and security boundary are explicit and tested locally.

## Phase 3 boundary

Phase 2 stops at fake completion. Phase 3 may add provider agents and sandbox execution, but must preserve manifest
identity, command/outbox semantics, typed gate Updates, feedback provenance, monotonic projections, replay fixtures,
local-only defaults, broker restrictions, redaction, and cancellation behavior. Do not reinterpret Phase 2 approval
as authorization to mutate the original checkout, write a real source ticket, merge, publish, push, or tag.
