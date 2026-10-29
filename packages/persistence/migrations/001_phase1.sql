BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), name text NOT NULL,
  local_path text NOT NULL, default_branch text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);
CREATE TABLE IF NOT EXISTS source_plugins (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), plugin_key text NOT NULL,
  version text NOT NULL, config jsonb NOT NULL, credential_ref text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id, plugin_key)
);
CREATE TABLE IF NOT EXISTS routing_rules (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), revision integer NOT NULL CHECK(revision > 0),
  enabled boolean NOT NULL, priority integer NOT NULL, match_kind text NOT NULL CHECK(match_kind IN ('webhook','exact','prefix','regex','fallback')),
  pattern text NOT NULL, source_plugin_id uuid NOT NULL REFERENCES source_plugins(id), repository_id uuid NOT NULL REFERENCES repositories(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id, id, revision)
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), source_plugin_id uuid NOT NULL REFERENCES source_plugins(id),
  external_id text NOT NULL, source_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_plugin_id, external_id)
);
CREATE TABLE IF NOT EXISTS task_contexts (
  task_id uuid NOT NULL REFERENCES tasks(id), revision integer NOT NULL CHECK(revision > 0), source_revision text,
  context jsonb NOT NULL, context_sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id, revision), UNIQUE(task_id, source_revision)
);
CREATE TABLE IF NOT EXISTS ingest_deliveries (
  source_plugin_id uuid NOT NULL REFERENCES source_plugins(id), delivery_id text NOT NULL,
  payload_sha256 text NOT NULL, task_id uuid REFERENCES tasks(id), receipt jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_plugin_id, delivery_id)
);
CREATE TABLE IF NOT EXISTS command_requests (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), idempotency_key uuid NOT NULL UNIQUE,
  payload_sha256 text NOT NULL, command_type text NOT NULL, payload jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('PENDING','DISPATCHED','COMPLETED','FAILED')), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_event_counters (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), last_seq bigint NOT NULL DEFAULT 0 CHECK(last_seq >= 0)
);
CREATE TABLE IF NOT EXISTS outbox_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), seq bigint NOT NULL CHECK(seq > 0), event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL, schema_version text NOT NULL, payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id, seq)
);
COMMIT;
