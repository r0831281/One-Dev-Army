# Phase 1 implementation handoff

Date: 2026-10-27. Release slice: `0.1.0-phase.1`. Phase 1 is **release-gate complete**. Every executable check
available on this Windows host passes, including isolated Linux verification. On 2026-10-27 the release owner
explicitly accepted Docker isolation as sufficient platform proof and deferred native macOS/Linux lifecycle runs.
GitHub and Jira connector images, SPDX SBOMs, and locally verified signed attestations now complete the remaining
release artifacts. Phase 2 has not been started.

## Implemented components

- `packages/contracts`: AJV 2020-12 runtime validation sourced from `docs/reference/schemas.json`, authoritative
  `json-schema-to-typescript` public types, API error construction, compatibility fixtures, and an exact drift check.
- `packages/persistence`: ordered checksummed migrations, PostgreSQL repositories, immutable task-context
  revisions, delivery/source-revision deduplication, durable idempotent commands, transactions, commit-order outbox
  allocation, and an external-operation intent/reconciliation journal.
- `packages/cli`: deterministic Node/Docker/Git probes, resumable action journal, atomic configuration writes,
  native macOS/Linux vault adapters, Windows DPAPI vault, Argon2id/AES-256-GCM fallback, service lifecycle,
  safe stop-only rollback, doctor, and the fake-source demonstration.
- `packages/plugin-sdk` and `packages/plugin-host`: newline-delimited JSON-RPC 2.0, handshake validation,
  deadlines, concurrency/restart/circuit limits, digest-only non-root Docker confinement, a scoped/rate-limited HTTP
  broker with DNS/private-address and redirect denial, credential injection, response limits, and redaction.
- `packages/routing` and `packages/connectors`: deterministic route ranking/ambiguity handling, RE2-compatible
  syntax rejection, fake/GitHub/Jira read connectors, GitHub/Jira status and comment writes with stable markers and
  uncertain-write reconciliation, signed webhook verification, replay windows, manual ingest, and deduplication.
- `apps/api`: loopback enforcement, bearer session and CSRF checks, body limits, routing preview, manual ingest,
  and signed webhook ingest.
- `infra`: digest-pinned PostgreSQL 17.6, Temporal 1.28.1, OpenTelemetry Collector 0.137.0, and Prometheus 3.7.1;
  loopback ports, persistent volumes, separate product/Temporal roles and databases, health checks, telemetry
  filtering, and a release manifest.

## Installation, startup, tests, and demo

Prerequisites are Node.js 22, pnpm 11.25, Git, and Docker Desktop/Engine with Linux containers.

```powershell
pnpm install --frozen-lockfile
pnpm build
node dist/packages/cli/src/bin.js setup --root "$env:LOCALAPPDATA\O-D-A" --repository "$PWD"
node dist/packages/cli/src/bin.js doctor --root "$env:LOCALAPPDATA\O-D-A"
```

The setup command writes only opaque vault references to configuration, starts the digest-pinned stack, and waits
for service health. `--dry-run` performs probes without mutation; `--resume <setup-id>` reuses journaled actions;
`--no-start` is configuration-only. Lifecycle commands are `up`, `stop`, `status`, and `rollback`. Rollback stops
owned services and retains volumes, configuration, and secrets.

Run all offline gates and the deterministic release slice:

```powershell
pnpm check:markdown
pnpm check:docs
pnpm check:contracts
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm demo
```

Run the real container/PostgreSQL checks:

```powershell
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 120
pnpm build
node tools/verify-postgres.mjs
docker compose -f infra/compose.yaml stop
```

The local distribution path is intentionally tested from built workspace artifacts. No claim is made that
`create-auto-dev` is published to npm.

The consolidated final offline command was `pnpm check`; it passed Markdown/reference validation, generated-file
drift, strict TypeScript, a clean build, and 15/15 Node tests. `pnpm lint`, `pnpm format`, and `pnpm demo` also passed
on 2026-10-27.

The real PostgreSQL verifier reported `passed` for migrations through head 3, ingestion, duplicate delivery,
immutable context, durable command idempotency, process-restart crash recovery, and external-write reconciliation.
All four Compose services reported healthy; they were stopped afterward with their volumes retained.

Run the hostile plugin proof:

```powershell
node tools/verify-hostile-plugin.mjs
```

It passed with immutable image ID
`sha256:fcc1807c9ab9d0bb410464b2d073f3d4a959ab9fb8f46975f1202388750ea9dd`. The live assertions proved a read-only
root, writable/no-exec `/tmp`, hidden host and Docker socket, absent credentials, UID/GID 65532, blocked metadata
network, 64 MiB memory, 16 PIDs, 0.25 CPU, dropped capabilities, and no-new-privileges.

Run the Linux clean-build/configuration verifier:

```powershell
docker build -f infra/verification/linux.Dockerfile -t oda-linux-matrix:phase1 .
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m oda-linux-matrix:phase1
```

The pinned Node 22 Alpine image completed a frozen clean install and strict build. Its isolated runtime reported
Linux setup/resume, Argon2id fallback, and missing-native-keyring failure as passed. This is configuration-only
Linux lifecycle evidence, not a native Linux Docker/DB desktop lifecycle.

The Windows matrix used isolated Compose project `oda-matrix-win-1793042244` and root
`.test-tmp/matrix-win-1793042244`. Clean setup, four-service health, migration head 3, resume with setup ID
`40a5fb4c-b387-42bd-a75e-74bdb928f6ef`, doctor, DPAPI put/get/delete, and rollback passed. A separate live listener
on port 15310 produced `SETUP_PROBE_FAILED:port:15310`. Isolated test Compose resources were removed afterward.

## Decisions and deviations

- JSON Schema remains authoritative. `generated.ts` is produced by `json-schema-to-typescript`, checked in for
  consumers, and compared byte-for-byte by the drift gate.
- JavaScript regular expressions are used only after rejecting lookarounds, backreferences, conditionals, and
  nested quantifier forms unsupported or unsafe under RE2. A native RE2 dependency was avoided in bootstrap.
- Windows uses current-user DPAPI stored under the owner-only data root. macOS uses Keychain and Linux uses Secret
  Service. The explicit fallback uses Argon2id (64 MiB, three iterations) and AES-256-GCM; it starts locked because
  callers must provide the passphrase.
- TypeScript 7 is strict-checked directly. The current `typescript-eslint` release rejects TypeScript 7, so the lint
  gate combines strict TypeScript diagnostics with ESLint over executable JavaScript tooling.
- GitHub/Jira status and comment operations are implemented and verified only against controlled HTTP fixtures.
  No real provider write was attempted. Operation intent is persisted before dispatch and uncertain results remain
  recoverable by stable provider-visible markers.

## Acceptance evidence

| Criterion                                                              | Status                 | Evidence                                              |
| ---------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------- |
| Strict build/types/lint/format/docs                                    | Passed                 | `pnpm check`, `pnpm lint`, `pnpm format`; 15/15 tests |
| Schema generation and drift                                            | Passed                 | `pnpm check:contracts` via `pnpm check`               |
| GitHub/Jira status/comment reconciliation                              | Passed                 | Controlled fixtures; no real provider writes          |
| Durable external intent and uncertain recovery                         | Passed                 | Migration 003, tests, real PostgreSQL verifier        |
| Real migrations, command idempotency, crash recovery                   | Passed                 | `node tools/verify-postgres.mjs`, head 3              |
| Route/RPC/webhook/vault/migration failures                             | Passed                 | Offline test suite                                    |
| Fake end-to-end ingestion                                              | Passed                 | `pnpm demo`                                           |
| Full Compose health                                                    | Passed                 | Four digest-pinned services healthy on Docker 29.9.2  |
| Hostile filesystem/socket/network/credential/privilege/resource denial | Passed                 | `node tools/verify-hostile-plugin.mjs`                |
| Windows clean setup/resume/DPAPI/collision/rollback                    | Passed                 | Isolated project and persisted setup journal          |
| Linux clean build/resume/vault failure                                 | Passed with scope note | Pinned config-only container verifier                 |
| Native macOS/Linux lifecycle expansion                                 | Deferred               | Release owner accepted isolated Docker proof          |
| Connector images/SBOMs/signed attestations                             | Passed                 | `pnpm verify:connector-artifacts`                     |
| GitHub/Jira live auth/write probes                                     | Unverified by design   | Credentials absent; real ticket writes prohibited     |

## Connector release artifacts

```powershell
pnpm release:connectors
pnpm verify:connector-artifacts
```

Both commands passed. The generator built non-root, pinned-base GitHub and Jira JSON-RPC images, exercised manifest
and normalize calls with runtime networking disabled, inventoried Alpine and npm packages into SPDX 2.3 documents,
and emitted DSSE-wrapped in-toto statements signed with an ephemeral Ed25519 key. The independent verifier matched
the local immutable image IDs, verified both DSSE signatures with the retained public key, and matched each SBOM
hash to its attestation subject. Artifacts are under `artifacts/phase-1/connectors`; publication remains local-only.

The exact current GitHub/Jira image IDs and signer key ID are recorded in
`artifacts/phase-1/connectors/manifest.json`; the verifier rejects any mismatch with the locally built images.

## Deferred limitations

- Native macOS Keychain and native Linux Secret Service/full-service lifecycle matrices remain useful portability
  follow-ups but are not Phase 1 blockers by explicit release-owner decision.
- Real GitHub/Jira credentials and writes were intentionally not used. Controlled fixtures cover the release path.
- The connector attestations are local development attestations, not registry transparency-log identities. The
  private ephemeral signing key was not retained, so the recorded artifacts are verifiable but not re-signable.

## Version continuation data

- Node 22; pnpm 11.25.0; TypeScript 7.0.2; AJV 8.20.0; PostgreSQL client 8.13.1.
- Migration head: 3. Contract schema: 1.0. Plugin protocol: 1.0.
- Container tags and linux/amd64 digests are in `infra/release-manifest.json`.
- Connector image IDs and signed artifact paths are in `artifacts/phase-1/connectors/manifest.json`.
- The next session should use [the Phase 2 prompt](phase-2-prompt.md). Phase 2 was not started in this session.
