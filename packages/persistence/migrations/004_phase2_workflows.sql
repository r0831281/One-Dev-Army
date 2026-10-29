BEGIN;
CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  context_revision integer NOT NULL,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  base_sha text NOT NULL CHECK(base_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  workflow_id text NOT NULL UNIQUE,
  workflow_version integer NOT NULL CHECK(workflow_version > 0),
  state text NOT NULL CHECK(state IN ('QUEUED','CONTEXT_REVIEW','AWAITING_CONTEXT','PLANNING','AWAITING_PLAN','IMPLEMENTING','COMPLETED','FAILED','CANCELLING','CANCELLED','NEEDS_ATTENTION')),
  state_revision bigint NOT NULL DEFAULT 0 CHECK(state_revision >= 0),
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  projection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(task_id, context_revision) REFERENCES task_contexts(task_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_phase2_run_per_task ON workflow_runs(task_id)
  WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED');

CREATE TABLE IF NOT EXISTS agent_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  step_key text NOT NULL,
  logical_iteration integer NOT NULL CHECK(logical_iteration > 0),
  state text NOT NULL CHECK(state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  state_revision bigint NOT NULL CHECK(state_revision >= 0),
  projection jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, step_key, logical_iteration)
);

CREATE TABLE IF NOT EXISTS decision_gates (
  id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  kind text NOT NULL CHECK(kind IN ('CLARIFICATION','PLAN_APPROVAL','RECOVERY')),
  state text NOT NULL CHECK(state IN ('PENDING','DECIDED','SUPERSEDED','CANCELLED')),
  state_revision bigint NOT NULL CHECK(state_revision >= 0),
  artifact_hash text NOT NULL CHECK(artifact_hash ~ '^[a-f0-9]{64}$'),
  proposal jsonb NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY(id, version),
  UNIQUE(id, version, run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_phase2_gate_per_run ON decision_gates(run_id)
  WHERE state = 'PENDING';

CREATE TABLE IF NOT EXISTS gate_decisions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  gate_id uuid NOT NULL,
  gate_version integer NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
  reason text,
  actor_id uuid NOT NULL,
  receipt jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE(gate_id, gate_version),
  FOREIGN KEY(gate_id, gate_version, run_id) REFERENCES decision_gates(id, version, run_id),
  CHECK((decision='APPROVE' AND reason IS NULL) OR
    (decision='REJECT' AND reason IS NOT NULL AND reason ~ '[^[:space:]]' AND length(reason) BETWEEN 1 AND 8000))
);

CREATE TABLE IF NOT EXISTS state_checkpoints (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  state_revision bigint NOT NULL CHECK(state_revision >= 0),
  workflow_id text NOT NULL,
  temporal_execution_id text NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, state_revision)
);

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES workflow_runs(id);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS state_revision bigint;
ALTER TABLE command_requests ADD COLUMN IF NOT EXISTS workflow_id text;
ALTER TABLE command_requests ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0);
ALTER TABLE command_requests ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS command_dispatch_pending ON command_requests(available_at, created_at)
  WHERE state = 'PENDING';

DROP TRIGGER IF EXISTS workflow_manifest_immutable ON workflow_runs;
CREATE OR REPLACE FUNCTION oda_preserve_run_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
     OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id OR NEW.workflow_version IS DISTINCT FROM OLD.workflow_version THEN
    RAISE EXCEPTION 'immutable run manifest';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_manifest_immutable BEFORE UPDATE ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION oda_preserve_run_manifest();

DROP TRIGGER IF EXISTS gate_decisions_immutable ON gate_decisions;
CREATE TRIGGER gate_decisions_immutable BEFORE UPDATE OR DELETE ON gate_decisions
FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS state_checkpoints_immutable ON state_checkpoints;
CREATE TRIGGER state_checkpoints_immutable BEFORE UPDATE OR DELETE ON state_checkpoints
FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
COMMIT;
