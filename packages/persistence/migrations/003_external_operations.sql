BEGIN;
CREATE TABLE IF NOT EXISTS external_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_plugin_id uuid NOT NULL REFERENCES source_plugins(id),
  operation_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('comment','status')),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('INTENT','IN_FLIGHT','APPLIED','UNCERTAIN','FAILED')),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_operations_reconcile ON external_operations(state, updated_at)
  WHERE state IN ('INTENT','IN_FLIGHT','UNCERTAIN');
COMMIT;
