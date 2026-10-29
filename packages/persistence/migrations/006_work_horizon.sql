BEGIN;
CREATE TABLE IF NOT EXISTS work_horizon_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  days integer NOT NULL CHECK(days BETWEEN 0 AND 365),
  timezone text NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS work_horizon_overrides (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_id uuid NOT NULL,
  allowed boolean NOT NULL,
  reason text NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,task_id)
);
COMMIT;
