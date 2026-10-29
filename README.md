# One Developer Army (O-D-A)

O-D-A is a local-first platform for helping one developer supervise setup, task ingestion, and—across later
phases—durable software-delivery workflows without surrendering control of credentials, repositories, or external
side effects.

This repository contains the completed **Phase 1 setup-and-ingestion**, **Phase 2 durable state machine and
human-in-the-loop**, **Phase 3 agents, sandboxes, and telemetry**, and **Phase 4 dashboard and community SDK** slices.
Phase 4 adds the stable local dashboard, bounded live presentation, accessible gates, configuration inspection,
TypeScript/Python plugin starters and conformance, backup/restore drills, safe diagnostics, governance, and signed
local release artifacts without changing the Phase 3 workflow or migration boundaries.

The Phase 4 release gate is recorded in the [Phase 4 completion report](docs/reports/phase-4-completion.md). No paid
model call, E2B transfer, real ticket write, package/image publication, push, merge, or tag is part of the acceptance
path.

## Quick start

Prerequisites: Node.js 22, pnpm 11.25, Git, and Docker Desktop/Engine using Linux containers.

```powershell
pnpm install --frozen-lockfile
pnpm build
node dist/packages/cli/src/bin.js setup --root "$env:LOCALAPPDATA\O-D-A" --repository "$PWD"
node dist/packages/cli/src/bin.js doctor --root "$env:LOCALAPPDATA\O-D-A"
pnpm demo
pnpm demo:phase2
pnpm demo:phase3
pnpm verify:phase4
```

For the browser dashboard demo, without Postgres or Temporal:

```powershell
pnpm demo:dashboard
```

See [dashboard development](apps/dashboard/README.md) for its source layout and
standalone preview options.

The package is built and exercised locally; it has not been published to npm. Use the built CLI path above instead
of assuming `npx create-auto-dev` is publicly available.

Useful lifecycle commands:

```powershell
node dist/packages/cli/src/bin.js status
node dist/packages/cli/src/bin.js stop
node dist/packages/cli/src/bin.js up --root "$env:LOCALAPPDATA\O-D-A"
node dist/packages/cli/src/bin.js rollback
```

`rollback` stops services started by O-D-A and retains data volumes, configuration, and secrets. Setup supports
`--dry-run`, `--no-start`, and `--resume <setup-id>`.

## Verification

Run the offline gates:

```powershell
pnpm check:markdown
pnpm check:docs
pnpm check:contracts
pnpm lint
pnpm typecheck
pnpm test
pnpm demo
```

Exercise the real local stack and PostgreSQL path:

```powershell
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 120
pnpm build
node tools/verify-postgres.mjs
node tools/verify-phase2.mjs --restart-drill
node tools/verify-phase3-postgres.mjs
node tools/verify-phase3-temporal.mjs
node tools/verify-phase3.mjs --docker
node tools/verify-phase4-dashboard.mjs
node tools/phase4-operations.mjs drill --output .validation/phase4-drill
docker compose -f infra/compose.yaml stop
```

The integration verifier applies ordered migrations, checks immutable task contexts, ingests and retrieves a
validated context, replays a duplicate delivery, and checks durable command idempotency, process-restart recovery,
and external-write reconciliation. The additional container verifiers are documented in the Phase 1 handoff.

## Repository map

| Path                                 | Purpose                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `apps/api`                           | Loopback API, session/CSRF controls, preview and ingestion endpoints        |
| `apps/dashboard`                     | Accessible three-zone run, gate, telemetry, inspector, and configuration UI |
| `apps/worker`                        | Temporal workflow, typed Updates, Activities, replay fixtures, worker image |
| `packages/cli`                       | Bootstrap, setup journal, vaults, lifecycle, doctor, demo                   |
| `packages/contracts`                 | JSON-Schema validators, public types, fixtures, API errors                  |
| `packages/persistence`               | Migrations, repositories, commands, transactions, outbox                    |
| `packages/plugin-sdk`                | Public protocol types and offline community conformance                     |
| `packages/create-task-source-plugin` | TypeScript and Python community starters                                    |
| `packages/plugin-host`               | Process/container supervision and capability HTTP broker                    |
| `packages/routing`                   | Deterministic RE2-compatible route resolution and preview                   |
| `packages/connectors`                | Fake, GitHub, and Jira source connectors and webhook signatures             |
| `packages/agents`                    | Immutable profile revisions and compiled prompt artifact registry           |
| `packages/providers`                 | Fake-first normalized provider adapters and usage fixtures                  |
| `packages/sandboxes`                 | Docker/E2B policy, command receipts, candidate sealing, cleanup             |
| `packages/telemetry`                 | Usage budgets, redaction, retained streams, metrics                         |
| `packages/reporting`                 | Approval-bound marker publication and reconciliation                        |
| `infra`                              | Digest-pinned Compose stack, health checks, telemetry configuration         |
| `tests`                              | Offline contract, routing, setup, vault, RPC, broker, and ingestion tests   |
| `docs`                               | Architecture specification, roadmap, reference contracts, handoffs          |

## Security and durability baseline

- The API binds to loopback and requires a local session plus CSRF protection for ordinary mutations.
- Plugin images must be digest-pinned. The generated Docker wrapper uses no network, a read-only root, no host
  mounts, no Docker socket, dropped capabilities, no-new-privileges, bounded memory/CPU/PIDs, and a small no-exec
  temporary filesystem.
- Plugin HTTP access goes through an origin/path/method-scoped broker. Credentials are injected broker-side and
  secret-shaped response/log fields are redacted.
- Secrets use Windows current-user DPAPI, macOS Keychain, or Linux Secret Service. The explicit file fallback uses
  Argon2id and AES-256-GCM.
- PostgreSQL uses separate Temporal and product roles/databases. Context revisions and outbox events are immutable;
  webhook delivery, source revision, commands, and external effects use stable idempotency identities.
- Published ports are loopback-only, images are digest-pinned, and all four services have health checks.

## Architecture baseline

| Decision          | Baseline                                                              |
| ----------------- | --------------------------------------------------------------------- |
| Deployment        | One developer, one workspace, localhost                               |
| Application stack | Strict TypeScript, Node.js 22, pnpm workspaces, Turborepo metadata    |
| Durability        | PostgreSQL now; self-hosted Temporal is provisioned for Phase 2       |
| Storage           | Product PostgreSQL and local artifacts                                |
| Integrations      | Versioned JSON-RPC over stdio in hardened containers                  |
| Secrets           | Native OS vaults with an authenticated encrypted fallback             |
| Observability     | OpenTelemetry Collector and Prometheus, no external export by default |
| License           | Apache-2.0                                                            |

## Specification index

1. [High-level architecture and execution DAG](docs/01-architecture.md)
2. [Dashboard UI, telemetry visuals, and decision gates](docs/02-dashboard.md)
3. [Telemetry, observability, and streaming](docs/03-observability.md)
4. [Onboarding and secrets](docs/04-onboarding.md)
5. [Plugin SDK and routing](docs/05-plugins-and-routing.md)
6. [Data schemas and public API contracts](docs/06-data-contracts.md)
7. [Agent profiles and prompt compiler](docs/07-agents-and-prompts.md)
8. [Sandbox execution and test runners](docs/08-sandbox-execution.md)
9. [Phased implementation roadmap](docs/09-implementation-roadmap.md)

Phase 4 preserves the exact sealed candidate, evidence, approvals, usage, reporting, and policy boundaries from
Phase 3. Team RBAC, organizations, Kubernetes, hosted control planes, autonomous publication/merge, and remote
collaboration remain post-v1 work requiring separate design review.
