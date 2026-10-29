BEGIN;
CREATE TABLE IF NOT EXISTS workspace_operations (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  policy jsonb NOT NULL, assignments jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_admissions (
  run_id uuid PRIMARY KEY REFERENCES workflow_runs(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  reserved_microusd bigint NOT NULL CHECK(reserved_microusd >= 0),
  admitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_admissions_workspace ON run_admissions(workspace_id);
COMMIT;
