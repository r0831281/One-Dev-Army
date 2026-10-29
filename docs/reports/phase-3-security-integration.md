# Phase 3 Security-Focused Integration Report

Date: 2026-10-28. Scope: Phase 3 agents, sandbox policy, evidence binding, usage, telemetry, optional E2B consent, and reporter reconciliation.

## Implemented controls

- Provider profiles are immutable revisions. Capability validation rejects unsupported controls and prevents a local-only profile from falling back to a hosted provider.
- Prompt compilation normalizes LF/NFC, sorts policy inputs, intersects requested tools with role grants, separates untrusted task text, and hashes the complete provider-neutral artifact.
- Docker launch arguments are fixed by the broker: digest-pinned image, non-root UID/GID, read-only root, no network, all capabilities dropped, no-new-privileges, bounded CPU/RAM/PIDs, no-exec temporary storage, and only a broker-created volume.
- Repository and patch paths reject absolute paths, traversal, `.git`, symlinks, binary patches, excessive size, and excessive file count. Privilege tools, Docker clients/socket references, and metadata endpoints are denied.
- Command operation IDs bind to a request hash. Repeated IDs return the recorded receipt or reconnect; a different request conflicts.
- Candidate mutations clear test/review evidence. A final bundle can be created only when passing test/static and review receipts bind to the current candidate hash.
- Usage attempts and adjustments are append-only and idempotent. Reservations stop new calls at call/cost limits; unpriced calls remain explicit.
- Durable stream payloads are redacted before journaling. Retention gaps, epoch changes, slow clients, and log overflow produce explicit recovery states.
- E2B rejects execution without the exact remote-data consent flag and a complete parity report. No remote E2B probe was authorized or run.
- Reporter writes require final approval, use stable markers, and reconcile timeouts. An uncertain publication becomes `REPORT_PENDING`; it never starts implementation again.

## Verification status

Offline contract and fault tests are in `tests/phase3-core.test.ts`. Real-service and container evidence, including any environmental limitations, is recorded in `docs/handoffs/phase-3.md` and `artifacts/phase-3/verification.json`. This report does not claim sandbox-kernel isolation beyond Docker Desktop/Engine's documented boundary and does not treat model review as proof of security.

## Residual risks

- Windows cannot create symlinks without Developer Mode or elevated privilege; the equivalent escape check must therefore be exercised inside the Linux sandbox image.
- A registry-published digest and supply-chain signature are release/distribution work, not authorized in this phase. Local image IDs are evidence only.
- Live provider and E2B behavior remains intentionally unverified until the user supplies credentials, consent, and a spending cap.
