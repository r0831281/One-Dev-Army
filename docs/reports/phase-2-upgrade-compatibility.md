# Phase 2 upgrade compatibility report

Release: `0.2.0-phase.2`. Database migration head: 4. Workflow type/version: `TaskRunWorkflow`/1. Temporal queue:
`oda-task-run-v1`. Temporal TypeScript SDK: 1.25.0. Public JSON schemas and event protocol remain major version 1.

## Compatibility policy

Run manifests are immutable and pin workflow version, task-context revision, repository/base SHA, routing revision,
profile revisions, policy hash, and correction budgets. Workflow behavior changes use Temporal patch markers and
must replay all retained fixtures before deployment. A breaking state-machine change receives a new workflow type or
major workflow version and a separate task queue. Existing runs drain on compatible workers; they are never reset to
adopt new behavior.

Database changes follow expand, migrate, contract. Migration 004 only expands the Phase 1 schema with workflow,
step, gate, decision, checkpoint, and dispatch fields. Rollback means deploying a prior worker that is replay-compatible
with active histories while keeping migration 004. Physical down migrations and manifest rewrites are unsupported.

## Verified evolution

`apps/worker/fixtures/initial.json` was produced by the unpatched fixture workflow. The current worker replays it
through patch marker `phase2-compatible-evolution-v2`. `compatible-evolution.json` records the new branch. Both were
replayed by `Worker.runReplayHistory` during the real Temporal verifier.

Projection writes accept only higher state revisions. Step projections use the same monotonic guard. Checkpoints are
immutable per run/revision, and outbox cursors are allocated transactionally. Replaying an older Activity result
therefore cannot overwrite newer product state.

## Deployment and rollback

1. Back up product PostgreSQL, Temporal persistence, artifacts, configuration, and the release manifest together.
2. Apply migration 004 before starting Phase 2 API/worker code.
3. Run both replay fixtures, strict offline gates, and the real restart drill.
4. Start workers on `oda-task-run-v1`; then enable the Phase 2 API/dashboard routes.
5. To roll back application code, keep migration 004 and deploy only a worker that passes both replay fixtures.
6. If no compatible prior worker exists, keep the current worker until active runs drain; do not reset histories.

The worker image is local-only and unpublished. Its immutable local image ID is recorded in
`infra/release-manifest.json`; a registry digest and signing/transparency evidence are required before any future
publication.
