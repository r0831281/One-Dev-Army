# Phase 3 implementation handoff

Date: 2026-10-28. Release slice: `0.3.0-phase.3`. Scope: agents, sandboxes, immutable usage, live product telemetry, optional remote execution controls, and reconciled reporting. Phase 4 has not been started.

## Implemented decisions

- Workflow version 2 shares the stable `TaskRunWorkflow` identity and `oda-task-run-v1` queue with version 1, but branches only when the immutable manifest pins `workflowVersion=2`. Version 1 histories keep their Phase 2 fake-completion path. The Phase 3 branch adds `TESTING`, `REVIEWING`, `AWAITING_FINAL`, `REPORTING`, and `REPORT_PENDING` projections plus a `FINAL_APPROVAL` gate.
- The final gate proposal binds the candidate, test, review, usage, and operation hashes. Candidate sealing supersedes the prior generation and evidence insertion verifies the currently sealed candidate. In-memory and PostgreSQL paths reject stale candidate evidence; a mutation clears prior test/review evidence.
- Profiles are immutable revisions with role-specific tool intersections, local-only fallback enforcement, bounded options, and profile compile APIs. The prompt compiler normalizes LF/NFC, canonicalizes objects, keeps task text under an explicit untrusted heading, and hashes compiler/template/schema/policy/profile/message provenance.
- Fake-provider execution is the default. Named Ollama, OpenAI, Anthropic, Gemini, OpenRouter, and Bedrock adapters normalize provider fixtures through injected transports. Live probes require `ODA_ALLOW_LIVE_PROVIDER_PROBES=I_CONSENT` and a maximum USD cap of at most 1; none was authorized or run.
- Docker command construction is fixed by policy: digest-pinned image, UID/GID 10001, read-only root, no network, all capabilities dropped, no-new-privileges, CPU/RAM/PID bounds, bounded no-exec tmpfs, and a broker-created volume only. Paths, patches, commands, Docker socket references, metadata endpoints, binary patches, traversal, and symlink escapes fail closed.
- Command operation IDs bind to canonical request hashes. A replacement worker reconnects to the broker-side running receipt or receives the terminal receipt; the same operation is not started twice. Cleanup targets only explicitly broker-managed resources and records success, cancellation, or expiry.
- Model/sandbox attempts, usage adjustments, pricing snapshots, reservations, candidates, and execution evidence are append-only or state-restricted in migration 005. Retries are distinct attempts, cache/reasoning categories remain separate, unknown prices remain `UNPRICED`, and call/cost reservations block dispatch when exhausted.
- The journal retains ordered redacted envelopes, snapshot cursors, epochs, gap/resync results, a 1 MiB/1,000-envelope connection bound, close code 4008 for slow clients, 64 KiB payload bounds, stateful log redaction, and a complete low-cardinality metric catalog. Snapshot/history APIs read committed PostgreSQL state. Collector export failures do not roll back product state.
- E2B is disabled unless `ODA_E2B_REMOTE_DATA_CONSENT=I_CONSENT` and every normalized capability, including disk limits and network isolation, passes parity checks.
- Reporter operations require final approval, stable operation markers, and request hashes. Timeout becomes `UNCERTAIN`; reconciliation either finds the marker or leaves `REPORT_PENDING`. It never creates a new implementation run.

## Versions and release artifacts

| Item                           | Phase 3 value                                                             |
| ------------------------------ | ------------------------------------------------------------------------- |
| Product migration head         | 5 (`005_phase3_execution.sql`)                                            |
| Contract schema/event protocol | compatible `1.0` / `1.0`                                                  |
| Workflow versions              | `TaskRunWorkflow` 1 and 2                                                 |
| Task queue                     | `oda-task-run-v1`                                                         |
| Prompt compiler/template       | `1.0.0` / system revision 1                                               |
| Temporal service/SDK           | 1.28.1 / 1.25.0                                                           |
| Sandbox base                   | digest-pinned Node 22 Alpine; UID/GID 10001                               |
| Local sandbox image            | `sha256:b6dac1ffc3c67a6a043528a4cdbcf5ae32a449006d7157ca80cb82d23e0f8f9a` |
| Local broker image             | `sha256:cba1aadfa5e21a19cdfbb2356d31d7ecacc71acd5c37e2982a3263deb59c1496` |

Release artifacts are `packages/providers`, `packages/sandboxes`, `packages/agents`, `packages/prompt-compiler`, `packages/telemetry`, `packages/reporting`, `apps/sandbox-broker`, both hardened Dockerfiles, prompt templates, `artifacts/phase-3/full-execution-demo.json`, `artifacts/phase-3/cost-accounting-fixtures.json`, `docs/reports/phase-3-security-integration.md`, `tools/export-phase3.mjs`, `tools/retain-phase3.mjs`, the Phase 3 replay fixture, and `infra/phase3-release-manifest.json`.

## Exact passed evidence

Offline commands:

```powershell
pnpm check:markdown
pnpm check:docs
pnpm check:contracts
pnpm check:phase2-artifacts
pnpm check:phase3-artifacts
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm build
node tools/verify-phase3.mjs
node tools/verify-phase3.mjs --docker
node tools/export-phase3.mjs
node tools/retain-phase3.mjs
```

The 30/30-test suite covers prompt stability/injection boundaries, provider capability and usage fixtures, live-probe consent, traversal and command denial, worker-call replacement without duplicate tests, candidate invalidation, cleanup states, E2B parity/consent, retry/cache/reasoning accounting, unpriced and exhausted budgets, redaction, reconnect, retention gaps, epochs, backpressure, overflow, Collector failure, report timeout reconciliation, and patch-bound workflow activities. Temporal replay passes the Phase 1/2 initial, Phase 2 compatible-evolution, and completed Phase 3 histories.

Real local service commands:

```powershell
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 180
node tools/verify-postgres.mjs
node tools/verify-phase3-postgres.mjs
node tools/verify-phase2.mjs --restart-drill
node tools/verify-phase3-temporal.mjs
docker build -f infra/sandbox-node.Dockerfile -t oda-sandbox:phase3 .
docker build -f apps/sandbox-broker/Dockerfile -t oda-sandbox-broker:phase3 .
docker build -f infra/verification/phase3.Dockerfile -t oda-phase3-verifier:local .
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 256m --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,size=16m oda-phase3-verifier:local
docker compose -f infra/compose.yaml stop otel-collector
node tools/verify-phase3-temporal.mjs
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 180
docker compose -f infra/compose.yaml ps
```

PostgreSQL upgraded the retained database and a temporary fresh schema through migration head 5. The real version-2 Temporal run performed clarify, plan, reject with provenance, replan, approve, implement, test, review, final approval, and reconciled fake-source reporting; a worker restart preserved the exact final gate. The run retained one sealed candidate, four evidence rows, one explicit unpriced usage attempt, and one applied external-operation marker. The completed 187-event history replays offline.

The Linux security probe denied traversal, symlink escape, privilege tools, Docker socket access, and metadata egress. The runtime probe also verified non-root UID 10001, zero effective capabilities, `NoNewPrivs=1`, read-only root, absent Docker socket, blocked metadata networking, and scratch overflow. Explicit test containers left no resource after success, cancellation, or expiry. All four digest-pinned Compose services were healthy after the Collector-outage drill.

## Failed attempts retained as evidence

- The managed `pnpm` wrapper initially failed `realpath` before TypeScript ran. Direct installed binaries supplied feedback; canonical `pnpm` gates were rerun with approved local access.
- Docker Desktop was initially stopped, then the managed sandbox denied its named pipe. Docker Desktop was started and explicitly approved engine access was used for all recorded container/service evidence.
- The first Phase 3 history write double-encoded SDK JSON. The canonical `historyToJSON` bytes replaced it.
- The first Phase 3 replay used a synthetic workflow ID, causing Update validation to diverge before an Activity. The exact stable workflow ID is now stored beside the fixture; all three histories replay.
- Native Windows symlink creation was denied. The same resolver attack was run successfully inside the non-root Linux verifier image and denied there.

No failed release gate remains after the final reruns.

## Recovery and rollback

Follow `docs/runbooks/phase-3-recovery.md`. Preserve product and Temporal volumes, artifacts, manifests, profiles, prompt artifacts, usage attempts/adjustments, command receipts, evidence, and external-operation markers together. Reconcile an original operation ID before retry. Recreate a lost sandbox from the sealed base/candidate and rerun tests/review, which requires a fresh final gate. Never retry an uncertain source write under a new key.

Rollback stops new version-2 scheduling and drains compatible workers. Migration 005 remains in place. Deploy only workers that replay all retained histories; do not down-migrate, rewrite immutable records, reset Temporal history, or remove artifacts referenced by a gate/run.

## Known limitations and explicit non-actions

- Live provider probes and paid calls were not authorized. Fixture contracts cover all named providers; runtime availability, credentials, vendor quotas, and current pricing remain deployment-time checks.
- E2B remote-data transfer was not authorized. The adapter boundary, consent flag, timeout model, compute category, and parity rejection are implemented and tested locally; no remote handle was created.
- Source publication used the fake connector only. No real comment/status was published.
- Images are local and unpublished. No push, merge, tag, package/image publication, signature, or transparency record was created.
- Docker containers share the Docker Desktop Linux VM kernel; this is not a dedicated-hardware isolation claim.

## Phase 4 boundary

Phase 3 ends with the exact patch/evidence final gate and reconciled source report. It does not include Phase 4 visual polish, React Flow/xterm dashboard expansion, public community SDK onboarding, marketplace/community publication, merge automation, or stable-release work. Do not start Phase 4 without a new explicit session request.
