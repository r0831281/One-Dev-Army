# Phase 2 local recovery runbook

This runbook covers only the local Phase 2 control plane. It never resets PostgreSQL, deletes Temporal history, or
downgrades migration 004. Repairs are forward-compatible and retain commands, manifests, decisions, checkpoints,
and event rows.

## Normal startup and diagnosis

Start the pinned services and apply the product migrations:

```powershell
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 180
pnpm build
node tools/verify-postgres.mjs
```

Start the API process used by the local installation, then start the worker with `pnpm worker`. The worker connects
to `127.0.0.1:7233`, namespace `default`, queue `oda-task-run-v1`, and the product database on port 5433 unless the
corresponding `ODA_*` variables override those local defaults.

Inspect service health without mutating state:

```powershell
docker compose -f infra/compose.yaml ps
docker compose -f infra/compose.yaml logs --tail 200 temporal postgres
```

## Pending command recovery

Run start, gate decision, and cancellation requests are committed to `command_requests` before Temporal dispatch.
Restarting the API creates a fresh dispatcher that reads pending commands. A start uses stable workflow ID
`task/{taskId}/run/{runId}`. A decision uses its idempotency key as the Temporal Update ID. Repeating the same key and
canonical payload is safe; a different payload is a conflict.

Use `GET /api/v1/decisions/by-key/{key}` after a timeout. `RECORDED` is authoritative, `PENDING` means the same key
must be reconciled, and `ABSENT` means no local intent exists. Never mint a replacement key merely because the HTTP
response was lost.

## Restart drills

The executable drill restarts the API service object, the real worker, and the Temporal container while workflows
are parked at clarification, plan approval, replanned approval, and exhausted-budget recovery gates:

```powershell
pnpm build
node tools/verify-phase2.mjs --restart-drill
```

The drill compares gate ID, gate version, artifact hash, state revision, and feedback provenance after recovery. It
also cancels a heartbeating fake Activity, exercises continue-as-new, and replays both checked-in histories.

For manual Temporal recovery at a visible gate:

```powershell
docker compose -f infra/compose.yaml restart temporal
docker compose -f infra/compose.yaml up -d --wait --wait-timeout 180
```

Leave the product database and Temporal persistence volume intact. Once healthy, restart the worker. The gate must
retain its ID/version/artifact hash before a decision is enabled.

## Safe failure handling

- Database unavailable: stop mutations and leave commands pending. Do not report an approval from memory.
- Temporal unavailable: show cached projections as stale and disable new decisions until reconciliation is possible.
- Worker unavailable: restart it on the same queue. Human waits hold no Activity or sandbox.
- Update response lost: query by the original key; never submit a second intent.
- Stale gate: retain the draft reason, fetch the current projection, and require explicit resubmission.
- Cancellation: retry the original cancellation key. The workflow revokes a pending gate or cancels the active
  heartbeating fake Activity before projecting `CANCELLED`.
- Migration failure: fix forward with a new ordered migration. Do not edit an applied checksum or run a destructive
  down migration.

Stop only the containers after verification; retain volumes:

```powershell
docker compose -f infra/compose.yaml stop
```
